#!/usr/bin/env python3
"""Bounded explicit-server and managed-local transport for Overseer notices."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import subprocess
import threading
import time
from typing import Callable
from urllib.parse import parse_qsl, quote, urlsplit

from overseer_relay.config import (
    CampaignConfig,
    ConfigError,
    ManagedConnection,
    goal_resume_target,
    notices_deliverable,
    parse_config,
    to_json_dict,
)
from overseer_relay.journal import (
    JournalError,
    MAX_RESUME_LEDGER_BYTES,
    MAX_RESUME_LEDGER_RECORDS,
)
from overseer_relay.paths import PathError, confine_relative


MAX_API_STDOUT_BYTES = 256 * 1024
MAX_API_STDERR_BYTES = 16 * 1024
MAX_API_INPUT_BYTES = 64 * 1024
MAX_API_ARGUMENTS = 32
# Covers a 16 KiB notice after JSON string escaping plus the maximum validated
# pinned-server routing arguments, while remaining far below OS argv limits.
MAX_API_ARGUMENT_BYTES = 48 * 1024
READ_CHUNK_BYTES = 8192
MAX_RECONCILIATION_MESSAGE_PAGES = 10
MAX_RECONCILIATION_PAGE_ITEMS = 100
MAX_RECONCILIATION_INBOX_ITEMS = 1000
MAX_RECONCILIATION_CURSOR_BYTES = 512
MAX_RECONCILIATION_METADATA_BYTES = 16 * 1024
MAX_MANAGED_MANIFEST_BYTES = 64 * 1024
MAX_MANAGED_ARTIFACTS = 128
MAX_MANAGED_ARTIFACT_BYTES = 2 * 1024 * 1024
MAX_MANAGED_TOTAL_ARTIFACT_BYTES = 4 * 1024 * 1024
MAX_MANAGED_PROMPT_BYTES = 16 * 1024

_MANAGED_BATCH_ID = re.compile(r"b-[0-9a-f]{64}\Z", re.ASCII)
_MANAGED_CAMPAIGN_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z", re.ASCII)
_MANAGED_VERSION = re.compile(
    r"\d{1,4}\.\d{1,4}(?:\.\d{1,4})?(?:[-+][A-Za-z0-9.-]{1,32})?\Z",
    re.ASCII,
)
_SHA256 = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_RESUME_RULING_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z", re.ASCII)

_MANAGED_HELPER_CODES = frozenset(
    {
        "input_invalid",
        "input_too_large",
        "service_missing",
        "identity_mismatch",
        "timeout",
        "response_invalid",
        "response_too_large",
        "contract_invalid",
        "session_binding_mismatch",
        "request_failed",
        "redirect_blocked",
        "post_failed",
        "output_too_large",
        "operation_failed",
    }
)
_MANAGED_HELPER_MESSAGES = {
    "input_invalid": "Managed helper input is invalid",
    "input_too_large": "Managed helper input exceeded the size limit",
    "service_missing": "Managed service is unavailable",
    "identity_mismatch": "Managed service identity does not match configuration",
    "timeout": "OpenCode API request timed out",
    "response_invalid": "Managed service response is invalid",
    "response_too_large": "Managed service response exceeded the size limit",
    "contract_invalid": "Managed service API contract is incompatible",
    "session_binding_mismatch": "Overseer session identity does not match configuration",
    "request_failed": "Managed API request failed",
    "redirect_blocked": "Managed service redirect was blocked",
    "post_failed": "Managed prompt request failed",
    "output_too_large": "Managed helper output exceeded the size limit",
    "operation_failed": "Managed helper operation failed",
}

_PRE_POST_RETRYABLE_ERRORS = frozenset(
    {
        "OpenCode API request timed out",
        "OpenCode API command could not be started",
        "OpenCode API command failed",
    }
)


class TransportError(RuntimeError):
    """A bounded, value-free transport or identity failure."""

    def __init__(self, message: str, *, code: str | None = None, post_started=None):
        super().__init__(message)
        # Managed-helper failures retain only the fixed protocol enum and its
        # POST-start certainty bit.  Neither attribute contains provider text.
        self.code = code
        self.post_started = post_started


_SAFE_RUNNER_ERRORS = frozenset(
    {
        "OpenCode API command arguments are invalid",
        "OpenCode API timeout is invalid",
        "OpenCode API input is invalid",
        "OpenCode API input exceeded the size limit",
        "OpenCode API command could not be started",
        "OpenCode API command did not close its pipes",
        "OpenCode API request timed out",
        "OpenCode API output exceeded the size limit",
        "OpenCode API command failed",
    }
)


@dataclass(frozen=True)
class CommandResult:
    """Bounded subprocess output; raw fields stay internal to preflight."""

    returncode: int
    stdout: bytes
    stderr: bytes


@dataclass(frozen=True)
class SessionIdentity:
    """Only the qualified, non-archived identity needed by the relay."""

    session_id: str
    agent: str
    directory: str
    archived: bool = False


class _JSONObject(dict):
    """Object-pairs hook that preserves duplicate-key evidence."""

    def __init__(self, pairs):
        super().__init__()
        self.duplicate_keys = []
        for key, value in pairs:
            if key in self:
                self.duplicate_keys.append(key)
            else:
                self[key] = value


def _reject_json_constant(_value):
    raise ValueError("non-finite JSON number")


def _kill_process_group(process: subprocess.Popen) -> None:
    """Stop only the isolated process group created for the command."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        try:
            process.kill()
        except OSError:
            pass


def subprocess_runner(argv, *, timeout=None, input=None) -> CommandResult:
    """Run an argument array with bounded output and a hard timeout.

    Output is drained concurrently but retained only up to the per-stream
    limits.  An over-limit child is killed instead of allowing communicate()
    to accumulate unbounded output in memory.
    """
    if (
        not isinstance(argv, (list, tuple))
        or not argv
        or len(argv) > MAX_API_ARGUMENTS
        or any(not isinstance(arg, str) or not arg or "\x00" in arg for arg in argv)
    ):
        raise TransportError("OpenCode API command arguments are invalid")
    try:
        argv_bytes = sum(len(arg.encode("utf-8", errors="strict")) for arg in argv)
    except (UnicodeError, AttributeError):
        raise TransportError("OpenCode API command arguments are invalid") from None
    if argv_bytes > MAX_API_ARGUMENT_BYTES:
        raise TransportError("OpenCode API command arguments are invalid")
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
        raise TransportError("OpenCode API timeout is invalid")

    payload = None
    if input is not None:
        if isinstance(input, str):
            try:
                payload = input.encode("utf-8", errors="strict")
            except UnicodeError:
                raise TransportError("OpenCode API input is invalid") from None
        elif isinstance(input, bytes):
            payload = input
        else:
            raise TransportError("OpenCode API input is invalid")
        if len(payload) > MAX_API_INPUT_BYTES:
            raise TransportError("OpenCode API input exceeded the size limit")

    try:
        process = subprocess.Popen(
            list(argv),
            shell=False,
            stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
            start_new_session=True,
        )
    except (OSError, ValueError, TypeError):
        raise TransportError("OpenCode API command could not be started") from None

    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": MAX_API_STDOUT_BYTES, "stderr": MAX_API_STDERR_BYTES}
    output_exceeded = threading.Event()
    stream_failed = threading.Event()

    def drain(name, stream):
        try:
            while True:
                chunk = stream.read(READ_CHUNK_BYTES)
                if not chunk:
                    return
                buffer = buffers[name]
                room = limits[name] - len(buffer)
                if len(chunk) <= room:
                    buffer.extend(chunk)
                else:
                    if room > 0:
                        buffer.extend(chunk[:room])
                    output_exceeded.set()
                    _kill_process_group(process)
        except (OSError, ValueError):
            stream_failed.set()

    readers = [
        threading.Thread(target=drain, args=(name, getattr(process, name)), daemon=True)
        for name in ("stdout", "stderr")
    ]
    for reader in readers:
        reader.start()

    writer = None
    if payload is not None:
        def write_input():
            try:
                process.stdin.write(payload)
                process.stdin.flush()
            except (BrokenPipeError, OSError, ValueError):
                pass
            finally:
                try:
                    process.stdin.close()
                except (OSError, ValueError):
                    pass

        writer = threading.Thread(target=write_input, daemon=True)
        writer.start()

    timed_out = False
    try:
        process.wait(timeout=float(timeout))
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_process_group(process)
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except OSError:
                pass
            process.wait()

    for reader in readers:
        reader.join(timeout=1)
    if writer is not None:
        writer.join(timeout=1)

    if any(reader.is_alive() for reader in readers) or (writer is not None and writer.is_alive()):
        _kill_process_group(process)
        for reader in readers:
            reader.join(timeout=1)
        if writer is not None:
            writer.join(timeout=1)
    for stream in (process.stdout, process.stderr):
        try:
            stream.close()
        except (OSError, ValueError):
            pass
    if any(reader.is_alive() for reader in readers) or (writer is not None and writer.is_alive()):
        _kill_process_group(process)
        raise TransportError("OpenCode API command did not close its pipes")
    if timed_out:
        raise TransportError("OpenCode API request timed out")
    if output_exceeded.is_set():
        raise TransportError("OpenCode API output exceeded the size limit")
    if stream_failed.is_set():
        raise TransportError("OpenCode API command failed")
    return CommandResult(
        returncode=process.returncode,
        stdout=bytes(buffers["stdout"]),
        stderr=bytes(buffers["stderr"]),
    )


def _checked_config(config: CampaignConfig) -> CampaignConfig:
    if not isinstance(config, CampaignConfig):
        raise TransportError("Campaign configuration is invalid for transport")
    try:
        return parse_config(to_json_dict(config))
    except (ConfigError, TypeError, ValueError, KeyError, AttributeError):
        raise TransportError("Campaign configuration is invalid for transport") from None


def _pinned_server(config: CampaignConfig) -> str:
    connection = config.connection
    if not isinstance(connection, tuple):
        raise TransportError("Pinned server configuration is invalid")
    if len(connection) == 2 and connection[0] == "--server":
        server = connection[1]
    elif len(connection) == 1 and connection[0].startswith("--server="):
        server = connection[0][len("--server=") :]
    else:
        raise TransportError("Pinned server configuration is invalid")
    try:
        parsed = urlsplit(server)
        valid = (
            parsed.scheme in ("http", "https")
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and not parsed.fragment
        )
        _ = parsed.port
    except (TypeError, ValueError, UnicodeError):
        valid = False
    if not valid:
        raise TransportError("Pinned server configuration is invalid")
    return server


def _managed_helper_path() -> Path:
    """Resolve the fixed helper below this package, never from config/env."""
    package_root = Path(os.path.abspath(__file__)).parent.parent.parent
    return package_root / "managed" / "dist" / "relay-managed.mjs"


def _safe_absolute_path_kind(path, *, final_kind: str) -> bool:
    """Check every path component with lstat, rejecting all symlink aliases."""
    try:
        raw_path = os.fspath(path)
        if not isinstance(raw_path, str) or not os.path.isabs(raw_path):
            return False
        if os.path.normpath(raw_path) != raw_path:
            return False
        candidate = Path(raw_path)
        components = candidate.parts[1:]
        if not components:
            return final_kind == "directory"
        current = Path(candidate.anchor)
        for index, component in enumerate(components):
            current = current / component
            mode = os.lstat(current).st_mode
            if stat.S_ISLNK(mode):
                return False
            is_final = index == len(components) - 1
            if not is_final and not stat.S_ISDIR(mode):
                return False
            if is_final:
                if final_kind == "directory" and not stat.S_ISDIR(mode):
                    return False
                if final_kind == "file" and not stat.S_ISREG(mode):
                    return False
        return True
    except (OSError, RuntimeError, TypeError, ValueError):
        return False


def _safe_artifact_relative_path(value) -> bool:
    if not isinstance(value, str) or not value or len(value) > 512 or "\\" in value:
        return False
    if value.startswith("/") or any(
        not part or part in (".", "..") or re.fullmatch(r"[A-Za-z0-9._-]+", part, re.ASCII) is None
        for part in value.split("/")
    ):
        return False
    return True


def _read_safe_regular_file(path: Path, *, maximum: int) -> bytes:
    """Read a bounded regular file without following a final-component link."""
    if not _safe_absolute_path_kind(path, final_kind="file"):
        raise ValueError("unsafe file")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_size > maximum:
            raise ValueError("invalid file")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            content = stream.read(maximum + 1)
        if len(content) > maximum:
            raise ValueError("oversized file")
        return content
    finally:
        os.close(descriptor)


def _managed_dist_files(root: Path) -> set[str]:
    """Enumerate a small dist tree without following links or special files."""
    files = set()
    pending = [(root, "")]
    visited = 0
    while pending:
        directory, prefix = pending.pop()
        if not _safe_absolute_path_kind(directory, final_kind="directory"):
            raise ValueError("unsafe directory")
        with os.scandir(directory) as entries:
            for entry in entries:
                visited += 1
                if visited > MAX_MANAGED_ARTIFACTS * 2:
                    raise ValueError("artifact tree is too large")
                relative = f"{prefix}/{entry.name}" if prefix else entry.name
                if not _safe_artifact_relative_path(relative):
                    raise ValueError("unsafe artifact path")
                mode = entry.stat(follow_symlinks=False).st_mode
                if stat.S_ISLNK(mode):
                    raise ValueError("symlink artifact")
                path = directory / entry.name
                if stat.S_ISDIR(mode):
                    pending.append((path, relative))
                elif stat.S_ISREG(mode):
                    files.add(relative)
                    if len(files) > MAX_MANAGED_ARTIFACTS + 1:
                        raise ValueError("artifact tree is too large")
                else:
                    raise ValueError("special artifact")
    return files


def _verify_managed_helper() -> Path:
    """Verify the fixed managed ESM inventory before allowing a child launch."""
    try:
        helper = _managed_helper_path()
    except Exception:
        raise TransportError(
            "Managed helper artifact inventory is invalid", code="helper_invalid"
        ) from None
    try:
        os.lstat(helper)
    except FileNotFoundError:
        raise TransportError("Managed helper is unavailable", code="helper_missing") from None
    except (OSError, TypeError, ValueError):
        raise TransportError(
            "Managed helper artifact inventory is invalid", code="helper_invalid"
        ) from None
    try:
        root = helper.parent
        if (
            helper.name != "relay-managed.mjs"
            or root.name != "dist"
            or root.parent.name != "managed"
            or not _safe_absolute_path_kind(root, final_kind="directory")
            or not _safe_absolute_path_kind(helper, final_kind="file")
        ):
            raise ValueError("unsafe helper path")

        manifest_path = root / "artifact-manifest.json"
        manifest_bytes = _read_safe_regular_file(
            manifest_path, maximum=MAX_MANAGED_MANIFEST_BYTES
        )
        manifest = _decode_api_json(manifest_bytes)
        if (
            not isinstance(manifest, dict)
            or set(manifest) != {"schemaVersion", "hashAlgorithm", "files"}
            or type(manifest["schemaVersion"]) is not int
            or manifest["schemaVersion"] != 1
            or manifest["hashAlgorithm"] != "SHA-256"
            or not isinstance(manifest["files"], list)
            or not 1 <= len(manifest["files"]) <= MAX_MANAGED_ARTIFACTS
        ):
            raise ValueError("invalid manifest")

        expected = {}
        previous_path = None
        total_size = 0
        for entry in manifest["files"]:
            if (
                not isinstance(entry, dict)
                or set(entry) != {"path", "size", "sha256"}
                or not _safe_artifact_relative_path(entry["path"])
                or entry["path"] == "artifact-manifest.json"
                or type(entry["size"]) is not int
                or not 0 <= entry["size"] <= MAX_MANAGED_ARTIFACT_BYTES
                or not isinstance(entry["sha256"], str)
                or _SHA256.fullmatch(entry["sha256"]) is None
            ):
                raise ValueError("invalid manifest entry")
            relative = entry["path"]
            if relative in expected or (previous_path is not None and relative <= previous_path):
                raise ValueError("unordered or duplicate manifest path")
            previous_path = relative
            total_size += entry["size"]
            if total_size > MAX_MANAGED_TOTAL_ARTIFACT_BYTES:
                raise ValueError("artifact inventory is too large")
            expected[relative] = (entry["size"], entry["sha256"])

        if "relay-managed.mjs" not in expected:
            raise ValueError("helper entry is not inventoried")
        actual = _managed_dist_files(root)
        if actual != set(expected) | {"artifact-manifest.json"}:
            raise ValueError("artifact inventory does not match dist")

        for relative, (expected_size, expected_hash) in expected.items():
            artifact = root.joinpath(*relative.split("/"))
            content = _read_safe_regular_file(
                artifact, maximum=MAX_MANAGED_ARTIFACT_BYTES
            )
            if (
                len(content) != expected_size
                or hashlib.sha256(content).hexdigest() != expected_hash
            ):
                raise ValueError("artifact hash mismatch")
        return helper
    except Exception:
        # Paths, manifests, and artifact bytes are not safe diagnostic input.
        raise TransportError(
            "Managed helper artifact inventory is invalid", code="helper_invalid"
        ) from None


def _managed_error(code: str, *, post_started: bool) -> TransportError:
    message = _MANAGED_HELPER_MESSAGES[code]
    return TransportError(message, code=code, post_started=post_started)


def _managed_metadata(value, *, campaign: str | None = None, batch_id: str | None = None) -> bool:
    if not isinstance(value, dict):
        return False
    if not value:
        return campaign is None and batch_id is None
    if set(value) != {"overseerRelay"}:
        return False
    relay = value["overseerRelay"]
    if (
        not isinstance(relay, dict)
        or set(relay) != {"campaign", "batchId"}
        or not _valid_text(relay["campaign"], maximum=64)
        or _MANAGED_CAMPAIGN_ID.fullmatch(relay["campaign"]) is None
        or not _valid_text(relay["batchId"], maximum=66)
        or _MANAGED_BATCH_ID.fullmatch(relay["batchId"]) is None
    ):
        return False
    if campaign is not None and relay["campaign"] != campaign:
        return False
    if batch_id is not None and relay["batchId"] != batch_id:
        return False
    return True


def _validate_managed_projection(value, *, operation: str, campaign: str, batch_id=None) -> None:
    """Reject any helper output outside its exact, content-free projection."""
    if not isinstance(value, dict):
        raise TransportError("Managed helper response is invalid", code="operation_failed")

    def invalid():
        raise TransportError("Managed helper response is invalid", code="operation_failed")

    if operation == "session":
        if set(value) != {"data"}:
            invalid()
        session = value["data"]
        if (
            not isinstance(session, dict)
            or not {"id", "agent", "location", "time"}.issubset(session)
            or not set(session).issubset({"id", "agent", "location", "time", "subpath"})
            or not isinstance(session["location"], dict)
            or set(session["location"]) != {"directory"}
            or not isinstance(session["time"], dict)
            or not {"created", "updated"}.issubset(session["time"])
            or not set(session["time"]).issubset({"created", "updated", "archived"})
        ):
            invalid()
        return

    if operation == "inbox":
        if set(value) != {"data"} or not isinstance(value["data"], list) or len(value["data"]) > 256:
            invalid()
        for item in value["data"]:
            if (
                not isinstance(item, dict)
                or set(item) != {"id", "sessionID", "type", "time", "delivery", "payload"}
                or not isinstance(item["time"], dict)
                or set(item["time"]) != {"created"}
                or not isinstance(item["payload"], dict)
                or set(item["payload"]) != {"text", "metadata"}
                or item["payload"]["text"] != ""
                or item["type"] != "user"
                or item["delivery"] not in ("queue", "steer")
                or not _managed_metadata(item["payload"]["metadata"])
            ):
                invalid()
        return

    if operation == "messages":
        if (
            set(value) != {"data", "cursor"}
            or not isinstance(value["data"], list)
            or len(value["data"]) > MAX_RECONCILIATION_PAGE_ITEMS
            or not isinstance(value["cursor"], dict)
            or set(value["cursor"]) != {"previous", "next"}
        ):
            invalid()
        for item in value["data"]:
            if (
                not isinstance(item, dict)
                or set(item) != {"id", "sessionID", "type", "time", "text", "metadata"}
                or item["type"] != "user"
                or not isinstance(item["time"], dict)
                or set(item["time"]) != {"created"}
                or item["text"] != ""
                or not _managed_metadata(item["metadata"])
            ):
                invalid()
        return

    if operation == "prompt":
        receipt = value.get("data")
        if (
            set(value) != {"data"}
            or not isinstance(receipt, dict)
            or set(receipt) != {"id", "sessionID", "type", "time", "delivery", "payload"}
            or receipt["type"] != "user"
            or receipt["delivery"] != "queue"
            or not isinstance(receipt["time"], dict)
            or set(receipt["time"]) != {"created"}
            or not isinstance(receipt["payload"], dict)
            or set(receipt["payload"]) != {"metadata"}
            or not _managed_metadata(
                receipt["payload"]["metadata"], campaign=campaign, batch_id=batch_id
            )
        ):
            invalid()
        return

    if operation == "resume_goal":
        if (
            set(value) != {"delivered"}
            or type(value["delivered"]) is not bool
            or value["delivered"] is not True
        ):
            invalid()
        return

    invalid()


def _managed_operation(config: CampaignConfig, method: str, route: str, data):
    """Translate an existing internal API request into one fixed helper op."""
    binding = config.roles["overseer"]
    session_id = binding.session_id
    if session_id is None or binding.directory is None or binding.agent is None:
        raise TransportError("Overseer binding is incomplete")
    base = f"/api/session/{session_id}"

    if method == "get" and route == base and data is None:
        return "session", None, None
    if method == "get" and route == f"{base}/inbox" and data is None:
        return "inbox", None, None
    if method == "get" and data is None:
        try:
            parsed = urlsplit(route)
            if (
                parsed.scheme
                or parsed.netloc
                or parsed.fragment
                or parsed.path != f"{base}/message"
            ):
                raise ValueError("route")
            pairs = parse_qsl(
                parsed.query,
                keep_blank_values=True,
                strict_parsing=True,
                max_num_fields=3,
            )
        except (TypeError, ValueError, UnicodeError):
            pairs = []
            parsed = None
        if pairs == [("type", "user"), ("limit", "100"), ("order", "desc")]:
            if route == f"{base}/message?type=user&limit=100&order=desc":
                return "messages", None, {"cursor": None}
        elif (
            len(pairs) == 3
            and pairs[0] == ("type", "user")
            and pairs[1] == ("limit", "100")
            and pairs[2][0] == "cursor"
            and parsed is not None
        ):
            cursor = pairs[2][1]
            if (
                _valid_text(cursor, maximum=MAX_RECONCILIATION_CURSOR_BYTES)
                and route == f"{base}/message?type=user&limit=100&cursor={quote(cursor, safe='')}"
            ):
                return "messages", None, {"cursor": cursor}

    if method == "post" and route == f"{base}/prompt" and isinstance(data, str):
        try:
            raw = _output_bytes(data, maximum=MAX_API_INPUT_BYTES)
            body = _decode_api_json(raw)
        except TransportError:
            raise TransportError("Managed prompt request is invalid", code="input_invalid") from None
        if (
            not isinstance(body, dict)
            or set(body) != {"text", "delivery", "resume", "metadata"}
            or body["delivery"] != "queue"
            or body["resume"] is not True
            or not isinstance(body["text"], str)
        ):
            raise TransportError("Managed prompt request is invalid", code="input_invalid")
        try:
            prompt_bytes = body["text"].encode("utf-8", errors="strict")
            _message_text(body["text"])
        except (TransportError, UnicodeError):
            raise TransportError("Managed prompt request is invalid", code="input_invalid") from None
        if len(prompt_bytes) > MAX_MANAGED_PROMPT_BYTES:
            raise TransportError("Managed prompt request is invalid", code="input_invalid")
        metadata = body["metadata"]
        if (
            not isinstance(metadata, dict)
            or set(metadata) != {"overseerRelay"}
            or not isinstance(metadata["overseerRelay"], dict)
            or set(metadata["overseerRelay"]) != {"campaign", "batchId"}
        ):
            raise TransportError("Managed prompt request is invalid", code="input_invalid")
        identity = metadata["overseerRelay"]
        batch_id = identity["batchId"]
        if (
            identity["campaign"] != config.campaign_id
            or not isinstance(batch_id, str)
            or _MANAGED_BATCH_ID.fullmatch(batch_id) is None
        ):
            raise TransportError("Managed prompt request is invalid", code="input_invalid")
        return "prompt", batch_id, {"text": body["text"], "batch_id": batch_id}

    raise TransportError("Managed API operation is not allowed", code="input_invalid")


def _managed_api_request(
    config: CampaignConfig,
    runner: Callable | None,
    method: str,
    route: str,
    *,
    data: str | None = None,
    _worker_role: str | None = None,
):
    try:
        if _worker_role is None:
            operation, batch_id, operation_data = _managed_operation(
                config, method, route, data
            )
            binding = config.roles["overseer"]
        else:
            if (
                _worker_role not in ("A", "B")
                or method != "post"
                or _worker_role not in config.roles
                or data is not None
            ):
                raise TransportError(
                    "Managed goal-resume operation is invalid", code="input_invalid"
                )
            binding = config.roles[_worker_role]
            if (
                binding.session_id is None
                or route != f"/api/session/{binding.session_id}/command"
            ):
                raise TransportError(
                    "Managed goal-resume operation is invalid", code="input_invalid"
                )
            operation, batch_id, operation_data = "resume_goal", None, None
        helper = _verify_managed_helper()
        timeout_ms = min(30000, max(50, int(config.limits.api_timeout_seconds * 1000)))
        connection = {
            "mode": "managed-local",
            "expected_url": config.connection.expected_url,
        }
        if config.connection.expected_pid is not None:
            connection["expected_pid"] = config.connection.expected_pid
        request = {
            "schema_version": 1,
            "operation": operation,
            "connection": connection,
            "binding": {
                "session_id": binding.session_id,
                "directory": binding.directory,
                "agent": binding.agent,
            },
            "campaign": config.campaign_id,
            "timeout_ms": timeout_ms,
        }
        if operation == "messages":
            request["cursor"] = operation_data["cursor"]
        elif operation == "prompt":
            request["data"] = operation_data
        encoded_input = json.dumps(
            request,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise TransportError(
            "Managed helper input is invalid",
            code="input_invalid",
            post_started=False if method == "post" else None,
        ) from None
    except TransportError as error:
        # These checks all precede the helper launch.  Only this explicit
        # control-flow fact, not a diagnostic string, can prove a managed
        # prompt was not posted.
        raise TransportError(
            str(error),
            code=error.code,
            post_started=False if method == "post" else error.post_started,
        ) from None
    try:
        encoded_size = len(encoded_input.encode("utf-8", errors="strict"))
    except UnicodeError:
        raise TransportError(
            "Managed helper input is invalid",
            code="input_invalid",
            post_started=False if method == "post" else None,
        ) from None
    if encoded_size > MAX_API_INPUT_BYTES:
        raise TransportError(
            "Managed helper input exceeded the size limit",
            code="input_too_large",
            post_started=False if method == "post" else None,
        )

    selected_runner = subprocess_runner if runner is None else runner
    timeout_seconds = min(float(config.limits.api_timeout_seconds), 30.0)
    post_started_unknown = None if operation in ("prompt", "resume_goal") else False
    try:
        result = selected_runner(
            ["node", str(helper)],
            timeout=timeout_seconds,
            input=encoded_input,
        )
    except (subprocess.TimeoutExpired, TimeoutError):
        raise TransportError(
            "OpenCode API request timed out", code="timeout", post_started=post_started_unknown
        ) from None
    except TransportError as error:
        message = str(error)
        if type(error) is TransportError and message in _SAFE_RUNNER_ERRORS:
            post_started = post_started_unknown
            if operation == "resume_goal" and message in {
                "OpenCode API command arguments are invalid",
                "OpenCode API timeout is invalid",
                "OpenCode API input is invalid",
                "OpenCode API input exceeded the size limit",
                "OpenCode API command could not be started",
            }:
                post_started = False
            raise TransportError(
                message,
                code="timeout" if message == "OpenCode API request timed out" else "operation_failed",
                post_started=post_started,
            ) from None
        raise TransportError(
            "OpenCode API command failed",
            code="operation_failed",
            post_started=post_started_unknown,
        ) from None
    except Exception:
        raise TransportError(
            "OpenCode API command failed",
            code="operation_failed",
            post_started=post_started_unknown,
        ) from None

    try:
        returncode = result.returncode
        stdout = result.stdout
        stderr = result.stderr
    except Exception:
        raise TransportError(
            "Managed helper response is invalid",
            code="operation_failed",
            post_started=post_started_unknown,
        ) from None
    stdout_bytes = _output_bytes(stdout, maximum=MAX_API_STDOUT_BYTES)
    _output_bytes(stderr, maximum=MAX_API_STDERR_BYTES)
    if type(returncode) is not int:
        raise TransportError(
            "Managed helper response is invalid",
            code="operation_failed",
            post_started=post_started_unknown,
        )
    response = _decode_api_json(stdout_bytes)
    if not isinstance(response, dict) or type(response.get("ok")) is not bool:
        raise TransportError(
            "Managed helper response is invalid",
            code="operation_failed",
            post_started=post_started_unknown,
        )
    if response["ok"] is False:
        if (
            set(response) != {"ok", "code", "post_started"}
            or returncode != 1
            or not isinstance(response["code"], str)
            or response["code"] not in _MANAGED_HELPER_CODES
            or type(response["post_started"]) is not bool
            or (response["post_started"] and operation not in ("prompt", "resume_goal"))
        ):
            raise TransportError(
                "Managed helper response is invalid",
                code="operation_failed",
                post_started=post_started_unknown,
            )
        raise _managed_error(response["code"], post_started=response["post_started"])

    if (
        set(response) != {"ok", "data", "host_version"}
        or returncode != 0
        or not isinstance(response["host_version"], str)
        or len(response["host_version"]) > 64
        or _MANAGED_VERSION.fullmatch(response["host_version"]) is None
    ):
        raise TransportError(
            "Managed helper response is invalid",
            code="operation_failed",
            post_started=post_started_unknown,
        )
    _validate_managed_projection(
        response["data"],
        operation=operation,
        campaign=config.campaign_id,
        batch_id=batch_id,
    )
    # host_version is safe, informational metadata; compatibility was already
    # determined by helper identity and API-contract qualification.
    return response["data"]


def _output_bytes(value, *, maximum=MAX_API_STDOUT_BYTES) -> bytes:
    if isinstance(value, bytes):
        if len(value) > maximum:
            raise TransportError("OpenCode API output exceeded the size limit")
        return value
    if isinstance(value, str) and len(value) <= maximum:
        try:
            encoded = value.encode("utf-8", errors="strict")
        except UnicodeError:
            raise TransportError("OpenCode API response is invalid") from None
        if len(encoded) > maximum:
            raise TransportError("OpenCode API output exceeded the size limit")
        return encoded
    if isinstance(value, str):
        raise TransportError("OpenCode API output exceeded the size limit")
    raise TransportError("OpenCode API response is invalid")


def _has_duplicate_keys(root) -> bool:
    pending = [root]
    while pending:
        current = pending.pop()
        if isinstance(current, _JSONObject):
            if current.duplicate_keys:
                return True
            pending.extend(current.values())
        elif isinstance(current, list):
            pending.extend(current)
    return False


def _decode_session_info(stdout) -> dict:
    raw = _output_bytes(stdout, maximum=MAX_API_STDOUT_BYTES)
    try:
        text = raw.decode("utf-8", errors="strict")
        response = json.loads(
            text,
            object_pairs_hook=_JSONObject,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeError, json.JSONDecodeError, ValueError, RecursionError):
        raise TransportError("OpenCode API response is invalid") from None
    if _has_duplicate_keys(response):
        raise TransportError("OpenCode API response is invalid")
    if not isinstance(response, dict) or set(response) != {"data"}:
        raise TransportError("OpenCode API response is invalid")
    info = response["data"]
    if not isinstance(info, dict):
        raise TransportError("OpenCode API response is invalid")
    return info


def _valid_text(value, *, maximum=4096) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and len(value) <= maximum
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)
    )


def _check_local_path(path: str) -> bool:
    """Reject non-canonical paths and any locally inspectable symlink drift."""
    try:
        if not os.path.isabs(path) or os.path.normpath(path) != path:
            return False
        if os.path.realpath(path) != path:
            return False
        current = Path(os.path.abspath(os.sep))
        # Path(path).parts starts with the root anchor.  Inspect each existing
        # component without following it; a missing component means the rest
        # cannot currently be checked, which is valid for a remote server path.
        components = Path(path).parts[1:]
        for index, component in enumerate(components):
            current = current / component
            try:
                mode = os.lstat(current).st_mode
            except FileNotFoundError:
                break
            if stat.S_ISLNK(mode):
                return False
            if index == len(components) - 1 and not stat.S_ISDIR(mode):
                return False
        return True
    except (OSError, RuntimeError, TypeError, ValueError):
        return False


def _session_directory(info: dict) -> str:
    location = info.get("location")
    if not isinstance(location, dict):
        raise TransportError("Overseer session directory is invalid")
    base = location.get("directory")
    if not _valid_text(base) or not _check_local_path(base):
        raise TransportError("Overseer session directory is invalid")

    if "subpath" not in info:
        actual = base
    else:
        subpath = info["subpath"]
        if (
            not _valid_text(subpath)
            or subpath.startswith("/")
            or "\\" in subpath
            or any(part in ("", ".", "..") for part in subpath.split("/"))
        ):
            raise TransportError("Overseer session directory is invalid")
        actual = os.path.join(base, *subpath.split("/"))
        try:
            if os.path.commonpath((base, actual)) != base:
                raise TransportError("Overseer session directory is invalid")
        except (OSError, ValueError):
            raise TransportError("Overseer session directory is invalid") from None

    if not _check_local_path(actual):
        raise TransportError("Overseer session directory is invalid")
    return actual


def _timestamp(value) -> int | float | None:
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        return None
    return value


def _session_identity(info: dict, binding) -> SessionIdentity:
    # The public Session.Info shape uses location.directory plus optional
    # top-level subpath.  Refuse the legacy/guessed top-level directory shape.
    if "directory" in info or "archived" in info:
        raise TransportError("OpenCode API response is invalid")

    session_id = info.get("id")
    if not _valid_text(session_id, maximum=128) or session_id != binding.session_id:
        raise TransportError("Overseer session identity does not match configuration")

    agent = info.get("agent")
    if not _valid_text(agent, maximum=255) or agent != binding.agent:
        raise TransportError("Overseer session agent does not match configuration")

    directory = _session_directory(info)
    if directory != binding.directory:
        raise TransportError("Overseer session directory does not match configuration")

    time_info = info.get("time")
    if not isinstance(time_info, dict) or "created" not in time_info or "updated" not in time_info:
        raise TransportError("Overseer session time is invalid")
    created = _timestamp(time_info["created"])
    updated = _timestamp(time_info["updated"])
    if created is None or updated is None or created > updated:
        raise TransportError("Overseer session time is invalid")
    archived_at = None
    if "archived" in time_info:
        archived_at = _timestamp(time_info["archived"])
        if archived_at is None:
            raise TransportError("Overseer session time is invalid")
    if archived_at is not None and archived_at > 0:
        raise TransportError("Overseer session is archived")

    return SessionIdentity(session_id, agent, directory, archived=False)


def preflight_session(
    config: CampaignConfig,
    *,
    runner: Callable | None = None,
) -> SessionIdentity:
    """Read and verify only the explicitly approved Overseer session.

    No source-role session IDs or contexts are sent to OpenCode.  A preflight
    failure is value-free and never selects a replacement server or session.
    """
    config = _checked_config(config)
    deliverable, reason = notices_deliverable(config)
    if not deliverable:
        raise TransportError(reason)

    binding = config.roles["overseer"]
    if isinstance(config.connection, ManagedConnection):
        response = _api_request(
            config,
            runner,
            "get",
            f"/api/session/{binding.session_id}",
        )
        info = _wrapped_data(response, fields={"data"})
        return _session_identity(info, binding)

    server = _pinned_server(config)
    argv = [
        "opencode",
        "--server",
        server,
        "api",
        "get",
        f"/api/session/{binding.session_id}",
    ]
    selected_runner = subprocess_runner if runner is None else runner
    try:
        result = selected_runner(
            argv,
            timeout=config.limits.api_timeout_seconds,
            input=None,
        )
    except (subprocess.TimeoutExpired, TimeoutError):
        raise TransportError("OpenCode API request timed out") from None
    except TransportError as error:
        if type(error) is TransportError:
            message = str(error)
            if message in _SAFE_RUNNER_ERRORS:
                raise TransportError(message) from None
        raise TransportError("OpenCode API command failed") from None
    except Exception:
        # Runner messages may contain response bodies, URLs, auth details, or
        # other untrusted values; do not expose or persist them.
        raise TransportError("OpenCode API command failed") from None

    try:
        returncode = result.returncode
        stdout = result.stdout
        stderr = result.stderr
    except Exception:
        raise TransportError("OpenCode API command failed") from None
    stdout_bytes = _output_bytes(stdout, maximum=MAX_API_STDOUT_BYTES)
    stderr_bytes = _output_bytes(stderr, maximum=MAX_API_STDERR_BYTES)
    if type(returncode) is not int or returncode != 0:
        raise TransportError("OpenCode API command failed")

    info = _decode_session_info(stdout_bytes)
    return _session_identity(info, binding)


def _decode_api_json(stdout) -> object:
    raw = _output_bytes(stdout, maximum=MAX_API_STDOUT_BYTES)
    try:
        text = raw.decode("utf-8", errors="strict")
        response = json.loads(
            text,
            object_pairs_hook=_JSONObject,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeError, json.JSONDecodeError, ValueError, RecursionError):
        raise TransportError("OpenCode API response is invalid") from None
    if _has_duplicate_keys(response):
        raise TransportError("OpenCode API response is invalid")
    return response


def _api_request(
    config: CampaignConfig,
    runner: Callable | None,
    method: str,
    route: str,
    *,
    data: str | None = None,
):
    """Run one pinned, bounded API operation without retaining raw errors."""
    if method not in ("get", "post") or not _valid_text(route, maximum=4096):
        raise TransportError("OpenCode API request is invalid")
    if (method == "post") != (data is not None):
        raise TransportError("OpenCode API input is invalid")
    config = _checked_config(config)
    if isinstance(config.connection, ManagedConnection):
        return _managed_api_request(config, runner, method, route, data=data)

    argv = ["opencode", *config.connection, "api", method, route]
    if data is not None:
        if not isinstance(data, str):
            raise TransportError("OpenCode API input is invalid")
        try:
            encoded_input = data.encode("utf-8", errors="strict")
        except UnicodeError:
            raise TransportError("OpenCode API input is invalid") from None
        if len(encoded_input) > MAX_API_INPUT_BYTES:
            raise TransportError("OpenCode API input exceeded the size limit")
        argv.extend(("--data", data))
    if len(argv) > MAX_API_ARGUMENTS:
        raise TransportError("OpenCode API command arguments are invalid")
    try:
        argv_bytes = sum(len(arg.encode("utf-8", errors="strict")) for arg in argv)
    except UnicodeError:
        raise TransportError("OpenCode API command arguments are invalid") from None
    if argv_bytes > MAX_API_ARGUMENT_BYTES:
        raise TransportError("OpenCode API command arguments are invalid")

    selected_runner = subprocess_runner if runner is None else runner
    try:
        result = selected_runner(
            argv,
            timeout=config.limits.api_timeout_seconds,
            input=None,
        )
    except (subprocess.TimeoutExpired, TimeoutError):
        raise TransportError("OpenCode API request timed out") from None
    except TransportError as error:
        if type(error) is TransportError and str(error) in _SAFE_RUNNER_ERRORS:
            raise TransportError(str(error)) from None
        raise TransportError("OpenCode API command failed") from None
    except Exception:
        raise TransportError("OpenCode API command failed") from None

    try:
        returncode = result.returncode
        stdout = result.stdout
        stderr = result.stderr
    except Exception:
        raise TransportError("OpenCode API command failed") from None
    _output_bytes(stdout, maximum=MAX_API_STDOUT_BYTES)
    _output_bytes(stderr, maximum=MAX_API_STDERR_BYTES)
    if type(returncode) is not int or returncode != 0:
        raise TransportError("OpenCode API command failed")
    return _decode_api_json(stdout)


def _wrapped_data(response, *, fields: set[str]):
    if not isinstance(response, dict) or set(response) != fields or "data" not in response:
        raise TransportError("OpenCode API response is invalid")
    return response["data"]


def _metadata_is_bounded(value) -> dict:
    if not isinstance(value, dict):
        raise TransportError("OpenCode API response is invalid")
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise TransportError("OpenCode API response is invalid") from None
    if len(encoded) > MAX_RECONCILIATION_METADATA_BYTES:
        raise TransportError("OpenCode API response is invalid")
    return value


def _session_id_field(item: dict, expected_session_id: str) -> str | None:
    if "sessionID" not in item:
        return None
    value = item["sessionID"]
    if not _valid_text(value, maximum=128) or value != expected_session_id:
        raise TransportError("OpenCode API response is invalid")
    return value


def _message_text(value) -> str:
    if not isinstance(value, str):
        raise TransportError("OpenCode API response is invalid")
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeError:
        raise TransportError("OpenCode API response is invalid") from None
    if (
        len(encoded) > MAX_API_INPUT_BYTES
        or any(
            (ord(character) < 32 and character not in "\n\t")
            or ord(character) == 127
            for character in value
        )
    ):
        raise TransportError("OpenCode API response is invalid")
    return value


def _message_record(item, *, source: str, session_id: str) -> dict:
    if not isinstance(item, dict):
        raise TransportError("OpenCode API response is invalid")
    if source == "inbox":
        if not {"id", "type", "payload"}.issubset(item) or not set(item).issubset(
            {"id", "type", "payload", "sessionID", "time", "delivery"}
        ):
            raise TransportError("OpenCode API response is invalid")
        payload = item["payload"]
        if (
            not isinstance(payload, dict)
            or not {"text"}.issubset(payload)
            or not set(payload).issubset({"text", "metadata"})
        ):
            raise TransportError("OpenCode API response is invalid")
        text = _message_text(payload["text"])
        metadata = _metadata_is_bounded(payload.get("metadata", {}))
        created = None
        if "time" in item:
            time_info = item["time"]
            if not isinstance(time_info, dict) or set(time_info) != {"created"}:
                raise TransportError("OpenCode API response is invalid")
            created = _timestamp(time_info["created"])
            if created is None:
                raise TransportError("OpenCode API response is invalid")
        if "delivery" in item and item["delivery"] not in ("queue", "steer"):
            raise TransportError("OpenCode API response is invalid")
    else:
        if not {"id", "type", "time", "text", "metadata"}.issubset(item) or not set(item).issubset(
            {"id", "type", "time", "text", "metadata", "sessionID"}
        ):
            raise TransportError("OpenCode API response is invalid")
        time_info = item["time"]
        if not isinstance(time_info, dict) or "created" not in time_info:
            raise TransportError("OpenCode API response is invalid")
        created = _timestamp(time_info["created"])
        if created is None:
            raise TransportError("OpenCode API response is invalid")
        text = _message_text(item["text"])
        metadata = _metadata_is_bounded(item["metadata"])

    message_id = item["id"]
    if not _valid_text(message_id, maximum=128) or item["type"] != "user":
        raise TransportError("OpenCode API response is invalid")
    exposed_session_id = _session_id_field(item, session_id)
    # ``text`` is validated for the user-message shape but deliberately never
    # copied into a journal receipt or diagnostic.
    _ = text
    return {
        "id": message_id,
        "session_id": exposed_session_id,
        "metadata": metadata,
        "created": created,
    }


def _cursor(value) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TransportError("OpenCode API response is invalid")
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeError:
        raise TransportError("OpenCode API response is invalid") from None
    if (
        not encoded
        or len(encoded) > MAX_RECONCILIATION_CURSOR_BYTES
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise TransportError("OpenCode API response is invalid")
    return value


def _merge_reconciliation_record(records: dict, record: dict) -> None:
    previous = records.get(record["id"])
    if previous is None:
        records[record["id"]] = record
        return
    if previous["metadata"] != record["metadata"]:
        raise TransportError("OpenCode API reconciliation is conflicting")
    if (
        previous["session_id"] is not None
        and record["session_id"] is not None
        and previous["session_id"] != record["session_id"]
    ):
        raise TransportError("OpenCode API reconciliation is conflicting")
    if previous["session_id"] is None:
        previous["session_id"] = record["session_id"]
    if previous["created"] is None:
        previous["created"] = record["created"]


def _reconcile_session(
    config: CampaignConfig,
    session_id: str,
    batch_id: str,
    runner: Callable | None,
) -> dict | None:
    """Return one sanitized admitted receipt, or None when no match is proved."""
    expected_metadata = {
        "overseerRelay": {"campaign": config.campaign_id, "batchId": batch_id}
    }
    records = {}

    inbox_route = f"/api/session/{session_id}/inbox"
    inbox_response = _api_request(config, runner, "get", inbox_route)
    inbox_items = _wrapped_data(inbox_response, fields={"data"})
    if not isinstance(inbox_items, list) or len(inbox_items) > MAX_RECONCILIATION_INBOX_ITEMS:
        raise TransportError("OpenCode API response is invalid")
    for item in inbox_items:
        _merge_reconciliation_record(
            records,
            _message_record(item, source="inbox", session_id=session_id),
        )

    base_route = f"/api/session/{session_id}/message"
    next_cursor = None
    seen_cursors = set()
    total_items = 0
    for page_number in range(MAX_RECONCILIATION_MESSAGE_PAGES):
        if page_number == 0:
            route = f"{base_route}?type=user&limit=100&order=desc"
        else:
            assert next_cursor is not None
            route = (
                f"{base_route}?type=user&limit=100&cursor={quote(next_cursor, safe='')}"
            )
        page_response = _api_request(config, runner, "get", route)
        page_items = _wrapped_data(page_response, fields={"data", "cursor"})
        cursor_info = page_response["cursor"]
        if (
            not isinstance(page_items, list)
            or len(page_items) > MAX_RECONCILIATION_PAGE_ITEMS
            or not isinstance(cursor_info, dict)
            or set(cursor_info) != {"previous", "next"}
        ):
            raise TransportError("OpenCode API response is invalid")
        _cursor(cursor_info["previous"])
        current_next = _cursor(cursor_info["next"])
        total_items += len(page_items)
        if total_items > MAX_RECONCILIATION_MESSAGE_PAGES * MAX_RECONCILIATION_PAGE_ITEMS:
            raise TransportError("OpenCode API response is invalid")
        for item in page_items:
            _merge_reconciliation_record(
                records,
                _message_record(item, source="message", session_id=session_id),
            )
        if current_next is None:
            break
        if current_next in seen_cursors:
            raise TransportError("OpenCode API pagination is incomplete")
        seen_cursors.add(current_next)
        next_cursor = current_next
    else:
        # A non-null cursor after the fixed page budget is not evidence that
        # the searched history was complete.
        raise TransportError("OpenCode API pagination is incomplete")

    matches = [
        record
        for record in records.values()
        if record["metadata"] == expected_metadata
    ]
    if len(matches) != 1:
        return None
    match = matches[0]
    receipt = {
        "id": match["id"],
        "sessionID": session_id,
        "type": "user",
        "delivery": "queue",
        "metadata": expected_metadata,
        "reconciled": True,
    }
    if match["created"] is not None:
        receipt["time"] = {"created": match["created"]}
    return receipt


def _validated_post_receipt(
    response,
    *,
    session_id: str,
    text: str,
    metadata: dict,
    managed: bool = False,
) -> dict:
    data = _wrapped_data(response, fields={"data"})
    expected_fields = {"id", "sessionID", "time", "type", "delivery", "payload"}
    if not isinstance(data, dict) or set(data) != expected_fields:
        raise TransportError("OpenCode API admission receipt is invalid")
    if (
        not _valid_text(data["id"], maximum=128)
        or data["sessionID"] != session_id
        or data["type"] != "user"
        or data["delivery"] != "queue"
    ):
        raise TransportError("OpenCode API admission receipt is invalid")
    time_info = data["time"]
    if not isinstance(time_info, dict) or set(time_info) != {"created"}:
        raise TransportError("OpenCode API admission receipt is invalid")
    created = _timestamp(time_info["created"])
    payload = data["payload"]
    expected_payload_fields = {"metadata"} if managed else {"text", "metadata"}
    if (
        type(managed) is not bool
        or created is None
        or not isinstance(payload, dict)
        or set(payload) != expected_payload_fields
        or (not managed and payload["text"] != text)
        or payload["metadata"] != metadata
    ):
        raise TransportError("OpenCode API admission receipt is invalid")
    # Persist only the validated admission identity and routing metadata.  The
    # response's prompt text is intentionally omitted from durable state.
    return {
        "id": data["id"],
        "sessionID": session_id,
        "time": {"created": created},
        "type": "user",
        "delivery": "queue",
        "metadata": metadata,
    }


def _notice_evidence_paths(snapshot: dict) -> dict[str, list[str]]:
    result = {"A": [], "B": []}
    metadata = snapshot.get("metadata", {})
    watcher = metadata.get("watcher") if isinstance(metadata, dict) else None
    if watcher is None:
        return result
    if (
        not isinstance(watcher, dict)
        or watcher.get("schema_version") != 1
        or not isinstance(watcher.get("entries"), list)
        or len(watcher["entries"]) > 4096
    ):
        raise TransportError("Batch snapshot metadata is invalid")
    for entry in watcher["entries"]:
        if not isinstance(entry, dict) or entry.get("role") not in result:
            raise TransportError("Batch snapshot metadata is invalid")
        paths = entry.get("evidence_paths", [])
        if not isinstance(paths, list) or len(paths) > 128:
            raise TransportError("Batch snapshot metadata is invalid")
        for value in paths:
            try:
                confine_relative(Path("."), value)
            except (PathError, TypeError):
                raise TransportError("Batch snapshot metadata is invalid") from None
            if not _valid_text(value, maximum=4096):
                raise TransportError("Batch snapshot metadata is invalid")
            if value not in result[entry["role"]]:
                result[entry["role"]].append(value)
    return result


def _build_notice(config: CampaignConfig, snapshot: dict, batch_id: str) -> str:
    if snapshot.get("campaign_id") != config.campaign_id or snapshot.get("batch_id") != batch_id:
        raise TransportError("Batch snapshot identity is invalid")
    sources = snapshot.get("sources")
    if not isinstance(sources, dict) or not sources or not set(sources).issubset({"A", "B"}):
        raise TransportError("Batch snapshot source data is invalid")
    evidence_paths = _notice_evidence_paths(snapshot)
    lines = [
        "Overseer relay notice — review only",
        f"Campaign: {config.campaign_id}",
        f"Batch: {batch_id}",
        "",
        "Snapshotted source ranges:",
    ]
    for role in ("A", "B"):
        item = sources.get(role)
        if item is None:
            continue
        if (
            item.get("role") != role
            or item.get("path") != f"inbox/{role}.md"
            or type(item.get("start")) is not int
            or type(item.get("end")) is not int
            or item["start"] < 0
            or item["end"] <= item["start"]
            or not isinstance(item.get("sha256"), str)
            or len(item["sha256"]) != 64
            or any(character not in "0123456789abcdef" for character in item["sha256"])
        ):
            raise TransportError("Batch snapshot source data is invalid")
        lines.append(
            f"- {role}: {item['path']} bytes [{item['start']},{item['end']}); sha256={item['sha256']}"
        )
        for path in evidence_paths[role]:
            lines.append(f"  Evidence pointer: {json.dumps(path, ensure_ascii=False)}")
    lines.extend(
        (
            "",
            f"Acknowledgement path: watcher/batches/{batch_id}/overseer-ack.md",
            "Load and follow the overseer-coordinate skill, review the reports using the listed evidence pointers,",
            "then write an owner-visible summary in this Overseer conversation and append the exact batch-ack",
            "frame to the acknowledgement path above.",
        )
    )
    notice = "\n".join(lines)
    try:
        notice_bytes = notice.encode("utf-8", errors="strict")
    except UnicodeError:
        raise TransportError("Overseer notice is invalid") from None
    if (
        len(notice_bytes) > config.limits.max_notice_bytes
        or len(notice_bytes) > MAX_API_INPUT_BYTES - 1024
    ):
        raise TransportError("Overseer notice exceeds the size limit")
    return notice


def _delivery_result(journal, status: str, batch_id: str | None, *, surfaced=False) -> dict:
    state = journal.load()
    batch_status = None
    if batch_id is not None:
        batch = state["batches"].get(batch_id)
        batch_status = None if batch is None else batch["status"]
    return {
        "status": status,
        "batch_id": batch_id,
        "batch_status": batch_status,
        "pending_batch": state["pending_batch"],
        "newly_surfaced_hold": surfaced,
    }


def _mark_batch_hold_once(journal, batch_id: str) -> bool:
    state = journal.load()
    hold = state["batches"][batch_id]["hold"]
    if hold is None or hold["notice_emitted"]:
        return False
    journal.mark_hold_notice(batch_id=batch_id)
    return True


def _record_batch_outcome(
    journal,
    batch_id: str,
    state_name: str,
    *,
    receipt=None,
    last_attempt_proven_unsent=False,
) -> bool:
    journal.set_delivery_state(
        batch_id,
        state_name,
        receipt=receipt,
        last_attempt_proven_unsent=last_attempt_proven_unsent,
    )
    if state_name in ("held", "uncertain"):
        return _mark_batch_hold_once(journal, batch_id)
    return False


def _record_campaign_hold(journal, reason: str) -> bool:
    transition = journal.set_hold(reason)
    if not transition["should_notify"]:
        return False
    journal.mark_hold_notice()
    return True


def _saved_config_matches(config: CampaignConfig, journal) -> bool:
    try:
        return journal.read_config() == config
    except Exception:
        return False


def _resume_ledger_capacity(
    records: list[dict],
    ledger_bytes: int,
    *,
    ruling_id: str,
    role: str,
    session_id: str,
    request_id: str,
    additional_records: int,
) -> None:
    """Reserve the full bounded sequence before making its first POST."""
    largest_entry = {
        "ruling_id": ruling_id,
        "role": role,
        "session_id": session_id,
        "timestamp": (1 << 63) - 1,
        "outcome_code": "failed_not_started",
        "request_id": request_id,
        "attempt": 2,
    }
    encoded_maximum = len(
        json.dumps(
            largest_entry,
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
    ) + 1
    if (
        len(records) + additional_records > MAX_RESUME_LEDGER_RECORDS
        or ledger_bytes + additional_records * encoded_maximum > MAX_RESUME_LEDGER_BYTES
    ):
        raise TransportError(
            "Goal resume ledger reached its safety limit",
            code="ledger_full",
            post_started=False,
        )


def _resume_ledger_record(
    ruling_id: str,
    role: str,
    session_id: str,
    request_id: str,
    attempt: int,
    outcome_code: str,
) -> dict:
    return {
        "ruling_id": ruling_id,
        "role": role,
        "session_id": session_id,
        "timestamp": time.time_ns() // 1_000_000,
        "outcome_code": outcome_code,
        "request_id": request_id,
        "attempt": attempt,
    }


def _append_resume_record(journal, record: dict, *, post_started=None) -> None:
    try:
        journal.append_resume_record(record)
    except JournalError:
        raise TransportError(
            "Goal resume ledger could not be updated safely",
            code="ledger_invalid",
            post_started=post_started,
        ) from None


def request_goal_resume(
    config: CampaignConfig,
    journal,
    role: str,
    ruling_id: str,
    *,
    runner: Callable | None = None,
    force: bool = False,
) -> dict:
    """Queue the one fixed native resume command to a bound A/B worker.

    The campaign lock covers ledger inspection, durable attempt intent, and
    every helper invocation.  ``--force`` is represented by starting a new
    request ID only after any unresolved prior sequence has been recovered.
    """
    config = _checked_config(config)
    if not isinstance(ruling_id, str) or _RESUME_RULING_ID.fullmatch(ruling_id) is None:
        raise TransportError(
            "Goal resume ruling ID is invalid", code="input_invalid", post_started=False
        )
    if type(force) is not bool:
        raise TransportError(
            "Goal resume force value is invalid", code="input_invalid", post_started=False
        )
    eligible, reason = goal_resume_target(config, role)
    if not eligible:
        raise TransportError(reason, code="input_invalid", post_started=False)
    if (
        journal is None
        or config.campaign_id != getattr(journal, "campaign_id", None)
        or config.common_dir != str(getattr(journal, "common_dir", ""))
        or not callable(getattr(journal, "operation_lock", None))
        or not callable(getattr(journal, "load_resume_ledger", None))
        or not callable(getattr(journal, "append_resume_record", None))
    ):
        raise TransportError(
            "Campaign configuration does not match its journal",
            code="input_invalid",
            post_started=False,
        )

    binding = config.roles[role]
    # The managed helper receives only the selected worker role's immutable
    # binding.  It never receives the Overseer binding for resume operations.
    with journal.operation_lock():
        if not _saved_config_matches(config, journal):
            raise TransportError(
                "Campaign configuration changed before goal resume",
                code="input_invalid",
                post_started=False,
            )
        try:
            records, ledger_bytes = journal.load_resume_ledger()
        except JournalError:
            raise TransportError(
                "Goal resume ledger is corrupt or unavailable",
                code="ledger_invalid",
                post_started=False,
            ) from None

        pair_records = [
            record
            for record in records
            if record["ruling_id"] == ruling_id and record["role"] == role
        ]
        latest_id = pair_records[-1]["request_id"] if pair_records else None
        latest_rows = (
            [record for record in pair_records if record["request_id"] == latest_id]
            if latest_id is not None
            else []
        )
        latest = latest_rows[-1] if latest_rows else None
        unresolved = latest is not None and latest["outcome_code"] == "attempt_started"

        if unresolved:
            request_id = latest["request_id"]
            if latest["attempt"] == 2:
                _resume_ledger_capacity(
                    records,
                    ledger_bytes,
                    ruling_id=ruling_id,
                    role=role,
                    session_id=binding.session_id,
                    request_id=request_id,
                    additional_records=1,
                )
                _append_resume_record(
                    journal,
                    _resume_ledger_record(
                        ruling_id, role, binding.session_id, request_id, 2, "uncertain"
                    ),
                    post_started=None,
                )
                return {"status": "uncertain"}
            attempt = 2
            additional_records = 2
        else:
            if latest is not None and latest["outcome_code"] == "uncertain" and not force:
                return {"status": "uncertain"}
            if any(record["outcome_code"] == "delivered" for record in pair_records) and not force:
                return {"status": "duplicate"}
            used_ids = {record["request_id"] for record in records}
            request_id = None
            for _attempt in range(8):
                candidate = secrets.token_hex(16)
                if candidate not in used_ids:
                    request_id = candidate
                    break
            if request_id is None:
                raise TransportError(
                    "Goal resume request ID could not be allocated",
                    code="operation_failed",
                    post_started=False,
                )
            attempt = 1
            additional_records = 3

        _resume_ledger_capacity(
            records,
            ledger_bytes,
            ruling_id=ruling_id,
            role=role,
            session_id=binding.session_id,
            request_id=request_id,
            additional_records=additional_records,
        )

        def run_attempt(attempt_number: int):
            _append_resume_record(
                journal,
                _resume_ledger_record(
                    ruling_id,
                    role,
                    binding.session_id,
                    request_id,
                    attempt_number,
                    "attempt_started",
                ),
                post_started=False,
            )
            try:
                data = _managed_api_request(
                    config,
                    runner,
                    "post",
                    f"/api/session/{binding.session_id}/command",
                    _worker_role=role,
                )
                if (
                    not isinstance(data, dict)
                    or set(data) != {"delivered"}
                    or type(data["delivered"]) is not bool
                    or data["delivered"] is not True
                ):
                    raise TransportError(
                        "Managed helper response is invalid",
                        code="operation_failed",
                    )
            except TransportError as error:
                if attempt_number == 2:
                    _append_resume_record(
                        journal,
                        _resume_ledger_record(
                            ruling_id, role, binding.session_id, request_id, 2, "uncertain"
                        ),
                    )
                    return "uncertain", False
                if error.post_started is False:
                    _append_resume_record(
                        journal,
                        _resume_ledger_record(
                            ruling_id,
                            role,
                            binding.session_id,
                            request_id,
                            1,
                            "failed_not_started",
                        ),
                        post_started=False,
                    )
                    return "failed_not_started", False
                # core.mjs currently reports both network failure and a
                # non-204 response as post_failed with post_started=true. It
                # exposes no response-status bit, so treating that result as
                # ambiguous is safer than claiming a definitive rejection.
                if error.post_started is True and error.code == "redirect_blocked":
                    _append_resume_record(
                        journal,
                        _resume_ledger_record(
                            ruling_id, role, binding.session_id, request_id, 1, "failed"
                        ),
                        post_started=True,
                    )
                    return "failed", False
                return "ambiguous", True
            except Exception:
                # Unexpected runner/protocol failures carry no safe evidence
                # about whether the helper's POST started.
                if attempt_number == 2:
                    _append_resume_record(
                        journal,
                        _resume_ledger_record(
                            ruling_id, role, binding.session_id, request_id, 2, "uncertain"
                        ),
                    )
                    return "uncertain", False
                return "ambiguous", True

            _append_resume_record(
                journal,
                _resume_ledger_record(
                    ruling_id,
                    role,
                    binding.session_id,
                    request_id,
                    attempt_number,
                    "delivered",
                ),
                post_started=True,
            )
            return "delivered", False

        outcome, retry = run_attempt(attempt)
        if retry:
            # Same request ID and target, with the second durable intent
            # written before this one bounded retry.
            outcome, _retry = run_attempt(2)
        return {"status": outcome}


def _preflight_with_retry(
    config: CampaignConfig,
    *,
    runner: Callable | None,
    sleep: Callable[[float], object],
) -> SessionIdentity:
    retries = config.limits.pre_post_retries
    backoffs = config.limits.pre_post_backoff_seconds
    for attempt in range(retries + 1):
        try:
            return preflight_session(config, runner=runner)
        except TransportError as error:
            if attempt >= retries or str(error) not in _PRE_POST_RETRYABLE_ERRORS:
                raise
            try:
                sleep(backoffs[attempt])
            except Exception:
                raise TransportError("OpenCode API preflight retry wait failed") from None
    raise TransportError("OpenCode API command failed")


def _active_hold(hold) -> bool:
    return hold is not None and not hold["released"]


def _blocked_by_campaign_or_source_hold(state: dict, batch: dict) -> bool:
    if _active_hold(state["hold"]):
        return True
    for role in batch["sources"]:
        if _active_hold(state["sources"][role]["hold"]):
            return True
    return False


def deliver_pending(
    config: CampaignConfig,
    journal,
    runner: Callable | None = None,
    sleep: Callable[[float], object] | None = None,
) -> dict:
    """Deliver or reconcile one durable batch to the configured Overseer only.

    A snapshotted batch gets bounded preflight retries and exactly one POST.
    Any durable send intent is treated as potentially admitted and is only
    reconciled; no restart path issues a second POST.
    """
    config = _checked_config(config)
    if (
        journal is None
        or config.campaign_id != getattr(journal, "campaign_id", None)
        or config.common_dir != str(getattr(journal, "common_dir", ""))
    ):
        raise TransportError("Campaign configuration does not match its journal")
    selected_sleep = time.sleep if sleep is None else sleep

    with journal.operation_lock():
        if not _saved_config_matches(config, journal):
            surfaced = _record_campaign_hold(journal, "campaign configuration changed after startup")
            return _delivery_result(journal, "held", journal.load()["pending_batch"], surfaced=surfaced)

        state = journal.load()
        batch_id = state["pending_batch"]
        if batch_id is None:
            return _delivery_result(journal, "idle", None)
        batch = state["batches"][batch_id]
        current = batch["status"]

        if current in ("admitted", "acknowledged"):
            return _delivery_result(journal, current, batch_id)
        if current in ("held", "failed"):
            return _delivery_result(journal, current, batch_id)
        if _blocked_by_campaign_or_source_hold(state, batch):
            return _delivery_result(journal, "held", batch_id)
        if current == "snapshotted" and _active_hold(batch["hold"]):
            return _delivery_result(journal, "held", batch_id)
        if current == "send-intent" and _active_hold(batch["hold"]):
            return _delivery_result(journal, "held", batch_id)
        if current not in ("snapshotted", "send-intent", "uncertain"):
            return _delivery_result(journal, "held", batch_id)

        try:
            snapshot = journal.read_batch_snapshot(batch_id)
            notice = _build_notice(config, snapshot, batch_id)
        except Exception:
            if current == "snapshotted":
                surfaced = _record_batch_outcome(journal, batch_id, "held")
                return _delivery_result(journal, "held", batch_id, surfaced=surfaced)
            surfaced = _record_batch_outcome(journal, batch_id, "uncertain")
            return _delivery_result(journal, "uncertain", batch_id, surfaced=surfaced)

        if current in ("send-intent", "uncertain"):
            try:
                _preflight_with_retry(config, runner=runner, sleep=selected_sleep)
                if not _saved_config_matches(config, journal):
                    surfaced = _record_campaign_hold(
                        journal, "campaign configuration changed after startup"
                    )
                    batch_state = journal.load()["batches"][batch_id]["status"]
                    if batch_state == "send-intent":
                        surfaced = _record_batch_outcome(
                            journal, batch_id, "uncertain"
                        ) or surfaced
                    return _delivery_result(
                        journal, "held", batch_id, surfaced=surfaced
                    )
                receipt = _reconcile_session(
                    config,
                    config.roles["overseer"].session_id,
                    batch_id,
                    runner,
                )
            except TransportError:
                receipt = None
            if receipt is not None:
                journal.set_delivery_state(batch_id, "admitted", receipt=receipt)
                journal.release_hold(batch_id=batch_id)
                return _delivery_result(journal, "admitted", batch_id)
            surfaced = _record_batch_outcome(journal, batch_id, "uncertain")
            return _delivery_result(journal, "uncertain", batch_id, surfaced=surfaced)

        # A preflight failure is provably before POST and may retry only within
        # the configured bounded backoff.  Once exhausted, hold this batch.
        try:
            _preflight_with_retry(config, runner=runner, sleep=selected_sleep)
        except TransportError:
            surfaced = _record_batch_outcome(journal, batch_id, "held")
            return _delivery_result(journal, "held", batch_id, surfaced=surfaced)

        if not _saved_config_matches(config, journal):
            surfaced = _record_campaign_hold(journal, "campaign configuration changed after startup")
            surfaced = _record_batch_outcome(
                journal,
                batch_id,
                "held",
                last_attempt_proven_unsent=isinstance(config.connection, ManagedConnection),
            ) or surfaced
            return _delivery_result(journal, "held", batch_id, surfaced=surfaced)

        # Re-read journal state and holds immediately before recording intent.
        current_state = journal.load()
        current_batch = current_state["batches"].get(batch_id)
        if (
            current_state["pending_batch"] != batch_id
            or current_batch is None
            or current_batch["status"] != "snapshotted"
            or _blocked_by_campaign_or_source_hold(current_state, current_batch)
            or _active_hold(current_batch["hold"])
        ):
            return _delivery_result(journal, "held", batch_id)

        metadata = {"overseerRelay": {"campaign": config.campaign_id, "batchId": batch_id}}
        request = {
            "text": notice,
            "delivery": "queue",
            "resume": True,
            "metadata": metadata,
        }
        try:
            request_text = json.dumps(
                request,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
        except (TypeError, ValueError, UnicodeError):
            surfaced = _record_batch_outcome(journal, batch_id, "held")
            return _delivery_result(journal, "held", batch_id, surfaced=surfaced)

        # This durable transition is committed before the runner is invoked.
        journal.set_delivery_state(batch_id, "send-intent")

        # Revalidate the saved capability and destination after the durable
        # intent and immediately before invoking the one permitted POST.
        if not _saved_config_matches(config, journal):
            surfaced = _record_campaign_hold(journal, "campaign configuration changed after startup")
            surfaced = _record_batch_outcome(
                journal,
                batch_id,
                "held",
                last_attempt_proven_unsent=isinstance(config.connection, ManagedConnection),
            ) or surfaced
            return _delivery_result(journal, "held", batch_id, surfaced=surfaced)
        latest = journal.load()
        latest_batch = latest["batches"].get(batch_id)
        if (
            latest["pending_batch"] != batch_id
            or latest_batch is None
            or latest_batch["status"] != "send-intent"
            or _blocked_by_campaign_or_source_hold(latest, latest_batch)
        ):
            surfaced = _record_batch_outcome(
                journal,
                batch_id,
                "held",
                last_attempt_proven_unsent=(
                    isinstance(config.connection, ManagedConnection)
                    and latest_batch is not None
                    and latest_batch["status"] == "send-intent"
                ),
            )
            return _delivery_result(journal, "held", batch_id, surfaced=surfaced)

        try:
            response = _api_request(
                config,
                runner,
                "post",
                f"/api/session/{config.roles['overseer'].session_id}/prompt",
                data=request_text,
            )
            receipt = _validated_post_receipt(
                response,
                session_id=config.roles["overseer"].session_id,
                text=notice,
                metadata=metadata,
                managed=isinstance(config.connection, ManagedConnection),
            )
        except TransportError as error:
            if (
                isinstance(config.connection, ManagedConnection)
                and type(error) is TransportError
                and error.post_started is False
            ):
                # A validated helper failure envelope, or a failure before
                # launching the helper, proves this attempt did not reach a
                # POST.  Preserve the monotonic intent marker while recording
                # this attempt's narrow release proof; do not reconcile an
                # outcome that is already known to be unsent.
                journal.set_delivery_state(
                    batch_id,
                    "held",
                    last_attempt_proven_unsent=True,
                )
                surfaced = _mark_batch_hold_once(journal, batch_id)
                return _delivery_result(journal, "held", batch_id, surfaced=surfaced)
            receipt = None

        if receipt is not None:
            journal.set_delivery_state(batch_id, "admitted", receipt=receipt)
            return _delivery_result(journal, "admitted", batch_id)

        # A timeout, nonzero exit, or malformed receipt is ambiguous.  Complete
        # scans of both endpoints are required even if one already found a hit.
        try:
            reconciled = _reconcile_session(
                config,
                config.roles["overseer"].session_id,
                batch_id,
                runner,
            )
        except TransportError:
            reconciled = None
        if reconciled is not None:
            journal.set_delivery_state(batch_id, "admitted", receipt=reconciled)
            return _delivery_result(journal, "admitted", batch_id)
        surfaced = _record_batch_outcome(journal, batch_id, "uncertain")
        return _delivery_result(journal, "uncertain", batch_id, surfaced=surfaced)
