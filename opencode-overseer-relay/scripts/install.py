#!/usr/bin/env python3
"""Preview or install the Overseer relay runtime and skills, without dependencies."""

from __future__ import annotations

import argparse
import ast
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import secrets
import stat
import sys


MAX_ARTIFACT_BYTES = 1024 * 1024
MAX_TOTAL_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_ARTIFACTS = 128
MAX_TOTAL_BACKUP_BYTES = 16 * 1024 * 1024
MANIFEST_SCHEMA = "overseer-relay.install-manifest.v1"
INTENT_SCHEMA = "overseer-relay.install-intent.v1"
PACKAGE_NAME = "opencode-overseer-relay"
SUPPORTED_PACKAGE_VERSIONS = frozenset({"0.1.0", "0.2.0"})
MANAGED_ARTIFACT_MANIFEST_SHA256 = "bee765da636166f53bcf40e229c3a10509edb75fdd9327d8d82526741fa4a621"
MAX_MANAGED_DIST_FILES = 128
MAX_MANAGED_DIST_DEPTH = 32
MAX_MANAGED_DIST_SCAN_ENTRIES = 512
MANAGED_DIST_RELATIVE_PATHS = (
    "THIRD_PARTY_NOTICES.md",
    "contract.mjs",
    "core.mjs",
    "licenses/opencode-MIT.txt",
    "provenance.json",
    "relay-managed.mjs",
    "vendor/chunks/contract-1r8wv9wh.js",
    "vendor/chunks/contract-6r38tsk5.js",
    "vendor/chunks/contract-8ye1ye6f.js",
    "vendor/chunks/contract-9rqn6x4v.js",
    "vendor/chunks/contract-gecjxyvt.js",
    "vendor/chunks/contract-mwrzahmf.js",
    "vendor/chunks/contract-nwcpakzx.js",
    "vendor/chunks/contract-qav6mfdz.js",
    "vendor/chunks/contract-sdjh9vmn.js",
    "vendor/chunks/contract-sxt88q69.js",
    "vendor/chunks/contract-ve4aws36.js",
    "vendor/chunks/contract-vxrn9xjg.js",
    "vendor/chunks/contract-vyas3vgt.js",
    "vendor/chunks/contract-xby11z3y.js",
    "vendor/chunks/contract-xgnj2w4v.js",
    "vendor/chunks/contract-xqwq6bgr.js",
    "vendor/package.json",
    "vendor/promise/index.js",
    "vendor/promise/service.js",
)
MANIFEST_RELATIVE = "overseer-relay/install-manifest.json"
INTENT_RELATIVE = "overseer-relay/install-intent.json"
LOCK_RELATIVE = ".overseer-relay-install.lock"

_VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z", re.ASCII)
_SHA256 = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_INSTALL_ID = re.compile(r"[0-9a-f]{32}\Z", re.ASCII)
_PYTHON_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\.py\Z", re.ASCII)
_TEMPLATE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z", re.ASCII)
_SECRET_ASSIGNMENT = re.compile(
    r"\b(?:token|secret|password|api[_ -]?key|authorization|cookie|credential)\b\s*[:=]\s*\S+",
    re.IGNORECASE | re.ASCII,
)
_SKILL_SOURCES = (
    "skills/overseer-setup/SKILL.md",
    "skills/overseer-setup/references/setup-checklist.md",
    "skills/overseer-coordinate/SKILL.md",
    "skills/overseer-coordinate/references/protocol.md",
    "skills/overseer-coordinate/references/authority-and-goals.md",
    "skills/overseer-coordinate/references/recovery.md",
)
_REQUIRED_SOURCES = frozenset(
    {
        "src/overseer_relay/__init__.py",
        "scripts/install.py",
        *_SKILL_SOURCES,
    }
)
_SCRIPT_ALLOWLIST = ("install.py", "verify.py", "rollback.py")


class InstallerError(ValueError):
    """Content-free diagnostic for invalid sources, targets, or manifests."""


def _absolute_lexical(raw_path: str | os.PathLike, *, base: Path | None = None) -> Path:
    """Normalize a path without resolving symlinks and reject lexical traversal."""
    try:
        raw = os.fspath(raw_path)
    except (OSError, TypeError, ValueError):
        raise InstallerError("path is invalid") from None
    if (
        not isinstance(raw, str)
        or not raw
        or "\x00" in raw
        or "\\" in raw
        or PureWindowsPath(raw).drive
    ):
        raise InstallerError("path is invalid")
    # Inspect the spelling before abspath/Path can normalize away traversal.
    if ".." in raw.split("/") or ".." in PureWindowsPath(raw).parts:
        raise InstallerError("path contains a traversal component")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = (base or Path.cwd()) / path
    try:
        normalized = Path(os.path.abspath(os.fspath(path)))
    except (OSError, TypeError, ValueError):
        raise InstallerError("path is invalid") from None
    if any(component == ".." for component in normalized.parts):
        raise InstallerError("path contains a traversal component")
    return normalized


def _check_components(path: Path, *, allow_missing: bool = False, final_kind: str | None = None) -> bool:
    """lstat each component in order; never inspect descendants through a link."""
    path = Path(path)
    if not path.is_absolute() or any(part in (".", "..") for part in path.parts):
        raise InstallerError("path is not a normalized absolute path")
    current = Path(path.anchor)
    parts = path.parts[1:]
    try:
        anchor_info = current.lstat()
    except OSError:
        raise InstallerError("path cannot be inspected safely") from None
    if stat.S_ISLNK(anchor_info.st_mode) or not stat.S_ISDIR(anchor_info.st_mode):
        raise InstallerError("path has an unsafe root component")
    for index, component in enumerate(parts):
        current = current / component
        try:
            info = current.lstat()
        except FileNotFoundError:
            if allow_missing:
                return False
            raise InstallerError("path component is missing") from None
        except OSError:
            raise InstallerError("path component cannot be inspected safely") from None
        if stat.S_ISLNK(info.st_mode):
            raise InstallerError("path contains a symlink")
        final = index == len(parts) - 1
        if not final and not stat.S_ISDIR(info.st_mode):
            raise InstallerError("path parent is not a directory")
        if final and final_kind == "directory" and not stat.S_ISDIR(info.st_mode):
            raise InstallerError("path is not a directory")
        if final and final_kind == "file":
            if not stat.S_ISREG(info.st_mode):
                raise InstallerError("path is not a regular file")
            if info.st_nlink != 1:
                raise InstallerError("path has an unexpected hard link")
    if not parts and final_kind == "directory":
        return True
    return True


def _safe_path(path: Path, *, allow_missing: bool = False, final_kind: str | None = None) -> bool:
    """Apply both the package's shared path guard and strict local checks."""
    exists = _check_components(path, allow_missing=allow_missing, final_kind=final_kind)
    try:
        from overseer_relay.paths import PathError, check_no_symlinks

        check_no_symlinks(Path(path.anchor), path, allow_missing=allow_missing)
    except ImportError:
        pass
    except PathError:
        raise InstallerError("path is unsafe") from None
    return exists


def _read_regular_file(path: Path, *, limit: int) -> bytes:
    """Read a bounded, single-link regular file without following its final link."""
    path = Path(path)
    _safe_path(path, final_kind="file")
    try:
        before = path.lstat()
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0),
        )
    except OSError:
        raise InstallerError("file could not be opened safely") from None
    try:
        opened = os.fstat(descriptor)
        identity = (before.st_dev, before.st_ino)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or (opened.st_dev, opened.st_ino) != identity
            or opened.st_size > limit
        ):
            raise InstallerError("file is not a bounded, single-link regular file")
        chunks = []
        remaining = limit + 1
        while remaining:
            block = os.read(descriptor, min(64 * 1024, remaining))
            if not block:
                break
            chunks.append(block)
            remaining -= len(block)
        data = b"".join(chunks)
        after = os.fstat(descriptor)
        try:
            current = path.lstat()
        except OSError:
            raise InstallerError("file identity changed while reading") from None
        if (
            len(data) > limit
            or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
            or (current.st_dev, current.st_ino) != identity
            or not stat.S_ISREG(current.st_mode)
            or current.st_nlink != 1
        ):
            raise InstallerError("file changed or exceeded its read limit")
        return data
    finally:
        os.close(descriptor)


def _strict_json_bytes(raw: bytes):
    class DuplicateKey(ValueError):
        pass

    def unique_pairs(pairs):
        value = {}
        for key, child in pairs:
            if key in value:
                raise DuplicateKey
            value[key] = child
        return value

    def reject_constant(_value):
        raise ValueError

    try:
        decoded = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=unique_pairs,
            parse_constant=reject_constant,
        )
    except (UnicodeError, json.JSONDecodeError, ValueError, RecursionError):
        raise InstallerError("JSON is invalid") from None
    if not isinstance(decoded, dict):
        raise InstallerError("JSON object is invalid")
    return decoded


def _credential_scan(value) -> None:
    """Reject credential-like metadata without echoing the offending value."""
    try:
        from overseer_relay.config import ConfigError, _scan_credentials

        _scan_credentials(value)
    except ImportError:
        pass
    except ConfigError:
        raise InstallerError("manifest contains disallowed credential-like data") from None

    pending = [value]
    while pending:
        current = pending.pop()
        if isinstance(current, dict):
            if any(not isinstance(key, str) or _SECRET_ASSIGNMENT.search(key) for key in current):
                raise InstallerError("manifest contains disallowed credential-like data")
            pending.extend(current.values())
        elif isinstance(current, list):
            pending.extend(current)
        elif isinstance(current, str) and _SECRET_ASSIGNMENT.search(current):
            raise InstallerError("manifest contains disallowed credential-like data")


def _relative_parts(value: str) -> tuple[str, ...]:
    if (
        not isinstance(value, str)
        or not value
        or "\x00" in value
        or "\\" in value
        or value.startswith("/")
        or PureWindowsPath(value).is_absolute()
        or PureWindowsPath(value).drive
    ):
        raise InstallerError("manifest contains an unsafe relative path")
    parts = tuple(value.split("/"))
    if any(part in ("", ".", "..") for part in parts):
        raise InstallerError("manifest contains an unsafe relative path")
    return parts


def _expected_destination(source: str, version: str) -> str:
    parts = _relative_parts(source)
    if len(parts) == 3 and parts[:2] == ("src", "overseer_relay") and _PYTHON_NAME.fullmatch(parts[2]):
        return f"overseer-relay/runtime/{version}/src/overseer_relay/{parts[2]}"
    if len(parts) == 2 and parts[0] == "templates" and _TEMPLATE_NAME.fullmatch(parts[1]):
        return f"overseer-relay/runtime/templates/{parts[1]}"
    if len(parts) == 2 and parts[0] == "scripts" and parts[1] in _SCRIPT_ALLOWLIST:
        return f"overseer-relay/runtime/scripts/{parts[1]}"
    if version == "0.2.0" and len(parts) >= 3 and parts[:2] == ("managed", "dist"):
        relative = "/".join(parts[2:])
        _managed_dist_relative_parts(relative)
        return f"overseer-relay/runtime/{version}/managed/dist/{relative}"
    if parts == ("README.md",):
        return "overseer-relay/runtime/README.md"
    if source in _SKILL_SOURCES:
        return source
    raise InstallerError("manifest contains an unsupported source path")


def validate_manifest(value: dict) -> dict:
    """Validate a versioned manifest before any manifest path is used."""
    if not isinstance(value, dict):
        raise InstallerError("install manifest is invalid")
    _credential_scan(value)
    required = {
        "schema",
        "schema_version",
        "package",
        "package_version",
        "install_id",
        "records",
    }
    if set(value) != required:
        raise InstallerError("install manifest is invalid")
    version = value["package_version"]
    install_id = value["install_id"]
    records = value["records"]
    if (
        value["schema"] != MANIFEST_SCHEMA
        or type(value["schema_version"]) is not int
        or value["schema_version"] != 1
        or value["package"] != PACKAGE_NAME
        or not isinstance(version, str)
        or version not in SUPPORTED_PACKAGE_VERSIONS
        or not isinstance(install_id, str)
        or _INSTALL_ID.fullmatch(install_id) is None
        or not isinstance(records, list)
        or not 1 <= len(records) <= MAX_ARTIFACTS
    ):
        raise InstallerError("install manifest is invalid")

    normalized = []
    sources = set()
    destinations = set()
    expected_managed_sources = None
    if version == "0.2.0":
        expected_managed_sources = {
            f"managed/dist/{relative}"
            for relative in ("artifact-manifest.json", *MANAGED_DIST_RELATIVE_PATHS)
        }
    for record in records:
        expected_fields = {
            "source",
            "destination",
            "version",
            "installed_sha256",
            "prior_exists",
            "prior_sha256",
            "backup",
            "backup_sha256",
        }
        if not isinstance(record, dict) or set(record) != expected_fields:
            raise InstallerError("install manifest record is invalid")
        source = record["source"]
        destination = record["destination"]
        _relative_parts(source)
        _relative_parts(destination)
        if (
            record["version"] != version
            or destination != _expected_destination(source, version)
            or source in sources
            or destination in destinations
            or not isinstance(record["installed_sha256"], str)
            or _SHA256.fullmatch(record["installed_sha256"]) is None
            or type(record["prior_exists"]) is not bool
        ):
            raise InstallerError("install manifest record is invalid")
        sources.add(source)
        destinations.add(destination)
        if record["prior_exists"]:
            prior_hash = record["prior_sha256"]
            backup = record["backup"]
            backup_hash = record["backup_sha256"]
            expected_backup = f"overseer-relay/backups/{install_id}/{destination}"
            _relative_parts(backup)
            if (
                not isinstance(prior_hash, str)
                or _SHA256.fullmatch(prior_hash) is None
                or backup != expected_backup
                or backup_hash != prior_hash
            ):
                raise InstallerError("install manifest backup record is invalid")
        elif any(record[key] is not None for key in ("prior_sha256", "backup", "backup_sha256")):
            raise InstallerError("install manifest backup record is invalid")
        normalized.append(dict(record))

    if not _REQUIRED_SOURCES.issubset(sources):
        raise InstallerError("install manifest is incomplete")
    if expected_managed_sources is not None:
        actual_managed_sources = {source for source in sources if source.startswith("managed/dist/")}
        if actual_managed_sources != expected_managed_sources:
            raise InstallerError("install manifest managed artifact inventory is incomplete")
    return {
        "schema": MANIFEST_SCHEMA,
        "schema_version": 1,
        "package": PACKAGE_NAME,
        "package_version": version,
        "install_id": install_id,
        "records": normalized,
    }


def _discover_layout(script_file: Path):
    """Find only the source tree adjacent to the script or its installed runtime."""
    script_path = _absolute_lexical(script_file)
    _safe_path(script_path, final_kind="file")
    parent = script_path.parent.parent
    if script_path.parent.name == "scripts" and parent.name == "runtime":
        _safe_path(parent, final_kind="directory")
        candidates = []
        try:
            entries = list(parent.iterdir())
        except OSError:
            raise InstallerError("installed runtime cannot be inspected safely") from None
        for entry in entries:
            if _VERSION.fullmatch(entry.name) is None:
                continue
            try:
                info = entry.lstat()
            except OSError:
                raise InstallerError("installed runtime cannot be inspected safely") from None
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise InstallerError("installed runtime contains an unsafe version entry")
            candidate = entry / "src"
            _safe_path(candidate, final_kind="directory")
            candidates.append((tuple(int(part) for part in entry.name.split(".")), entry, candidate))
        if not candidates:
            raise InstallerError("installed runtime source is missing")
        _sort_key, version_dir, source_root = max(candidates, key=lambda item: item[0])
        runtime_root = parent
        package_root = None
        source_script_root = runtime_root / "scripts"
        templates_root = runtime_root / "templates"
        skills_root = runtime_root.parent.parent / "skills"
        readme_path = runtime_root / "README.md"
    else:
        package_root = parent
        source_root = package_root / "src"
        _safe_path(source_root, final_kind="directory")
        version_dir = None
        runtime_root = None
        source_script_root = package_root / "scripts"
        templates_root = package_root / "templates"
        skills_root = package_root / "skills"
        readme_path = package_root / "README.md"

    module_dir = source_root / "overseer_relay"
    _safe_path(module_dir, final_kind="directory")
    # Validate Python source paths before adding this tree to the import path.
    for candidate in module_dir.iterdir():
        if candidate.suffix == ".py":
            _safe_path(candidate, final_kind="file")
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(source_root))
    return package_root, source_root, version_dir, runtime_root, source_script_root, templates_root, skills_root, readme_path


(
    _PACKAGE_ROOT,
    _SOURCE_ROOT,
    _VERSION_DIR,
    _RUNTIME_ROOT,
    _SCRIPT_ROOT,
    _TEMPLATES_ROOT,
    _SKILLS_ROOT,
    _README_PATH,
) = _discover_layout(Path(__file__))
_MANAGED_DIST_ROOT = (
    _VERSION_DIR / "managed" / "dist"
    if _VERSION_DIR is not None
    else _PACKAGE_ROOT / "managed" / "dist"
)

# The shared package helpers are imported only after the package source paths
# have been checked. Installed scripts resolve these imports from runtime/<version>/src.
try:
    from overseer_relay.config import ConfigError, _scan_credentials
    from overseer_relay.journal import JournalError, atomic_write_text
    from overseer_relay.paths import PathError, check_no_symlinks
except ImportError:
    raise InstallerError("relay runtime helpers could not be loaded") from None


@dataclass(frozen=True)
class Artifact:
    source: str
    destination: str
    version: str
    content: bytes
    sha256: str


def _package_version(source_root: Path) -> str:
    """Extract the literal version assignment without executing package code."""
    init_path = source_root / "overseer_relay" / "__init__.py"
    raw = _read_regular_file(init_path, limit=MAX_ARTIFACT_BYTES)
    try:
        tree = ast.parse(raw.decode("utf-8", errors="strict"), filename="__init__.py")
    except (SyntaxError, UnicodeError, ValueError):
        raise InstallerError("package version declaration is invalid") from None
    values = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets
        ):
            values.append(node.value)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "__version__":
            values.append(node.value)
    if (
        len(values) != 1
        or not isinstance(values[0], ast.Constant)
        or not isinstance(values[0].value, str)
        or values[0].value not in SUPPORTED_PACKAGE_VERSIONS
    ):
        raise InstallerError("package version declaration is invalid")
    version = values[0].value
    if _VERSION_DIR is not None and _VERSION_DIR.name != version:
        raise InstallerError("installed runtime version does not match its source")
    return version


def _directory_files(directory: Path, *, suffix: str | None = None) -> list[Path]:
    _safe_path(directory, final_kind="directory")
    try:
        entries = sorted(directory.iterdir(), key=lambda entry: entry.name)
    except OSError:
        raise InstallerError("source directory cannot be inspected safely") from None
    result = []
    for entry in entries:
        if suffix is not None and entry.suffix != suffix:
            continue
        if entry.name.startswith(".") or entry.name in ("__pycache__", "tests", "tmp"):
            continue
        _safe_path(entry, final_kind="file")
        result.append(entry)
    return result


def _read_artifact(path: Path, source: str, version: str) -> Artifact:
    content = _read_regular_file(path, limit=MAX_ARTIFACT_BYTES)
    return _artifact_from_bytes(source, version, content)


def _artifact_from_bytes(source: str, version: str, content: bytes) -> Artifact:
    if len(content) > MAX_ARTIFACT_BYTES:
        raise InstallerError("source artifact exceeds its size limit")
    try:
        content.decode("utf-8", errors="strict")
    except UnicodeError:
        raise InstallerError("source artifact is not UTF-8 text") from None
    destination = _expected_destination(source, version)
    return Artifact(source, destination, version, content, hashlib.sha256(content).hexdigest())


def _managed_dist_relative_parts(relative: str) -> tuple[str, ...]:
    parts = _relative_parts(relative)
    if (
        len(parts) > MAX_MANAGED_DIST_DEPTH
        or any(
            part == "node_modules"
            or part.startswith(".")
            or re.fullmatch(r"[A-Za-z0-9._-]+", part, re.ASCII) is None
            for part in parts
        )
    ):
        raise InstallerError("managed artifact inventory contains an unsupported path")
    return parts


def _managed_dist_inventory() -> dict[str, bytes]:
    """Read only the pinned 0.2 ESM inventory and reject any other dist entry."""
    root = _MANAGED_DIST_ROOT
    _safe_path(root, final_kind="directory")
    manifest_path = root / "artifact-manifest.json"
    manifest_bytes = _read_regular_file(manifest_path, limit=MAX_MANIFEST_BYTES)
    if hashlib.sha256(manifest_bytes).hexdigest() != MANAGED_ARTIFACT_MANIFEST_SHA256:
        raise InstallerError("managed artifact manifest does not match the pinned inventory")
    manifest = _strict_json_bytes(manifest_bytes)
    if (
        set(manifest) != {"schemaVersion", "hashAlgorithm", "files"}
        or type(manifest["schemaVersion"]) is not int
        or manifest["schemaVersion"] != 1
        or manifest["hashAlgorithm"] != "SHA-256"
        or not isinstance(manifest["files"], list)
        or not 1 <= len(manifest["files"]) <= MAX_MANAGED_DIST_FILES
    ):
        raise InstallerError("managed artifact manifest is invalid")

    expected: dict[str, tuple[int, str]] = {}
    expected_directories = set()
    previous_path = None
    total_size = len(manifest_bytes)
    for entry in manifest["files"]:
        if (
            not isinstance(entry, dict)
            or set(entry) != {"path", "size", "sha256"}
            or not isinstance(entry["path"], str)
            or entry["path"] == "artifact-manifest.json"
            or type(entry["size"]) is not int
            or not 0 <= entry["size"] <= MAX_ARTIFACT_BYTES
            or not isinstance(entry["sha256"], str)
            or _SHA256.fullmatch(entry["sha256"]) is None
        ):
            raise InstallerError("managed artifact manifest entry is invalid")
        relative = entry["path"]
        parts = _managed_dist_relative_parts(relative)
        if relative in expected or (previous_path is not None and relative <= previous_path):
            raise InstallerError("managed artifact manifest paths are duplicated or unordered")
        previous_path = relative
        total_size += entry["size"]
        if total_size > MAX_TOTAL_ARTIFACT_BYTES:
            raise InstallerError("managed artifact inventory exceeds its size limit")
        expected[relative] = (entry["size"], entry["sha256"])
        for end in range(1, len(parts)):
            expected_directories.add("/".join(parts[:end]))

    if set(expected) != set(MANAGED_DIST_RELATIVE_PATHS):
        raise InstallerError("managed artifact manifest paths do not match the fixed inventory")

    expected_files = set(expected) | {"artifact-manifest.json"}
    observed_files = set()
    visited = 0
    pending = [(root, "", 0)]
    while pending:
        directory, prefix, depth = pending.pop()
        if depth > MAX_MANAGED_DIST_DEPTH:
            raise InstallerError("managed artifact tree exceeds its depth limit")
        _safe_path(directory, final_kind="directory")
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    visited += 1
                    if visited > MAX_MANAGED_DIST_SCAN_ENTRIES:
                        raise InstallerError("managed artifact tree exceeds its entry limit")
                    if (
                        not entry.name
                        or entry.name.startswith(".")
                        or entry.name == "node_modules"
                        or re.fullmatch(r"[A-Za-z0-9._-]+", entry.name, re.ASCII) is None
                    ):
                        raise InstallerError("managed artifact tree contains an unsupported path")
                    relative = f"{prefix}/{entry.name}" if prefix else entry.name
                    _managed_dist_relative_parts(relative)
                    path = directory / entry.name
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode):
                        raise InstallerError("managed artifact tree contains a symlink")
                    if stat.S_ISDIR(info.st_mode):
                        if relative not in expected_directories:
                            raise InstallerError("managed artifact tree contains an unexpected directory")
                        pending.append((path, relative, depth + 1))
                    elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                        if relative not in expected_files:
                            raise InstallerError("managed artifact tree contains an unexpected file")
                        observed_files.add(relative)
                    else:
                        raise InstallerError("managed artifact tree contains an unsafe file")
        except InstallerError:
            raise
        except OSError:
            raise InstallerError("managed artifact tree cannot be inspected safely") from None
    if observed_files != expected_files:
        raise InstallerError("managed artifact tree does not match its pinned inventory")

    contents = {"artifact-manifest.json": manifest_bytes}
    for relative, (expected_size, expected_hash) in expected.items():
        content = _read_regular_file(root.joinpath(*_managed_dist_relative_parts(relative)), limit=MAX_ARTIFACT_BYTES)
        if len(content) != expected_size or hashlib.sha256(content).hexdigest() != expected_hash:
            raise InstallerError("managed artifact does not match its pinned hash")
        contents[relative] = content
    return contents


def collect_artifacts() -> list[Artifact]:
    """Read the bounded, fixed-layout install inventory; never recurse broadly."""
    version = _package_version(_SOURCE_ROOT)
    artifacts = []
    module_dir = _SOURCE_ROOT / "overseer_relay"
    for path in _directory_files(module_dir, suffix=".py"):
        artifacts.append(_read_artifact(path, f"src/overseer_relay/{path.name}", version))

    for path in _directory_files(_TEMPLATES_ROOT):
        if _TEMPLATE_NAME.fullmatch(path.name) is None:
            raise InstallerError("template inventory contains an unsupported filename")
        artifacts.append(_read_artifact(path, f"templates/{path.name}", version))

    _safe_path(_SCRIPT_ROOT, final_kind="directory")
    for name in _SCRIPT_ALLOWLIST:
        path = _SCRIPT_ROOT / name
        if not _safe_path(path, allow_missing=True):
            if name == "install.py":
                raise InstallerError("installer source is missing")
            continue
        artifacts.append(_read_artifact(path, f"scripts/{name}", version))

    for source in _SKILL_SOURCES:
        path = _SKILLS_ROOT.joinpath(*_relative_parts(source)[1:])
        artifacts.append(_read_artifact(path, source, version))

    if version == "0.2.0":
        for relative, content in sorted(_managed_dist_inventory().items()):
            artifacts.append(_artifact_from_bytes(f"managed/dist/{relative}", version, content))

    if _safe_path(_README_PATH, allow_missing=True):
        artifacts.append(_read_artifact(_README_PATH, "README.md", version))

    if len(artifacts) > MAX_ARTIFACTS:
        raise InstallerError("install inventory exceeds its file limit")
    if not _REQUIRED_SOURCES.issubset({artifact.source for artifact in artifacts}):
        raise InstallerError("install inventory is incomplete")
    total = sum(len(artifact.content) for artifact in artifacts)
    if total > MAX_TOTAL_ARTIFACT_BYTES:
        raise InstallerError("install inventory exceeds its size limit")
    destinations = [artifact.destination for artifact in artifacts]
    if len(destinations) != len(set(destinations)):
        raise InstallerError("install inventory contains duplicate destinations")
    return sorted(artifacts, key=lambda artifact: artifact.destination)


def _target_root(raw: str) -> Path:
    target = _absolute_lexical(raw)
    if target == Path(target.anchor):
        raise InstallerError("target root cannot be a filesystem root")
    _safe_path(target, allow_missing=True, final_kind="directory")
    return target


def _global_config_root(home: str | os.PathLike | None) -> Path:
    if home is None:
        try:
            home_path = Path.home()
        except (OSError, RuntimeError):
            raise InstallerError("home directory cannot be determined") from None
    else:
        home_path = Path(_absolute_lexical(home))
    return Path(_absolute_lexical(home_path / ".config" / "opencode"))


def _is_global_target(target: Path, home: str | os.PathLike | None) -> bool:
    global_root = _global_config_root(home)
    try:
        target.relative_to(global_root)
        return True
    except ValueError:
        return False


def _target_file(
    target_root: Path,
    relative: str,
    *,
    required: bool = False,
    limit: int = MAX_TOTAL_ARTIFACT_BYTES,
) -> bytes | None:
    path = target_root.joinpath(*_relative_parts(relative))
    if not _safe_path(path, allow_missing=True):
        if required:
            raise InstallerError("managed target file is missing")
        return None
    return _read_regular_file(path, limit=limit)


def _read_existing_manifest(target_root: Path) -> dict | None:
    try:
        raw = _target_file(target_root, MANIFEST_RELATIVE, limit=MAX_MANIFEST_BYTES)
    except InstallerError:
        raise InstallerError("existing install manifest is unsafe or unreadable") from None
    if raw is None:
        return None
    value = _strict_json_bytes(raw)
    try:
        return validate_manifest(value)
    except InstallerError:
        raise InstallerError("existing install manifest is corrupt or unsafe") from None


def _read_existing_intent(target_root: Path) -> bool:
    try:
        return _target_file(target_root, INTENT_RELATIVE, limit=MAX_MANIFEST_BYTES) is not None
    except InstallerError:
        raise InstallerError("existing install intent is unsafe or unreadable") from None


def _planned_records(target_root: Path, artifacts: list[Artifact]) -> list[dict]:
    records = []
    total_prior_bytes = 0
    for artifact in artifacts:
        prior = _target_file(target_root, artifact.destination)
        prior_exists = prior is not None
        if prior_exists:
            total_prior_bytes += len(prior)
            if total_prior_bytes > MAX_TOTAL_BACKUP_BYTES:
                raise InstallerError("pre-existing files exceed the backup size limit")
        prior_hash = hashlib.sha256(prior).hexdigest() if prior_exists else None
        records.append(
            {
                "source": artifact.source,
                "destination": artifact.destination,
                "version": artifact.version,
                "installed_sha256": artifact.sha256,
                "prior_exists": prior_exists,
                "prior_sha256": prior_hash,
                "backup": None,
                "backup_sha256": None,
            }
        )
    return records


def _same_install(manifest: dict, planned: list[dict], target_root: Path) -> bool:
    existing = manifest["records"]
    if len(existing) != len(planned):
        return False
    by_destination = {record["destination"]: record for record in existing}
    if set(by_destination) != {record["destination"] for record in planned}:
        return False
    for item in planned:
        old = by_destination[item["destination"]]
        if any(old[key] != item[key] for key in ("source", "destination", "version", "installed_sha256")):
            return False
        current = _target_file(target_root, old["destination"])
        if current is None or hashlib.sha256(current).hexdigest() != old["installed_sha256"]:
            raise InstallerError("managed artifact differs from its install manifest")
        if old["prior_exists"]:
            backup = _target_file(target_root, old["backup"])
            if backup is None or hashlib.sha256(backup).hexdigest() != old["backup_sha256"]:
                raise InstallerError("verified install backup is missing or corrupt")
    return True


def _check_target_destinations(target_root: Path, records: list[dict], *, replace_existing: bool, applying: bool) -> None:
    for record in records:
        if record["prior_exists"] and applying and not replace_existing:
            raise InstallerError(f"existing destination requires --replace-existing: {record['destination']}")


def _relative_target_path(target_root: Path, relative: str) -> Path:
    path = target_root.joinpath(*_relative_parts(relative))
    _safe_path(path, allow_missing=True)
    return path


def _ensure_directories(path: Path) -> None:
    """Create each missing directory after checking the preceding components."""
    path = Path(path)
    _safe_path(path, allow_missing=True)
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current = current / component
        try:
            current.mkdir()
        except FileExistsError:
            pass
        except OSError:
            raise InstallerError("directory could not be created safely") from None
        _safe_path(current, final_kind="directory")


class _InstallLock:
    """An exclusive installer lock that is never stolen when stale-looking."""

    def __init__(self, target_root: Path):
        self.path = target_root / LOCK_RELATIVE
        self.parent_fd = None
        self.descriptor = None
        self.identity = None
        self.parent_identity = None

    def acquire(self) -> None:
        _ensure_directories(self.path.parent)
        _safe_path(self.path.parent, final_kind="directory")
        try:
            self.parent_fd = os.open(
                self.path.parent,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
            )
            parent_info = os.fstat(self.parent_fd)
            if not stat.S_ISDIR(parent_info.st_mode):
                raise InstallerError("installer lock directory is unsafe")
            self.parent_identity = (parent_info.st_dev, parent_info.st_ino)
            self.descriptor = os.open(
                self.path.name,
                os.O_WRONLY
                | os.O_CREAT
                | os.O_EXCL
                | getattr(os, "O_NOFOLLOW", 0),
                0o600,
                dir_fd=self.parent_fd,
            )
            lock_info = os.fstat(self.descriptor)
            if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_nlink != 1:
                raise InstallerError("installer lock is unsafe")
            self.identity = (lock_info.st_dev, lock_info.st_ino)
            os.fsync(self.descriptor)
            os.fsync(self.parent_fd)
        except FileExistsError:
            self.close()
            raise InstallerError("installer lock already exists; stale locks are never stolen") from None
        except InstallerError:
            self.close()
            raise
        except OSError:
            self.close()
            raise InstallerError("installer lock could not be acquired safely") from None

    def close(self) -> None:
        if self.parent_fd is not None and self.identity is not None:
            try:
                parent = os.fstat(self.parent_fd)
                if (parent.st_dev, parent.st_ino) == self.parent_identity:
                    current = os.stat(self.path.name, dir_fd=self.parent_fd, follow_symlinks=False)
                    if (
                        stat.S_ISREG(current.st_mode)
                        and current.st_nlink == 1
                        and (current.st_dev, current.st_ino) == self.identity
                    ):
                        os.unlink(self.path.name, dir_fd=self.parent_fd)
                        os.fsync(self.parent_fd)
            except OSError:
                pass
        if self.descriptor is not None:
            try:
                os.close(self.descriptor)
            except OSError:
                pass
            self.descriptor = None
        if self.parent_fd is not None:
            try:
                os.close(self.parent_fd)
            except OSError:
                pass
            self.parent_fd = None


def _write_new_file(path: Path, data: bytes) -> None:
    """Create backup bytes exclusively and fsync before the install can proceed."""
    _ensure_directories(path.parent)
    _safe_path(path.parent, final_kind="directory")
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
    except FileExistsError:
        raise InstallerError("backup destination already exists") from None
    except OSError:
        raise InstallerError("backup could not be created safely") from None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise InstallerError("backup file is unsafe")
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise InstallerError("backup could not be written completely")
            view = view[written:]
        os.fsync(descriptor)
    except OSError:
        raise InstallerError("backup could not be written safely") from None
    finally:
        os.close(descriptor)
    check = _read_regular_file(path, limit=MAX_TOTAL_ARTIFACT_BYTES)
    if hashlib.sha256(check).digest() != hashlib.sha256(data).digest():
        raise InstallerError("backup verification failed")


def _atomic_install_file(target_root: Path, record: dict, content: bytes) -> None:
    destination = _relative_target_path(target_root, record["destination"])
    _ensure_directories(destination.parent)
    current = _target_file(target_root, record["destination"])
    if record["prior_exists"]:
        if current is None or hashlib.sha256(current).hexdigest() != record["prior_sha256"]:
            raise InstallerError(f"destination changed after preflight: {record['destination']}")
    elif current is not None:
        raise InstallerError(f"destination appeared after preflight: {record['destination']}")
    try:
        text = content.decode("utf-8", errors="strict")
        atomic_write_text(destination, text)
    except (JournalError, UnicodeError, OSError, ValueError):
        raise InstallerError(f"artifact could not be installed: {record['destination']}") from None
    installed = _target_file(target_root, record["destination"])
    if installed is None or hashlib.sha256(installed).hexdigest() != record["installed_sha256"]:
        raise InstallerError(f"installed artifact failed hash verification: {record['destination']}")


def _write_metadata(path: Path, value: dict, *, must_not_exist: bool) -> None:
    try:
        _credential_scan(value)
        text = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
        encoded = text.encode("utf-8", errors="strict")
    except (ConfigError, TypeError, ValueError, UnicodeError, RecursionError):
        raise InstallerError("install metadata could not be serialized safely") from None
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise InstallerError("install metadata exceeds its size limit")
    _ensure_directories(path.parent)
    _safe_path(path.parent, final_kind="directory")
    if must_not_exist and _safe_path(path, allow_missing=True):
        raise InstallerError("install metadata already exists")
    try:
        atomic_write_text(path, text)
    except (JournalError, OSError, ValueError):
        raise InstallerError("install metadata could not be written atomically") from None


def _apply(target_root: Path, artifacts: list[Artifact], records: list[dict]) -> dict:
    install_id = secrets.token_hex(16)
    for record in records:
        if record["prior_exists"]:
            backup = f"overseer-relay/backups/{install_id}/{record['destination']}"
            record["backup"] = backup
            record["backup_sha256"] = record["prior_sha256"]
    manifest = validate_manifest(
        {
            "schema": MANIFEST_SCHEMA,
            "schema_version": 1,
            "package": PACKAGE_NAME,
            "package_version": artifacts[0].version,
            "install_id": install_id,
            "records": records,
        }
    )
    # Check every backup path before the intent record or any artifact changes.
    for record in manifest["records"]:
        if record["backup"] is not None:
            _relative_target_path(target_root, record["backup"])
    intent = {
        "schema": INTENT_SCHEMA,
        "schema_version": 1,
        "package": PACKAGE_NAME,
        "package_version": artifacts[0].version,
        "install_id": install_id,
        "records": manifest["records"],
    }
    intent_path = _relative_target_path(target_root, INTENT_RELATIVE)
    _write_metadata(intent_path, intent, must_not_exist=True)

    originals = {record["destination"]: _target_file(target_root, record["destination"]) for record in records}
    for record in records:
        if record["prior_exists"]:
            original = originals[record["destination"]]
            if original is None or hashlib.sha256(original).hexdigest() != record["prior_sha256"]:
                raise InstallerError(f"destination changed after preflight: {record['destination']}")
            backup_path = _relative_target_path(target_root, record["backup"])
            _write_new_file(backup_path, original)
            backup = _target_file(target_root, record["backup"])
            if backup is None or hashlib.sha256(backup).hexdigest() != record["backup_sha256"]:
                raise InstallerError("verified backup could not be confirmed")

    by_source = {artifact.source: artifact for artifact in artifacts}
    for record in records:
        artifact = by_source[record["source"]]
        _atomic_install_file(target_root, record, artifact.content)

    manifest_path = _relative_target_path(target_root, MANIFEST_RELATIVE)
    _write_metadata(manifest_path, manifest, must_not_exist=True)
    try:
        _safe_path(intent_path, final_kind="file")
        intent_path.unlink()
    except OSError:
        # Keep the transaction evidence and report the incomplete cleanup.
        raise InstallerError("install completed but its intent record could not be cleared") from None
    return manifest


def _format_preview(artifacts: list[Artifact], records: list[dict]) -> None:
    print(f"preview: {len(artifacts)} files; no writes")
    for artifact, record in zip(artifacts, records):
        suffix = ""
        if record["prior_exists"]:
            suffix = f" prior={record['prior_sha256']} (apply requires --replace-existing)"
        print(f"{artifact.sha256}  {artifact.destination}{suffix}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-root", required=True, help="explicit OpenCode config/install root")
    parser.add_argument("--apply", action="store_true", help="write the reviewed installation")
    parser.add_argument(
        "--authorize-global-install",
        action="store_true",
        help="authorize apply below ~/.config/opencode",
    )
    parser.add_argument(
        "--replace-existing",
        action="store_true",
        help="back up approved pre-existing destination files before replacement",
    )
    return parser


def main(argv: list[str] | None = None, *, home: str | os.PathLike | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        target_root = _target_root(args.target_root)
        global_target = _is_global_target(target_root, home)
        if args.apply and global_target and not args.authorize_global_install:
            raise InstallerError("global install requires --authorize-global-install")
        if args.replace_existing and not args.apply:
            raise InstallerError("--replace-existing requires --apply")

        artifacts = collect_artifacts()
        if len(artifacts) == 0:
            raise InstallerError("install inventory is empty")
        if _read_existing_intent(target_root):
            raise InstallerError("an earlier install transaction is incomplete; preserve its evidence for review")
        existing_manifest = _read_existing_manifest(target_root)
        if (
            existing_manifest is not None
            and existing_manifest["package_version"] == "0.1.0"
            and _package_version(_SOURCE_ROOT) == "0.2.0"
        ):
            raise InstallerError(
                "existing 0.1.0 install must be rolled back with its matching 0.1.0 runtime before a separate 0.2.0 install"
            )
        records = _planned_records(target_root, artifacts)

        if existing_manifest is not None:
            if _same_install(existing_manifest, records, target_root):
                if args.apply:
                    print(f"already installed: {len(artifacts)} files; no writes")
                else:
                    _format_preview(artifacts, records)
                    print("installation already matches its manifest")
                return 0
            raise InstallerError("managed install differs; refusing to overwrite manifest or backup history")

        _check_target_destinations(
            target_root,
            records,
            replace_existing=args.replace_existing,
            applying=args.apply,
        )
        if not args.apply:
            _format_preview(artifacts, records)
            return 0

        _ensure_directories(target_root)
        lock = _InstallLock(target_root)
        lock.acquire()
        try:
            # Recompute under the exclusive lock so concurrent prior changes are
            # never backed up or replaced based only on a stale preview.
            if _read_existing_intent(target_root):
                raise InstallerError("an earlier install transaction is incomplete; preserve its evidence for review")
            if _read_existing_manifest(target_root) is not None:
                raise InstallerError("install manifest appeared after preflight")
            locked_records = _planned_records(target_root, artifacts)
            if locked_records != records:
                raise InstallerError("target changed after preflight; no artifacts were replaced")
            manifest = _apply(target_root, artifacts, locked_records)
        finally:
            lock.close()
        print(f"installed: {len(manifest['records'])} files; manifest {MANIFEST_RELATIVE}")
        for record in manifest["records"]:
            print(f"{record['installed_sha256']}  {record['destination']}")
        return 0
    except (InstallerError, PathError) as error:
        print(f"install: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
