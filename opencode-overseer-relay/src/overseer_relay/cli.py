#!/usr/bin/env python3
"""Owner-directed campaign setup and foreground relay commands.

The initial watcher state is intentionally minimal for task 2.3: schema_version,
two source records containing cursor and consumed-prefix SHA-256, and an empty
batches object. The journal task owns any later extensions to this shape.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

from overseer_relay import __version__
from overseer_relay.config import (
    ConfigError,
    default_config,
    notices_deliverable,
    parse_config,
    goal_resume_target,
    to_json_dict,
)
from overseer_relay.journal import (
    Journal,
    JournalError,
    atomic_write_json,
    atomic_write_text,
)
from overseer_relay.mailbox import parse as parse_mailbox
from overseer_relay.paths import (
    GIT_TIMEOUT_SECONDS,
    PathError,
    campaign_dir,
    check_no_symlinks,
    resolve_common_dir,
)
from overseer_relay.transport import TransportError, deliver_pending, request_goal_resume
from overseer_relay.watcher import Watcher


EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
STATE_JSON_SHAPE = {
    "schema_version": 1,
    "sources": {
        "A": {"cursor": "baseline end offset", "prefix_sha256": "sha256(bytes[0:cursor])"},
        "B": {"cursor": "baseline end offset", "prefix_sha256": "sha256(bytes[0:cursor])"},
    },
    "batches": {},
}
_BASELINE_RANGE = re.compile(r"([0-9]+):([0-9]+)\Z", re.ASCII)


class CLIError(ValueError):
    """A safe, value-minimizing command-line diagnostic."""


def _git_output(argv: list[str], *, cwd: Path, optional_locks: bool = True) -> str:
    """Run Git with an argument array, fixed timeout, and no echoed stderr."""
    env = os.environ.copy()
    if optional_locks:
        # `status` may otherwise refresh the index during a supposedly read-only
        # inspect or dry-run. Git honors this switch for optional index writes.
        env["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        result = subprocess.run(
            argv,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=GIT_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError, UnicodeError, ValueError):
        raise CLIError("Git command could not be completed") from None
    if result.returncode != 0:
        raise CLIError("Git command failed")
    output = result.stdout
    if output.endswith("\n"):
        output = output[:-1]
    if "\x00" in output:
        raise CLIError("Git returned invalid command output")
    return output


def _canonical_user_directory(value: str | os.PathLike) -> Path:
    """Validate an explicit existing directory without following symlinks."""
    try:
        raw_path = Path(value).expanduser()
        absolute = Path(os.path.abspath(raw_path))
        check_no_symlinks(Path(absolute.anchor), absolute)
        if not absolute.is_dir():
            raise CLIError("repository path must be an existing directory")
        return Path(os.path.realpath(absolute))
    except CLIError:
        raise
    except (OSError, TypeError, ValueError, PathError):
        raise CLIError("repository path could not be inspected safely") from None


def _repository_root(start: Path) -> Path:
    output = _git_output(
        ["git", "-C", str(start), "rev-parse", "--show-toplevel"], cwd=start
    )
    if not output or "\n" in output or "\r" in output:
        raise CLIError("Git repository root could not be resolved")
    root = Path(os.path.realpath(output))
    try:
        check_no_symlinks(Path(root.anchor), root)
    except PathError:
        raise CLIError("Git repository root contains an unsafe path") from None
    return root


def _parse_worktree_list(output: str) -> list[dict]:
    """Parse `git worktree list --porcelain` without exposing malformed data."""
    records: list[dict] = []
    current: dict | None = None

    def finish() -> None:
        nonlocal current
        if current is not None:
            if not current.get("path"):
                raise CLIError("Git returned an invalid worktree list")
            records.append(current)
            current = None

    for line in output.splitlines():
        if not line:
            finish()
            continue
        if line.startswith("worktree "):
            finish()
            current = {"path": line[len("worktree ") :], "branch": None, "head": None}
            continue
        if current is None:
            raise CLIError("Git returned an invalid worktree list")
        if line.startswith("HEAD "):
            current["head"] = line[len("HEAD ") :]
        elif line.startswith("branch "):
            current["branch"] = line[len("branch ") :]
        elif line == "detached":
            current["detached"] = True
        elif line == "bare":
            current["bare"] = True
        elif line == "locked" or line.startswith("locked "):
            current["locked"] = True
        elif line == "prunable" or line.startswith("prunable "):
            current["prunable"] = True
        else:
            # Keep forward-compatible metadata out of the result; only known
            # identity fields affect setup decisions.
            continue
    finish()
    if not records:
        raise CLIError("Git returned no worktrees")
    return records


def _worktrees(repo_root: Path) -> list[dict]:
    output = _git_output(
        ["git", "-C", str(repo_root), "worktree", "list", "--porcelain"],
        cwd=repo_root,
    )
    records = _parse_worktree_list(output)
    for record in records:
        listed_path = Path(os.path.abspath(record["path"]))
        record["path"] = str(listed_path)
        record["dirty"] = None
        try:
            worktree_path = listed_path
            check_no_symlinks(Path(worktree_path.anchor), worktree_path, allow_missing=True)
            if worktree_path.is_dir() and not record.get("bare"):
                status_output = _git_output(
                    ["git", "-C", str(worktree_path), "status", "--porcelain"],
                    cwd=repo_root,
                )
                record["dirty"] = bool(status_output)
        except (CLIError, PathError, OSError):
            # Inspect must show each Git-registered worktree even when a
            # prunable/deleted entry cannot provide a status.
            record["dirty"] = None
    return records


def _branch_name(branch: str | None) -> str | None:
    if branch is None:
        return None
    prefix = "refs/heads/"
    if branch.startswith(prefix):
        return branch[len(prefix) :]
    return branch


def _validate_branch_pair(
    branch_a: str | None,
    branch_b: str | None,
    *,
    main_branch: str | None,
    base_branch: str | None,
) -> None:
    """Require independent worker branches, excluding both protected refs."""
    if not branch_a or not branch_b:
        raise CLIError("A and B must both be attached to branches")
    if branch_a == branch_b:
        raise CLIError("A and B must use distinct branches")
    protected = {branch for branch in (main_branch, base_branch) if branch}
    for branch in (branch_a, branch_b):
        if branch in protected:
            raise CLIError("worker branches must not use the main or base branch")


def _selected_worktree(path_arg: str, *, common_dir: Path, records: list[dict]) -> dict:
    requested = _canonical_user_directory(path_arg)
    repo_root = _repository_root(requested)
    if repo_root != requested:
        raise CLIError("worktree path must name its checkout root")
    try:
        selected_common = resolve_common_dir(repo_root)
    except PathError:
        raise CLIError("worker path is not a Git worktree in this repository") from None
    if selected_common != common_dir:
        raise CLIError("all selected worktrees must share the main repository common directory")
    for record in records:
        if record["path"] == str(repo_root):
            if record.get("bare") or record.get("prunable"):
                break
            return record
    raise CLIError("selected path is not a registered worktree")


def _validate_base_ref(repo_root: Path, base_ref: str) -> str | None:
    # Parse once through the same strict config validation used for persistence;
    # this catches controls/credential-like values without echoing them.
    default_config("baseline-check", str(resolve_common_dir(repo_root)), base_ref)
    revision = f"{base_ref}^{{commit}}"
    try:
        _git_output(
            [
                "git",
                "-C",
                str(repo_root),
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                revision,
            ],
            cwd=repo_root,
        )
    except CLIError:
        raise CLIError("base ref does not resolve to a commit") from None
    try:
        symbolic = _git_output(
            [
                "git",
                "-C",
                str(repo_root),
                "rev-parse",
                "--symbolic-full-name",
                "--verify",
                "--quiet",
                "--end-of-options",
                base_ref,
            ],
            cwd=repo_root,
        )
    except CLIError:
        return None
    if symbolic.startswith(("refs/heads/", "refs/remotes/")):
        return symbolic
    return None


def _baseline_for_file(selection: str, inbox_path: Path) -> dict:
    """Compute an explicit now/range baseline from a safe regular inbox file."""
    if selection != "now":
        match = _BASELINE_RANGE.fullmatch(selection)
        if match is None:
            raise CLIError("baseline must be 'now' or START:END")
        start, end = (int(value) for value in match.groups())
        if end <= start:
            raise CLIError("baseline byte range is reversed or empty")
    else:
        start = None
        end = None

    try:
        descriptor = os.open(
            inbox_path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        )
    except FileNotFoundError:
        size = 0
        if selection == "now":
            return {"mode": "now", "offset": 0, "prefix_sha256": EMPTY_SHA256}
        raise CLIError("baseline byte range exceeds the inbox length") from None
    except (OSError, TypeError, ValueError):
        raise CLIError("inbox baseline could not be read safely") from None

    try:
        with os.fdopen(descriptor, "rb") as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode):
                raise CLIError("inbox baseline must be a regular file")
            size = metadata.st_size
            if selection == "now":
                cursor = size
            else:
                if end > size:
                    raise CLIError("baseline byte range exceeds the inbox length")
                cursor = end
            remaining = cursor
            digest = hashlib.sha256()
            while remaining:
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise CLIError("inbox changed while its baseline was read")
                digest.update(chunk)
                remaining -= len(chunk)
            prefix_sha256 = digest.hexdigest()
    except CLIError:
        raise
    except (OSError, ValueError):
        raise CLIError("inbox baseline could not be read safely") from None

    if selection == "now":
        return {"mode": "now", "offset": cursor, "prefix_sha256": prefix_sha256}
    return {
        "mode": "range",
        "start": start,
        "end": end,
        "prefix_sha256": prefix_sha256,
    }


def _campaigns_and_backlogs(common_dir: Path) -> list[dict]:
    root = common_dir / "overseer-relay" / "campaigns"
    try:
        check_no_symlinks(common_dir, root, allow_missing=True)
        root_stat = root.lstat()
    except FileNotFoundError:
        return []
    except PathError:
        raise CLIError("campaign path contains an unsafe component") from None
    except OSError:
        raise CLIError("campaign directory could not be inspected") from None
    if not stat.S_ISDIR(root_stat.st_mode):
        raise CLIError("campaign directory is not a directory")

    results = []
    try:
        entries = sorted(root.iterdir(), key=lambda entry: entry.name)
    except OSError:
        raise CLIError("campaign directory could not be inspected") from None
    for entry in entries:
        try:
            check_no_symlinks(common_dir, entry)
            entry_stat = entry.lstat()
        except (OSError, PathError):
            raise CLIError("campaign entry contains an unsafe component") from None
        if not stat.S_ISDIR(entry_stat.st_mode):
            continue
        backlog = {}
        for role in ("A", "B"):
            inbox = entry / "inbox" / f"{role}.md"
            try:
                check_no_symlinks(common_dir, inbox, allow_missing=True)
                inbox_stat = inbox.lstat()
            except FileNotFoundError:
                backlog[role] = 0
                continue
            except (OSError, PathError):
                raise CLIError("campaign inbox contains an unsafe component") from None
            if not stat.S_ISREG(inbox_stat.st_mode):
                raise CLIError("campaign inbox must be a regular file")
            backlog[role] = inbox_stat.st_size
        results.append(
            {
                "campaign_id": entry.name,
                "path": str(entry),
                "backlog_bytes": backlog,
            }
        )
    return results


def _inspect(repo_arg: str | os.PathLike) -> dict:
    start = _canonical_user_directory(repo_arg)
    repo_root = _repository_root(start)
    common_dir = resolve_common_dir(repo_root)
    try:
        check_no_symlinks(Path(common_dir.anchor), common_dir)
    except PathError:
        raise CLIError("Git common directory contains an unsafe path") from None
    worktrees = _worktrees(repo_root)
    campaigns = _campaigns_and_backlogs(common_dir)
    return {
        "common_dir": str(common_dir),
        "worktrees": [
            {
                "path": record["path"],
                "branch": record.get("branch"),
                "dirty": record.get("dirty"),
            }
            for record in worktrees
        ],
        "campaigns": campaigns,
    }


def _format_inspect(report: dict) -> str:
    lines = [f"Git common directory: {report['common_dir']}", "Worktrees:"]
    for record in report["worktrees"]:
        branch = record["branch"] or "(detached or unavailable)"
        dirty = "unavailable" if record["dirty"] is None else ("dirty" if record["dirty"] else "clean")
        lines.append(f"  - {record['path']} | branch: {branch} | status: {dirty}")
    lines.append("Existing campaigns:")
    if not report["campaigns"]:
        lines.append("  (none)")
    for campaign in report["campaigns"]:
        backlog = campaign["backlog_bytes"]
        lines.append(
            f"  - {campaign['campaign_id']}: {campaign['path']} "
            f"(inbox/A.md: {backlog['A']} bytes; inbox/B.md: {backlog['B']} bytes)"
        )
    return "\n".join(lines)


def _prepare_init(args) -> tuple[Path, dict, dict, list[dict]]:
    start = _canonical_user_directory(args.repo)
    repo_root = _repository_root(start)
    common_dir = resolve_common_dir(repo_root)
    try:
        check_no_symlinks(Path(common_dir.anchor), common_dir)
    except PathError:
        raise CLIError("Git common directory contains an unsafe path") from None

    target = campaign_dir(common_dir, args.campaign)
    try:
        check_no_symlinks(common_dir, target, allow_missing=True)
        target.lstat()
    except FileNotFoundError:
        pass
    except PathError:
        raise CLIError("campaign path contains an unsafe component") from None
    except OSError:
        raise CLIError("campaign path could not be inspected") from None
    else:
        raise CLIError("campaign already exists; refusing to overwrite or adopt it")

    worktrees = _worktrees(repo_root)
    main_record = next(
        (item for item in worktrees if item["path"] == str(repo_root)),
        None,
    )
    if main_record is None or main_record.get("bare"):
        raise CLIError("--repo must identify a registered non-bare checkout")

    base_branch = _validate_base_ref(repo_root, args.base_ref)
    selected_a = selected_b = None
    if bool(args.worktree_a) != bool(args.worktree_b):
        raise CLIError("provide both --worktree-a and --worktree-b, or neither")
    if args.worktree_a and args.worktree_b:
        selected_a = _selected_worktree(args.worktree_a, common_dir=common_dir, records=worktrees)
        selected_b = _selected_worktree(args.worktree_b, common_dir=common_dir, records=worktrees)
        if selected_a["path"] == selected_b["path"]:
            raise CLIError("A and B must be distinct worktrees")
        if selected_a["path"] == str(repo_root) or selected_b["path"] == str(repo_root):
            raise CLIError("A and B must not use the main checkout")
        _validate_branch_pair(
            selected_a.get("branch"),
            selected_b.get("branch"),
            main_branch=main_record.get("branch"),
            base_branch=base_branch,
        )
        if selected_a.get("dirty") is None or selected_b.get("dirty") is None:
            raise CLIError("selected worktree status could not be determined")

    data = default_config(args.campaign, str(common_dir), args.base_ref)
    if args.overseer_session is not None:
        data["roles"]["overseer"]["session_id"] = args.overseer_session
    if args.overseer_directory is not None:
        data["roles"]["overseer"]["directory"] = str(
            _canonical_user_directory(args.overseer_directory)
        )
    if args.overseer_agent is not None:
        data["roles"]["overseer"]["agent"] = args.overseer_agent
    if args.a_session is not None:
        data["roles"]["A"]["session_id"] = args.a_session
    if args.b_session is not None:
        data["roles"]["B"]["session_id"] = args.b_session
    if selected_a is not None and selected_b is not None:
        for role, record in (("A", selected_a), ("B", selected_b)):
            data["roles"][role]["directory"] = record["path"]
            data["roles"][role]["branch"] = _branch_name(record.get("branch"))

    inbox_paths = {
        role: target / "inbox" / f"{role}.md"
        for role in ("A", "B")
    }
    for inbox in inbox_paths.values():
        try:
            check_no_symlinks(common_dir, inbox, allow_missing=True)
        except PathError:
            raise CLIError("campaign inbox path contains an unsafe component") from None
    data["baseline"] = {
        role: _baseline_for_file(selection, inbox_paths[role])
        for role, selection in (("A", args.baseline_a), ("B", args.baseline_b))
    }
    validated_config = to_json_dict(parse_config(data))
    state = {
        "schema_version": 1,
        "sources": {
            role: {
                "cursor": (
                    baseline["offset"] if baseline["mode"] == "now" else baseline["end"]
                ),
                "prefix_sha256": baseline["prefix_sha256"],
            }
            for role, baseline in validated_config["baseline"].items()
        },
        "batches": {},
    }
    return target, validated_config, state, worktrees


_LAYOUT = (
    ("config.json", "file"),
    ("inbox/", "directory"),
    ("inbox/A.md", "file"),
    ("inbox/B.md", "file"),
    ("rulings/", "directory"),
    ("rulings/A.md", "file"),
    ("rulings/B.md", "file"),
    ("watcher/", "directory"),
    ("watcher/state.json", "file"),
    ("watcher/batches/", "directory"),
    ("holds.json", "file"),
    ("overseer-handoff.md", "file"),
)


def _render_init_preview(
    target: Path,
    config: dict,
    state: dict,
    worktrees: list[dict],
    *,
    applied: bool = False,
) -> str:
    lines = [
        "Applied campaign state." if applied else "Dry run: no files written.",
        f"Campaign root: {target}",
        "Created layout:" if applied else "Layout that would be created:",
    ]
    lines.extend(f"  {path} ({kind})" for path, kind in _LAYOUT)
    lines.append("  watcher/lock is not created; the runtime acquires it when needed.")
    lines.append(
        "Configuration written to config.json:"
        if applied
        else "Configuration that would be written to config.json:"
    )
    lines.append(json.dumps(config, ensure_ascii=False, indent=2))
    lines.append("Initial watcher/state.json:")
    lines.append(json.dumps(state, ensure_ascii=False, indent=2))
    if not any(arg for arg in (config["roles"]["A"]["directory"], config["roles"]["B"]["directory"])):
        lines.append("A/B worktrees are unbound; no worktree paths were supplied.")
    lines.append("Registered worktree status:")
    role_by_path = {
        config["roles"][role]["directory"]: role
        for role in ("A", "B")
        if config["roles"][role]["directory"] is not None
    }
    for record in worktrees:
        path = record["path"]
        role = role_by_path.get(path, "unassigned")
        dirty = record.get("dirty")
        status = "unavailable" if dirty is None else ("dirty" if dirty else "clean")
        branch = record.get("branch") or "(detached or unavailable)"
        lines.append(f"Worktree {role}: {path} | branch: {branch} | status: {status}")
        if dirty:
            lines.append(f"Worktree {role} is dirty; it will be preserved unchanged.")
    lines.append("No sessions or goals are discovered, created, or adopted.")
    return "\n".join(lines)


def _apply_init(target: Path, config: dict, state: dict, common_dir: Path) -> None:
    try:
        check_no_symlinks(common_dir, target, allow_missing=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        check_no_symlinks(common_dir, target.parent)
        # The final mkdir is exclusive: an existing campaign is never adopted.
        try:
            target.mkdir()
        except FileExistsError:
            raise CLIError("campaign already exists; refusing to overwrite or adopt it") from None
        check_no_symlinks(common_dir, target)
        for relative in ("inbox", "rulings", "watcher", "watcher/batches"):
            directory = target / relative
            directory.mkdir()
            check_no_symlinks(common_dir, directory)

        files = {
            "config.json": config,
            "inbox/A.md": "",
            "inbox/B.md": "",
            "rulings/A.md": "",
            "rulings/B.md": "",
            "watcher/state.json": state,
            "holds.json": {},
            "overseer-handoff.md": (
                "# Overseer handoff\n\n"
                "Campaign state is in this directory. Review `config.json` and the A/B inboxes "
                "before any separately approved notice activation.\n"
            ),
        }
        for relative, value in files.items():
            destination = target / relative
            check_no_symlinks(common_dir, destination, allow_missing=True)
            if destination.exists() or destination.is_symlink():
                raise CLIError("campaign file already exists; refusing to overwrite it")
            if relative in ("config.json", "watcher/state.json", "holds.json"):
                atomic_write_json(destination, value)
            else:
                atomic_write_text(destination, value)
            check_no_symlinks(common_dir, destination)
    except CLIError:
        raise
    except (OSError, PathError):
        raise CLIError("campaign state could not be written safely") from None


def _open_campaign(campaign_dir_arg: str | os.PathLike) -> tuple[Journal, object]:
    """Resolve an explicit campaign path and prove its canonical layout."""
    try:
        requested = Path(campaign_dir_arg).expanduser()
        target = Path(os.path.abspath(requested))
        check_no_symlinks(Path(target.anchor), target)
        if not target.is_dir() or Path(os.path.realpath(target)) != target:
            raise CLIError("campaign directory is invalid or unsafe")
        campaign_id = target.name
        common_dir = target.parents[2]
        if campaign_dir(common_dir, campaign_id) != target:
            raise CLIError("campaign directory is not at its configured canonical location")
        journal = Journal(common_dir, campaign_id)
        config = journal.read_config_readonly()
        if config.campaign_id != campaign_id or config.common_dir != str(common_dir):
            raise CLIError("campaign configuration does not match its canonical directory")
        return journal, config
    except CLIError:
        raise
    except (IndexError, OSError, PathError, JournalError, TypeError, ValueError):
        raise CLIError("campaign directory is invalid or unsafe") from None


def _active_hold(hold) -> bool:
    return hold is not None and not hold["released"]


def _hold_summary(hold) -> dict | None:
    if hold is None:
        return None
    return {
        "reason": hold["reason"],
        "released": hold["released"],
        "notice_emitted": hold["notice_emitted"],
        "fingerprint": hold["fingerprint"],
    }


def _ack_status(journal: Journal, config, batch_id: str) -> str:
    try:
        raw = journal.read_batch_ack_readonly(
            batch_id, limit=config.limits.max_frame_bytes
        )
    except JournalError:
        return "unsafe"
    if raw is None:
        return "missing"
    try:
        parsed = parse_mailbox(
            raw,
            config.campaign_id,
            "overseer",
            config.roles["overseer"].generation,
            worktree=config.roles["overseer"].directory,
            max_frame_bytes=config.limits.max_frame_bytes,
            expected_batch_id=batch_id,
        )
    except (TypeError, ValueError):
        return "invalid"
    valid = (
        parsed.consumed == len(raw)
        and len(parsed.entries) == 1
        and parsed.entries[0].start == 0
        and parsed.entries[0].end == len(raw)
        and parsed.entries[0].classification == "protocol"
        and parsed.entries[0].reason == "validated"
        and parsed.entries[0].kind == "batch-ack"
        and parsed.entries[0].batch_id == batch_id
    )
    return "valid" if valid else "invalid"


def _campaign_view(journal: Journal, config) -> dict:
    """Build a bounded, content-free view using only read-only journal APIs."""
    state = journal.read_state_readonly()
    sources = {}
    for role in ("A", "B"):
        _path, metadata = journal._check_path(f"inbox/{role}.md", kind="file")
        assert metadata is not None
        cursor = state["sources"][role]["cursor"]
        observation = state["sources"][role]["observation"]
        sources[role] = {
            "cursor": cursor,
            "file_size": metadata.st_size,
            "queued_range": [cursor, metadata.st_size]
            if metadata.st_size > cursor
            else None,
            "observation_range": (
                [observation["start"], observation["end"]]
                if observation is not None
                else None
            ),
            "observation_fingerprint": (
                observation["fingerprint"] if observation is not None else None
            ),
            "hold": _hold_summary(state["sources"][role]["hold"]),
        }

    batches = []
    for batch_id, record in sorted(state["batches"].items()):
        if record["status"] == "acknowledged":
            continue
        ranges = {
            role: [item["start"], item["end"]]
            for role, item in record["sources"].items()
        }
        # Validate the immutable snapshot before presenting its ranges as
        # journal-backed state; never expose the snapshot's report content.
        journal.read_batch_snapshot_readonly(batch_id)
        receipt = record["receipt"]
        batches.append(
            {
                "batch_id": batch_id,
                "status": record["status"],
                "pending": state["pending_batch"] == batch_id,
                "send_intent_recorded": record["send_intent_recorded"],
                "ranges": ranges,
                "receipt_id": receipt.get("id") if receipt is not None else None,
                "acknowledgement": _ack_status(journal, config, batch_id),
                "hold": _hold_summary(record["hold"]),
                "unresolved_outcome": record["status"] in ("held", "uncertain", "failed"),
            }
        )

    return {
        "campaign_id": config.campaign_id,
        "campaign_dir": str(journal.campaign_root),
        "common_dir": str(journal.common_dir),
        "sources": sources,
        "campaign_hold": _hold_summary(state["hold"]),
        "pending_batch": state["pending_batch"],
        "batches": batches,
        "holds_json": "initial compatibility artifact; watcher/state.json is the source of truth",
    }


def _format_campaign_view(view: dict, *, dry_run=False) -> str:
    lines = []
    if dry_run:
        lines.append("Dry run: no transport, lock, or state writes.")
    lines.extend(
        (
            f"Campaign: {view['campaign_id']}",
            f"Campaign root: {view['campaign_dir']}",
            "Sources:",
        )
    )
    for role in ("A", "B"):
        source = view["sources"][role]
        queued = source["queued_range"]
        observation = source["observation_range"]
        lines.append(
            f"  {role}: cursor={source['cursor']}, file_size={source['file_size']}, "
            f"queued={f'[{queued[0]},{queued[1]})' if queued else 'none'}, "
            f"observation={f'[{observation[0]},{observation[1]})' if observation else 'none'}"
        )
        hold = source["hold"]
        if hold is not None:
            state = "released" if hold["released"] else "active"
            lines.append(f"    hold ({state}): {hold['reason']}")
    campaign_hold = view["campaign_hold"]
    if campaign_hold is not None:
        state = "released" if campaign_hold["released"] else "active"
        lines.append(f"Campaign hold ({state}): {campaign_hold['reason']}")
    if view["batches"]:
        lines.append("Pending/unresolved batches:")
        for batch in view["batches"]:
            flags = []
            if batch["pending"]:
                flags.append("pending")
            if batch["unresolved_outcome"]:
                flags.append("unresolved outcome")
            ranges = ", ".join(
                f"{role}=[{span[0]},{span[1]})"
                for role, span in batch["ranges"].items()
            )
            lines.append(
                f"  {batch['batch_id']}: status={batch['status']} "
                f"({', '.join(flags) or 'queued'}); {ranges}; "
                f"acknowledgement={batch['acknowledgement']}"
            )
            if batch["receipt_id"] is not None:
                lines.append(f"    admission receipt: {batch['receipt_id']}")
            if batch["hold"] is not None:
                state = "released" if batch["hold"]["released"] else "active"
                lines.append(f"    hold ({state}): {batch['hold']['reason']}")
    else:
        lines.append("Pending/unresolved batches: none")
    lines.append(view["holds_json"])
    return "\n".join(lines)


def _delivery_block_reason(state: dict, batch_id: str) -> str | None:
    if _active_hold(state["hold"]):
        return "campaign hold is active"
    batch = state["batches"].get(batch_id)
    if batch is None:
        return "pending batch is missing from the journal"
    if batch["status"] in ("held", "failed"):
        return "batch requires an explicit release or operator investigation"
    if batch["status"] == "uncertain" and _active_hold(batch["hold"]):
        return "uncertain outcome is held; explicit operator release is required before reconciliation"
    if _active_hold(batch["hold"]):
        return "batch hold is active; use release before another delivery operation"
    if batch["status"] == "uncertain":
        if batch["hold"] is None or not batch["hold"]["released"]:
            return "uncertain outcome requires explicit operator release before reconciliation"
    for role in batch["sources"]:
        if _active_hold(state["sources"][role]["hold"]):
            return f"source {role} hold is active"
    if batch["status"] not in ("snapshotted", "send-intent", "uncertain"):
        return "batch is not eligible for delivery or reconciliation"
    return None


def _run_cycle(
    journal: Journal,
    config,
    *,
    deliver_notices: bool,
    runner=None,
    sleep=None,
) -> tuple[dict, dict | None]:
    result = Watcher(config, journal).process_once()
    delivery = None
    if not deliver_notices:
        return result, delivery

    # Read the persisted config again for each delivery decision. A saved
    # revocation is effective even while a foreground watch is running.
    current_config = journal.read_config_readonly()
    allowed, reason = notices_deliverable(current_config)
    if not allowed:
        return result, {"status": "not-authorized", "reason": reason}

    state = journal.read_state_readonly()
    batch_id = state["pending_batch"]
    if batch_id is None:
        return result, {"status": "idle", "batch_id": None}
    batch = state["batches"].get(batch_id)
    if batch is not None and batch["status"] == "admitted":
        return result, {
            "status": "admitted",
            "batch_id": batch_id,
            "reason": "awaiting Overseer acknowledgement",
        }
    blocked = _delivery_block_reason(state, batch_id)
    if blocked is not None:
        return result, {"status": "held", "batch_id": batch_id, "reason": blocked}

    delivery = deliver_pending(current_config, journal, runner=runner, sleep=sleep)
    if delivery["status"] == "uncertain" and delivery["batch_id"] is not None:
        latest = journal.read_state_readonly()
        batch = latest["batches"][delivery["batch_id"]]
        hold = batch["hold"]
        if hold is not None and hold["released"]:
            # A released uncertain batch gets exactly one reconciliation pass;
            # re-arm its operator gate if the outcome remains unresolved.
            journal.set_hold(
                "delivery outcome remains unresolved; operator release required",
                batch_id=delivery["batch_id"],
                notice_emitted=True,
            )
    return result, delivery


def _cycle_report(result: dict, delivery: dict | None) -> dict:
    return {
        "status": result["status"],
        "batch_id": result["batch_id"],
        "batch_status": result["batch_status"],
        "pending_batch": result["pending_batch"],
        "source_roles": result["source_roles"],
        "newly_surfaced_holds": result["newly_surfaced_holds"],
        "delivery": delivery,
    }


def _format_cycle_report(report: dict) -> str:
    lines = [
        f"Cycle: {report['status']}"
        + (f"; batch={report['batch_id']}" if report["batch_id"] else "")
        + (f"; batch_status={report['batch_status']}" if report["batch_status"] else "")
    ]
    for hold in report["newly_surfaced_holds"]:
        target = hold.get("source") or hold.get("batch_id") or "campaign"
        lines.append(f"New hold ({target}): {hold['reason']}")
    if report["delivery"] is not None:
        delivery = report["delivery"]
        line = f"Delivery: {delivery['status']}"
        if delivery.get("batch_id"):
            line += f"; batch={delivery['batch_id']}"
        if delivery.get("reason"):
            line += f"; {delivery['reason']}"
        lines.append(line)
    return "\n".join(lines)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="overseer-relay")
    parser.add_argument("--version", action="version", version=__version__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="Inspect a repository and campaign state")
    inspect_parser.add_argument("--repo", required=True, help="Repository checkout to inspect")
    inspect_parser.add_argument("--json", action="store_true", help="Print a JSON report")

    init_parser = subparsers.add_parser("init", help="Preview or initialize a campaign")
    init_parser.add_argument("--repo", required=True, help="Main repository checkout")
    init_parser.add_argument("--campaign", required=True, help="Campaign identifier")
    init_parser.add_argument("--base-ref", required=True, help="Git base ref")
    init_parser.add_argument("--worktree-a", help="Explicit A worktree path")
    init_parser.add_argument("--worktree-b", help="Explicit B worktree path")
    init_parser.add_argument("--baseline-a", default="now", metavar="now|START:END")
    init_parser.add_argument("--baseline-b", default="now", metavar="now|START:END")
    init_parser.add_argument("--overseer-session")
    init_parser.add_argument("--overseer-directory")
    init_parser.add_argument("--overseer-agent")
    init_parser.add_argument("--a-session")
    init_parser.add_argument("--b-session")
    init_parser.add_argument("--apply", action="store_true", help="Persist the proposed campaign")

    once_parser = subparsers.add_parser("once", help="Preview or process one relay cycle")
    once_parser.add_argument("--campaign-dir", required=True, help="Exact campaign directory")
    once_mode = once_parser.add_mutually_exclusive_group()
    once_mode.add_argument("--dry-run", action="store_true", help="Read-only preview (default)")
    once_mode.add_argument("--apply", action="store_true", help="Persist one watcher cycle")
    once_parser.add_argument(
        "--deliver-notices",
        action="store_true",
        help="With --apply, deliver only to an approved, bound Overseer",
    )
    once_parser.add_argument("--json", action="store_true", help="Print a JSON result")

    watch_parser = subparsers.add_parser("watch", help="Run the foreground mailbox watcher")
    watch_parser.add_argument("--campaign-dir", required=True, help="Exact campaign directory")
    watch_parser.add_argument(
        "--deliver-notices",
        action="store_true",
        help="Enable delivery only to an approved, bound Overseer",
    )

    status_parser = subparsers.add_parser("status", help="Show read-only relay status")
    status_parser.add_argument("--campaign-dir", required=True, help="Exact campaign directory")
    status_parser.add_argument("--json", action="store_true", help="Print a JSON report")

    for name, help_text in (("hold", "Record an operator hold"), ("release", "Release an operator hold")):
        command_parser = subparsers.add_parser(name, help=help_text)
        command_parser.add_argument("--campaign-dir", required=True, help="Exact campaign directory")
        target_group = command_parser.add_mutually_exclusive_group()
        target_group.add_argument("--source", choices=("A", "B"), help="Select one source hold")
        target_group.add_argument("--batch-id", help="Select one batch hold")
        if name == "hold":
            command_parser.add_argument("--reason", required=True, help="Static, credential-free operator reason")
    resume_parser = subparsers.add_parser("resume", help="Queue the fixed native goal-resume command")
    resume_parser.add_argument("--campaign-dir", required=True, help="Exact campaign directory")
    resume_parser.add_argument("--role", choices=("A", "B"), action="append", required=True)
    resume_parser.add_argument("--ruling", required=True, help="Overseer ruling identifier")
    resume_parser.add_argument("--force", action="store_true")
    resume_parser.add_argument("--dry-run", action="store_true", help="Read-only eligibility preview")
    resume_parser.add_argument("--json", action="store_true", help="Print a JSON result")
    return parser


def _watch(journal: Journal, *, deliver_notices: bool, runner=None, sleep=None) -> int:
    sleep_fn = time.sleep if sleep is None else sleep
    last_cycle_signature = None
    last_delivery_notice = None
    try:
        while True:
            config = journal.read_config_readonly()
            result, delivery = _run_cycle(
                journal,
                config,
                deliver_notices=deliver_notices,
                runner=runner,
                sleep=sleep_fn,
            )
            report = _cycle_report(result, delivery)
            cycle_signature = (
                report["status"],
                report["batch_id"],
                report["batch_status"],
                report["pending_batch"],
                json.dumps(delivery, ensure_ascii=False, sort_keys=True) if delivery else None,
            )
            if report["status"] != "idle" or delivery is not None:
                if cycle_signature != last_cycle_signature:
                    print(_format_cycle_report(report))
            last_cycle_signature = cycle_signature

            if delivery is not None and delivery["status"] == "not-authorized":
                if delivery["reason"] != last_delivery_notice:
                    print(f"Delivery disabled: {delivery['reason']}")
                last_delivery_notice = delivery["reason"]
            else:
                last_delivery_notice = None

            sleep_fn(config.limits.scan_interval_seconds)
    except KeyboardInterrupt:
        print("Watch stopped; the last completed cycle is durable.")
        return 0


def main(argv=None, *, runner=None, sleep=None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            report = _inspect(args.repo)
            if args.json:
                print(json.dumps(report, ensure_ascii=False, indent=2))
            else:
                print(_format_inspect(report))
            return 0
        if args.command == "init":
            target, config, state, worktrees = _prepare_init(args)
            preview = _render_init_preview(target, config, state, worktrees)
            if not args.apply:
                print(preview)
                return 0
            common_dir = Path(config["common_dir"])
            _apply_init(target, config, state, common_dir)
            print(_render_init_preview(target, config, state, worktrees, applied=True))
            return 0
        if args.command in ("once", "watch", "status", "hold", "release", "resume"):
            journal, config = _open_campaign(args.campaign_dir)

            if args.command == "resume":
                results = []
                roles = [role for role in ("A", "B") if role in set(args.role)]
                for role in roles:
                    binding = config.roles[role]
                    eligible, reason = goal_resume_target(config, role)
                    row = {
                        "role": role,
                        "session_id": binding.session_id,
                        "directory": binding.directory,
                        "agent": binding.agent,
                        "goal_resume_target": {"eligible": eligible, "reason": reason},
                    }
                    if args.dry_run:
                        ledger = journal.read_resume_ledger_readonly()
                        row.update(status="dry-run", already_delivered=any(
                            entry["ruling_id"] == args.ruling and entry["role"] == role
                            and entry["outcome_code"] == "delivered" for entry in ledger
                        ))
                    else:
                        try:
                            outcome = request_goal_resume(config, journal, role, args.ruling,
                                                          runner=runner, force=args.force)
                            row.update(outcome)
                        except TransportError as error:
                            row.update(status="refused", error=str(error))
                    results.append(row)
                success = all(row.get("status") in ("delivered", "duplicate") for row in results)
                if args.json:
                    print(json.dumps({"roles": results}, ensure_ascii=False, indent=2))
                else:
                    for row in results:
                        print(f"{row['role']}: {row.get('status')}" +
                              (f"; {row.get('error')}" if row.get('error') else ""))
                return 0 if args.dry_run or success else 1

            if args.command == "once":
                if args.deliver_notices and not args.apply:
                    raise CLIError("--deliver-notices requires --apply for once")
                if not args.apply:
                    view = _campaign_view(journal, config)
                    if args.json:
                        print(json.dumps({"mode": "dry-run", **view}, ensure_ascii=False, indent=2))
                    else:
                        print(_format_campaign_view(view, dry_run=True))
                    return 0
                result, delivery = _run_cycle(
                    journal,
                    config,
                    deliver_notices=args.deliver_notices,
                    runner=runner,
                    sleep=sleep,
                )
                report = _cycle_report(result, delivery)
                if args.json:
                    print(
                        json.dumps(
                            {
                                "campaign_id": config.campaign_id,
                                "campaign_dir": str(journal.campaign_root),
                                "cycle": report,
                            },
                            ensure_ascii=False,
                            indent=2,
                        )
                    )
                else:
                    print(_format_cycle_report(report))
                return 0

            if args.command == "watch":
                return _watch(
                    journal,
                    deliver_notices=args.deliver_notices,
                    runner=runner,
                    sleep=sleep,
                )

            if args.command == "status":
                view = _campaign_view(journal, config)
                if args.json:
                    print(json.dumps(view, ensure_ascii=False, indent=2))
                else:
                    print(_format_campaign_view(view))
                return 0

            source = args.source
            batch_id = args.batch_id
            if args.command == "hold":
                journal.set_hold(args.reason, source=source, batch_id=batch_id)
                target = f"source {source}" if source else f"batch {batch_id}" if batch_id else "campaign"
                print(f"Hold recorded for {target}.")
                return 0

            released = journal.release_hold(source=source, batch_id=batch_id)
            target = f"source {source}" if source else f"batch {batch_id}" if batch_id else "campaign"
            if not released:
                print(f"No active hold found for {target}.")
                return 0
            if batch_id is None:
                print(f"Hold released for {target}.")
                return 0
            state = journal.read_state_readonly()
            batch = state["batches"][batch_id]
            print(f"Hold released for {target}; batch status is {batch['status']}.")
            return 0
        raise CLIError("command is not supported")
    except (CLIError, PathError, ConfigError, JournalError, TransportError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    except (OSError, ValueError, TypeError, UnicodeError):
        print("error: campaign command failed safely", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
