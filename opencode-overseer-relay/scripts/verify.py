#!/usr/bin/env python3
"""Read-only verification of a manifest-managed Overseer relay installation."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


# Verification must not create runtime bytecode while loading the installed
# helper. Any pre-existing __pycache__ entry is consequently reported as an
# unexpected managed file rather than silently ignored.
sys.dont_write_bytecode = True

_INSTALLER = None
_HELPER_MODULE = "_overseer_relay_install_helpers_verify"
_MANAGED_ROOTS = (
    "overseer-relay/runtime",
    "skills/overseer-setup",
    "skills/overseer-coordinate",
)
_MAX_SCAN_ENTRIES = 16_384
_MAX_SCAN_DEPTH = 32


def _load_installer():
    global _INSTALLER
    if _INSTALLER is not None:
        return _INSTALLER
    helper_path = Path(os.path.abspath(os.fspath(Path(__file__).parent / "install.py")))
    spec = importlib.util.spec_from_file_location(_HELPER_MODULE, helper_path)
    if spec is None or spec.loader is None:
        raise ImportError
    module = importlib.util.module_from_spec(spec)
    sys.modules[_HELPER_MODULE] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(_HELPER_MODULE, None)
        raise
    _INSTALLER = module
    return module


def _display_path(relative: str) -> str:
    """Quote a relative path so untrusted filename characters cannot spoof output."""
    return json.dumps(relative, ensure_ascii=True)


def _managed_tree_issues(installer, target_root: Path, expected_files: set[str]):
    """Find unmanifested or unsafe entries without following links."""
    issues = set()
    expected_directories = set()
    for relative in expected_files:
        parts = relative.split("/")
        for end in range(1, len(parts)):
            expected_directories.add("/".join(parts[:end]))

    visited = 0
    for relative_root in _MANAGED_ROOTS:
        root = target_root.joinpath(*relative_root.split("/"))
        try:
            if not installer._safe_path(root, allow_missing=True):
                continue
            info = root.lstat()
        except (installer.InstallerError, OSError):
            issues.add(("unsafe", relative_root))
            continue
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            issues.add(("unsafe", relative_root))
            continue

        stack = [(root, relative_root, len(relative_root.split("/")))]
        while stack:
            directory, directory_relative, depth = stack.pop()
            if depth > _MAX_SCAN_DEPTH:
                issues.add(("unsafe", directory_relative))
                continue
            try:
                installer._safe_path(directory, final_kind="directory")
            except installer.InstallerError:
                issues.add(("unsafe", directory_relative))
                continue
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        visited += 1
                        if visited > _MAX_SCAN_ENTRIES:
                            raise installer.InstallerError("managed directory scan limit exceeded")
                        child_relative = f"{directory_relative}/{entry.name}"
                        child = Path(entry.path)
                        try:
                            info = child.lstat()
                        except OSError:
                            issues.add(("unsafe", child_relative))
                            continue
                        if stat.S_ISLNK(info.st_mode):
                            issues.add(("unsafe", child_relative))
                        elif stat.S_ISDIR(info.st_mode):
                            if child_relative not in expected_directories:
                                issues.add(("unexpected directory", child_relative))
                            stack.append((child, child_relative, depth + 1))
                        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                            if child_relative not in expected_files:
                                issues.add(("unexpected", child_relative))
                        else:
                            issues.add(("unsafe", child_relative))
            except OSError:
                issues.add(("unsafe", directory_relative))
    return sorted(issues)


def _check_installation(installer, target_root: Path):
    """Return a normalized manifest and content-free verification findings."""
    if not installer._safe_path(target_root, final_kind="directory"):
        raise installer.InstallerError("target root is unavailable")
    manifest = installer._read_existing_manifest(target_root)
    if manifest is None:
        raise installer.InstallerError("install manifest is missing")

    issues = set()
    expected_files = {record["destination"] for record in manifest["records"]}
    total_artifact_bytes = 0
    total_backup_bytes = 0
    for record in manifest["records"]:
        relative = record["destination"]
        try:
            content = installer._target_file(target_root, relative)
        except installer.InstallerError:
            issues.add(("unsafe", relative))
        else:
            if content is None:
                issues.add(("missing", relative))
            else:
                total_artifact_bytes += len(content)
                if total_artifact_bytes > installer.MAX_TOTAL_ARTIFACT_BYTES:
                    issues.add(("unsafe", relative))
                elif hashlib.sha256(content).hexdigest() != record["installed_sha256"]:
                    issues.add(("changed", relative))

        if record["prior_exists"]:
            backup = record["backup"]
            try:
                previous = installer._target_file(
                    target_root,
                    backup,
                    limit=installer.MAX_TOTAL_BACKUP_BYTES,
                )
            except installer.InstallerError:
                issues.add(("unsafe backup", backup))
                continue
            if previous is None:
                issues.add(("missing backup", backup))
                continue
            total_backup_bytes += len(previous)
            if total_backup_bytes > installer.MAX_TOTAL_BACKUP_BYTES:
                issues.add(("unsafe backup", backup))
                continue
            if hashlib.sha256(previous).hexdigest() != record["backup_sha256"]:
                issues.add(("changed backup", backup))

    try:
        if installer._read_existing_intent(target_root):
            issues.add(("incomplete", installer.INTENT_RELATIVE))
    except installer.InstallerError:
        issues.add(("unsafe", installer.INTENT_RELATIVE))

    issues.update(_managed_tree_issues(installer, target_root, expected_files))
    return manifest, sorted(issues)


def _parser():
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-root", required=True, help="explicit OpenCode config/install root")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        installer = _load_installer()
    except (ImportError, OSError, TypeError, ValueError):
        print("verify: installer helpers could not be loaded", file=sys.stderr)
        return 2

    args = _parser().parse_args(argv)
    try:
        target_root = installer._target_root(args.target_root)
        manifest, issues = _check_installation(installer, target_root)
        if issues:
            for kind, relative in issues:
                print(f"{kind}: {_display_path(relative)}")
            print(f"verification failed: {len(issues)} issue(s)")
            return 2
        print(
            f"verified: {len(manifest['records'])} files; "
            f"package version {manifest['package_version']}; no writes"
        )
        return 0
    except (installer.InstallerError, installer.PathError) as error:
        print(f"verify: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
