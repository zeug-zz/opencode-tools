#!/usr/bin/env python3
"""Preview or safely roll back a manifest-managed Overseer relay installation."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import stat
import sys


sys.dont_write_bytecode = True

_INSTALLER = None
_HELPER_MODULE = "_overseer_relay_install_helpers_rollback"
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


def _load_manifest(installer, target_root: Path):
    """Read and validate all manifest fields before using any record path."""
    if not installer._safe_path(target_root, final_kind="directory"):
        raise installer.InstallerError("target root is unavailable")
    manifest_path = target_root.joinpath(*installer._relative_parts(installer.MANIFEST_RELATIVE))
    try:
        if not installer._safe_path(manifest_path, allow_missing=True):
            raise installer.InstallerError("install manifest is missing")
        before = manifest_path.lstat()
    except installer.InstallerError:
        raise
    except FileNotFoundError:
        raise installer.InstallerError("install manifest is missing")
    except OSError:
        raise installer.InstallerError("install manifest is unsafe or unreadable") from None
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise installer.InstallerError("install manifest is unsafe")
    try:
        raw = installer._target_file(
            target_root,
            installer.MANIFEST_RELATIVE,
            required=True,
            limit=installer.MAX_MANIFEST_BYTES,
        )
        installer._safe_path(manifest_path, final_kind="file")
        after = manifest_path.lstat()
    except installer.InstallerError:
        raise installer.InstallerError("existing install manifest is corrupt or unsafe") from None
    except OSError:
        raise installer.InstallerError("install manifest changed while it was read") from None
    if (
        not stat.S_ISREG(after.st_mode)
        or after.st_nlink != 1
        or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)
    ):
        raise installer.InstallerError("install manifest changed while it was read")
    try:
        manifest = installer.validate_manifest(installer._strict_json_bytes(raw))
    except installer.InstallerError:
        raise installer.InstallerError("existing install manifest is corrupt or unsafe") from None
    return manifest, raw, (after.st_dev, after.st_ino)


def _preflight(installer, target_root: Path, manifest: dict):
    """Validate every target, backup, and receipt path before changing anything."""
    issues = _managed_tree_issues(
        installer,
        target_root,
        {record["destination"] for record in manifest["records"]},
    )
    if issues:
        details = ", ".join(f"{kind} {_display_path(relative)}" for kind, relative in issues)
        raise installer.InstallerError(f"unmanaged or unsafe files prevent rollback: {details}")

    receipt = f"overseer-relay/rollback-receipts/{manifest['install_id']}.json"
    receipt_path = installer._relative_target_path(target_root, receipt)
    if installer._safe_path(receipt_path, allow_missing=True):
        raise installer.InstallerError("rollback receipt already exists; refusing to reuse install history")

    actions = []
    total_artifact_bytes = 0
    total_backup_bytes = 0
    for record in manifest["records"]:
        destination = record["destination"]
        try:
            current = installer._target_file(target_root, destination, required=True)
        except installer.InstallerError:
            raise installer.InstallerError(
                f"rollback preflight found an unsafe or missing destination {_display_path(destination)}"
            ) from None
        if current is None:
            raise installer.InstallerError(
                f"rollback preflight found a missing destination {_display_path(destination)}"
            )
        total_artifact_bytes += len(current)
        if total_artifact_bytes > installer.MAX_TOTAL_ARTIFACT_BYTES:
            raise installer.InstallerError("installed artifact set exceeds its size limit")
        if hashlib.sha256(current).hexdigest() != record["installed_sha256"]:
            raise installer.InstallerError(
                f"rollback preflight found an intervening edit at {_display_path(destination)}"
            )
        destination_path = installer._relative_target_path(target_root, destination)
        info = destination_path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise installer.InstallerError(
                f"rollback preflight found an unsafe destination {_display_path(destination)}"
            )

        prior = None
        if record["prior_exists"]:
            backup_path = record["backup"]
            try:
                prior = installer._target_file(
                    target_root,
                    backup_path,
                    required=True,
                    limit=installer.MAX_TOTAL_BACKUP_BYTES,
                )
            except installer.InstallerError:
                raise installer.InstallerError(
                    f"rollback preflight found an unsafe or missing backup {_display_path(backup_path)}"
                ) from None
            if prior is None:
                raise installer.InstallerError(
                    f"rollback preflight found a missing backup {_display_path(backup_path)}"
                )
            total_backup_bytes += len(prior)
            if total_backup_bytes > installer.MAX_TOTAL_BACKUP_BYTES:
                raise installer.InstallerError("backup set exceeds its size limit")
            if hashlib.sha256(prior).hexdigest() != record["backup_sha256"]:
                raise installer.InstallerError(
                    f"rollback preflight found a corrupt backup {_display_path(backup_path)}"
                )
        actions.append(
            {
                "record": record,
                "prior": prior,
                "destination_identity": (info.st_dev, info.st_ino),
            }
        )
    return actions, receipt


def _open_parent(installer, target_root: Path, relative: str):
    destination = installer._relative_target_path(target_root, relative)
    installer._safe_path(destination.parent, final_kind="directory")
    descriptor = None
    try:
        descriptor = os.open(
            destination.parent,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
        )
        info = os.fstat(descriptor)
        current = destination.parent.lstat()
        identity = (info.st_dev, info.st_ino)
        if (
            not stat.S_ISDIR(info.st_mode)
            or (current.st_dev, current.st_ino) != identity
            or stat.S_ISLNK(current.st_mode)
        ):
            raise installer.InstallerError("rollback destination parent changed")
        return destination, descriptor, identity
    except installer.InstallerError:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise
    except OSError:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise installer.InstallerError("rollback destination parent is unsafe") from None


def _current_matches(installer, target_root: Path, record: dict, identity: tuple[int, int]) -> bool:
    current = installer._target_file(target_root, record["destination"], required=True)
    path = installer._relative_target_path(target_root, record["destination"])
    info = path.lstat()
    return (
        current is not None
        and hashlib.sha256(current).hexdigest() == record["installed_sha256"]
        and stat.S_ISREG(info.st_mode)
        and info.st_nlink == 1
        and (info.st_dev, info.st_ino) == identity
    )


def _restore_file(installer, target_root: Path, action: dict) -> None:
    record = action["record"]
    relative = record["destination"]
    destination, parent_fd, parent_identity = _open_parent(installer, target_root, relative)
    temporary_name = f".{destination.name}.{secrets.token_hex(8)}.rollback"
    temporary_created = False
    try:
        if not _current_matches(installer, target_root, record, action["destination_identity"]):
            raise installer.InstallerError(
                f"rollback destination changed after preflight: {_display_path(relative)}"
            )
        descriptor = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=parent_fd,
        )
        temporary_created = True
        with os.fdopen(descriptor, "wb") as stream:
            view = memoryview(action["prior"])
            while view:
                written = stream.write(view)
                if written is None or written <= 0:
                    raise installer.InstallerError("backup could not be restored completely")
                view = view[written:]
            stream.flush()
            os.fsync(stream.fileno())

        parent = destination.parent.lstat()
        opened_parent = os.fstat(parent_fd)
        if (
            not stat.S_ISDIR(parent.st_mode)
            or (parent.st_dev, parent.st_ino) != parent_identity
            or (opened_parent.st_dev, opened_parent.st_ino) != parent_identity
            or not _current_matches(installer, target_root, record, action["destination_identity"])
        ):
            raise installer.InstallerError(
                f"rollback destination changed after preflight: {_display_path(relative)}"
            )
        os.replace(temporary_name, destination.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        temporary_created = False
        os.fsync(parent_fd)
    except installer.InstallerError:
        raise
    except OSError:
        raise installer.InstallerError(f"prior artifact could not be restored: {_display_path(relative)}") from None
    finally:
        if temporary_created:
            try:
                os.unlink(temporary_name, dir_fd=parent_fd)
            except OSError:
                pass
        os.close(parent_fd)


def _remove_file(installer, target_root: Path, action: dict) -> None:
    record = action["record"]
    relative = record["destination"]
    destination, parent_fd, parent_identity = _open_parent(installer, target_root, relative)
    try:
        if not _current_matches(installer, target_root, record, action["destination_identity"]):
            raise installer.InstallerError(
                f"rollback destination changed after preflight: {_display_path(relative)}"
            )
        parent = destination.parent.lstat()
        opened_parent = os.fstat(parent_fd)
        current = os.stat(destination.name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISDIR(parent.st_mode)
            or (parent.st_dev, parent.st_ino) != parent_identity
            or (opened_parent.st_dev, opened_parent.st_ino) != parent_identity
            or not stat.S_ISREG(current.st_mode)
            or current.st_nlink != 1
            or (current.st_dev, current.st_ino) != action["destination_identity"]
            or not _current_matches(installer, target_root, record, action["destination_identity"])
        ):
            raise installer.InstallerError(
                f"rollback destination changed after preflight: {_display_path(relative)}"
            )
        os.unlink(destination.name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    except installer.InstallerError:
        raise
    except OSError:
        raise installer.InstallerError(f"installed artifact could not be removed: {_display_path(relative)}") from None
    finally:
        os.close(parent_fd)


def _remove_manifest(installer, target_root: Path, raw: bytes, identity: tuple[int, int]) -> None:
    relative = installer.MANIFEST_RELATIVE
    destination, parent_fd, parent_identity = _open_parent(installer, target_root, relative)
    try:
        current = installer._target_file(
            target_root,
            relative,
            required=True,
            limit=installer.MAX_MANIFEST_BYTES,
        )
        parent = destination.parent.lstat()
        opened_parent = os.fstat(parent_fd)
        info = os.stat(destination.name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            current != raw
            or not stat.S_ISDIR(parent.st_mode)
            or (parent.st_dev, parent.st_ino) != parent_identity
            or (opened_parent.st_dev, opened_parent.st_ino) != parent_identity
            or not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or (info.st_dev, info.st_ino) != identity
        ):
            raise installer.InstallerError("install manifest changed during rollback")
        os.unlink(destination.name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    except installer.InstallerError:
        raise
    except OSError:
        raise installer.InstallerError("active install manifest could not be removed") from None
    finally:
        os.close(parent_fd)


def _receipt(manifest: dict, actions: list[dict]) -> dict:
    records = []
    for action in actions:
        record = action["record"]
        records.append(
            {
                "source": record["source"],
                "destination": record["destination"],
                "version": record["version"],
                "installed_sha256": record["installed_sha256"],
                "action": "restored" if record["prior_exists"] else "removed",
                "prior_sha256": record["prior_sha256"],
            }
        )
    return {
        "schema": "overseer-relay.rollback-receipt.v1",
        "schema_version": 1,
        "package": manifest["package"],
        "package_version": manifest["package_version"],
        "install_id": manifest["install_id"],
        "records": records,
    }


def _parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-root", required=True, help="explicit OpenCode config/install root")
    parser.add_argument("--apply", action="store_true", help="apply the reviewed rollback")
    parser.add_argument(
        "--authorize-global-install",
        action="store_true",
        help="authorize rollback below ~/.config/opencode",
    )
    return parser


def main(argv: list[str] | None = None, *, home: str | os.PathLike | None = None) -> int:
    try:
        installer = _load_installer()
    except (ImportError, OSError, TypeError, ValueError):
        print("rollback: installer helpers could not be loaded", file=sys.stderr)
        return 2

    args = _parser().parse_args(argv)
    lock = None
    try:
        target_root = installer._target_root(args.target_root)
        if args.apply and installer._is_global_target(target_root, home) and not args.authorize_global_install:
            raise installer.InstallerError("global rollback requires --authorize-global-install")

        manifest, raw_manifest, manifest_identity = _load_manifest(installer, target_root)
        if installer._read_existing_intent(target_root):
            raise installer.InstallerError("an earlier install transaction is incomplete; preserve its evidence for review")
        actions, receipt_path = _preflight(installer, target_root, manifest)
        if not args.apply:
            print(f"preview: rollback {len(actions)} files; no writes")
            for action in actions:
                record = action["record"]
                outcome = "restore prior file" if record["prior_exists"] else "remove installed file"
                print(f"{outcome}: {_display_path(record['destination'])}")
            return 0

        lock = installer._InstallLock(target_root)
        lock.acquire()
        try:
            locked_manifest, locked_raw, locked_identity = _load_manifest(installer, target_root)
            if (
                locked_raw != raw_manifest
                or locked_identity != manifest_identity
                or locked_manifest["install_id"] != manifest["install_id"]
            ):
                raise installer.InstallerError("install manifest changed after rollback preflight")
            if installer._read_existing_intent(target_root):
                raise installer.InstallerError("an earlier install transaction is incomplete; preserve its evidence for review")
            actions, receipt_path = _preflight(installer, target_root, locked_manifest)

            for action in actions:
                if action["record"]["prior_exists"]:
                    _restore_file(installer, target_root, action)
                else:
                    _remove_file(installer, target_root, action)

            installer._write_metadata(
                installer._relative_target_path(target_root, receipt_path),
                _receipt(locked_manifest, actions),
                must_not_exist=True,
            )
            _remove_manifest(installer, target_root, locked_raw, locked_identity)
        finally:
            lock.close()

        print(f"rolled back: {len(actions)} files; receipt {_display_path(receipt_path)}")
        print("active install manifest removed; backups retained")
        return 0
    except (installer.InstallerError, installer.PathError) as error:
        print(f"rollback: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
