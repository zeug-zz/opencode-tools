"""Crash-safe, single-writer campaign journal.

``Journal(common_dir, campaign_id)`` validates the canonical campaign layout
and pins its filesystem identity. ``with journal.lock():`` establishes the
exclusive campaign lock; mutations acquire it automatically when needed.
``load``/``save`` manage watcher state, ``commit_batch`` writes an immutable
snapshot before moving cursors, and ``recover_batches`` replays a durable
snapshot whose cursor commit was interrupted. Delivery and hold transitions
are explicit and never turn a released uncertain send into a resend.
"""

from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import threading
import time

from overseer_relay.config import ConfigError, _scan_credentials, parse_config
from overseer_relay.paths import (
    PathError,
    campaign_dir,
    check_no_symlinks,
    confine_relative,
    file_identity,
    validate_campaign_id,
)
from overseer_relay.mailbox import parse as parse_mailbox


MAX_STATE_BYTES = 1024 * 1024
MAX_CONFIG_BYTES = 1024 * 1024
MAX_SNAPSHOT_BYTES = 512 * 1024
MAX_RECEIPT_BYTES = 16 * 1024
MAX_OBSERVATION_BYTES = 4096
MAX_CONTENT_BYTES = 512 * 1024
MAX_RESUME_LEDGER_RECORDS = 1024
MAX_RESUME_LEDGER_BYTES = 256 * 1024
MAX_BATCH_ID_LENGTH = 66
MAX_CURSOR = (1 << 63) - 1
SOURCE_ROLES = ("A", "B")
DELIVERY_STATES = frozenset(
    {"snapshotted", "send-intent", "admitted", "acknowledged", "held", "uncertain", "failed"}
)

_SHA256 = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_BATCH_ID = re.compile(r"b-[0-9a-f]{64}\Z", re.ASCII)
_TEMP_SNAPSHOT = re.compile(r"\.snapshot\.json\.[0-9a-f]{16}\.tmp\Z", re.ASCII)
_RESUME_RULING_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z", re.ASCII)
_RESUME_SESSION_ID = re.compile(r"ses_[A-Za-z0-9]{1,124}\Z", re.ASCII)
_RESUME_REQUEST_ID = re.compile(r"[0-9a-f]{32}\Z", re.ASCII)
_RESUME_OUTCOMES = frozenset(
    {"attempt_started", "delivered", "failed_not_started", "failed", "uncertain"}
)
_HOLD_SECRET_ASSIGNMENT = re.compile(
    r"\b(?:token|secret|password|api[_ -]?key|authorization|cookie|credential)\b\s*[:=]\s*\S+",
    re.IGNORECASE | re.ASCII,
)


class JournalError(ValueError):
    """A safe, content-free journal diagnostic."""


class _DuplicateKey(ValueError):
    pass


def _pairs_no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey
        result[key] = value
    return result


def _reject_nonfinite(_value):
    raise ValueError("non-finite JSON number")


def _normalize_resume_record(value) -> dict:
    required = {
        "ruling_id", "role", "session_id", "timestamp", "outcome_code",
        "request_id", "attempt",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise JournalError("resume ledger is corrupt")
    if (
        not isinstance(value["ruling_id"], str)
        or _RESUME_RULING_ID.fullmatch(value["ruling_id"]) is None
        or not isinstance(value["role"], str)
        or value["role"] not in SOURCE_ROLES
        or not isinstance(value["session_id"], str)
        or _RESUME_SESSION_ID.fullmatch(value["session_id"]) is None
        or type(value["timestamp"]) is not int
        or not 0 <= value["timestamp"] <= (1 << 63) - 1
        or not isinstance(value["outcome_code"], str)
        or value["outcome_code"] not in _RESUME_OUTCOMES
        or not isinstance(value["request_id"], str)
        or _RESUME_REQUEST_ID.fullmatch(value["request_id"]) is None
        or type(value["attempt"]) is not int
        or value["attempt"] not in (1, 2)
    ):
        raise JournalError("resume ledger is corrupt")
    try:
        _scan_credentials(value)
    except ConfigError:
        raise JournalError("resume ledger contains disallowed data") from None
    return {
        "ruling_id": value["ruling_id"],
        "role": value["role"],
        "session_id": value["session_id"],
        "timestamp": value["timestamp"],
        "outcome_code": value["outcome_code"],
        "request_id": value["request_id"],
        "attempt": value["attempt"],
    }


def _validate_resume_history(records: list[dict]) -> None:
    """Validate the append-only attempt state machine for every request ID."""
    states = {}
    terminal = {"delivered", "failed_not_started", "failed", "uncertain"}
    for record in records:
        request_id = record["request_id"]
        identity = (record["ruling_id"], record["role"], record["session_id"])
        state = states.get(request_id)
        if state is None:
            if record["attempt"] != 1 or record["outcome_code"] != "attempt_started":
                raise JournalError("resume ledger is corrupt")
            states[request_id] = {
                "identity": identity,
                "attempt": 1,
                "outcome": "attempt_started",
            }
            continue

        if state["identity"] != identity or state["outcome"] != "attempt_started":
            raise JournalError("resume ledger is corrupt")
        outcome = record["outcome_code"]
        if state["attempt"] == 1:
            if record["attempt"] == 1 and outcome in terminal:
                state["outcome"] = outcome
            elif record["attempt"] == 2 and outcome == "attempt_started":
                state["attempt"] = 2
                state["outcome"] = "attempt_started"
            else:
                raise JournalError("resume ledger is corrupt")
        elif (
            state["attempt"] == 2
            and record["attempt"] == 2
            and outcome in ("delivered", "uncertain")
        ):
            state["outcome"] = outcome
        else:
            raise JournalError("resume ledger is corrupt")


def _decode_resume_ledger(raw: bytes) -> list[dict]:
    if len(raw) > MAX_RESUME_LEDGER_BYTES:
        raise JournalError("resume ledger exceeds its safety limit")
    if not raw:
        return []
    if not raw.endswith(b"\n"):
        raise JournalError("resume ledger is corrupt")
    lines = raw[:-1].split(b"\n")
    if len(lines) > MAX_RESUME_LEDGER_RECORDS:
        raise JournalError("resume ledger exceeds its safety limit")
    records = []
    for line in lines:
        if not line:
            raise JournalError("resume ledger is corrupt")
        records.append(
            _normalize_resume_record(
                _decode_json(line, message="resume ledger is corrupt")
            )
        )
    _validate_resume_history(records)
    return records


def _json_bytes(value, *, limit: int, message: str) -> bytes:
    try:
        _scan_credentials(value)
        text = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            indent=2,
            separators=(",", ": "),
        ) + "\n"
        encoded = text.encode("utf-8", errors="strict")
    except (ConfigError, TypeError, ValueError, UnicodeError, RecursionError):
        raise JournalError(message) from None
    if len(encoded) > limit:
        raise JournalError(message)
    return encoded


def _decode_json(raw: bytes, *, message: str):
    try:
        return json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_pairs_no_duplicates,
            parse_constant=_reject_nonfinite,
        )
    except (UnicodeError, json.JSONDecodeError, _DuplicateKey, ValueError, RecursionError):
        raise JournalError(message) from None


def _safe_absolute(path: Path) -> Path:
    try:
        raw = os.fspath(path)
        if not isinstance(raw, str) or "\x00" in raw:
            raise JournalError("file path is invalid")
        return Path(os.path.abspath(raw))
    except (OSError, TypeError, ValueError):
        raise JournalError("file path is invalid") from None


def _open_directory(path: Path) -> tuple[int, tuple[int, int]]:
    """Open a checked directory without following its final component."""
    absolute = _safe_absolute(Path(path))
    try:
        check_no_symlinks(Path(absolute.anchor), absolute)
        before = absolute.lstat()
        if not stat.S_ISDIR(before.st_mode):
            raise JournalError("directory is not a regular directory")
        descriptor = os.open(
            absolute,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
        )
        after = os.fstat(descriptor)
        identity = (before.st_dev, before.st_ino)
        if not stat.S_ISDIR(after.st_mode) or (after.st_dev, after.st_ino) != identity:
            os.close(descriptor)
            raise JournalError("directory identity changed")
        return descriptor, identity
    except JournalError:
        raise
    except (OSError, PathError, TypeError, ValueError):
        raise JournalError("directory could not be opened safely") from None


def atomic_write_text(path: str | os.PathLike, text: str) -> None:
    """Atomically replace UTF-8 text using a same-directory temp file.

    Existing callers retain the original signature. Parent components and the
    target are checked without following symlinks; file and parent directory
    metadata are fsynced around the atomic replace.
    """
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    try:
        destination = _safe_absolute(Path(path))
        if destination.name in ("", ".", ".."):
            raise JournalError("file path is invalid")
        check_no_symlinks(Path(destination.anchor), destination.parent)
        parent_fd, parent_identity = _open_directory(destination.parent)
    except JournalError:
        raise
    except (OSError, PathError, TypeError, ValueError):
        raise JournalError("file path could not be opened safely") from None

    temporary_name = f".{destination.name}.{secrets.token_hex(8)}.tmp"
    temporary_created = False
    try:
        try:
            existing = os.stat(destination.name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing is not None and not stat.S_ISREG(existing.st_mode):
            raise JournalError("target must be a regular file")

        descriptor = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=parent_fd,
        )
        temporary_created = True
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())

        current_parent = destination.parent.lstat()
        if (
            not stat.S_ISDIR(current_parent.st_mode)
            or (current_parent.st_dev, current_parent.st_ino) != parent_identity
            or (os.fstat(parent_fd).st_dev, os.fstat(parent_fd).st_ino) != parent_identity
        ):
            raise JournalError("parent directory identity changed")
        check_no_symlinks(Path(destination.anchor), destination.parent)
        try:
            existing = os.stat(destination.name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing is not None and not stat.S_ISREG(existing.st_mode):
            raise JournalError("target must be a regular file")
        # rename replaces a symlink entry rather than following it. The check
        # above rejects a pre-existing link; the dirfd keeps the parent fixed.
        os.replace(
            temporary_name,
            destination.name,
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
        )
        temporary_created = False
        os.fsync(parent_fd)
    except JournalError:
        raise
    except (OSError, UnicodeError, ValueError):
        raise JournalError("file could not be written atomically") from None
    finally:
        if temporary_created:
            try:
                os.unlink(temporary_name, dir_fd=parent_fd)
            except OSError:
                pass
        os.close(parent_fd)


def atomic_write_json(path: str | os.PathLike, value) -> None:
    """Serialize strict JSON and atomically replace the destination."""
    encoded = _json_bytes(value, limit=MAX_STATE_BYTES, message="JSON value is invalid or too large")
    atomic_write_text(path, encoded.decode("utf-8"))


def _object(value, required, optional=()):
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise JournalError("journal state is corrupt")
    allowed = set(required) | set(optional)
    if not set(required).issubset(value) or not set(value).issubset(allowed):
        raise JournalError("journal state is corrupt")
    return value


def _integer(value, *, minimum=0, maximum=MAX_CURSOR):
    if type(value) is not int or value < minimum or value > maximum:
        raise JournalError("journal state is corrupt")
    return value


def _digest(value):
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise JournalError("journal state is corrupt")
    return value


def _identity(value):
    if isinstance(value, (tuple, list)) and len(value) == 2:
        value = {"device": value[0], "inode": value[1]}
    if value is None:
        return None
    _object(value, ("device", "inode"))
    return {
        "device": _integer(value["device"], maximum=(1 << 63) - 1),
        "inode": _integer(value["inode"], maximum=(1 << 63) - 1),
    }


def _identity_tuple(value) -> tuple[int, int]:
    normalized = _identity(value)
    if normalized is None:
        raise JournalError("source identity is required")
    return normalized["device"], normalized["inode"]


def _batch_id(value):
    if not isinstance(value, str) or len(value) > MAX_BATCH_ID_LENGTH or _BATCH_ID.fullmatch(value) is None:
        raise JournalError("batch ID is invalid")
    return value


def _hold(value):
    if value is None:
        return None
    value = _object(value, ("reason", "fingerprint", "notice_emitted", "released"))
    reason = value["reason"]
    if (
        not isinstance(reason, str)
        or not reason
        or len(reason) > 256
        or any(ord(character) < 32 or ord(character) == 127 for character in reason)
    ):
        raise JournalError("hold state is invalid")
    if type(value["notice_emitted"]) is not bool or type(value["released"]) is not bool:
        raise JournalError("hold state is invalid")
    try:
        _scan_credentials(value)
    except ConfigError:
        raise JournalError("hold state contains disallowed data") from None
    if _HOLD_SECRET_ASSIGNMENT.search(reason):
        raise JournalError("hold state contains disallowed data")
    return {
        "reason": reason,
        "fingerprint": _digest(value["fingerprint"]),
        "notice_emitted": value["notice_emitted"],
        "released": value["released"],
    }


def _safe_json_object(value, *, limit: int, message: str):
    if not isinstance(value, dict):
        raise JournalError(message)
    encoded = _json_bytes(value, limit=limit, message=message)
    return _decode_json(encoded, message=message)


class CampaignLock:
    """Exclusive O_EXCL lock; stale-looking locks are never stolen."""

    def __init__(self, journal: Journal):
        self._journal = journal
        self._held = False
        self._token = None
        self._identity = None
        self._watcher_fd = None
        self._watcher_identity = None
        self._owner_thread = None

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        self.release()
        return False

    def acquire(self):
        journal = self._journal
        if self._held or journal._active_lock is not None:
            raise JournalError("nested campaign lock acquisition is not allowed")
        journal._assert_root()
        watcher_fd, watcher_identity = journal._open_directory("watcher")
        token = secrets.token_hex(32)
        payload = json.dumps(
            {
                "schema_version": 1,
                "pid": os.getpid(),
                "created_ns": time.time_ns(),
                "token": token,
            },
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii") + b"\n"
        descriptor = None
        created_identity = None
        try:
            descriptor = os.open(
                "lock",
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                0o600,
                dir_fd=watcher_fd,
            )
            identity_stat = os.fstat(descriptor)
            identity = (identity_stat.st_dev, identity_stat.st_ino)
            created_identity = identity
            with os.fdopen(descriptor, "wb") as stream:
                descriptor = None
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            if (journal._path_identity("watcher")) != watcher_identity:
                self._remove_own_lock(watcher_fd, identity, token, watcher_identity)
                raise JournalError("campaign root identity changed")
            os.fsync(watcher_fd)
            self._held = True
            self._token = token
            self._identity = identity
            self._watcher_fd = watcher_fd
            self._watcher_identity = watcher_identity
            self._owner_thread = threading.get_ident()
            journal._active_lock = self
            return self
        except FileExistsError:
            raise JournalError("campaign lock already exists; it is never stolen automatically") from None
        except JournalError:
            raise
        except (OSError, ValueError, TypeError):
            raise JournalError("campaign lock could not be acquired safely") from None
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if not self._held:
                if created_identity is not None:
                    try:
                        journal._assert_root()
                        self._unlink_created_inode(watcher_fd, created_identity, watcher_identity)
                    except JournalError:
                        pass
                os.close(watcher_fd)

    @staticmethod
    def _unlink_created_inode(watcher_fd, identity, watcher_identity):
        try:
            directory = os.fstat(watcher_fd)
            if (directory.st_dev, directory.st_ino) != watcher_identity:
                return
            current = os.stat("lock", dir_fd=watcher_fd, follow_symlinks=False)
            if stat.S_ISREG(current.st_mode) and (current.st_dev, current.st_ino) == identity:
                os.unlink("lock", dir_fd=watcher_fd)
                os.fsync(watcher_fd)
        except OSError:
            return

    def _remove_own_lock(self, watcher_fd, identity, token, watcher_identity) -> bool:
        try:
            watcher_stat = os.fstat(watcher_fd)
            if (watcher_stat.st_dev, watcher_stat.st_ino) != watcher_identity:
                return False
            current = os.stat("lock", dir_fd=watcher_fd, follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != identity:
                return False
            lock_fd = os.open("lock", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=watcher_fd)
            try:
                opened = os.fstat(lock_fd)
                if (opened.st_dev, opened.st_ino) != identity or not stat.S_ISREG(opened.st_mode):
                    return False
                raw = os.read(lock_fd, 4097)
                if len(raw) > 4096:
                    return False
            finally:
                os.close(lock_fd)
            data = _decode_json(raw, message="campaign lock is invalid")
            if not isinstance(data, dict) or data.get("token") != token:
                return False
            again = os.stat("lock", dir_fd=watcher_fd, follow_symlinks=False)
            if (again.st_dev, again.st_ino) != identity or not stat.S_ISREG(again.st_mode):
                return False
            os.unlink("lock", dir_fd=watcher_fd)
            os.fsync(watcher_fd)
            return True
        except (OSError, JournalError, ValueError):
            return False

    def release(self):
        if not self._held:
            return False
        if self._owner_thread != threading.get_ident():
            raise JournalError("campaign lock must be released by its acquiring thread")
        journal = self._journal
        removed = False
        try:
            journal._assert_root()
            if journal._path_identity("watcher") == self._watcher_identity:
                removed = self._remove_own_lock(
                    self._watcher_fd,
                    self._identity,
                    self._token,
                    self._watcher_identity,
                )
        except JournalError:
            # A replaced campaign/directory is not ours to modify. Leave the
            # lock in place rather than risking deletion from a new root.
            removed = False
        finally:
            if self._watcher_fd is not None:
                os.close(self._watcher_fd)
            self._watcher_fd = None
            self._held = False
            self._owner_thread = None
            if journal._active_lock is self:
                journal._active_lock = None
        return removed


class Journal:
    """Validated persistence API for one canonical campaign."""

    def __init__(self, common_dir: str | os.PathLike, campaign_id: str, *, crash_hook=None):
        try:
            raw_common = os.fspath(common_dir)
            common = Path(raw_common)
            if not common.is_absolute() or os.path.normpath(raw_common) != raw_common:
                raise JournalError("common directory must be canonical and absolute")
            validate_campaign_id(campaign_id)
            check_no_symlinks(Path(common.anchor), common)
            if Path(os.path.realpath(common)) != common:
                raise JournalError("common directory must be canonical")
            common_identity = file_identity(common)
            root = campaign_dir(common, campaign_id)
            check_no_symlinks(common, root)
            root_identity = file_identity(root)
        except JournalError:
            raise
        except (OSError, PathError, TypeError, ValueError):
            raise JournalError("campaign path is invalid or unsafe") from None
        self.common_dir = common
        self.campaign_id = campaign_id
        self.campaign_root = root
        self._common_identity = common_identity
        self._root_identity = root_identity
        self._active_lock: CampaignLock | None = None
        self._crash_hook = crash_hook
        self._validate_layout()

    def lock(self) -> CampaignLock:
        """Return a context manager for the exclusive campaign lock."""
        return CampaignLock(self)

    def operation_lock(self):
        """Acquire the campaign lock, reusing it for nested journal operations."""
        return self._operation_lock()

    def _crash(self, point: str) -> None:
        if self._crash_hook is not None:
            self._crash_hook(point)

    def _assert_root(self) -> None:
        try:
            check_no_symlinks(Path(self.common_dir.anchor), self.common_dir)
            if file_identity(self.common_dir) != self._common_identity:
                raise JournalError("common directory identity changed")
            check_no_symlinks(self.common_dir, self.campaign_root)
            if file_identity(self.campaign_root) != self._root_identity:
                raise JournalError("campaign root identity changed")
        except JournalError:
            raise
        except (OSError, PathError, TypeError, ValueError):
            raise JournalError("campaign path is no longer safe") from None

    def _path(self, relative: str) -> Path:
        try:
            return confine_relative(self.campaign_root, relative)
        except PathError:
            raise JournalError("campaign path is invalid") from None

    def _path_identity(self, relative: str) -> tuple[int, int]:
        self._assert_root()
        path = self._path(relative)
        try:
            check_no_symlinks(self.common_dir, path)
            return file_identity(path)
        except (OSError, PathError, ValueError):
            raise JournalError("campaign path identity changed") from None

    def _check_path(self, relative: str, *, kind: str, allow_missing=False):
        self._assert_root()
        path = self._path(relative)
        try:
            check_no_symlinks(self.common_dir, path, allow_missing=allow_missing)
            metadata = path.lstat()
        except FileNotFoundError:
            if allow_missing:
                return path, None
            raise JournalError("campaign state path is missing") from None
        except (OSError, PathError, ValueError):
            raise JournalError("campaign state path is unsafe") from None
        valid = stat.S_ISREG(metadata.st_mode) if kind == "file" else stat.S_ISDIR(metadata.st_mode)
        if not valid:
            raise JournalError("campaign state path has an invalid type")
        return path, metadata

    def _open_directory(self, relative: str) -> tuple[int, tuple[int, int]]:
        path, metadata = self._check_path(relative, kind="directory")
        assert metadata is not None
        try:
            descriptor = os.open(
                path,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
            )
            opened = os.fstat(descriptor)
            identity = (metadata.st_dev, metadata.st_ino)
            if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) != identity:
                os.close(descriptor)
                raise JournalError("campaign directory identity changed")
            self._assert_root()
            return descriptor, identity
        except JournalError:
            raise
        except (OSError, ValueError):
            raise JournalError("campaign directory could not be opened safely") from None

    def _read_file(self, relative: str, *, limit: int) -> bytes:
        path, metadata = self._check_path(relative, kind="file")
        assert metadata is not None
        descriptor = None
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            opened = os.fstat(descriptor)
            identity = (metadata.st_dev, metadata.st_ino)
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != identity:
                raise JournalError("campaign file identity changed")
            chunks = []
            remaining = limit + 1
            with os.fdopen(descriptor, "rb") as stream:
                descriptor = None
                while remaining:
                    chunk = stream.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
            raw = b"".join(chunks)
            if len(raw) > limit:
                raise JournalError("campaign JSON exceeds the size limit")
            self._assert_root()
            if self._path_identity(relative) != identity:
                raise JournalError("campaign file identity changed")
            return raw
        except JournalError:
            raise
        except (OSError, ValueError, TypeError):
            raise JournalError("campaign file could not be read safely") from None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    @contextlib.contextmanager
    def _resume_ledger_file(self):
        """Open the private append-only ledger through pinned directory FDs."""
        root_fd = controls_fd = ledger_fd = None
        try:
            self._assert_root()
            root_fd = os.open(
                self.campaign_root,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
            )
            root_stat = os.fstat(root_fd)
            if (
                not stat.S_ISDIR(root_stat.st_mode)
                or (root_stat.st_dev, root_stat.st_ino) != self._root_identity
            ):
                raise JournalError("campaign root identity changed")

            controls_created = False
            try:
                os.mkdir("controls", 0o700, dir_fd=root_fd)
                controls_created = True
            except FileExistsError:
                pass
            controls_entry = os.stat("controls", dir_fd=root_fd, follow_symlinks=False)
            if not stat.S_ISDIR(controls_entry.st_mode):
                raise JournalError("resume ledger directory is unsafe")
            controls_fd = os.open(
                "controls",
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=root_fd,
            )
            controls_stat = os.fstat(controls_fd)
            controls_identity = (controls_entry.st_dev, controls_entry.st_ino)
            if (
                not stat.S_ISDIR(controls_stat.st_mode)
                or (controls_stat.st_dev, controls_stat.st_ino) != controls_identity
            ):
                raise JournalError("resume ledger directory identity changed")
            if controls_created:
                os.fchmod(controls_fd, 0o700)
                os.fsync(root_fd)

            ledger_created = False
            flags = (
                os.O_RDWR
                | os.O_APPEND
                | os.O_CREAT
                | os.O_EXCL
                | getattr(os, "O_NOFOLLOW", 0)
            )
            try:
                ledger_fd = os.open("resume.jsonl", flags, 0o600, dir_fd=controls_fd)
                ledger_created = True
            except FileExistsError:
                ledger_fd = os.open(
                    "resume.jsonl",
                    os.O_RDWR | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=controls_fd,
                )
            if ledger_created:
                os.fchmod(ledger_fd, 0o600)
                os.fsync(ledger_fd)
                os.fsync(controls_fd)
            ledger_stat = os.fstat(ledger_fd)
            ledger_entry = os.stat(
                "resume.jsonl", dir_fd=controls_fd, follow_symlinks=False
            )
            ledger_identity = (ledger_stat.st_dev, ledger_stat.st_ino)
            if (
                not stat.S_ISREG(ledger_stat.st_mode)
                or stat.S_IMODE(ledger_stat.st_mode) != 0o600
                or ledger_stat.st_nlink != 1
                or not stat.S_ISREG(ledger_entry.st_mode)
                or (ledger_entry.st_dev, ledger_entry.st_ino) != ledger_identity
            ):
                raise JournalError("resume ledger file is unsafe")
            self._assert_root()
            if self._path_identity("controls") != controls_identity:
                raise JournalError("resume ledger directory identity changed")

            yield ledger_fd, controls_fd

            self._assert_root()
            if self._path_identity("controls") != controls_identity:
                raise JournalError("resume ledger directory identity changed")
            current_entry = os.stat(
                "resume.jsonl", dir_fd=controls_fd, follow_symlinks=False
            )
            if (
                not stat.S_ISREG(current_entry.st_mode)
                or (current_entry.st_dev, current_entry.st_ino) != ledger_identity
            ):
                raise JournalError("resume ledger file identity changed")
        except JournalError:
            raise
        except (OSError, PathError, TypeError, ValueError):
            raise JournalError("resume ledger could not be accessed safely") from None
        finally:
            if ledger_fd is not None:
                os.close(ledger_fd)
            if controls_fd is not None:
                os.close(controls_fd)
            if root_fd is not None:
                os.close(root_fd)

    @staticmethod
    def _read_resume_ledger_fd(descriptor: int) -> bytes:
        metadata = os.fstat(descriptor)
        if metadata.st_size > MAX_RESUME_LEDGER_BYTES:
            raise JournalError("resume ledger exceeds its safety limit")
        os.lseek(descriptor, 0, os.SEEK_SET)
        chunks = []
        remaining = MAX_RESUME_LEDGER_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > MAX_RESUME_LEDGER_BYTES:
            raise JournalError("resume ledger exceeds its safety limit")
        return raw

    def load_resume_ledger(self) -> tuple[list[dict], int]:
        """Safely create/read and strictly validate the bounded goal-resume ledger."""
        with self._operation_lock():
            with self._resume_ledger_file() as (ledger_fd, _controls_fd):
                raw = self._read_resume_ledger_fd(ledger_fd)
                records = _decode_resume_ledger(raw)
                return copy.deepcopy(records), len(raw)

    def read_resume_ledger_readonly(self) -> list[dict]:
        """Read and validate the bounded resume ledger without creating state."""
        self._assert_root()
        controls, metadata = self._check_path("controls", kind="directory", allow_missing=True)
        if metadata is None:
            return []
        ledger, metadata = self._check_path("controls/resume.jsonl", kind="file", allow_missing=True)
        if metadata is None:
            return []
        descriptor = None
        try:
            descriptor = os.open(ledger, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            opened = os.fstat(descriptor)
            if (not stat.S_ISREG(opened.st_mode) or stat.S_IMODE(opened.st_mode) != 0o600
                    or opened.st_nlink != 1 or (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino)):
                raise JournalError("resume ledger file is unsafe")
            raw = self._read_resume_ledger_fd(descriptor)
            records = _decode_resume_ledger(raw)
            self._assert_root()
            if self._path_identity("controls/resume.jsonl") != (opened.st_dev, opened.st_ino):
                raise JournalError("resume ledger file identity changed")
            return copy.deepcopy(records)
        except JournalError:
            raise
        except (OSError, PathError, TypeError, ValueError):
            raise JournalError("resume ledger could not be accessed safely") from None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def append_resume_record(self, value: dict) -> dict:
        """Durably append one validated goal-resume record under the campaign lock."""
        record = _normalize_resume_record(value)
        try:
            encoded = (
                json.dumps(
                    record,
                    ensure_ascii=True,
                    allow_nan=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("ascii", errors="strict")
                + b"\n"
            )
        except (TypeError, ValueError, UnicodeError, RecursionError):
            raise JournalError("resume ledger record is invalid") from None

        with self._operation_lock():
            with self._resume_ledger_file() as (ledger_fd, controls_fd):
                raw = self._read_resume_ledger_fd(ledger_fd)
                records = _decode_resume_ledger(raw)
                _validate_resume_history([*records, record])
                if (
                    len(records) >= MAX_RESUME_LEDGER_RECORDS
                    or len(raw) + len(encoded) > MAX_RESUME_LEDGER_BYTES
                ):
                    raise JournalError("resume ledger reached its safety limit")
                if os.fstat(ledger_fd).st_size != len(raw):
                    raise JournalError("resume ledger changed while it was being updated")
                written = os.write(ledger_fd, encoded)
                if written != len(encoded):
                    raise JournalError("resume ledger record could not be appended safely")
                os.fsync(ledger_fd)
                os.fsync(controls_fd)
            return copy.deepcopy(record)

    def _read_json(self, relative: str, *, limit: int, message: str):
        value = _decode_json(self._read_file(relative, limit=limit), message=message)
        if not isinstance(value, dict):
            raise JournalError(message)
        return value

    def _write_json(self, relative: str, value, *, limit: int, message: str) -> bytes:
        encoded = _json_bytes(value, limit=limit, message=message)
        self._assert_root()
        path = self._path(relative)
        try:
            check_no_symlinks(self.common_dir, path, allow_missing=True)
            atomic_write_text(path, encoded.decode("utf-8"))
            self._assert_root()
            self._check_path(relative, kind="file")
        except JournalError:
            raise
        except (OSError, PathError, TypeError, ValueError):
            raise JournalError(message) from None
        return encoded

    def _validate_layout(self) -> None:
        self._assert_root()
        for relative in ("inbox", "rulings", "watcher", "watcher/batches"):
            self._check_path(relative, kind="directory")
        for relative in (
            "config.json",
            "inbox/A.md",
            "inbox/B.md",
            "rulings/A.md",
            "rulings/B.md",
            "watcher/state.json",
            "holds.json",
            "overseer-handoff.md",
        ):
            self._check_path(relative, kind="file")
        config_data = self._read_json(
            "config.json", limit=MAX_CONFIG_BYTES, message="campaign configuration is invalid"
        )
        try:
            config = parse_config(config_data)
        except ConfigError:
            raise JournalError("campaign configuration is invalid") from None
        if config.campaign_id != self.campaign_id or config.common_dir != str(self.common_dir):
            raise JournalError("campaign configuration does not match its journal")
        if config.campaign_id != self.campaign_id or config.common_dir != str(self.common_dir):
            raise JournalError("campaign configuration does not match its canonical path")

    @contextlib.contextmanager
    def _operation_lock(self):
        if self._active_lock is not None:
            if self._active_lock._owner_thread != threading.get_ident():
                raise JournalError("campaign lock is owned by another thread")
            yield
        else:
            with self.lock():
                yield

    def _legacy_state(self, data: dict) -> dict | None:
        if set(data) != {"schema_version", "sources", "batches"}:
            return None
        if type(data["schema_version"]) is not int or data["schema_version"] != 1:
            raise JournalError("journal state is corrupt")
        if not isinstance(data["batches"], dict) or data["batches"]:
            raise JournalError("journal state is corrupt")
        sources = data["sources"]
        if not isinstance(sources, dict) or set(sources) != set(SOURCE_ROLES):
            raise JournalError("journal state is corrupt")
        migrated_sources = {}
        for role in SOURCE_ROLES:
            source = _object(sources[role], ("cursor", "prefix_sha256"))
            migrated_sources[role] = {
                "cursor": _integer(source["cursor"]),
                "prefix_sha256": _digest(source["prefix_sha256"]),
                "identity": None,
                "observation": None,
                "hold": None,
            }
        return {
            "schema_version": 1,
            "campaign_id": self.campaign_id,
            "common_dir": str(self.common_dir),
            "campaign_identity": {"device": self._root_identity[0], "inode": self._root_identity[1]},
            "sources": migrated_sources,
            "batches": {},
            "pending_batch": None,
            "hold": None,
        }

    def _normalize_batch_record(self, batch_id, value):
        _batch_id(batch_id)
        value = _object(
            value,
            ("status", "snapshot_sha256", "sources", "receipt", "hold"),
            ("send_intent_recorded", "last_attempt_proven_unsent"),
        )
        if not isinstance(value["status"], str) or value["status"] not in DELIVERY_STATES:
            raise JournalError("journal state is corrupt")
        send_intent_recorded = value.get("send_intent_recorded")
        if send_intent_recorded is None:
            # Older records cannot prove whether a non-snapshotted batch had a
            # send intent. Fail closed so release cannot authorize a blind POST.
            send_intent_recorded = value["status"] != "snapshotted"
        if type(send_intent_recorded) is not bool:
            raise JournalError("journal state is corrupt")
        last_attempt_proven_unsent = value.get("last_attempt_proven_unsent", False)
        if type(last_attempt_proven_unsent) is not bool:
            raise JournalError("journal state is corrupt")
        if value["status"] == "send-intent" and not send_intent_recorded:
            raise JournalError("journal state is corrupt")
        if value["status"] == "send-intent" and last_attempt_proven_unsent:
            raise JournalError("journal state is corrupt")
        if last_attempt_proven_unsent and (
            not send_intent_recorded or value["status"] not in ("held", "snapshotted")
        ):
            raise JournalError("journal state is corrupt")
        if (
            value["status"] == "snapshotted"
            and send_intent_recorded
            and not last_attempt_proven_unsent
        ):
            raise JournalError("journal state is corrupt")
        digest = _digest(value["snapshot_sha256"])
        sources = value["sources"]
        if not isinstance(sources, dict) or not sources or not set(sources).issubset(SOURCE_ROLES):
            raise JournalError("journal state is corrupt")
        normalized_sources = {}
        for role, item in sources.items():
            item = _object(item, ("start", "end", "prefix_before", "prefix_after", "identity", "sha256"))
            start = _integer(item["start"])
            end = _integer(item["end"])
            if end <= start:
                raise JournalError("journal state is corrupt")
            normalized_sources[role] = {
                "start": start,
                "end": end,
                "prefix_before": _digest(item["prefix_before"]),
                "prefix_after": _digest(item["prefix_after"]),
                "identity": _identity(item["identity"]),
                "sha256": _digest(item["sha256"]),
            }
        receipt = value["receipt"]
        if receipt is not None:
            receipt = _safe_json_object(
                receipt, limit=MAX_RECEIPT_BYTES, message="delivery receipt is invalid"
            )
        return {
            "status": value["status"],
            "send_intent_recorded": send_intent_recorded,
            "last_attempt_proven_unsent": last_attempt_proven_unsent,
            "snapshot_sha256": digest,
            "sources": normalized_sources,
            "receipt": receipt,
            "hold": _hold(value["hold"]),
        }

    def _normalize_state(self, data: dict) -> dict:
        required = (
            "schema_version",
            "campaign_id",
            "common_dir",
            "campaign_identity",
            "sources",
            "batches",
            "pending_batch",
            "hold",
        )
        data = _object(data, required)
        if type(data["schema_version"]) is not int or data["schema_version"] != 1:
            raise JournalError("journal state is corrupt")
        if data["campaign_id"] != self.campaign_id or data["common_dir"] != str(self.common_dir):
            raise JournalError("journal state belongs to a different campaign")
        identity = _identity(data["campaign_identity"])
        expected_identity = {"device": self._root_identity[0], "inode": self._root_identity[1]}
        if identity != expected_identity:
            raise JournalError("campaign root identity changed")

        source_data = data["sources"]
        if not isinstance(source_data, dict) or set(source_data) != set(SOURCE_ROLES):
            raise JournalError("journal state is corrupt")
        sources = {}
        for role in SOURCE_ROLES:
            item = _object(
                source_data[role],
                ("cursor", "prefix_sha256", "identity", "observation", "hold"),
            )
            observation = item["observation"]
            if observation is not None:
                observation = _safe_json_object(
                    observation, limit=MAX_OBSERVATION_BYTES, message="source observation is invalid"
                )
            sources[role] = {
                "cursor": _integer(item["cursor"]),
                "prefix_sha256": _digest(item["prefix_sha256"]),
                "identity": _identity(item["identity"]),
                "observation": observation,
                "hold": _hold(item["hold"]),
            }

        batch_data = data["batches"]
        if not isinstance(batch_data, dict) or len(batch_data) > 4096:
            raise JournalError("journal state is corrupt")
        batches = {
            _batch_id(batch_id): self._normalize_batch_record(batch_id, value)
            for batch_id, value in batch_data.items()
        }
        pending = data["pending_batch"]
        if pending is not None:
            pending = _batch_id(pending)
            if pending not in batches or batches[pending]["status"] == "acknowledged":
                raise JournalError("journal state is corrupt")
        active = [
            batch_id
            for batch_id, batch in batches.items()
            if batch["status"] != "acknowledged"
        ]
        if len(active) > 1 or (active and pending != active[0]) or (not active and pending is not None):
            raise JournalError("journal state is corrupt")
        return {
            "schema_version": 1,
            "campaign_id": self.campaign_id,
            "common_dir": str(self.common_dir),
            "campaign_identity": expected_identity,
            "sources": sources,
            "batches": batches,
            "pending_batch": pending,
            "hold": _hold(data["hold"]),
        }

    def _write_state(self, state: dict) -> None:
        normalized = self._normalize_state(state)
        self._write_json(
            "watcher/state.json",
            normalized,
            limit=MAX_STATE_BYTES,
            message="journal state could not be persisted safely",
        )

    def _load_unlocked(self) -> dict:
        self._assert_root()
        data = self._read_json(
            "watcher/state.json", limit=MAX_STATE_BYTES, message="journal state is corrupt"
        )
        migrated = self._legacy_state(data)
        if migrated is not None:
            self._write_state(migrated)
            return migrated
        return self._normalize_state(data)

    def load(self) -> dict:
        """Load strict bounded state, migrating the CLI's minimal v1 shape."""
        with self._operation_lock():
            return copy.deepcopy(self._load_unlocked())

    def read_state_readonly(self) -> dict:
        """Read and validate state without acquiring a lock or migrating it.

        This is for CLI previews/status only. A setup-era minimal state is
        expanded in memory, but the file and ``watcher/lock`` remain untouched.
        """
        self._assert_root()
        data = self._read_json(
            "watcher/state.json", limit=MAX_STATE_BYTES, message="journal state is corrupt"
        )
        migrated = self._legacy_state(data)
        if migrated is not None:
            return copy.deepcopy(migrated)
        return copy.deepcopy(self._normalize_state(data))

    def read_config(self):
        """Read and validate the current persisted campaign config.

        Transport uses this immediately before delivery rather than trusting
        the immutable config object captured when a long-running watcher
        started.  The result remains bounded, credential-free, and tied to this
        journal's canonical campaign root.
        """
        with self._operation_lock():
            data = self._read_json(
                "config.json", limit=MAX_CONFIG_BYTES, message="campaign configuration is invalid"
            )
            try:
                config = parse_config(data)
            except ConfigError:
                raise JournalError("campaign configuration is invalid") from None
            if config.campaign_id != self.campaign_id or config.common_dir != str(self.common_dir):
                raise JournalError("campaign configuration does not match its journal")
            return config

    def read_config_readonly(self):
        """Read the current config without creating the runtime lock."""
        self._assert_root()
        data = self._read_json(
            "config.json", limit=MAX_CONFIG_BYTES, message="campaign configuration is invalid"
        )
        try:
            config = parse_config(data)
        except ConfigError:
            raise JournalError("campaign configuration is invalid") from None
        if config.campaign_id != self.campaign_id or config.common_dir != str(self.common_dir):
            raise JournalError("campaign configuration does not match its journal")
        return config

    def save(self, state: dict) -> dict:
        """Persist observation updates; cursor and batch changes use commit APIs."""
        with self._operation_lock():
            current = self._load_unlocked()
            proposed = self._normalize_state(state)
            if (
                proposed["batches"] != current["batches"]
                or proposed["pending_batch"] != current["pending_batch"]
                or proposed["hold"] != current["hold"]
            ):
                raise JournalError("use journal transition APIs for batch and hold changes")
            for role in SOURCE_ROLES:
                old = current["sources"][role]
                new = proposed["sources"][role]
                if new["cursor"] != old["cursor"] or new["prefix_sha256"] != old["prefix_sha256"]:
                    raise JournalError("source cursors advance only with a durable batch snapshot")
                if old["identity"] is not None and new["identity"] != old["identity"]:
                    raise JournalError("source identity cannot be silently replaced")
                if new["identity"] is not None:
                    if self._path_identity(f"inbox/{role}.md") != _identity_tuple(new["identity"]):
                        raise JournalError("source identity does not match its mailbox")
                if new["hold"] != old["hold"]:
                    raise JournalError("use set_hold and release_hold for hold changes")
            self._write_state(proposed)
            return copy.deepcopy(proposed)

    def initialize_range_baseline(self, role: str) -> dict:
        """Turn a fresh CLI range baseline into its explicit first scan cursor.

        ``init`` records the configured range end as the initial cursor so the
        setup preview accurately describes the selected baseline.  The watcher
        must process that explicit ``[start, end)`` range once, so this narrow
        transition moves a pristine source to ``start`` and pins the live file
        identity.  It is allowed only while the campaign has no batches and
        only when the persisted config, range hash, and initial source state
        agree exactly; it is not a general re-baseline operation.
        """
        if role not in SOURCE_ROLES:
            raise JournalError("source role is invalid")
        with self._operation_lock():
            state = self._load_unlocked()
            config_data = self._read_json(
                "config.json", limit=MAX_CONFIG_BYTES, message="campaign configuration is invalid"
            )
            try:
                config = parse_config(config_data)
            except ConfigError:
                raise JournalError("campaign configuration is invalid") from None
            baseline = config.baseline[role]
            if baseline.mode != "range":
                raise JournalError("source does not have an explicit range baseline")

            source = state["sources"][role]
            if source["identity"] is not None:
                return copy.deepcopy(state)
            if (
                state["batches"]
                or state["pending_batch"] is not None
                or (state["hold"] is not None and not state["hold"]["released"])
                or source["observation"] is not None
                or (source["hold"] is not None and not source["hold"]["released"])
            ):
                raise JournalError("range baseline can only initialize a pristine source")

            identity = self._path_identity(f"inbox/{role}.md")
            prefix_before, prefix_through_end = self._source_prefix_hashes(
                role, baseline.start, baseline.end, identity
            )
            if prefix_through_end != baseline.prefix_sha256:
                raise JournalError("configured range baseline does not match its source")

            if (
                source["cursor"] == baseline.end
                and source["prefix_sha256"] == baseline.prefix_sha256
            ):
                source["cursor"] = baseline.start
                source["prefix_sha256"] = prefix_before
            elif not (
                source["cursor"] == baseline.start
                and source["prefix_sha256"] == prefix_before
            ):
                raise JournalError("initial source cursor does not match its range baseline")

            source["identity"] = identity
            source["observation"] = None
            self._write_state(state)
            return copy.deepcopy(state)

    def _make_batch_id(self, source_data: dict) -> str:
        identity_rows = []
        for role in SOURCE_ROLES:
            if role not in source_data:
                continue
            source = source_data[role]
            identity = source["identity"]
            identity_rows.append(
                {
                    "role": role,
                    "identity": [identity["device"], identity["inode"]],
                    "start": source["start"],
                    "end": source["end"],
                    "sha256": source["sha256"],
                }
            )
        canonical = json.dumps(
            {"campaign_id": self.campaign_id, "sources": identity_rows},
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("ascii")
        return "b-" + hashlib.sha256(canonical).hexdigest()

    def make_batch_id(self, sources: dict) -> str:
        """Return the stable ID for normalized source ranges (same inputs as commit_batch)."""
        with self._operation_lock():
            normalized = self._prepare_sources(sources, self._load_unlocked())
            return self._make_batch_id(normalized)

    def _read_source_range(self, role: str, start: int, end: int, expected_identity) -> bytes:
        relative = f"inbox/{role}.md"
        path, metadata = self._check_path(relative, kind="file")
        assert metadata is not None
        identity = _identity_tuple(expected_identity)
        if (metadata.st_dev, metadata.st_ino) != identity or metadata.st_size < end:
            raise JournalError("source changed before its batch snapshot")
        descriptor = None
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != identity:
                raise JournalError("source changed before its batch snapshot")
            with os.fdopen(descriptor, "rb") as stream:
                descriptor = None
                stream.seek(start)
                remaining = end - start
                chunks = []
                while remaining:
                    chunk = stream.read(remaining)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                content = b"".join(chunks)
            if len(content) != end - start:
                raise JournalError("source range changed before its batch snapshot")
            self._assert_root()
            if self._path_identity(relative) != identity:
                raise JournalError("source changed before its batch snapshot")
            return content
        except JournalError:
            raise
        except (OSError, ValueError, TypeError):
            raise JournalError("source range could not be read safely") from None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _source_prefix_hashes(self, role: str, start: int, end: int, expected_identity):
        """Hash the live consumed prefix and candidate prefix through ``end``.

        The bounded range is read only through ``end``; bytes appended after it
        remain queued and cannot change either digest.
        """
        relative = f"inbox/{role}.md"
        path, metadata = self._check_path(relative, kind="file")
        assert metadata is not None
        identity = _identity_tuple(expected_identity)
        if (metadata.st_dev, metadata.st_ino) != identity or metadata.st_size < end:
            raise JournalError("source changed while validating its consumed prefix")
        descriptor = None
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or (opened.st_dev, opened.st_ino) != identity
                or opened.st_size < end
            ):
                raise JournalError("source changed while validating its consumed prefix")
            before = hashlib.sha256()
            through_end = hashlib.sha256()
            position = 0
            with os.fdopen(descriptor, "rb") as stream:
                descriptor = None
                while position < end:
                    wanted = min(64 * 1024, end - position)
                    parts = []
                    remaining = wanted
                    while remaining:
                        chunk = stream.read(remaining)
                        if not chunk:
                            raise JournalError("source was truncated while validating its prefix")
                        parts.append(chunk)
                        remaining -= len(chunk)
                    chunk = b"".join(parts)
                    through_end.update(chunk)
                    before_length = max(0, min(len(chunk), start - position))
                    if before_length:
                        before.update(chunk[:before_length])
                    position += len(chunk)
            self._assert_root()
            if self._path_identity(relative) != identity:
                raise JournalError("source identity changed while validating its prefix")
            return before.hexdigest(), through_end.hexdigest()
        except JournalError:
            raise
        except (OSError, ValueError, TypeError):
            raise JournalError("source prefix could not be validated safely") from None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _prepare_sources(self, sources: dict, state: dict) -> dict:
        if not isinstance(sources, dict) or not sources or not set(sources).issubset(SOURCE_ROLES):
            raise JournalError("batch sources are invalid")
        prepared = {}
        total_content = 0
        for role in SOURCE_ROLES:
            if role not in sources:
                continue
            source = _object(
                sources[role],
                ("start", "end", "prefix_before", "prefix_after", "identity", "content"),
                ("frame_ids",),
            )
            start = _integer(source["start"])
            end = _integer(source["end"])
            if end <= start or start != state["sources"][role]["cursor"]:
                raise JournalError("batch range does not begin at the current cursor")
            prefix_before = _digest(source["prefix_before"])
            prefix_after = _digest(source["prefix_after"])
            if prefix_before != state["sources"][role]["prefix_sha256"]:
                raise JournalError("batch prefix does not match the journal cursor")
            identity = _identity(source["identity"])
            if identity is None:
                raise JournalError("source identity is required")
            old_identity = state["sources"][role]["identity"]
            if old_identity is not None and identity != old_identity:
                raise JournalError("source identity changed")
            content = source["content"]
            if isinstance(content, bytes):
                try:
                    content = content.decode("utf-8", errors="strict")
                except UnicodeError:
                    raise JournalError("snapshot content is not valid UTF-8") from None
            if not isinstance(content, str):
                raise JournalError("snapshot content is invalid")
            try:
                content_bytes = content.encode("utf-8", errors="strict")
            except UnicodeError:
                raise JournalError("snapshot content is invalid") from None
            total_content += len(content_bytes)
            if len(content_bytes) != end - start or total_content > MAX_CONTENT_BYTES:
                raise JournalError("snapshot content exceeds its range or size limit")
            try:
                _scan_credentials({"content": content})
            except ConfigError:
                raise JournalError("snapshot contains disallowed secret-like data") from None
            frame_ids = source.get("frame_ids", [])
            if (
                not isinstance(frame_ids, list)
                or len(frame_ids) > 4096
                or any(
                    not isinstance(frame_id, str)
                    or not frame_id
                    or len(frame_id) > 128
                    or any(ord(character) < 32 or ord(character) == 127 for character in frame_id)
                    for frame_id in frame_ids
                )
                or len(set(frame_ids)) != len(frame_ids)
            ):
                raise JournalError("snapshot frame IDs are invalid")
            digest = hashlib.sha256(content_bytes).hexdigest()
            live_content = self._read_source_range(role, start, end, identity)
            if live_content != content_bytes:
                raise JournalError("source range differs from snapshot content")
            live_prefix_before, live_prefix_after = self._source_prefix_hashes(
                role, start, end, identity
            )
            if live_prefix_before != prefix_before:
                raise JournalError("consumed source prefix changed after observation")
            if live_prefix_after != prefix_after:
                raise JournalError("computed source prefix hash does not match")
            prepared[role] = {
                "role": role,
                "path": f"inbox/{role}.md",
                "start": start,
                "end": end,
                "prefix_before": prefix_before,
                "prefix_after": prefix_after,
                "identity": identity,
                "sha256": digest,
                "content": content,
                "frame_ids": list(frame_ids),
            }
        return prepared

    def _snapshot_from_sources(self, sources: dict) -> dict:
        return {
            "schema_version": 1,
            "campaign_id": self.campaign_id,
            "batch_id": self._make_batch_id(sources),
            "sources": sources,
        }

    def _normalize_snapshot(self, value, expected_id: str):
        value = _object(value, ("schema_version", "campaign_id", "batch_id", "sources"), ("metadata",))
        if type(value["schema_version"]) is not int or value["schema_version"] != 1:
            raise JournalError("batch snapshot is corrupt")
        if value["campaign_id"] != self.campaign_id or value["batch_id"] != expected_id:
            raise JournalError("batch snapshot identity does not match its path")
        raw_sources = value["sources"]
        if not isinstance(raw_sources, dict) or not raw_sources or not set(raw_sources).issubset(SOURCE_ROLES):
            raise JournalError("batch snapshot is corrupt")
        sources = {}
        for role in SOURCE_ROLES:
            if role not in raw_sources:
                continue
            item = _object(
                raw_sources[role],
                (
                    "role", "path", "start", "end", "prefix_before", "prefix_after",
                    "identity", "sha256", "content", "frame_ids",
                ),
            )
            if item["role"] != role or item["path"] != f"inbox/{role}.md":
                raise JournalError("batch snapshot source identity is invalid")
            start = _integer(item["start"])
            end = _integer(item["end"])
            if end <= start:
                raise JournalError("batch snapshot range is invalid")
            content = item["content"]
            if not isinstance(content, str):
                raise JournalError("batch snapshot content is invalid")
            try:
                content_bytes = content.encode("utf-8", errors="strict")
            except UnicodeError:
                raise JournalError("batch snapshot content is invalid") from None
            if len(content_bytes) != end - start or len(content_bytes) > MAX_CONTENT_BYTES:
                raise JournalError("batch snapshot content is invalid")
            if hashlib.sha256(content_bytes).hexdigest() != _digest(item["sha256"]):
                raise JournalError("batch snapshot content hash does not match")
            try:
                _scan_credentials({"content": content})
            except ConfigError:
                raise JournalError("batch snapshot contains disallowed secret-like data") from None
            frames = item["frame_ids"]
            if (
                not isinstance(frames, list)
                or len(frames) > 4096
                or any(
                    not isinstance(frame_id, str)
                    or not frame_id
                    or len(frame_id) > 128
                    or any(ord(character) < 32 or ord(character) == 127 for character in frame_id)
                    for frame_id in frames
                )
                or len(set(frames)) != len(frames)
            ):
                raise JournalError("batch snapshot frame IDs are invalid")
            sources[role] = {
                "role": role,
                "path": f"inbox/{role}.md",
                "start": start,
                "end": end,
                "prefix_before": _digest(item["prefix_before"]),
                "prefix_after": _digest(item["prefix_after"]),
                "identity": _identity(item["identity"]),
                "sha256": item["sha256"],
                "content": content,
                "frame_ids": list(frames),
            }
            if sources[role]["identity"] is None:
                raise JournalError("batch snapshot source identity is invalid")
        metadata = value.get("metadata", {})
        if not isinstance(metadata, dict):
            raise JournalError("batch snapshot metadata is invalid")
        normalized = {
            "schema_version": 1,
            "campaign_id": self.campaign_id,
            "batch_id": expected_id,
            "sources": sources,
        }
        if "metadata" in value:
            normalized["metadata"] = _safe_json_object(
                metadata, limit=16 * 1024, message="batch snapshot metadata is invalid"
            )
        if self._make_batch_id(sources) != expected_id:
            raise JournalError("batch ID does not match its source ranges")
        _json_bytes(normalized, limit=MAX_SNAPSHOT_BYTES, message="batch snapshot is too large")
        return normalized

    def _batch_record(self, snapshot: dict, snapshot_bytes: bytes) -> dict:
        sources = {
            role: {
                "start": item["start"],
                "end": item["end"],
                "prefix_before": item["prefix_before"],
                "prefix_after": item["prefix_after"],
                "identity": item["identity"],
                "sha256": item["sha256"],
            }
            for role, item in snapshot["sources"].items()
        }
        return {
            "status": "snapshotted",
            "send_intent_recorded": False,
            "last_attempt_proven_unsent": False,
            "snapshot_sha256": hashlib.sha256(snapshot_bytes).hexdigest(),
            "sources": sources,
            "receipt": None,
            "hold": None,
        }

    def _batch_directory(self, batch_id: str) -> Path:
        _batch_id(batch_id)
        return self.campaign_root / "watcher" / "batches" / batch_id

    def _read_snapshot(self, batch_id: str) -> tuple[dict, bytes]:
        relative = f"watcher/batches/{_batch_id(batch_id)}/snapshot.json"
        raw = self._read_file(relative, limit=MAX_SNAPSHOT_BYTES)
        data = _decode_json(raw, message="batch snapshot is corrupt")
        normalized = self._normalize_snapshot(data, batch_id)
        return normalized, raw

    def read_batch_snapshot(self, batch_id: str) -> dict:
        """Return a validated copy of one immutable batch snapshot."""
        batch_id = _batch_id(batch_id)
        with self._operation_lock():
            snapshot, raw = self._read_snapshot(batch_id)
            state = self._load_unlocked()
            record = state["batches"].get(batch_id)
            if record is not None and record["snapshot_sha256"] != hashlib.sha256(raw).hexdigest():
                raise JournalError("batch snapshot differs from its journal record")
            return copy.deepcopy(snapshot)

    def read_batch_snapshot_readonly(self, batch_id: str) -> dict:
        """Validate one snapshot without acquiring a lock or migrating state."""
        batch_id = _batch_id(batch_id)
        snapshot, raw = self._read_snapshot(batch_id)
        state = self.read_state_readonly()
        record = state["batches"].get(batch_id)
        if record is not None and record["snapshot_sha256"] != hashlib.sha256(raw).hexdigest():
            raise JournalError("batch snapshot differs from its journal record")
        return copy.deepcopy(snapshot)

    def read_batch_ack(self, batch_id: str, *, limit: int) -> bytes | None:
        """Read the per-batch acknowledgement without following links.

        The caller validates the frame protocol. A missing acknowledgement is
        represented as ``None``; malformed, oversized, or unsafe paths fail
        closed with a content-free JournalError.
        """
        batch_id = _batch_id(batch_id)
        if type(limit) is not int or not 1 <= limit <= MAX_CONTENT_BYTES:
            raise JournalError("acknowledgement size limit is invalid")
        relative = f"watcher/batches/{batch_id}/overseer-ack.md"
        with self._operation_lock():
            _path, metadata = self._check_path(relative, kind="file", allow_missing=True)
            if metadata is None:
                return None
            return self._read_file(relative, limit=limit)

    def read_batch_ack_readonly(self, batch_id: str, *, limit: int) -> bytes | None:
        """Read a bounded acknowledgement without creating ``watcher/lock``."""
        batch_id = _batch_id(batch_id)
        if type(limit) is not int or not 1 <= limit <= MAX_CONTENT_BYTES:
            raise JournalError("acknowledgement size limit is invalid")
        relative = f"watcher/batches/{batch_id}/overseer-ack.md"
        _path, metadata = self._check_path(relative, kind="file", allow_missing=True)
        if metadata is None:
            return None
        return self._read_file(relative, limit=limit)

    def _snapshot_is_protocol_only(self, snapshot: dict) -> bool:
        """Re-validate durable metadata before silently consuming protocol input."""
        metadata = snapshot.get("metadata")
        watcher = metadata.get("watcher") if isinstance(metadata, dict) else None
        if (
            not isinstance(watcher, dict)
            or watcher.get("schema_version") != 1
            or watcher.get("classification") != "protocol-only"
            or not isinstance(watcher.get("entries"), list)
            or not watcher["entries"]
        ):
            return False

        config_data = self._read_json(
            "config.json", limit=MAX_CONFIG_BYTES, message="campaign configuration is invalid"
        )
        try:
            config = parse_config(config_data)
        except ConfigError:
            raise JournalError("campaign configuration is invalid") from None

        stored_entries = watcher["entries"]
        expected_entries = []
        seen_ids = set()
        for role in SOURCE_ROLES:
            item = snapshot["sources"].get(role)
            if item is None:
                continue
            content = item["content"].encode("utf-8", errors="strict")
            try:
                parsed = parse_mailbox(
                    content,
                    self.campaign_id,
                    role,
                    config.roles[role].generation,
                    worktree=config.roles[role].directory,
                    max_frame_bytes=config.limits.max_frame_bytes,
                )
            except (TypeError, ValueError):
                return False
            if parsed.consumed != len(content) or not parsed.entries:
                return False
            for entry in parsed.entries:
                if (
                    entry.classification != "protocol"
                    or entry.kind != "setup-ack"
                    or entry.frame_id is None
                    or entry.frame_id in seen_ids
                ):
                    return False
                seen_ids.add(entry.frame_id)
                expected_entries.append(
                    {
                        "role": role,
                        "start": item["start"] + entry.start,
                        "end": item["start"] + entry.end,
                        "classification": entry.classification,
                        "reason": entry.reason,
                        "frame_id": entry.frame_id,
                        "report_id": entry.report_id,
                        "kind": entry.kind,
                        "batch_id": entry.batch_id,
                    }
                )

        if len(expected_entries) != len(stored_entries):
            return False
        for expected, stored in zip(expected_entries, stored_entries):
            if not isinstance(stored, dict) or any(stored.get(key) != value for key, value in expected.items()):
                return False
            if set(stored) - set(expected) not in (set(), {"evidence_paths"}):
                return False
        return True

    def _clear_abandoned_snapshot_temps(self, batch_id: str) -> None:
        relative = f"watcher/batches/{_batch_id(batch_id)}"
        directory_fd, _ = self._open_directory(relative)
        try:
            for name in os.listdir(directory_fd):
                if _TEMP_SNAPSHOT.fullmatch(name) is None:
                    raise JournalError("incomplete batch directory contains unexpected data")
                metadata = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if not stat.S_ISREG(metadata.st_mode):
                    raise JournalError("incomplete batch directory is unsafe")
                os.unlink(name, dir_fd=directory_fd)
            os.fsync(directory_fd)
        except JournalError:
            raise
        except (OSError, ValueError):
            raise JournalError("incomplete batch directory could not be recovered safely") from None
        finally:
            os.close(directory_fd)

    def _validate_orphan_source(self, state: dict, role: str, item: dict) -> None:
        source_state = state["sources"][role]
        if (
            source_state["cursor"] != item["start"]
            or source_state["prefix_sha256"] != item["prefix_before"]
        ):
            raise JournalError("orphan snapshot does not follow the current source cursor")
        if source_state["identity"] is not None and source_state["identity"] != item["identity"]:
            raise JournalError("orphan snapshot source identity changed")
        content = self._read_source_range(role, item["start"], item["end"], item["identity"])
        if content != item["content"].encode("utf-8"):
            raise JournalError("orphan snapshot no longer matches its source range")

    def _recover_unlocked(self, state: dict) -> list[str]:
        batches_fd, batches_identity = self._open_directory("watcher/batches")
        try:
            with os.scandir(batches_fd) as iterator:
                entries = sorted((entry.name for entry in iterator))
        except OSError:
            raise JournalError("batch snapshots could not be enumerated safely") from None
        finally:
            os.close(batches_fd)
        if self._path_identity("watcher/batches") != batches_identity:
            raise JournalError("batch directory identity changed")
        orphaned = []
        found_ids = set()
        for batch_id in entries:
            _batch_id(batch_id)
            relative_dir = f"watcher/batches/{batch_id}"
            _path, metadata = self._check_path(relative_dir, kind="directory")
            snapshot_relative = f"{relative_dir}/snapshot.json"
            snapshot_path = self._path(snapshot_relative)
            try:
                check_no_symlinks(self.common_dir, snapshot_path, allow_missing=True)
                snapshot_stat = snapshot_path.lstat()
            except FileNotFoundError:
                if batch_id in state["batches"]:
                    raise JournalError("journal references a missing batch snapshot") from None
                self._clear_abandoned_snapshot_temps(batch_id)
                continue
            except (OSError, PathError, ValueError):
                raise JournalError("batch snapshot path is unsafe") from None
            if not stat.S_ISREG(snapshot_stat.st_mode):
                raise JournalError("batch snapshot is not a regular file")
            snapshot, raw = self._read_snapshot(batch_id)
            found_ids.add(batch_id)
            expected_record = self._batch_record(snapshot, raw)
            recorded = state["batches"].get(batch_id)
            if recorded is None:
                orphaned.append((batch_id, snapshot, raw, expected_record))
            else:
                if (
                    recorded["snapshot_sha256"] != expected_record["snapshot_sha256"]
                    or recorded["sources"] != expected_record["sources"]
                ):
                    raise JournalError("journal batch record does not match its snapshot")
        if not set(state["batches"]).issubset(found_ids):
            raise JournalError("journal and batch snapshots disagree")
        if len(orphaned) > 1:
            raise JournalError("multiple uncommitted batch snapshots require operator review")
        if not orphaned:
            return []

        batch_id, snapshot, raw, record = orphaned[0]
        if state["pending_batch"] not in (None, batch_id):
            raise JournalError("orphan snapshot conflicts with the pending batch")
        updated = copy.deepcopy(state)
        for role, item in snapshot["sources"].items():
            self._validate_orphan_source(state, role, item)
            source_state = updated["sources"][role]
            source_state["cursor"] = item["end"]
            source_state["prefix_sha256"] = item["prefix_after"]
            source_state["identity"] = item["identity"]
            source_state["observation"] = None
        protocol_only = self._snapshot_is_protocol_only(snapshot)
        if protocol_only:
            record["status"] = "acknowledged"
        updated["batches"][batch_id] = record
        if not protocol_only:
            updated["pending_batch"] = batch_id
        self._write_state(updated)
        return [batch_id]

    def recover_batches(self) -> list[str]:
        """Replay a validated snapshot left before cursor advancement, once."""
        with self._operation_lock():
            state = self._load_unlocked()
            return self._recover_unlocked(state)

    def commit_batch(self, sources: dict, *, batch_id: str | None = None, metadata: dict | None = None) -> str:
        """Persist an immutable snapshot, then atomically advance its cursors.

        A source record has ``start``, ``end``, ``prefix_before``,
        ``prefix_after``, ``identity`` (``(st_dev, st_ino)`` or an equivalent
        mapping), and UTF-8 ``content``; optional ``frame_ids`` are retained.
        The returned ID is deterministic over the campaign and ordered source
        identities/ranges/content hashes.
        """
        with self._operation_lock():
            state = self._load_unlocked()
            self._recover_unlocked(state)
            state = self._load_unlocked()
            if state["hold"] is not None and not state["hold"]["released"]:
                raise JournalError("campaign is held")
            prepared_sources = self._prepare_sources(sources, state)
            expected_id = self._make_batch_id(prepared_sources)
            if batch_id is not None and _batch_id(batch_id) != expected_id:
                raise JournalError("batch ID does not match its source ranges")
            batch_id = expected_id
            if batch_id in state["batches"]:
                self._read_snapshot(batch_id)
                return batch_id
            if state["pending_batch"] is not None:
                raise JournalError("a batch is already pending")
            if any(
                state["sources"][role]["hold"] is not None
                and not state["sources"][role]["hold"]["released"]
                for role in prepared_sources
            ):
                raise JournalError("a batch source is held")
            if metadata is not None:
                metadata = _safe_json_object(
                    metadata, limit=16 * 1024, message="batch snapshot metadata is invalid"
                )
            snapshot = self._snapshot_from_sources(prepared_sources)
            if metadata is not None:
                snapshot["metadata"] = metadata
            encoded = _json_bytes(snapshot, limit=MAX_SNAPSHOT_BYTES, message="batch snapshot is too large")
            self._crash("before_snapshot")

            batch_dir = self._batch_directory(batch_id)
            try:
                check_no_symlinks(self.common_dir, batch_dir, allow_missing=True)
                parent_fd, _ = self._open_directory("watcher/batches")
                try:
                    try:
                        os.mkdir(batch_id, mode=0o700, dir_fd=parent_fd)
                    except FileExistsError:
                        pass
                    os.fsync(parent_fd)
                finally:
                    os.close(parent_fd)
            except JournalError:
                raise
            except (OSError, PathError, ValueError):
                raise JournalError("batch snapshot directory could not be created safely") from None

            snapshot_relative = f"watcher/batches/{batch_id}/snapshot.json"
            snapshot_path = self._path(snapshot_relative)
            snapshot_exists = False
            try:
                check_no_symlinks(self.common_dir, snapshot_path, allow_missing=True)
                try:
                    snapshot_path.lstat()
                    snapshot_exists = True
                except FileNotFoundError:
                    pass
                if snapshot_exists:
                    existing, existing_raw = self._read_snapshot(batch_id)
                    if existing != snapshot or existing_raw != encoded:
                        raise JournalError("batch snapshot is immutable")
                    encoded = existing_raw
                else:
                    self._clear_abandoned_snapshot_temps(batch_id)
                    self._write_json(
                        snapshot_relative,
                        snapshot,
                        limit=MAX_SNAPSHOT_BYTES,
                        message="batch snapshot could not be persisted safely",
                    )
            except JournalError:
                raise
            except (OSError, PathError, ValueError):
                raise JournalError("batch snapshot could not be persisted safely") from None

            self._crash("after_snapshot")
            self._crash("before_cursor_commit")
            updated = copy.deepcopy(state)
            for role, item in prepared_sources.items():
                source_state = updated["sources"][role]
                source_state["cursor"] = item["end"]
                source_state["prefix_sha256"] = item["prefix_after"]
                source_state["identity"] = item["identity"]
                source_state["observation"] = None
            normalized_snapshot = self._normalize_snapshot(snapshot, batch_id)
            record = self._batch_record(normalized_snapshot, encoded)
            protocol_only = self._snapshot_is_protocol_only(normalized_snapshot)
            if protocol_only:
                record["status"] = "acknowledged"
            updated["batches"][batch_id] = record
            if not protocol_only:
                updated["pending_batch"] = batch_id
            self._write_state(updated)
            self._crash("after_cursor_commit")
            return batch_id

    def set_delivery_state(
        self,
        batch_id: str,
        delivery_state: str,
        *,
        receipt: dict | None = None,
        last_attempt_proven_unsent: bool = False,
    ) -> dict:
        """Advance one pending batch without permitting an uncertain resend."""
        batch_id = _batch_id(batch_id)
        if not isinstance(delivery_state, str) or delivery_state not in DELIVERY_STATES:
            raise JournalError("delivery state is invalid")
        if type(last_attempt_proven_unsent) is not bool:
            raise JournalError("delivery certainty is invalid")
        with self._operation_lock():
            state = self._load_unlocked()
            batch = state["batches"].get(batch_id)
            if batch is None:
                raise JournalError("batch is not present in the journal")
            current = batch["status"]
            transitions = {
                "snapshotted": {"send-intent", "held", "failed"},
                "send-intent": {"admitted", "uncertain", "held", "failed"},
                "admitted": {"acknowledged", "held"},
                "uncertain": {"admitted", "held"},
                "held": {"admitted", "uncertain"},
                "failed": set(),
                "acknowledged": set(),
            }
            if delivery_state == current:
                if receipt is not None and batch["receipt"] not in (None, receipt):
                    raise JournalError("delivery receipt is immutable")
                if receipt is None or receipt == batch["receipt"]:
                    return copy.deepcopy(state)
            elif delivery_state not in transitions[current]:
                raise JournalError("delivery state transition is not allowed")
            if delivery_state == "send-intent" and batch_id != state["pending_batch"]:
                raise JournalError("only the pending batch can enter send-intent")
            if last_attempt_proven_unsent and (
                delivery_state != "held"
                or current != "send-intent"
                or not batch["send_intent_recorded"]
            ):
                raise JournalError("proven-unsent state requires an active send intent")
            if delivery_state == "acknowledged" and current != "admitted":
                raise JournalError("only an admitted batch can be acknowledged")
            if receipt is not None:
                receipt = _safe_json_object(
                    receipt, limit=MAX_RECEIPT_BYTES, message="delivery receipt is invalid"
                )
                if batch["receipt"] is not None and batch["receipt"] != receipt:
                    raise JournalError("delivery receipt is immutable")
            updated = copy.deepcopy(state)
            updated_batch = updated["batches"][batch_id]
            updated_batch["status"] = delivery_state
            if delivery_state == "send-intent":
                # This marker is monotonic. Explicit release must never clear
                # evidence that a POST might have been attempted. A release
                # proof applies only to the previous attempt, so reset it
                # before the next helper invocation.
                updated_batch["send_intent_recorded"] = True
                updated_batch["last_attempt_proven_unsent"] = False
            elif last_attempt_proven_unsent:
                updated_batch["last_attempt_proven_unsent"] = True
            elif delivery_state in ("admitted", "uncertain") or current == "send-intent":
                updated_batch["last_attempt_proven_unsent"] = False
            if receipt is not None:
                updated_batch["receipt"] = receipt
            if delivery_state in ("uncertain", "held"):
                fingerprint = hashlib.sha256(f"{self.campaign_id}:{batch_id}:{delivery_state}".encode()).hexdigest()
                updated_batch["hold"] = {
                    "reason": "delivery outcome requires operator review",
                    "fingerprint": fingerprint,
                    "notice_emitted": False,
                    "released": False,
                }
            if delivery_state == "acknowledged":
                if updated["pending_batch"] != batch_id:
                    raise JournalError("acknowledged batch is not pending")
                updated["pending_batch"] = None
            self._write_state(updated)
            return copy.deepcopy(updated)

    def _hold_location(self, state: dict, *, source=None, batch_id=None):
        if source is not None and batch_id is not None:
            raise JournalError("select either a source or a batch hold")
        if source is not None:
            if source not in SOURCE_ROLES:
                raise JournalError("source role is invalid")
            return state["sources"][source], "hold"
        if batch_id is not None:
            batch_id = _batch_id(batch_id)
            batch = state["batches"].get(batch_id)
            if batch is None:
                raise JournalError("batch is not present in the journal")
            return batch, "hold"
        return state, "hold"

    def set_hold(
        self,
        reason: str,
        *,
        source: str | None = None,
        batch_id: str | None = None,
        fingerprint: str | None = None,
        notice_emitted: bool = False,
    ) -> dict:
        """Set or reaffirm a campaign/source/batch hold and return its notice state."""
        if (
            not isinstance(reason, str)
            or not reason
            or len(reason) > 256
            or any(ord(character) < 32 or ord(character) == 127 for character in reason)
        ):
            raise JournalError("hold reason is invalid")
        try:
            _scan_credentials({"reason": reason})
        except ConfigError:
            raise JournalError("hold reason contains disallowed data") from None
        if _HOLD_SECRET_ASSIGNMENT.search(reason):
            raise JournalError("hold reason contains disallowed data")
        if type(notice_emitted) is not bool:
            raise JournalError("hold notice state is invalid")
        fingerprint = _digest(fingerprint) if fingerprint is not None else hashlib.sha256(reason.encode("utf-8")).hexdigest()
        with self._operation_lock():
            state = self._load_unlocked()
            target, key = self._hold_location(state, source=source, batch_id=batch_id)
            previous = target[key]
            if previous is not None and previous["fingerprint"] == fingerprint:
                record = copy.deepcopy(previous)
                record["reason"] = reason
                record["released"] = False
                record["notice_emitted"] = previous["notice_emitted"] or notice_emitted
            else:
                record = {
                    "reason": reason,
                    "fingerprint": fingerprint,
                    "notice_emitted": notice_emitted,
                    "released": False,
                }
            target[key] = record
            self._write_state(state)
            return {
                "hold": copy.deepcopy(record),
                "should_notify": not record["notice_emitted"],
            }

    def mark_hold_notice(self, *, source: str | None = None, batch_id: str | None = None) -> dict:
        """Record that the current unchanged hold already emitted its one notice."""
        with self._operation_lock():
            state = self._load_unlocked()
            target, key = self._hold_location(state, source=source, batch_id=batch_id)
            record = target[key]
            if record is None:
                raise JournalError("there is no hold to mark")
            record["notice_emitted"] = True
            self._write_state(state)
            return copy.deepcopy(record)

    def release_hold(self, *, source: str | None = None, batch_id: str | None = None) -> bool:
        """Release a hold without erasing send history or authorizing blind POSTs.

        A held batch returns to ``snapshotted`` only when no intent was ever
        recorded or the latest attempt has a validated no-POST proof. The
        monotonic intent marker is retained. Other histories become
        ``uncertain`` and a later explicit delivery operation can only reconcile.
        """
        with self._operation_lock():
            state = self._load_unlocked()
            target, key = self._hold_location(state, source=source, batch_id=batch_id)
            record = target[key]
            if record is None or record["released"]:
                return False
            record["released"] = True
            if batch_id is not None:
                batch = state["batches"][batch_id]
                if batch["status"] == "held":
                    batch["status"] = (
                        "uncertain"
                        if (
                            batch["send_intent_recorded"]
                            and not batch["last_attempt_proven_unsent"]
                        )
                        else "snapshotted"
                    )
            self._write_state(state)
            return True
