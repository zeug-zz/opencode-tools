#!/usr/bin/env python3
"""Settled, bounded observations of the two append-only report mailboxes."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import stat

from overseer_relay.config import (
    MAX_CONFIG_BYTES,
    CampaignConfig,
    ConfigError,
    parse_config,
    _scan_credentials,
)
from overseer_relay.journal import Journal, JournalError
from overseer_relay.mailbox import parse


_SOURCE_ROLES = ("A", "B")
_READ_CHUNK_BYTES = 64 * 1024
_MAX_IDENTITY_VALUE = (1 << 63) - 1
_NONEMPTY_EVIDENCE_PATHS = re.compile(rb'"evidence_paths"\s*:\s*\[\s*"', re.ASCII)
_PARTIAL_CREDENTIAL_SUFFIX = re.compile(
    rb"(?:\b(?:token|secret|password|api[_ -]?key|authorization|cookie|credential)\b\s*[:=]\s*"
    rb"|\bbearer\s+|\bsk-[a-z0-9_-]*)\s*\Z",
    re.IGNORECASE | re.ASCII,
)


class WatcherError(ValueError):
    """A safe watcher diagnostic that never includes mailbox content."""


class _SourceProblem(Exception):
    """An input-specific problem with a static, content-free reason."""

    def __init__(self, reason: str, detail=None):
        self.reason = reason
        self.detail = detail
        super().__init__(reason)


class _SourceUnsettled(Exception):
    """A mutation confined to not-yet-consumed bytes invalidated this read."""

    def __init__(self, identity: dict):
        self.identity = identity
        super().__init__("source additions changed during observation")


def _digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _canonical_hash(value) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")
    return _digest(encoded)


def _identity(metadata) -> dict:
    device = metadata.st_dev
    inode = metadata.st_ino
    if (
        type(device) is not int
        or type(inode) is not int
        or not 0 <= device <= _MAX_IDENTITY_VALUE
        or not 0 <= inode <= _MAX_IDENTITY_VALUE
    ):
        raise _SourceProblem("source file identity is invalid")
    return {"device": device, "inode": inode}


def _identity_tuple(identity: dict) -> tuple[int, int]:
    return identity["device"], identity["inode"]


def _hash_fd(fd: int, start: int, end: int) -> str | None:
    """Hash one bounded-memory file range, returning None on a short read."""
    if start < 0 or end < start:
        return None
    try:
        os.lseek(fd, start, os.SEEK_SET)
    except OSError:
        return None
    digest = hashlib.sha256()
    remaining = end - start
    while remaining:
        try:
            chunk = os.read(fd, min(_READ_CHUNK_BYTES, remaining))
        except OSError:
            return None
        if not chunk:
            return None
        digest.update(chunk)
        remaining -= len(chunk)
    return digest.hexdigest()


def _read_fd(fd: int, start: int, length: int) -> bytes | None:
    """Read at most ``length`` bytes and distinguish a short read."""
    try:
        os.lseek(fd, start, os.SEEK_SET)
    except OSError:
        return None
    chunks = []
    remaining = length
    while remaining:
        try:
            chunk = os.read(fd, min(_READ_CHUNK_BYTES, remaining))
        except OSError:
            return None
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class Watcher:
    """Persist source identity and settling fingerprints, returning safe ranges.

    Each returned role value has exactly the source fields accepted by
    ``Journal.commit_batch``.  Content-free entry classifications are exposed
    separately as ``entry_metadata`` so they cannot accidentally be included
    in a journal source record.
    """

    def __init__(self, config: CampaignConfig, journal: Journal):
        if not isinstance(config, CampaignConfig) or not isinstance(journal, Journal):
            raise TypeError("Watcher requires a validated config and Journal")
        if config.campaign_id != journal.campaign_id or config.common_dir != str(journal.common_dir):
            raise WatcherError("watcher configuration does not match its campaign journal")
        self.config = config
        self.journal = journal
        self.entry_metadata: dict[str, dict] = {}
        self.newly_surfaced_holds: list[dict] = []

    def _assert_config_matches_journal(self) -> None:
        try:
            data = self.journal._read_json(
                "config.json",
                limit=MAX_CONFIG_BYTES,
                message="campaign configuration is invalid",
            )
            stored = parse_config(data)
        except (JournalError, ConfigError):
            raise WatcherError("campaign configuration could not be validated") from None
        if stored != self.config:
            raise WatcherError("watcher configuration differs from persisted campaign configuration")

    def _record_hold(self, role: str, state_source: dict, reason: str, detail=None) -> None:
        fingerprint = _canonical_hash(
            {
                "campaign_id": self.config.campaign_id,
                "role": role,
                "reason": reason,
                "cursor": state_source["cursor"],
                "identity": state_source["identity"],
                "detail": detail,
            }
        )
        transition = self.journal.set_hold(reason, source=role, fingerprint=fingerprint)
        if transition["should_notify"]:
            hold = transition["hold"]
            self.journal.mark_hold_notice(source=role)
            self.newly_surfaced_holds.append(
                {"id": hold["fingerprint"], "source": role, "reason": hold["reason"]}
            )
        # A released hold must not reuse a candidate fingerprint that predates
        # the hold.  Clearing observation is safe when the source path still
        # has the pinned identity; on replacement/symlink failures save refuses
        # the write and the source remains held.
        try:
            latest = self.journal.load()
            source = latest["sources"][role]
            if source["observation"] is not None:
                latest["sources"][role]["observation"] = None
                self.journal.save(latest)
        except JournalError:
            pass

    def _source_directory(self, role: str):
        """Open inbox and one regular source without following path links."""
        try:
            directory_fd, directory_identity = self.journal._open_directory("inbox")
        except JournalError:
            # A campaign-root replacement is not a source-local hold: the
            # journal itself must reject it rather than writing into a new root.
            self.journal.load()
            raise _SourceProblem("source directory is unsafe") from None

        name = f"{role}.md"
        descriptor = None
        try:
            try:
                before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            except OSError:
                raise _SourceProblem("source file is missing or unsafe") from None
            if stat.S_ISLNK(before.st_mode):
                raise _SourceProblem("source path contains a symlink")
            if not stat.S_ISREG(before.st_mode):
                raise _SourceProblem("source is not a regular file")
            try:
                descriptor = os.open(
                    name,
                    os.O_RDONLY
                    | getattr(os, "O_NOFOLLOW", 0)
                    | getattr(os, "O_NONBLOCK", 0),
                    dir_fd=directory_fd,
                )
            except OSError:
                raise _SourceProblem("source file could not be opened safely") from None
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode):
                raise _SourceProblem("source is not a regular file")
            opened_identity = _identity(opened)
            if _identity(before) != opened_identity:
                raise _SourceProblem("source file identity changed")
            if self.journal._path_identity("inbox") != directory_identity:
                raise _SourceProblem("source directory identity changed")
            return descriptor, directory_fd, directory_identity, opened_identity, opened
        except _SourceProblem:
            if descriptor is not None:
                os.close(descriptor)
            os.close(directory_fd)
            raise
        except (OSError, JournalError, ValueError, TypeError):
            if descriptor is not None:
                os.close(descriptor)
            os.close(directory_fd)
            # Check root integrity before converting a filesystem error into a
            # source-local hold.
            self.journal.load()
            raise _SourceProblem("source path could not be inspected safely") from None

    def _verify_source_path(
        self,
        role: str,
        directory_fd: int,
        directory_identity: tuple[int, int],
        identity: dict,
    ) -> None:
        name = f"{role}.md"
        try:
            current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except OSError:
            raise _SourceProblem("source path changed during observation") from None
        if stat.S_ISLNK(current.st_mode):
            raise _SourceProblem("source path contains a symlink")
        if not stat.S_ISREG(current.st_mode):
            raise _SourceProblem("source is not a regular file")
        if _identity(current) != identity:
            raise _SourceProblem("source file identity changed")
        try:
            if self.journal._path_identity("inbox") != directory_identity:
                raise _SourceProblem("source directory identity changed")
        except JournalError:
            self.journal.load()
            raise _SourceProblem("source directory changed during observation") from None

    def _initialize_baseline_range(self, role: str, source: dict) -> dict:
        baseline = self.config.baseline[role]
        if baseline.mode != "range" or source["identity"] is not None:
            return source
        try:
            self.journal.initialize_range_baseline(role)
        except JournalError:
            # Preserve root/state integrity failures as campaign errors.  A
            # mismatch in the explicitly configured source range is local.
            self.journal.load()
            latest = self.journal.load()["sources"][role]
            self._record_hold(
                role,
                latest,
                "configured baseline range does not match source",
                {"start": baseline.start, "end": baseline.end, "sha256": baseline.prefix_sha256},
            )
            return self.journal.load()["sources"][role]
        return self.journal.load()["sources"][role]

    def _candidate_source(self, role: str, source: dict):
        baseline = self.config.baseline[role]
        cursor = source["cursor"]
        expected_identity = source["identity"]
        if baseline.mode == "now" and expected_identity is None:
            if cursor != baseline.offset or source["prefix_sha256"] != baseline.prefix_sha256:
                raise _SourceProblem("configured baseline does not match journal cursor")
        if baseline.mode == "range" and cursor < baseline.start:
            raise _SourceProblem("journal cursor precedes configured baseline range")

        descriptor, directory_fd, directory_identity, identity, initial_stat = self._source_directory(role)
        try:
            if expected_identity is not None and identity != expected_identity:
                raise _SourceProblem(
                    "source file identity changed",
                    {"expected": expected_identity, "actual": identity},
                )
            if initial_stat.st_size < cursor:
                raise _SourceProblem(
                    "source was truncated below its cursor",
                    {"size": initial_stat.st_size, "cursor": cursor},
                )

            prefix_before = _hash_fd(descriptor, 0, cursor)
            if prefix_before is None:
                raise _SourceProblem("source was truncated while hashing its consumed prefix")
            if prefix_before != source["prefix_sha256"]:
                raise _SourceProblem(
                    "consumed source prefix changed",
                    {"expected": source["prefix_sha256"], "actual": prefix_before},
                )

            # An explicit range baseline pins the hash through its configured
            # end until that range has been consumed. This catches edits to
            # selected-but-not-yet-consumed baseline bytes as well as edits to
            # the consumed prefix.
            baseline_end = None
            if baseline.mode == "range" and cursor < baseline.end:
                if initial_stat.st_size < baseline.end:
                    raise _SourceProblem(
                        "configured baseline range is shorter than its stored end",
                        {"size": initial_stat.st_size, "end": baseline.end},
                    )
                baseline_hash = _hash_fd(descriptor, 0, baseline.end)
                if baseline_hash != baseline.prefix_sha256:
                    raise _SourceProblem(
                        "configured baseline range changed",
                        {"expected": baseline.prefix_sha256, "actual": baseline_hash},
                    )
                baseline_end = baseline.end

            available_end = initial_stat.st_size
            if baseline_end is not None:
                available_end = min(available_end, baseline_end)
            available = max(0, available_end - cursor)
            read_limit = min(
                self.config.limits.max_new_bytes_per_observation,
                self.config.limits.max_batch_snapshot_bytes,
            )
            read_length = min(available, read_limit)
            data = _read_fd(descriptor, cursor, read_length)
            if data is None:
                # A mutation in not-yet-consumed bytes restarts settling; it is
                # not a consumed-prefix rewrite unless the second prefix check
                # below proves that invariant was violated.
                prefix_after_read = _hash_fd(descriptor, 0, cursor)
                if prefix_after_read != source["prefix_sha256"]:
                    raise _SourceProblem("consumed source prefix changed during observation")
                self._verify_source_path(role, directory_fd, directory_identity, identity)
                raise _SourceUnsettled(identity)

            prefix_after_read = _hash_fd(descriptor, 0, cursor)
            if prefix_after_read is None or prefix_after_read != source["prefix_sha256"]:
                raise _SourceProblem("consumed source prefix changed during observation")

            # Re-read only the bounded candidate window to reject a same-inode
            # rewrite that raced the first read. Later appends remain queued.
            candidate_hash = _digest(data)
            observed_hash = _hash_fd(descriptor, cursor, cursor + len(data))
            if observed_hash is None or observed_hash != candidate_hash:
                self._verify_source_path(role, directory_fd, directory_identity, identity)
                raise _SourceUnsettled(identity)

            self._verify_source_path(role, directory_fd, directory_identity, identity)
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise _SourceProblem("source is not a regular file")

            parsed = parse(
                data,
                self.config.campaign_id,
                role,
                self.config.roles[role].generation,
                worktree=self.config.roles[role].directory,
                max_frame_bytes=self.config.limits.max_frame_bytes,
            )

            if parsed.consumed == 0:
                # A complete frame that cannot fit in either configured read
                # or snapshot bound cannot ever progress without operator
                # intervention; retain only a hash in the hold fingerprint.
                if data and (available > len(data) or len(data) >= read_limit):
                    raise _SourceProblem(
                        "source input exceeds configured observation bound",
                        {"start": cursor, "available_at_least": len(data) + 1},
                    )
                return {
                    "identity": identity,
                    "candidate": None,
                    "observation": None,
                    "metadata": None,
                }

            safe_end = parsed.consumed
            for entry in parsed.entries:
                if entry.classification == "held":
                    # Complete leading entries may settle first. The held range
                    # is reconsidered at the cursor after those bytes commit.
                    safe_end = min(safe_end, entry.start)
                    break
            if safe_end <= 0:
                held_entry = next(
                    (entry for entry in parsed.entries if entry.classification == "held"),
                    None,
                )
                reason = (
                    "report identity, evidence path, or credential validation failed"
                    if held_entry is not None
                    else "source input could not be safely classified"
                )
                raise _SourceProblem(reason, {"start": cursor, "end": cursor + len(data)})

            candidate_bytes = data[:safe_end]
            try:
                content = candidate_bytes.decode("utf-8", errors="strict")
            except UnicodeError:
                raise _SourceProblem(
                    "source range is not valid UTF-8",
                    {"start": cursor, "end": cursor + safe_end, "sha256": _digest(candidate_bytes)},
                ) from None
            try:
                _scan_credentials({"content": content})
            except ConfigError:
                raise _SourceProblem(
                    "source range contains credential-like input",
                    {"start": cursor, "end": cursor + safe_end, "sha256": _digest(candidate_bytes)},
                ) from None
            if _PARTIAL_CREDENTIAL_SUFFIX.search(candidate_bytes) is not None:
                raise _SourceProblem(
                    "source range contains credential-like input",
                    {"start": cursor, "end": cursor + safe_end, "sha256": _digest(candidate_bytes)},
                )
            if (
                self.config.roles[role].directory is None
                and _NONEMPTY_EVIDENCE_PATHS.search(candidate_bytes) is not None
            ):
                raise _SourceProblem(
                    "report identity, evidence path, or credential validation failed",
                    {"start": cursor, "end": cursor + safe_end, "sha256": _digest(candidate_bytes)},
                )

            candidate_end = cursor + safe_end
            prefix_after = _hash_fd(descriptor, 0, candidate_end)
            if prefix_after is None:
                prefix_after_cursor = _hash_fd(descriptor, 0, cursor)
                if prefix_after_cursor != source["prefix_sha256"]:
                    raise _SourceProblem("consumed source prefix changed during observation")
                self._verify_source_path(role, directory_fd, directory_identity, identity)
                raise _SourceUnsettled(identity)
            if _hash_fd(descriptor, cursor, candidate_end) != _digest(candidate_bytes):
                raise _SourceUnsettled(identity)
            if _hash_fd(descriptor, 0, candidate_end) != prefix_after:
                prefix_after_cursor = _hash_fd(descriptor, 0, cursor)
                if prefix_after_cursor != source["prefix_sha256"]:
                    raise _SourceProblem("consumed source prefix changed during observation")
                self._verify_source_path(role, directory_fd, directory_identity, identity)
                raise _SourceUnsettled(identity)
            self._verify_source_path(role, directory_fd, directory_identity, identity)

            metadata_entries = []
            frame_ids = []
            seen_ids = set()
            for entry in parsed.entries:
                if entry.start >= safe_end:
                    break
                if entry.end > safe_end:
                    break
                classification = entry.classification
                reason = entry.reason
                if entry.frame_id is not None:
                    if entry.frame_id in seen_ids:
                        classification = "review"
                        reason = "duplicate_frame_or_report_id"
                    else:
                        seen_ids.add(entry.frame_id)
                        if entry.classification in ("report", "protocol"):
                            frame_ids.append(entry.frame_id)
                metadata_entries.append(
                    {
                        "start": cursor + entry.start,
                        "end": cursor + entry.end,
                        "classification": classification,
                        "reason": reason,
                        "frame_id": entry.frame_id,
                        "report_id": entry.report_id,
                        "kind": entry.kind,
                        "batch_id": entry.batch_id,
                    }
                )

            source_candidate = {
                "start": cursor,
                "end": candidate_end,
                "prefix_before": prefix_before,
                "prefix_after": prefix_after,
                "identity": identity,
                "content": content,
                "frame_ids": frame_ids,
            }
            observation = {
                "schema_version": 1,
                "start": cursor,
                "end": candidate_end,
                "identity": identity,
                "prefix_before": prefix_before,
                "prefix_after": prefix_after,
                "sha256": candidate_hash if safe_end == len(data) else _digest(candidate_bytes),
            }
            observation["fingerprint"] = _canonical_hash(observation)
            classifications = {item["classification"] for item in metadata_entries}
            overall = (
                next(iter(classifications))
                if len(classifications) == 1
                else "mixed"
            )
            return {
                "identity": identity,
                "candidate": source_candidate,
                "observation": observation,
                "metadata": {
                    "classification": overall,
                    "entries": tuple(metadata_entries),
                },
            }
        finally:
            os.close(descriptor)
            os.close(directory_fd)

    def _persist_observation(self, role: str, identity: dict, observation) -> dict:
        state = self.journal.load()
        source = state["sources"][role]
        if source["hold"] is not None and not source["hold"]["released"]:
            return source
        if source["identity"] is not None and source["identity"] != identity:
            raise _SourceProblem(
                "source file identity changed",
                {"expected": source["identity"], "actual": identity},
            )
        if source["identity"] == identity and source["observation"] == observation:
            return source
        updated = copy.deepcopy(state)
        updated_source = updated["sources"][role]
        updated_source["identity"] = identity
        updated_source["observation"] = observation
        try:
            return self.journal.save(updated)["sources"][role]
        except JournalError:
            # Re-assert campaign identity before deciding this is source-local.
            self.journal.load()
            raise _SourceProblem("source identity changed while persisting observation") from None

    def observe_sources(self) -> dict[str, dict]:
        """Persist observations and return candidates settled twice by hash."""
        candidates = {}
        self.entry_metadata = {}
        self.newly_surfaced_holds = []
        with self.journal.operation_lock():
            self.journal.load()
            self._assert_config_matches_journal()

            for role in _SOURCE_ROLES:
                state = self.journal.load()
                source_state = state["sources"][role]
                hold = source_state["hold"]
                if hold is not None and not hold["released"]:
                    continue

                baseline_source = self._initialize_baseline_range(role, source_state)
                if baseline_source["hold"] is not None and not baseline_source["hold"]["released"]:
                    continue
                source_state = self.journal.load()["sources"][role]

                try:
                    result = self._candidate_source(role, source_state)
                except _SourceUnsettled as unsettled:
                    try:
                        self._persist_observation(role, unsettled.identity, None)
                    except _SourceProblem as problem:
                        self._record_hold(role, source_state, problem.reason, problem.detail)
                    continue
                except _SourceProblem as problem:
                    self._record_hold(role, source_state, problem.reason, problem.detail)
                    continue
                except JournalError:
                    # Campaign-root/state identity failures remain campaign
                    # errors; the Journal owns their fail-closed diagnosis.
                    raise
                except (OSError, TypeError, ValueError):
                    self._record_hold(
                        role,
                        source_state,
                        "source could not be safely observed",
                    )
                    continue

                # The source may be empty or end in incomplete UTF-8/frame
                # bytes. In either case pin its first observed identity but do
                # not advance or retain a candidate fingerprint.
                identity = result["identity"]
                source_candidate = result["candidate"]
                if source_candidate is not None:
                    observation = result["observation"]
                    metadata = result["metadata"]
                    old_observation = source_state["observation"]
                    try:
                        self._persist_observation(role, identity, observation)
                    except _SourceProblem as problem:
                        self._record_hold(role, source_state, problem.reason, problem.detail)
                        continue
                    if old_observation == observation:
                        candidates[role] = source_candidate
                        self.entry_metadata[role] = metadata
                else:
                    try:
                        self._persist_observation(role, identity, None)
                    except _SourceProblem as problem:
                        self._record_hold(role, source_state, problem.reason, problem.detail)
                        continue

            # The downstream batch limit applies to the coalesced source set.
            # Keep A/B ordering deterministic; omitted settled candidates stay
            # recorded and are available after the selected range commits.
            accepted = {}
            used_bytes = 0
            for role in _SOURCE_ROLES:
                candidate = candidates.get(role)
                if candidate is None:
                    continue
                size = candidate["end"] - candidate["start"]
                if used_bytes + size > self.config.limits.max_batch_snapshot_bytes:
                    self.entry_metadata.pop(role, None)
                    continue
                accepted[role] = candidate
                used_bytes += size
            return accepted

    def _evidence_pointers(self, candidate: dict, entry: dict) -> list[str]:
        """Extract only validated evidence paths for content-free snapshot metadata."""
        if entry["classification"] not in ("report", "protocol"):
            return []
        raw = candidate["content"].encode("utf-8", errors="strict")
        start = entry["start"] - candidate["start"]
        end = entry["end"] - candidate["start"]
        if start < 0 or end > len(raw) or end <= start:
            return []
        frame = raw[start:end]
        opening = b"```json\n"
        closing = b"\n```\n"
        body = frame.find(opening)
        if body < 0:
            return []
        body += len(opening)
        close_at = frame.find(closing, body)
        if close_at < 0:
            return []
        try:
            payload = json.loads(frame[body:close_at].decode("utf-8", errors="strict"))
        except (UnicodeError, json.JSONDecodeError, ValueError):
            return []
        paths = payload.get("evidence_paths") if isinstance(payload, dict) else None
        if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
            return []
        return list(paths)

    def _batch_metadata(self, candidates: dict[str, dict]) -> dict:
        entries = []
        protocol_only = True
        for role in _SOURCE_ROLES:
            candidate = candidates.get(role)
            metadata = self.entry_metadata.get(role)
            if candidate is None or metadata is None:
                continue
            for source_entry in metadata["entries"]:
                entry = dict(source_entry)
                entry["role"] = role
                entry["evidence_paths"] = self._evidence_pointers(candidate, source_entry)
                entries.append(entry)
                if entry["classification"] != "protocol":
                    protocol_only = False
        if not entries:
            protocol_only = False
        return {
            "watcher": {
                "schema_version": 1,
                "classification": "protocol-only" if protocol_only else "substantive",
                "entries": entries,
            }
        }

    def _surface_batch_hold(self, batch_id: str, reason: str) -> None:
        transition = self.journal.set_hold(reason, batch_id=batch_id)
        if not transition["should_notify"]:
            return
        hold = transition["hold"]
        self.journal.mark_hold_notice(batch_id=batch_id)
        self.newly_surfaced_holds.append(
            {"id": hold["fingerprint"], "batch_id": batch_id, "reason": hold["reason"]}
        )

    def _valid_batch_ack(self, batch_id: str, raw: bytes) -> bool:
        if not raw:
            return False
        try:
            parsed = parse(
                raw,
                self.config.campaign_id,
                "overseer",
                self.config.roles["overseer"].generation,
                worktree=self.config.roles["overseer"].directory,
                max_frame_bytes=self.config.limits.max_frame_bytes,
                expected_batch_id=batch_id,
            )
        except (TypeError, ValueError):
            return False
        return (
            parsed.consumed == len(raw)
            and len(parsed.entries) == 1
            and parsed.entries[0].start == 0
            and parsed.entries[0].end == len(raw)
            and parsed.entries[0].classification == "protocol"
            and parsed.entries[0].reason == "validated"
            and parsed.entries[0].kind == "batch-ack"
            and parsed.entries[0].batch_id == batch_id
        )

    def _pending_result(self, batch_id: str, state: dict, *, recovered=(), acknowledged=None) -> dict:
        batch = state["batches"][batch_id]
        active_hold = batch["hold"] is not None and not batch["hold"]["released"]
        return {
            "status": "held" if active_hold else "pending",
            "batch_id": batch_id,
            "batch_status": batch["status"],
            "pending_batch": batch_id,
            "source_roles": [role for role in _SOURCE_ROLES if role in batch["sources"]],
            "recovered_batch_ids": list(recovered),
            "acknowledged_batch_id": acknowledged,
            "newly_surfaced_holds": copy.deepcopy(self.newly_surfaced_holds),
        }

    def process_once(self) -> dict:
        """Run one locked, restart-safe watcher cycle without sending transport."""
        self.entry_metadata = {}
        self.newly_surfaced_holds = []
        acknowledged_batch_id = None
        with self.journal.operation_lock():
            recovered = self.journal.recover_batches()
            state = self.journal.load()
            pending = state["pending_batch"]

            if pending is not None:
                batch = state["batches"][pending]
                if batch["status"] == "admitted":
                    try:
                        raw_ack = self.journal.read_batch_ack(
                            pending, limit=self.config.limits.max_frame_bytes
                        )
                    except JournalError:
                        self._surface_batch_hold(pending, "batch acknowledgement is unsafe")
                        return self._pending_result(pending, self.journal.load(), recovered=recovered)
                    if raw_ack is not None:
                        if not self._valid_batch_ack(pending, raw_ack):
                            self._surface_batch_hold(pending, "batch acknowledgement is invalid")
                            return self._pending_result(pending, self.journal.load(), recovered=recovered)
                        self.journal.release_hold(batch_id=pending)
                        self.journal.set_delivery_state(pending, "acknowledged")
                        acknowledged_batch_id = pending
                        state = self.journal.load()
                        pending = state["pending_batch"]

                if pending is not None:
                    return self._pending_result(
                        pending,
                        state,
                        recovered=recovered,
                        acknowledged=acknowledged_batch_id,
                    )

            candidates = self.observe_sources()
            if not candidates:
                latest = self.journal.load()
                has_active_source_hold = any(
                    source["hold"] is not None and not source["hold"]["released"]
                    for source in latest["sources"].values()
                )
                return {
                    "status": "held" if has_active_source_hold else "idle",
                    "batch_id": None,
                    "batch_status": None,
                    "pending_batch": latest["pending_batch"],
                    "source_roles": [],
                    "recovered_batch_ids": list(recovered),
                    "acknowledged_batch_id": acknowledged_batch_id,
                    "newly_surfaced_holds": copy.deepcopy(self.newly_surfaced_holds),
                }

            batch_id = self.journal.commit_batch(
                candidates,
                metadata=self._batch_metadata(candidates),
            )
            state = self.journal.load()
            batch_status = state["batches"][batch_id]["status"]
            return {
                "status": "acknowledged" if batch_status == "acknowledged" else "snapshotted",
                "batch_id": batch_id,
                "batch_status": batch_status,
                "pending_batch": state["pending_batch"],
                "source_roles": [role for role in _SOURCE_ROLES if role in candidates],
                "recovered_batch_ids": list(recovered),
                "acknowledged_batch_id": acknowledged_batch_id,
                "newly_surfaced_holds": copy.deepcopy(self.newly_surfaced_holds),
            }


def observe_sources(config: CampaignConfig, journal: Journal) -> dict[str, dict]:
    """Convenience entrypoint for one observation pass."""
    return Watcher(config, journal).observe_sources()


__all__ = ("Watcher", "WatcherError", "observe_sources")
