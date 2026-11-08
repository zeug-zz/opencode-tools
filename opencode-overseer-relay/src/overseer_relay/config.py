#!/usr/bin/env python3
"""Strict versioned campaign configuration parsing and validation."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import re
from types import MappingProxyType
from typing import Mapping
from urllib.parse import parse_qsl, urlsplit

from overseer_relay.paths import PathError, validate_campaign_id


SCHEMA_VERSION = 1
SUPPORTED_SCHEMA_VERSIONS = (1, 2)
PHASE = 1
MAX_CONFIG_BYTES = 1024 * 1024
MAX_TEXT_LENGTH = 4096
MAX_BASELINE_OFFSET = (1 << 63) - 1
MAX_EXPECTED_PID = (1 << 31) - 1

ROLES = ("overseer", "A", "B")
SOURCE_ROLES = ("A", "B")
ROLE_FIELDS = ("generation", "session_id", "directory", "branch", "agent")

LIMIT_DEFAULTS = {
    "scan_interval_seconds": 30,
    "max_frame_bytes": 256 * 1024,
    "max_new_bytes_per_observation": 1024 * 1024,
    "max_batch_snapshot_bytes": 512 * 1024,
    "max_notice_bytes": 16 * 1024,
    "api_timeout_seconds": 30,
    "pre_post_retries": 3,
    "pre_post_backoff_seconds": [1, 2, 4],
}

# Hard bounds are deliberately no wider than the D3 proposed maxima. Duration
# bounds and retry count keep a hand-edited config from creating unbounded work.
LIMIT_BOUNDS = {
    "scan_interval_seconds": (1, 3600),
    "max_frame_bytes": (1, 256 * 1024),
    "max_new_bytes_per_observation": (1, 1024 * 1024),
    "max_batch_snapshot_bytes": (1, 512 * 1024),
    "max_notice_bytes": (1, 16 * 1024),
    "api_timeout_seconds": (1, 120),
    "pre_post_retries": (0, 3),
}
RETRY_BACKOFFS = (1, 2, 4)

_CREDENTIAL_KEY = re.compile(
    r"token|secret|password|api.?key|authorization|cookie|credential|bearer",
    re.IGNORECASE | re.ASCII,
)
_BEARER_VALUE = re.compile(r"\bbearer\s+\S+", re.IGNORECASE | re.ASCII)
_SK_KEY_VALUE = re.compile(r"\bsk-[a-z0-9][a-z0-9_-]*\b", re.IGNORECASE | re.ASCII)
_URL_VALUE = re.compile(r"[a-z][a-z0-9+.-]*://[^\s<>\"'`]+", re.IGNORECASE | re.ASCII)
_SESSION_ID = re.compile(r"ses_[A-Za-z0-9]+\Z", re.ASCII)
_SHA256 = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z", re.ASCII)


class ConfigError(ValueError):
    """A configuration error with a value-free JSON key path."""


@dataclass(frozen=True)
class RoleBinding:
    """An explicit role generation and its nullable owner-confirmed binding."""

    generation: int
    session_id: str | None
    directory: str | None
    branch: str | None
    agent: str | None


@dataclass(frozen=True)
class Baseline:
    """A source baseline; range prefix hashes identify the consumed prefix."""

    mode: str
    prefix_sha256: str
    offset: int | None = None
    start: int | None = None
    end: int | None = None


@dataclass(frozen=True)
class CampaignLimits:
    """Bounded phase-1 scan and notice limits."""

    scan_interval_seconds: int | float
    max_frame_bytes: int
    max_new_bytes_per_observation: int
    max_batch_snapshot_bytes: int
    max_notice_bytes: int
    api_timeout_seconds: int | float
    pre_post_retries: int
    pre_post_backoff_seconds: tuple[int, ...]


@dataclass(frozen=True)
class Capabilities:
    """Persisted notice approval and disabled reserved later-phase flags."""

    overseer_notices: bool
    owner_approved_notices: bool
    worker_delivery: bool
    worker_steers: bool
    goal_resume: bool


@dataclass(frozen=True)
class ManagedConnection:
    """An owner-confirmed endpoint and optional legacy PID pin."""

    expected_url: str
    expected_pid: int | None = None


@dataclass(frozen=True)
class CampaignConfig:
    """Immutable, validated schema-v1 or schema-v2 campaign configuration."""

    schema_version: int
    campaign_id: str
    common_dir: str
    base_ref: str
    phase: int
    roles: Mapping[str, RoleBinding]
    limits: CampaignLimits
    baseline: Mapping[str, Baseline]
    connection: tuple[str, ...] | ManagedConnection
    capabilities: Capabilities


class _PairsObject(dict):
    """JSON object retaining duplicate names until their paths are known."""

    def __init__(self, pairs):
        super().__init__()
        self.duplicate_keys = []
        for key, value in pairs:
            if key in self:
                self.duplicate_keys.append(key)
            else:
                self[key] = value


def _fail(path: str, message: str) -> None:
    raise ConfigError(f"{path}: {message}")


def _key_path(path: str, key: str) -> str:
    if _IDENTIFIER.fullmatch(key):
        return f"{path}.{key}"
    return f"{path}[{json.dumps(key, ensure_ascii=True)}]"


def _has_credential_key(key: str) -> bool:
    return _CREDENTIAL_KEY.search(key) is not None


def _url_has_credentials(value: str) -> bool:
    for match in _URL_VALUE.finditer(value):
        candidate = match.group(0).rstrip(".,;)]}")
        try:
            parsed = urlsplit(candidate)
            if parsed.username is not None or parsed.password is not None:
                return True
            if parsed.query:
                query = parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=128)
                if any(
                    _has_credential_key(key)
                    or _BEARER_VALUE.search(query_value)
                    or _SK_KEY_VALUE.search(query_value)
                    for key, query_value in query
                ):
                    return True
        except (ValueError, UnicodeError):
            # An unparseable URL cannot be safely qualified as a non-secret
            # routing address, so fail closed without exposing its contents.
            return True
    return False


def _scan_credentials(root) -> None:
    """Reject credential-like keys and values throughout the input tree."""
    pending = [(root, "$", 0)]
    visited = set()
    while pending:
        value, path, depth = pending.pop()
        if depth > 64:
            _fail(path, "configuration nesting is too deep")
        if isinstance(value, dict):
            identity = id(value)
            if identity in visited:
                continue
            visited.add(identity)
            for key in value:
                if not isinstance(key, str):
                    _fail(path, "object keys must be strings")
                key_path = _key_path(path, key)
                if _has_credential_key(key):
                    _fail(key_path, "credential-like field is not allowed")
            for key, child in reversed(tuple(value.items())):
                pending.append((child, _key_path(path, key), depth + 1))
        elif isinstance(value, (list, tuple)):
            identity = id(value)
            if identity in visited:
                continue
            visited.add(identity)
            for index in range(len(value) - 1, -1, -1):
                pending.append((value[index], f"{path}[{index}]", depth + 1))
        elif isinstance(value, str):
            if _BEARER_VALUE.search(value) or _SK_KEY_VALUE.search(value) or _url_has_credentials(value):
                _fail(path, "credential-like value is not allowed")


def _duplicate_path(value, path: str) -> str | None:
    pending = [(value, path)]
    while pending:
        current, current_path = pending.pop()
        if isinstance(current, _PairsObject):
            if current.duplicate_keys:
                return _key_path(current_path, current.duplicate_keys[0])
            for key, child in reversed(tuple(current.items())):
                pending.append((child, _key_path(current_path, key)))
        elif isinstance(current, list):
            for index in range(len(current) - 1, -1, -1):
                pending.append((current[index], f"{current_path}[{index}]"))
    return None


def _reject_nonfinite(_value):
    raise ValueError("non-finite JSON number")


def load_config(path: str | os.PathLike) -> CampaignConfig:
    """Load one bounded UTF-8 JSON config, rejecting duplicates and extras."""
    try:
        with Path(path).open("rb") as config_file:
            raw = config_file.read(MAX_CONFIG_BYTES + 1)
    except (OSError, TypeError, ValueError):
        _fail("$", "configuration file could not be read")
    if len(raw) > MAX_CONFIG_BYTES:
        _fail("$", "configuration file exceeds the size limit")
    try:
        text = raw.decode("utf-8", errors="strict")
        data = json.loads(
            text,
            object_pairs_hook=_PairsObject,
            parse_constant=_reject_nonfinite,
        )
    except (UnicodeError, json.JSONDecodeError, ValueError, RecursionError):
        _fail("$", "configuration is not strict JSON")
    duplicate_path = _duplicate_path(data, "$")
    if duplicate_path is not None:
        _fail(duplicate_path, "duplicate key")
    return parse_config(data)


def _check_object(value, path: str, required, optional=()) -> dict:
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    for key in value:
        if not isinstance(key, str):
            _fail(path, "object keys must be strings")
    allowed = set(required) | set(optional)
    for key in sorted(value):
        if key not in allowed:
            _fail(_key_path(path, key), "unknown field")
    for key in sorted(set(required) - value.keys()):
        _fail(_key_path(path, key), "required field is missing")
    return value


def _integer(value, path: str, minimum: int, maximum: int | None = None) -> int:
    if type(value) is not int:
        _fail(path, "must be an integer")
    if value < minimum or (maximum is not None and value > maximum):
        if maximum is None:
            _fail(path, f"must be at least {minimum}")
        _fail(path, f"must be between {minimum} and {maximum}")
    return value


def _number(value, path: str, minimum: int | float, maximum: int | float) -> int | float:
    if type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
        _fail(path, "must be a finite number")
    if value < minimum or value > maximum:
        _fail(path, f"must be between {minimum} and {maximum}")
    return value


def _boolean(value, path: str) -> bool:
    if type(value) is not bool:
        _fail(path, "must be a boolean")
    return value


def _text(value, path: str, *, max_length: int = MAX_TEXT_LENGTH, allow_empty=False) -> str:
    if not isinstance(value, str):
        _fail(path, "must be a string")
    if (not allow_empty and not value) or len(value) > max_length:
        _fail(path, "has an invalid length")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        _fail(path, "must not contain control characters")
    return value


def _canonical_directory(value, path: str) -> str:
    value = _text(value, path)
    try:
        canonical = os.path.realpath(value)
        if not os.path.isabs(value) or os.path.normpath(value) != value or canonical != value:
            _fail(path, "must be an absolute canonical directory")
    except (OSError, TypeError, ValueError):
        _fail(path, "must be an absolute canonical directory")
    return value


def _validate_role(value, role: str) -> RoleBinding:
    path = _key_path("$.roles", role)
    value = _check_object(value, path, ROLE_FIELDS)
    generation = _integer(value["generation"], f"{path}.generation", 1)

    session_id = value["session_id"]
    if session_id is not None:
        session_id = _text(session_id, f"{path}.session_id", max_length=128)
        if _SESSION_ID.fullmatch(session_id) is None:
            _fail(f"{path}.session_id", "does not match the session ID format")

    directory = value["directory"]
    if directory is not None:
        directory = _canonical_directory(directory, f"{path}.directory")

    branch = value["branch"]
    if branch is not None:
        branch = _text(branch, f"{path}.branch", max_length=255)

    agent = value["agent"]
    if agent is not None:
        agent = _text(agent, f"{path}.agent", max_length=255)

    return RoleBinding(generation, session_id, directory, branch, agent)


def _validate_baseline(value, role: str) -> Baseline:
    path = _key_path("$.baseline", role)
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    mode = value.get("mode")
    if mode == "now":
        value = _check_object(value, path, ("mode", "offset", "prefix_sha256"))
        offset = _integer(value["offset"], f"{path}.offset", 0, MAX_BASELINE_OFFSET)
        digest = _text(value["prefix_sha256"], f"{path}.prefix_sha256", max_length=64)
        if _SHA256.fullmatch(digest) is None:
            _fail(f"{path}.prefix_sha256", "must be a lowercase SHA-256 digest")
        return Baseline("now", digest, offset=offset)
    if mode == "range":
        value = _check_object(value, path, ("mode", "start", "end", "prefix_sha256"))
        start = _integer(value["start"], f"{path}.start", 0, MAX_BASELINE_OFFSET)
        end = _integer(value["end"], f"{path}.end", 0, MAX_BASELINE_OFFSET)
        if end <= start:
            _fail(f"{path}.end", "must be greater than start")
        digest = _text(value["prefix_sha256"], f"{path}.prefix_sha256", max_length=64)
        if _SHA256.fullmatch(digest) is None:
            _fail(f"{path}.prefix_sha256", "must be a lowercase SHA-256 digest")
        return Baseline("range", digest, start=start, end=end)
    _fail(f"{path}.mode", "must be 'now' or 'range'")


def _validate_limits(value) -> CampaignLimits:
    path = "$.limits"
    value = _check_object(value, path, LIMIT_DEFAULTS)
    validated = {}
    for name, (minimum, maximum) in LIMIT_BOUNDS.items():
        validated[name] = _number(value[name], f"{path}.{name}", minimum, maximum) if name in (
            "scan_interval_seconds",
            "api_timeout_seconds",
        ) else _integer(value[name], f"{path}.{name}", minimum, maximum)

    backoff_path = f"{path}.pre_post_backoff_seconds"
    backoff_value = value["pre_post_backoff_seconds"]
    if not isinstance(backoff_value, list) or not 1 <= len(backoff_value) <= len(RETRY_BACKOFFS):
        _fail(backoff_path, "must be a non-empty list of at most three values")
    backoff = tuple(
        _integer(item, f"{backoff_path}[{index}]", 1, 4)
        for index, item in enumerate(backoff_value)
    )
    if backoff != RETRY_BACKOFFS[: len(backoff)]:
        _fail(backoff_path, "must be an increasing prefix of the approved backoff")
    if validated["pre_post_retries"] > len(backoff):
        _fail("$.limits.pre_post_retries", "exceeds the configured backoff count")

    return CampaignLimits(
        scan_interval_seconds=validated["scan_interval_seconds"],
        max_frame_bytes=validated["max_frame_bytes"],
        max_new_bytes_per_observation=validated["max_new_bytes_per_observation"],
        max_batch_snapshot_bytes=validated["max_batch_snapshot_bytes"],
        max_notice_bytes=validated["max_notice_bytes"],
        api_timeout_seconds=validated["api_timeout_seconds"],
        pre_post_retries=validated["pre_post_retries"],
        pre_post_backoff_seconds=backoff,
    )


def _validate_legacy_connection(value) -> tuple[str, ...]:
    path = "$.connection"
    if not isinstance(value, list) or len(value) > 8:
        _fail(path, "must be a bounded list of pinned routing arguments")
    args = tuple(_text(item, f"{path}[{index}]", max_length=2048) for index, item in enumerate(value))
    if not args:
        return args
    if len(args) == 1 and args[0].startswith("--server="):
        server = args[0][len("--server=") :]
    elif len(args) == 2 and args[0] == "--server":
        server = args[1]
    else:
        _fail(path, "only one pinned --server URL is supported")
    try:
        parsed = urlsplit(server)
        valid_server = (
            parsed.scheme in ("http", "https")
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and not parsed.fragment
        )
        # Accessing .port also verifies that an explicit port is numeric and
        # in range; the value is intentionally never included in diagnostics.
        _ = parsed.port
    except (ValueError, UnicodeError):
        valid_server = False
    if not valid_server:
        _fail("$.connection", "contains an invalid pinned server URL")
    if _url_has_credentials(server):
        _fail("$.connection", "contains credential-bearing routing data")
    return args


def _validate_managed_connection(value) -> ManagedConnection:
    path = "$.connection"
    value = _check_object(
        value, path, ("mode", "expected_url"), ("expected_pid",)
    )
    if value["mode"] != "managed-local":
        _fail("$.connection.mode", "must be 'managed-local'")

    expected_url = _text(
        value["expected_url"], "$.connection.expected_url", max_length=2048
    )
    try:
        parsed = urlsplit(expected_url)
        hostname = parsed.hostname
        port = parsed.port
        valid_url = (
            parsed.scheme in ("http", "https")
            and hostname in ("127.0.0.1", "::1")
            and parsed.username is None
            and parsed.password is None
            and port is not None
            and port > 0
            and not parsed.path
            and not parsed.query
            and not parsed.fragment
        )
        if valid_url:
            authority_host = f"[{hostname}]" if hostname == "::1" else hostname
            canonical_url = f"{parsed.scheme}://{authority_host}:{port}"
            valid_url = expected_url == canonical_url
    except (ValueError, UnicodeError):
        valid_url = False
    if not valid_url:
        _fail(
            "$.connection.expected_url",
            "must be a canonical HTTP(S) loopback URL with an explicit port and no path",
        )
    if _url_has_credentials(expected_url):
        _fail("$.connection.expected_url", "contains credential-bearing routing data")

    expected_pid = None
    if "expected_pid" in value:
        expected_pid = _integer(
            value["expected_pid"], "$.connection.expected_pid", 1, MAX_EXPECTED_PID
        )
    return ManagedConnection(expected_url=expected_url, expected_pid=expected_pid)


def _validate_connection(value, schema_version: int) -> tuple[str, ...] | ManagedConnection:
    if schema_version == 1:
        return _validate_legacy_connection(value)
    if schema_version == 2:
        return _validate_managed_connection(value)
    _fail("$.schema_version", "unsupported schema version")


def parse_config(data: dict) -> CampaignConfig:
    """Validate a JSON-compatible mapping without inferring any bindings."""
    _scan_credentials(data)
    root = _check_object(
        data,
        "$",
        (
            "schema_version",
            "campaign_id",
            "common_dir",
            "base_ref",
            "phase",
            "roles",
            "limits",
            "baseline",
            "connection",
            "capabilities",
        ),
    )

    schema_version = _integer(root["schema_version"], "$.schema_version", 1)
    if schema_version not in SUPPORTED_SCHEMA_VERSIONS:
        _fail("$.schema_version", "unsupported schema version")
    phase = _integer(root["phase"], "$.phase", 1)
    if phase != PHASE:
        _fail("$.phase", "unsupported phase")

    campaign_id = _text(root["campaign_id"], "$.campaign_id", max_length=64)
    try:
        validate_campaign_id(campaign_id)
    except PathError:
        _fail("$.campaign_id", "is invalid")

    common_dir = _canonical_directory(root["common_dir"], "$.common_dir")
    base_ref = _text(root["base_ref"], "$.base_ref", max_length=255)

    roles_data = _check_object(root["roles"], "$.roles", ROLES)
    roles = {
        role: _validate_role(roles_data[role], role)
        for role in ROLES
    }

    limits = _validate_limits(root["limits"])

    baseline_data = _check_object(root["baseline"], "$.baseline", SOURCE_ROLES)
    baseline = {
        role: _validate_baseline(baseline_data[role], role)
        for role in SOURCE_ROLES
    }

    connection = _validate_connection(root["connection"], schema_version)

    capabilities_data = _check_object(
        root["capabilities"],
        "$.capabilities",
        (),
        (
            "overseer_notices",
            "owner_approved_notices",
            "worker_delivery",
            "worker_steers",
            "goal_resume",
        ),
    )
    overseer_notices = _boolean(
        capabilities_data.get("overseer_notices", False),
        "$.capabilities.overseer_notices",
    )
    owner_approved_notices = _boolean(
        capabilities_data.get("owner_approved_notices", False),
        "$.capabilities.owner_approved_notices",
    )
    reserved = {}
    for name in ("worker_delivery", "worker_steers"):
        enabled = _boolean(capabilities_data.get(name, False), f"$.capabilities.{name}")
        if enabled:
            _fail(f"$.capabilities.{name}", "reserved later-phase capability must remain disabled")
        reserved[name] = False
    goal_resume = _boolean(
        capabilities_data.get("goal_resume", False), "$.capabilities.goal_resume"
    )
    if goal_resume and not isinstance(connection, ManagedConnection):
        _fail("$.capabilities.goal_resume", "requires schema-v2 managed-local configuration")

    return CampaignConfig(
        schema_version=schema_version,
        campaign_id=campaign_id,
        common_dir=common_dir,
        base_ref=base_ref,
        phase=phase,
        roles=MappingProxyType(roles),
        limits=limits,
        baseline=MappingProxyType(baseline),
        connection=connection,
        capabilities=Capabilities(
            overseer_notices=overseer_notices,
            owner_approved_notices=owner_approved_notices,
            worker_delivery=reserved["worker_delivery"],
            worker_steers=reserved["worker_steers"],
            goal_resume=goal_resume,
        ),
    )


def default_config(campaign_id: str, common_dir: str | os.PathLike, base_ref: str) -> dict:
    """Return a valid, unbound config with a safe empty-stream baseline."""
    try:
        raw_common_dir = os.fspath(common_dir)
    except (TypeError, ValueError):
        _fail("$.common_dir", "must be an absolute canonical directory")
    if not isinstance(raw_common_dir, str) or not os.path.isabs(raw_common_dir):
        _fail("$.common_dir", "must be an absolute canonical directory")
    canonical_common_dir = os.path.realpath(raw_common_dir)
    empty_prefix = hashlib.sha256(b"").hexdigest()
    data = {
        "schema_version": SCHEMA_VERSION,
        "campaign_id": campaign_id,
        "common_dir": canonical_common_dir,
        "base_ref": base_ref,
        "phase": PHASE,
        "roles": {
            role: {
                "generation": 1,
                "session_id": None,
                "directory": None,
                "branch": None,
                "agent": None,
            }
            for role in ROLES
        },
        "limits": dict(LIMIT_DEFAULTS),
        "baseline": {
            role: {
                "mode": "now",
                "offset": 0,
                "prefix_sha256": empty_prefix,
            }
            for role in SOURCE_ROLES
        },
        "connection": [],
        "capabilities": {
            "overseer_notices": False,
            "owner_approved_notices": False,
            "worker_delivery": False,
            "worker_steers": False,
            "goal_resume": False,
        },
    }
    return to_json_dict(parse_config(data))


def to_json_dict(config: CampaignConfig) -> dict:
    """Serialize the immutable model to its canonical versioned JSON shape."""
    if not isinstance(config, CampaignConfig):
        _fail("$", "expected a CampaignConfig")
    if config.schema_version == 1 and isinstance(config.connection, tuple):
        connection = list(config.connection)
    elif config.schema_version == 2 and isinstance(config.connection, ManagedConnection):
        connection = {
            "mode": "managed-local",
            "expected_url": config.connection.expected_url,
        }
        if config.connection.expected_pid is not None:
            connection["expected_pid"] = config.connection.expected_pid
    else:
        _fail("$.connection", "does not match the schema version")
    roles = {
        role: {
            "generation": config.roles[role].generation,
            "session_id": config.roles[role].session_id,
            "directory": config.roles[role].directory,
            "branch": config.roles[role].branch,
            "agent": config.roles[role].agent,
        }
        for role in ROLES
    }
    baseline = {}
    for role in SOURCE_ROLES:
        item = config.baseline[role]
        if item.mode == "now":
            baseline[role] = {
                "mode": item.mode,
                "offset": item.offset,
                "prefix_sha256": item.prefix_sha256,
            }
        else:
            baseline[role] = {
                "mode": item.mode,
                "start": item.start,
                "end": item.end,
                "prefix_sha256": item.prefix_sha256,
            }
    return {
        "schema_version": config.schema_version,
        "campaign_id": config.campaign_id,
        "common_dir": config.common_dir,
        "base_ref": config.base_ref,
        "phase": config.phase,
        "roles": roles,
        "limits": {
            "scan_interval_seconds": config.limits.scan_interval_seconds,
            "max_frame_bytes": config.limits.max_frame_bytes,
            "max_new_bytes_per_observation": config.limits.max_new_bytes_per_observation,
            "max_batch_snapshot_bytes": config.limits.max_batch_snapshot_bytes,
            "max_notice_bytes": config.limits.max_notice_bytes,
            "api_timeout_seconds": config.limits.api_timeout_seconds,
            "pre_post_retries": config.limits.pre_post_retries,
            "pre_post_backoff_seconds": list(config.limits.pre_post_backoff_seconds),
        },
        "baseline": baseline,
        "connection": connection,
        "capabilities": {
            "overseer_notices": config.capabilities.overseer_notices,
            "owner_approved_notices": config.capabilities.owner_approved_notices,
            "worker_delivery": config.capabilities.worker_delivery,
            "worker_steers": config.capabilities.worker_steers,
            "goal_resume": config.capabilities.goal_resume,
        },
    }


def notices_deliverable(config: CampaignConfig) -> tuple[bool, str]:
    """Report whether an approved and completely bound Overseer can be notified."""
    if not isinstance(config, CampaignConfig):
        _fail("$", "expected a CampaignConfig")
    overseer = config.roles["overseer"]
    if overseer.session_id is None or overseer.directory is None or overseer.agent is None:
        return False, "Overseer binding is incomplete"
    if not config.capabilities.overseer_notices:
        return False, "Overseer notices are disabled"
    if not config.capabilities.owner_approved_notices:
        return False, "Overseer notice delivery lacks owner approval"
    if not config.connection:
        return False, "Pinned server is not configured"
    return True, "Overseer notice delivery is approved"


def goal_resume_target(config: CampaignConfig, role: str) -> tuple[bool, str]:
    """Report whether the explicitly selected A/B worker is resume-eligible."""
    if not isinstance(config, CampaignConfig):
        return False, "Campaign configuration is invalid"
    if role not in ("A", "B"):
        return False, "Goal resume role must be A or B"
    if not config.capabilities.goal_resume:
        return False, "Goal resume is disabled"
    if not isinstance(config.connection, ManagedConnection):
        return False, "Goal resume requires managed-local configuration"
    binding = config.roles.get(role)
    if binding is None or any(
        value is None for value in (binding.session_id, binding.directory, binding.agent)
    ):
        return False, "Goal resume worker binding is incomplete"
    return True, f"Goal resume to {role} is approved"
