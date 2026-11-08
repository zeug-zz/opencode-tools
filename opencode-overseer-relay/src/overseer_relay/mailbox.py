#!/usr/bin/env python3
"""Bounded parser and formatter for versioned mailbox frames."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
from typing import Literal
from urllib.parse import parse_qsl, urlsplit

from overseer_relay.paths import PathError, check_no_symlinks, confine_relative, validate_campaign_id


FRAME_SCHEMA = "overseer-relay.frame.v1"
DEFAULT_MAX_FRAME_BYTES = 256 * 1024
MAX_ID_LENGTH = 128

_BEGIN_PREFIX = b"<!-- overseer-relay:begin "
_END_PREFIX = b"<!-- overseer-relay:end "
_MARKER_SUFFIX = b" -->"
_ID_BYTES_RE = re.compile(rb"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?\Z", re.ASCII)
_ID_PREFIX_BYTES_RE = re.compile(rb"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z", re.ASCII)
_ID_TEXT_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?\Z", re.ASCII)
_CREDENTIAL_KEY_RE = re.compile(
    rb"[\"'][^\"']*(?:token|secret|password|api.?key|authorization|cookie|credential|bearer)[^\"']*[\"']\s*:",
    re.IGNORECASE | re.ASCII,
)
_CREDENTIAL_ASSIGNMENT_RE = re.compile(
    rb"\b(?:token|secret|password|api[_ -]?key|authorization|cookie|credential)\b\s*[:=]\s*[^\s,;]+",
    re.IGNORECASE | re.ASCII,
)
_BEARER_RE = re.compile(rb"\bbearer\s+\S+", re.IGNORECASE | re.ASCII)
_SECRET_TOKEN_RE = re.compile(rb"\bsk-[a-z0-9][a-z0-9_-]*\b", re.IGNORECASE | re.ASCII)
_URL_RE = re.compile(rb"[a-z][a-z0-9+.-]*://[^\s<>\"'`]+", re.IGNORECASE | re.ASCII)

_REQUIRED_FIELDS = (
    "schema",
    "campaign",
    "role",
    "generation",
    "report_id",
    "kind",
    "phase",
    "task",
    "summary",
    "recommendation",
    "evidence_paths",
    "head",
    "blocker",
    "goal_state",
    "batch_id",
)
_KINDS = frozenset(("progress", "recommendation", "blocker", "phase-complete", "setup-ack", "batch-ack"))
_REPORT_KINDS = frozenset(("progress", "recommendation", "blocker", "phase-complete"))
_GOAL_STATES = frozenset(
    (
        "active",
        "paused",
        "budget_limited",
        "usage_limited",
        "complete",
        "unmet",
        "cancelled",
        "unknown",
        "not_applicable",
    )
)


@dataclass(frozen=True)
class MailboxEntry:
    """A content-free classification of one half-open source byte range."""

    start: int
    end: int
    classification: Literal["report", "protocol", "review", "held"]
    reason: str
    frame_id: str | None = None
    report_id: str | None = None
    kind: str | None = None
    batch_id: str | None = None


@dataclass(frozen=True)
class ParseResult:
    """Parsed entries and the number of leading bytes safe to consume."""

    entries: tuple[MailboxEntry, ...]
    consumed: int


class _DuplicateKey(ValueError):
    """Raised by the JSON object hook without retaining duplicate values."""


def _object_no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey
        result[key] = value
    return result


def _reject_nonfinite(_value):
    raise ValueError


def _has_id(value: object) -> bool:
    return isinstance(value, str) and len(value) <= MAX_ID_LENGTH and _ID_TEXT_RE.fullmatch(value) is not None


def _valid_payload_text(value: object, *, maximum: int, allow_empty: bool = False) -> bool:
    if not isinstance(value, str) or len(value) > maximum or (not allow_empty and not value):
        return False
    return not any(
        (ord(character) < 32 and character not in "\n\t")
        or ord(character) == 127
        or 0xD800 <= ord(character) <= 0xDFFF
        for character in value
    )


def _url_contains_credentials(value: bytes) -> bool:
    for match in _URL_RE.finditer(value):
        candidate = match.group(0).decode("ascii", errors="ignore").rstrip(".,;)]}")
        try:
            parsed = urlsplit(candidate)
            if parsed.username is not None or parsed.password is not None:
                return True
            if parsed.query:
                pairs = parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=128)
                for key, query_value in pairs:
                    if re.search(r"token|secret|password|api.?key|authorization|cookie|credential|bearer", key, re.I | re.ASCII):
                        return True
                    if _BEARER_RE.search(query_value.encode("utf-8")) or _SECRET_TOKEN_RE.search(query_value.encode("utf-8")):
                        return True
        except (ValueError, UnicodeError):
            return True
    return False


def _credential_like(raw: bytes) -> bool:
    """Detect common credential-bearing input without returning its value."""
    return bool(
        _CREDENTIAL_KEY_RE.search(raw)
        or _CREDENTIAL_ASSIGNMENT_RE.search(raw)
        or _BEARER_RE.search(raw)
        or _SECRET_TOKEN_RE.search(raw)
        or _url_contains_credentials(raw)
    )


def _entry(
    start: int,
    end: int,
    classification: Literal["report", "protocol", "review", "held"],
    reason: str,
    *,
    frame_id: str | None = None,
    report_id: str | None = None,
    kind: str | None = None,
    batch_id: str | None = None,
) -> MailboxEntry:
    return MailboxEntry(start, end, classification, reason, frame_id, report_id, kind, batch_id)


def _untrusted_range(data: bytes, start: int, end: int, reason: str) -> MailboxEntry:
    classification = "held" if _credential_like(data[start:end]) else "review"
    return _entry(start, end, classification, "credential_like_input" if classification == "held" else reason)


def _line_start(data: bytes, index: int) -> bool:
    return index == 0 or data[index - 1 : index] == b"\n"


def _find_line_prefix(data: bytes, prefix: bytes, start: int, end: int) -> int | None:
    offset = start
    while True:
        found = data.find(prefix, offset, end)
        if found < 0:
            return None
        if _line_start(data, found):
            return found
        offset = found + len(prefix)


def _parse_marker(data: bytes, position: int, prefix: bytes, end: int):
    """Return (state, identifier, after-line), with state valid/partial/bad."""
    value_start = position + len(prefix)
    search_end = min(end, value_start + MAX_ID_LENGTH + len(_MARKER_SUFFIX))
    suffix_at = data.find(_MARKER_SUFFIX, value_start, search_end)
    if suffix_at >= 0:
        raw_id = data[value_start:suffix_at]
        if _ID_BYTES_RE.fullmatch(raw_id) is None:
            return "bad", None, suffix_at + len(_MARKER_SUFFIX)
        after = suffix_at + len(_MARKER_SUFFIX)
        if after == end:
            return "partial", raw_id.decode("ascii"), after
        if data[after : after + 1] != b"\n":
            return "bad", None, after
        return "valid", raw_id.decode("ascii"), after + 1

    tail = data[value_start:end]
    if _is_partial_marker_tail(tail):
        return "partial", None, end
    return "bad", None, end


def _is_partial_marker_tail(tail: bytes) -> bool:
    """Recognize only a syntactically possible unfinished marker suffix."""
    separator = _MARKER_SUFFIX
    for separator_length in range(len(separator)):
        if separator_length and not tail.endswith(separator[:separator_length]):
            continue
        id_end = len(tail) - separator_length
        raw_id = tail[:id_end]
        if raw_id and len(raw_id) <= MAX_ID_LENGTH and _ID_PREFIX_BYTES_RE.fullmatch(raw_id) is not None:
            return True
    return not tail


def _find_end_marker(data: bytes, start: int, end: int):
    """Find a complete end-marker line; malformed IDs still close a frame."""
    position = start
    while True:
        found = _find_line_prefix(data, _END_PREFIX, position, end)
        if found is None:
            return None
        value_start = found + len(_END_PREFIX)
        search_end = min(end, value_start + DEFAULT_MAX_FRAME_BYTES)
        suffix_at = data.find(_MARKER_SUFFIX, value_start, search_end)
        if suffix_at < 0:
            return None
        after = suffix_at + len(_MARKER_SUFFIX)
        line_ok = after == end or data[after : after + 1] == b"\n"
        raw_id = data[value_start:suffix_at]
        valid_id = _ID_BYTES_RE.fullmatch(raw_id) is not None
        return found, after, raw_id.decode("ascii") if valid_id else None, valid_id and line_ok


def _partial_begin_suffix(data: bytes, start: int, end: int) -> int | None:
    """Return a trailing valid prefix of a begin marker, never a generic '<'."""
    lower = max(start, end - (len(_BEGIN_PREFIX) + MAX_ID_LENGTH + len(_MARKER_SUFFIX)))
    prefix_floor = len(b"<!-- overseer-relay:")
    for candidate in range(max(start, end - len(_BEGIN_PREFIX) + 1), end):
        partial = data[candidate:end]
        if _line_start(data, candidate) and len(partial) >= prefix_floor and _BEGIN_PREFIX.startswith(partial):
            return candidate
    found = data.rfind(_BEGIN_PREFIX, lower, end)
    while found >= start:
        if _line_start(data, found) and _is_partial_marker_tail(data[found + len(_BEGIN_PREFIX) : end]):
            return found
        found = data.rfind(_BEGIN_PREFIX, lower, found)
    return None


def _validate_evidence_paths(evidence_paths: list, worktree: str | os.PathLike | None) -> bool:
    for evidence_path in evidence_paths:
        if not isinstance(evidence_path, str) or not evidence_path:
            return False
        try:
            if worktree is None:
                confine_relative(Path("."), evidence_path)
                continue
            root = Path(os.path.abspath(os.fspath(worktree)))
            target = confine_relative(root, evidence_path)
            check_no_symlinks(root, target, allow_missing=True)
        except (OSError, UnicodeError, TypeError, ValueError, PathError):
            return False
    return True


def _validate_payload(
    payload: object,
    frame_id: str,
    *,
    expected_campaign: str | None = None,
    expected_role: str | None = None,
    expected_generation: int | None = None,
    expected_batch_id: str | None = None,
    worktree: str | os.PathLike | None = None,
):
    """Return (classification, safe reason, selected IDs) for a decoded object."""
    if not isinstance(payload, dict) or set(payload) != set(_REQUIRED_FIELDS):
        return "review", "invalid_payload", None

    if payload["schema"] != FRAME_SCHEMA:
        return "review", "unsupported_schema", None
    campaign = payload["campaign"]
    role = payload["role"]
    generation = payload["generation"]
    report_id = payload["report_id"]
    kind = payload["kind"]

    if not isinstance(campaign, str) or not campaign or not isinstance(role, str) or not role:
        return "review", "invalid_payload", None
    try:
        validate_campaign_id(campaign)
    except PathError:
        return "review", "invalid_payload", None
    if type(generation) is not int or generation < 1:
        return "review", "invalid_payload", None
    if not _has_id(report_id) or report_id != frame_id:
        return "review", "report_id_mismatch", None
    if not isinstance(kind, str) or kind not in _KINDS:
        return "review", "unsupported_kind", None

    if role not in ("A", "B", "overseer"):
        return "held", "identity_mismatch", None
    if expected_campaign is not None and campaign != expected_campaign:
        return "held", "identity_mismatch", None
    if expected_role is not None and role != expected_role:
        return "held", "identity_mismatch", None
    if expected_generation is not None and generation != expected_generation:
        return "held", "identity_mismatch", None

    if not _has_id(frame_id):
        return "review", "invalid_frame_id", None
    if payload["phase"] is not None and not _valid_payload_text(payload["phase"], maximum=128):
        return "review", "invalid_payload", None
    if payload["task"] is not None and not _valid_payload_text(payload["task"], maximum=256):
        return "review", "invalid_payload", None
    if not _valid_payload_text(payload["summary"], maximum=4096, allow_empty=True):
        return "review", "invalid_payload", None
    if payload["recommendation"] is not None and not _valid_payload_text(payload["recommendation"], maximum=4096):
        return "review", "invalid_payload", None
    if not isinstance(payload["evidence_paths"], list) or any(
        not isinstance(item, str) or not _valid_payload_text(item, maximum=4096) for item in payload["evidence_paths"]
    ):
        return "review", "invalid_payload", None
    if len(payload["evidence_paths"]) > 128:
        return "review", "invalid_payload", None
    if payload["head"] is not None and not _valid_payload_text(payload["head"], maximum=128):
        return "review", "invalid_payload", None
    if payload["blocker"] is not None and not _valid_payload_text(payload["blocker"], maximum=4096):
        return "review", "invalid_payload", None
    if not isinstance(payload["goal_state"], str) or payload["goal_state"] not in _GOAL_STATES:
        return "review", "invalid_payload", None

    batch_id = payload["batch_id"]
    if batch_id is not None and not _has_id(batch_id):
        return "review", "invalid_payload", None
    if kind == "batch-ack":
        if role != "overseer":
            return "held", "identity_mismatch", None
        if batch_id is None:
            return "review", "invalid_payload", None
        if expected_batch_id is not None and batch_id != expected_batch_id:
            return "held", "batch_id_mismatch", None
    elif kind == "setup-ack":
        if role not in ("A", "B"):
            return "held", "identity_mismatch", None
        if batch_id is not None:
            return "review", "invalid_payload", None
    elif kind in _REPORT_KINDS:
        if role not in ("A", "B"):
            return "held", "identity_mismatch", None
        if batch_id is not None:
            return "review", "invalid_payload", None

    if not _validate_evidence_paths(payload["evidence_paths"], worktree):
        return "held", "invalid_evidence_path", None

    selected = {
        "frame_id": frame_id,
        "report_id": report_id,
        "kind": kind,
        "batch_id": batch_id,
    }
    return ("protocol" if kind in ("setup-ack", "batch-ack") else "report"), "validated", selected


def _decode_and_validate(
    data: bytes,
    start: int,
    content_start: int,
    end_start: int,
    frame_end: int,
    frame_id: str,
    end_id: str | None,
    end_marker_valid: bool,
    *,
    max_frame_bytes: int,
    expected_campaign: str,
    expected_role: str,
    expected_generation: int,
    expected_batch_id: str | None,
    worktree: str | os.PathLike | None,
) -> MailboxEntry:
    raw_frame = data[start:frame_end]
    if _credential_like(raw_frame):
        return _entry(start, frame_end, "held", "credential_like_input")
    if frame_end - start > max_frame_bytes:
        return _entry(start, frame_end, "review", "frame_too_large")
    if not end_marker_valid or end_id != frame_id:
        return _entry(start, frame_end, "review", "marker_id_mismatch")

    body = data[content_start:end_start]
    open_fence = b"```json\n"
    close_fence = b"\n```\n"
    if not body.startswith(open_fence) or not body.endswith(close_fence):
        return _entry(start, frame_end, "review", "invalid_frame_format")
    raw_json = body[len(open_fence) : -len(close_fence)]
    try:
        text = raw_json.decode("utf-8", errors="strict")
        payload = json.loads(text, object_pairs_hook=_object_no_duplicates, parse_constant=_reject_nonfinite)
    except (UnicodeError, json.JSONDecodeError, ValueError, RecursionError):
        return _entry(start, frame_end, "review", "invalid_json")

    classification, reason, selected = _validate_payload(
        payload,
        frame_id,
        expected_campaign=expected_campaign,
        expected_role=expected_role,
        expected_generation=expected_generation,
        expected_batch_id=expected_batch_id,
        worktree=worktree,
    )
    if selected is None:
        return _entry(start, frame_end, classification, reason)
    return _entry(start, frame_end, classification, reason, **selected)


def _utf8_complete_prefix(data: bytes) -> int:
    """Return the end of data, or exclude one incomplete UTF-8 suffix."""
    for start in range(max(0, len(data) - 3), len(data)):
        lead = data[start]
        if 0xC2 <= lead <= 0xDF:
            width = 2
        elif 0xE0 <= lead <= 0xEF:
            width = 3
        elif 0xF0 <= lead <= 0xF4:
            width = 4
        else:
            continue
        available = len(data) - start
        if available >= width:
            continue
        suffix = data[start + 1 :]
        if any(byte < 0x80 or byte > 0xBF for byte in suffix):
            continue
        if suffix:
            second = suffix[0]
            if (lead == 0xE0 and second < 0xA0) or (lead == 0xED and second > 0x9F):
                continue
            if (lead == 0xF0 and second < 0x90) or (lead == 0xF4 and second > 0x8F):
                continue
        return start
    return len(data)


def parse(
    data: bytes,
    expected_campaign: str,
    expected_role: str,
    expected_generation: int,
    worktree: str | os.PathLike | None = None,
    max_frame_bytes: int = DEFAULT_MAX_FRAME_BYTES,
    *,
    expected_batch_id: str | None = None,
) -> ParseResult:
    """Parse complete leading mailbox entries without returning source text.

    Entries use half-open byte offsets relative to ``data``. ``consumed`` is
    the safe leading prefix; an incomplete UTF-8 sequence or a syntactically
    possible unfinished frame remains unconsumed. The parser performs no I/O
    except ``lstat`` checks for evidence paths when ``worktree`` is supplied.
    """
    if not isinstance(data, bytes):
        raise TypeError("mailbox input must be bytes")
    try:
        validate_campaign_id(expected_campaign)
    except (PathError, TypeError):
        raise ValueError("expected_campaign must be a valid campaign ID") from None
    if expected_role not in ("A", "B", "overseer"):
        raise ValueError("expected_role must be A, B, or overseer")
    if type(expected_generation) is not int or expected_generation < 1:
        raise ValueError("expected_generation must be a positive integer")
    if type(max_frame_bytes) is not int or not 1 <= max_frame_bytes <= DEFAULT_MAX_FRAME_BYTES:
        raise ValueError("max_frame_bytes must be between 1 and 256 KiB")
    if expected_batch_id is not None and not _has_id(expected_batch_id):
        raise ValueError("expected_batch_id must be a conservative identifier")

    limit = _utf8_complete_prefix(data)
    entries: list[MailboxEntry] = []
    cursor = 0

    while cursor < limit:
        begin_at = _find_line_prefix(data, _BEGIN_PREFIX, cursor, limit)
        partial_at = _partial_begin_suffix(data, cursor, limit)

        if partial_at is not None and (begin_at is None or partial_at < begin_at):
            if partial_at > cursor:
                entries.append(_untrusted_range(data, cursor, partial_at, "unframed_bytes"))
            return ParseResult(tuple(entries), partial_at)

        if begin_at is None:
            entries.append(_untrusted_range(data, cursor, limit, "unframed_bytes"))
            return ParseResult(tuple(entries), limit)

        if begin_at > cursor:
            entries.append(_untrusted_range(data, cursor, begin_at, "unframed_bytes"))
            cursor = begin_at

        open_state, frame_id, content_start = _parse_marker(data, begin_at, _BEGIN_PREFIX, limit)
        if open_state == "partial":
            return ParseResult(tuple(entries), begin_at)
        if open_state != "valid":
            closing = _find_end_marker(data, begin_at + len(_BEGIN_PREFIX), limit)
            if closing is not None:
                _, after, _, _ = closing
                frame_end = after + (1 if data[after : after + 1] == b"\n" else 0)
                entries.append(_untrusted_range(data, begin_at, frame_end, "invalid_frame_marker"))
                cursor = frame_end
                continue
            next_begin = _find_line_prefix(data, _BEGIN_PREFIX, begin_at + len(_BEGIN_PREFIX), limit)
            if next_begin is not None:
                entries.append(_untrusted_range(data, begin_at, next_begin, "invalid_frame_marker"))
                cursor = next_begin
                continue
            entries.append(_untrusted_range(data, begin_at, limit, "invalid_frame_marker"))
            return ParseResult(tuple(entries), limit)

        closing = _find_end_marker(data, content_start, limit)
        if closing is None:
            if limit - begin_at > max_frame_bytes:
                entries.append(_untrusted_range(data, begin_at, limit, "frame_too_large"))
                return ParseResult(tuple(entries), limit)
            return ParseResult(tuple(entries), begin_at)

        end_at, marker_after, end_id, marker_valid = closing
        frame_end = marker_after
        if data[frame_end : frame_end + 1] == b"\n":
            frame_end += 1
        entry = _decode_and_validate(
            data,
            begin_at,
            content_start,
            end_at,
            frame_end,
            frame_id,
            end_id,
            marker_valid,
            max_frame_bytes=max_frame_bytes,
            expected_campaign=expected_campaign,
            expected_role=expected_role,
            expected_generation=expected_generation,
            expected_batch_id=expected_batch_id,
            worktree=worktree,
        )
        entries.append(entry)
        cursor = frame_end

    return ParseResult(tuple(entries), limit)


def format_frame(payload: Mapping) -> bytes:
    """Format one validated payload using the exact v1 marker/fence layout."""
    if not isinstance(payload, Mapping):
        raise TypeError("payload must be a mapping")
    try:
        payload_dict = dict(payload)
        frame_id = payload_dict.get("report_id")
        if not _has_id(frame_id):
            raise ValueError
        classification, _, _ = _validate_payload(payload_dict, frame_id)
        if classification not in ("report", "protocol") or _credential_like(
            json.dumps(payload_dict, ensure_ascii=False, allow_nan=False).encode("utf-8")
        ):
            raise ValueError
        ordered = {name: payload_dict[name] for name in _REQUIRED_FIELDS}
        encoded_payload = json.dumps(ordered, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")
    except (KeyError, TypeError, ValueError, UnicodeError, RecursionError):
        raise ValueError("payload is not a valid credential-free v1 frame") from None

    frame = (
        _BEGIN_PREFIX
        + frame_id.encode("ascii")
        + _MARKER_SUFFIX
        + b"\n```json\n"
        + encoded_payload
        + b"\n```\n"
        + _END_PREFIX
        + frame_id.encode("ascii")
        + _MARKER_SUFFIX
        + b"\n"
    )
    if len(frame) > DEFAULT_MAX_FRAME_BYTES:
        raise ValueError("formatted frame exceeds the size limit")
    return frame


__all__ = (
    "DEFAULT_MAX_FRAME_BYTES",
    "FRAME_SCHEMA",
    "MailboxEntry",
    "ParseResult",
    "format_frame",
    "parse",
)
