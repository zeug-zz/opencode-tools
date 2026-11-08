"""Campaign path resolution and confinement."""

from __future__ import annotations

import os
from pathlib import Path, PureWindowsPath
import re
import stat
import subprocess
from typing import TypeAlias


GIT_TIMEOUT_SECONDS = 5
MAX_CAMPAIGN_ID_LENGTH = 64
FileIdentity: TypeAlias = tuple[int, int]

_CAMPAIGN_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z", re.ASCII)


class PathError(ValueError):
    """A path, Git repository, or filesystem identity failed validation."""


def resolve_common_dir(start: Path, runner=None) -> Path:
    """Return the canonical Git common directory containing ``start``.

    ``runner`` is an optional command fake accepting ``(argv, timeout=...)``.
    The normal subprocess path always uses ``cwd=start`` and a fixed timeout.
    """
    argv = ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]
    try:
        if runner is None:
            result = subprocess.run(
                argv,
                cwd=Path(start),
                capture_output=True,
                text=True,
                timeout=GIT_TIMEOUT_SECONDS,
                check=False,
            )
        else:
            result = runner(argv, timeout=GIT_TIMEOUT_SECONDS)
    except (OSError, ValueError, subprocess.SubprocessError, UnicodeError):
        raise PathError("Git common directory could not be resolved") from None

    if getattr(result, "returncode", None) != 0:
        raise PathError("Git common directory could not be resolved")
    output = getattr(result, "stdout", None)
    if not isinstance(output, str):
        raise PathError("Git common directory could not be resolved")
    # Git emits one trailing line feed. Preserve legal leading/trailing spaces
    # in the directory name rather than stripping them.
    value = output[:-1] if output.endswith("\n") else output
    if not value or "\n" in value or "\r" in value or "\x00" in value:
        raise PathError("Git common directory could not be resolved")

    git_common_dir = Path(value)
    if not git_common_dir.is_absolute():
        raise PathError("Git did not return an absolute common directory")
    try:
        canonical = Path(os.path.realpath(git_common_dir))
        if not canonical.is_dir():
            raise PathError("Git common directory is not an available directory")
    except (OSError, ValueError):
        raise PathError("Git common directory could not be resolved") from None
    return canonical


def validate_campaign_id(campaign_id: str) -> str:
    """Validate and return a conservative lowercase campaign identifier."""
    if (
        not isinstance(campaign_id, str)
        or not campaign_id
        or len(campaign_id) > MAX_CAMPAIGN_ID_LENGTH
        or _CAMPAIGN_ID.fullmatch(campaign_id) is None
    ):
        raise PathError("invalid campaign ID")
    return campaign_id


def campaign_dir(common_dir: Path, campaign_id: str) -> Path:
    """Build the campaign directory beneath a previously resolved Git root."""
    return Path(common_dir) / "overseer-relay" / "campaigns" / validate_campaign_id(campaign_id)


def _relative_components(relative_path: str) -> tuple[str, ...]:
    if not isinstance(relative_path, str) or not relative_path or "\x00" in relative_path:
        raise PathError("path must be a non-empty relative path")
    windows_path = PureWindowsPath(relative_path)
    if (
        Path(relative_path).is_absolute()
        or windows_path.is_absolute()
        or windows_path.drive
        or "\\" in relative_path
    ):
        raise PathError("path must be relative")
    components = tuple(relative_path.split("/"))
    if any(component in ("", ".", "..") for component in components):
        raise PathError("path contains an invalid component")
    return components


def confine_relative(root: Path, relative_path: str) -> Path:
    """Return ``root/relative_path`` after lexical traversal validation.

    This function intentionally does not resolve or inspect symlinks; callers
    use :func:`check_no_symlinks` before accessing the returned path.
    """
    components = _relative_components(relative_path)
    return Path(root).joinpath(*components)


def _absolute_lexical(path: Path) -> Path:
    """Make a path absolute and normalized without resolving symlinks."""
    try:
        raw_path = os.fspath(path)
    except (OSError, TypeError, ValueError):
        raise PathError("path could not be inspected") from None
    if not isinstance(raw_path, str) or "\x00" in raw_path:
        raise PathError("path could not be inspected")
    try:
        return Path(os.path.abspath(raw_path))
    except (OSError, TypeError, ValueError):
        raise PathError("path could not be inspected") from None


def check_no_symlinks(root: Path, target: Path, *, allow_missing: bool = False) -> None:
    """Reject symlinks from an existing directory root through ``target``.

    ``target`` may be absolute beneath ``root`` or relative to it. Missing
    descendants are accepted only when ``allow_missing`` is true; the root
    itself must always exist and be a real directory.
    """
    root_path = _absolute_lexical(Path(root))
    try:
        raw_target = os.fspath(target)
    except TypeError:
        raise PathError("target path could not be inspected") from None
    if not isinstance(raw_target, str) or "\x00" in raw_target:
        raise PathError("target path could not be inspected")

    target_path = Path(raw_target)
    if target_path.is_absolute():
        if any(part in (".", "..") for part in target_path.parts):
            raise PathError("target path contains an invalid component")
        target_path = _absolute_lexical(target_path)
    elif raw_target in ("", "."):
        target_path = root_path
    else:
        components = _relative_components(raw_target)
        target_path = root_path.joinpath(*components)

    try:
        relative = target_path.relative_to(root_path)
    except ValueError:
        raise PathError("target path is outside the approved root") from None

    try:
        root_stat = root_path.lstat()
    except (OSError, ValueError):
        raise PathError("approved root cannot be inspected") from None
    if stat.S_ISLNK(root_stat.st_mode):
        raise PathError("approved root must not be a symlink")
    if not stat.S_ISDIR(root_stat.st_mode):
        raise PathError("approved root must be a directory")

    current = root_path
    components = relative.parts
    for index, component in enumerate(components):
        current = current / component
        try:
            component_stat = current.lstat()
        except FileNotFoundError:
            if allow_missing:
                return
            raise PathError("target path component is missing") from None
        except OSError:
            raise PathError("target path component cannot be inspected") from None
        if stat.S_ISLNK(component_stat.st_mode):
            raise PathError("target path contains a symlink")
        if index < len(components) - 1 and not stat.S_ISDIR(component_stat.st_mode):
            raise PathError("target path parent is not a directory")


def file_identity(path: Path) -> FileIdentity:
    """Return a non-symlink filesystem object's ``(st_dev, st_ino)`` identity."""
    try:
        path_stat = Path(path).lstat()
    except (OSError, TypeError, ValueError):
        raise PathError("path identity cannot be read") from None
    if stat.S_ISLNK(path_stat.st_mode):
        raise PathError("path identity refuses symlinks")
    return path_stat.st_dev, path_stat.st_ino


def assert_same_identity(path: Path, identity: FileIdentity) -> None:
    """Raise when ``path`` is missing, symlinked, or no longer the same object."""
    if (
        not isinstance(identity, tuple)
        or len(identity) != 2
        or any(not isinstance(value, int) for value in identity)
    ):
        raise PathError("invalid filesystem identity")
    if file_identity(path) != identity:
        raise PathError("filesystem identity changed")
