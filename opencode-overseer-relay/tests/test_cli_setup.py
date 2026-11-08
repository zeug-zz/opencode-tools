#!/usr/bin/env python3
"""Tests for safe repository inspection and campaign initialization."""

from tests import support

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

from overseer_relay.cli import (
    CLIError,
    _baseline_for_file,
    _validate_branch_pair,
    main,
)
from overseer_relay.config import load_config
from overseer_relay.paths import campaign_dir, resolve_common_dir


def _run_cli(*args):
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        result = main([str(arg) for arg in args])
    return result, stdout.getvalue(), stderr.getvalue()


def _snapshot(root: Path):
    """Capture paths, file bytes, modes and mtimes without following links."""
    snapshot = {}
    for directory, child_dirs, child_files in os.walk(root, followlinks=False):
        parent = Path(directory)
        for name in sorted(child_dirs + child_files):
            path = parent / name
            metadata = path.lstat()
            relative = path.relative_to(root).as_posix()
            if stat.S_ISLNK(metadata.st_mode):
                value = ("symlink", os.readlink(path))
            elif stat.S_ISDIR(metadata.st_mode):
                value = ("directory", stat.S_IMODE(metadata.st_mode), metadata.st_mtime_ns)
            elif stat.S_ISREG(metadata.st_mode):
                value = (
                    "file",
                    path.read_bytes(),
                    stat.S_IMODE(metadata.st_mode),
                    metadata.st_mtime_ns,
                )
            else:
                value = ("other", metadata.st_mode, metadata.st_mtime_ns)
            snapshot[relative] = value
    return snapshot


def _init_args(repo, campaign="campaign-setup"):
    return ["init", "--repo", repo, "--campaign", campaign, "--base-ref", "main"]


class CLISetupTests(unittest.TestCase):
    def _with_workers(self, repo):
        worker_a = repo.add_worktree("worker-a", "worker-a")
        worker_b = repo.add_worktree("worker-b", "worker-b")
        return worker_a, worker_b

    def test_default_init_is_a_no_write_preview(self):
        with support.TempGitRepo() as repo:
            worker_a, worker_b = self._with_workers(repo)
            common_dir = resolve_common_dir(repo.root)
            before = _snapshot(common_dir)

            result, stdout, stderr = _run_cli(
                *_init_args(repo.root), "--worktree-a", worker_a, "--worktree-b", worker_b
            )

            self.assertEqual(result, 0, stderr)
            self.assertIn("Dry run: no files written.", stdout)
            self.assertIn("config.json", stdout)
            self.assertIn('"overseer_notices": false', stdout)
            self.assertIn("watcher/lock is not created", stdout)
            self.assertEqual(_snapshot(common_dir), before)

    def test_apply_creates_exact_layout_and_loadable_config(self):
        with support.TempGitRepo() as repo:
            worker_a, worker_b = self._with_workers(repo)
            common_dir = resolve_common_dir(repo.root)
            target = campaign_dir(common_dir, "campaign-setup")
            result, stdout, stderr = _run_cli(
                *_init_args(repo.root),
                "--worktree-a",
                worker_a,
                "--worktree-b",
                worker_b,
                "--overseer-session",
                "ses_owner123",
                "--overseer-directory",
                repo.root,
                "--overseer-agent",
                "opencode",
                "--a-session",
                "ses_workerA",
                "--b-session",
                "ses_workerB",
                "--apply",
            )

            self.assertEqual(result, 0, stderr)
            self.assertIn("Applied campaign state.", stdout)
            expected_paths = {
                "config.json",
                "inbox",
                "inbox/A.md",
                "inbox/B.md",
                "rulings",
                "rulings/A.md",
                "rulings/B.md",
                "watcher",
                "watcher/state.json",
                "watcher/batches",
                "holds.json",
                "overseer-handoff.md",
            }
            actual_paths = {
                path.relative_to(target).as_posix()
                for path in target.rglob("*")
            }
            self.assertEqual(actual_paths, expected_paths)
            self.assertFalse((target / "watcher" / "lock").exists())

            config = load_config(target / "config.json")
            self.assertEqual(config.common_dir, str(common_dir))
            self.assertEqual(config.base_ref, "main")
            self.assertEqual(config.roles["overseer"].session_id, "ses_owner123")
            self.assertEqual(config.roles["overseer"].directory, str(repo.root))
            self.assertEqual(config.roles["overseer"].agent, "opencode")
            self.assertEqual(config.roles["A"].session_id, "ses_workerA")
            self.assertEqual(config.roles["B"].session_id, "ses_workerB")
            self.assertEqual(config.roles["A"].directory, str(worker_a))
            self.assertEqual(config.roles["B"].directory, str(worker_b))
            self.assertEqual(config.roles["A"].branch, "worker-a")
            self.assertEqual(config.roles["B"].branch, "worker-b")
            self.assertFalse(config.capabilities.overseer_notices)
            self.assertFalse(config.capabilities.owner_approved_notices)
            self.assertFalse(config.capabilities.worker_delivery)
            self.assertFalse(config.capabilities.worker_steers)
            self.assertFalse(config.capabilities.goal_resume)

            state = json.loads((target / "watcher" / "state.json").read_text())
            self.assertEqual(set(state), {"schema_version", "sources", "batches"})
            self.assertEqual(state["schema_version"], 1)
            self.assertEqual(set(state["sources"]), {"A", "B"})
            self.assertEqual(set(state["sources"]["A"]), {"cursor", "prefix_sha256"})
            self.assertEqual(state["sources"]["A"]["cursor"], 0)
            self.assertEqual(state["sources"]["A"]["prefix_sha256"], hashlib.sha256(b"").hexdigest())
            self.assertEqual(state["batches"], {})

    def test_common_dir_identity_is_shared_and_inspect_is_read_only(self):
        with support.TempGitRepo() as repo:
            worker_a, worker_b = self._with_workers(repo)
            common_dir = resolve_common_dir(repo.root)
            target = campaign_dir(common_dir, "campaign-setup")
            target.mkdir(parents=True)
            (target / "inbox").mkdir()
            (target / "inbox" / "A.md").write_bytes(b"abc")
            (target / "inbox" / "B.md").write_bytes(b"report B")
            before = _snapshot(common_dir)

            result, stdout, stderr = _run_cli("inspect", "--repo", worker_a, "--json")

            self.assertEqual(result, 0, stderr)
            report = json.loads(stdout)
            self.assertEqual(report["common_dir"], str(common_dir))
            self.assertEqual(
                {Path(item["path"]) for item in report["worktrees"]},
                {repo.root, worker_a, worker_b},
            )
            self.assertEqual(
                report["campaigns"][0]["backlog_bytes"],
                {"A": 3, "B": 8},
            )
            self.assertEqual(_snapshot(common_dir), before)
            self.assertEqual(resolve_common_dir(worker_a), resolve_common_dir(worker_b))

    def test_init_rejects_worktrees_from_a_different_repository(self):
        with support.TempGitRepo() as repo, support.TempGitRepo() as other:
            worker_a = other.add_worktree("worker-a", "worker-a")
            worker_b = other.add_worktree("worker-b", "worker-b")
            result, _, stderr = _run_cli(
                *_init_args(repo.root), "--worktree-a", worker_a, "--worktree-b", worker_b
            )
            self.assertEqual(result, 2)
            self.assertIn("share the main repository common directory", stderr)
            self.assertFalse(campaign_dir(resolve_common_dir(repo.root), "campaign-setup").exists())

    def test_init_rejects_main_checkout_and_duplicate_or_protected_branches(self):
        with support.TempGitRepo() as repo:
            worker_a, worker_b = self._with_workers(repo)
            result, _, stderr = _run_cli(
                *_init_args(repo.root), "--worktree-a", repo.root, "--worktree-b", worker_a
            )
            self.assertEqual(result, 2)
            self.assertIn("main checkout", stderr)

            with self.assertRaisesRegex(CLIError, "distinct branches"):
                _validate_branch_pair(
                    "refs/heads/worker-a",
                    "refs/heads/worker-a",
                    main_branch="refs/heads/main",
                    base_branch="refs/heads/main",
                )
            for candidate in ("refs/heads/main", "refs/heads/base"):
                with self.subTest(candidate=candidate):
                    with self.assertRaisesRegex(CLIError, "main or base branch"):
                        _validate_branch_pair(
                            candidate,
                            "refs/heads/worker-b",
                            main_branch="refs/heads/main",
                            base_branch="refs/heads/base",
                        )
            self.assertFalse(campaign_dir(resolve_common_dir(repo.root), "campaign-setup").exists())

    def test_baseline_now_and_explicit_range_hash_consumed_prefix(self):
        temporary = tempfile.TemporaryDirectory(dir=support.TMP_ROOT)
        self.addCleanup(temporary.cleanup)
        inbox = Path(temporary.name) / "baseline-input.md"
        inbox.write_bytes(b"old-prefix\nremaining")

        now = _baseline_for_file("now", inbox)
        selected = _baseline_for_file("0:11", inbox)
        self.assertEqual(now["mode"], "now")
        self.assertEqual(now["offset"], len(b"old-prefix\nremaining"))
        self.assertEqual(now["prefix_sha256"], hashlib.sha256(b"old-prefix\nremaining").hexdigest())
        self.assertEqual(selected["mode"], "range")
        self.assertEqual((selected["start"], selected["end"]), (0, 11))
        self.assertEqual(selected["prefix_sha256"], hashlib.sha256(b"old-prefix\n").hexdigest())

        for invalid in ("-1:2", "3:2", "0:0", "0:999"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(CLIError):
                    _baseline_for_file(invalid, inbox)

    def test_cli_range_is_checked_before_any_campaign_write(self):
        with support.TempGitRepo() as repo:
            result, _, stderr = _run_cli(*_init_args(repo.root), "--baseline-a", "0:1", "--apply")
            self.assertEqual(result, 2)
            self.assertIn("exceeds the inbox length", stderr)
            self.assertFalse(campaign_dir(resolve_common_dir(repo.root), "campaign-setup").exists())

    def test_dirty_worktree_is_preserved_exactly(self):
        with support.TempGitRepo() as repo:
            worker_a, worker_b = self._with_workers(repo)
            dirty_file = worker_a / "untracked report.md"
            dirty_file.write_text("preserve this\n")
            before = repo.git("-C", str(worker_a), "status", "--porcelain")

            result, stdout, stderr = _run_cli(
                *_init_args(repo.root),
                "--worktree-a",
                worker_a,
                "--worktree-b",
                worker_b,
                "--apply",
            )

            after = repo.git("-C", str(worker_a), "status", "--porcelain")
            self.assertEqual(result, 0, stderr)
            self.assertEqual(after, before)
            self.assertIn("Worktree A is dirty; it will be preserved unchanged.", stdout)
            self.assertTrue(dirty_file.exists())

    def test_existing_campaign_is_refused_without_adopting_bindings_or_goals(self):
        with support.TempGitRepo() as repo:
            common_dir = resolve_common_dir(repo.root)
            target = campaign_dir(common_dir, "campaign-setup")
            target.mkdir(parents=True)
            old_config = target / "config.json"
            old_config.write_text('{"roles":{"overseer":{"session_id":"ses_existing"}}}\n')
            goals = target / "goals.json"
            goals.write_text('{"goal_id":"existing-goal"}\n')
            before = _snapshot(common_dir)

            result, _, stderr = _run_cli(*_init_args(repo.root), "--apply")

            self.assertEqual(result, 2)
            self.assertIn("refusing to overwrite or adopt", stderr)
            self.assertEqual(_snapshot(common_dir), before)

    def test_fresh_setup_without_explicit_session_flags_keeps_roles_unbound(self):
        with support.TempGitRepo() as repo:
            result, _, stderr = _run_cli(*_init_args(repo.root), "--apply")
            self.assertEqual(result, 0, stderr)
            common_dir = resolve_common_dir(repo.root)
            config = load_config(campaign_dir(common_dir, "campaign-setup") / "config.json")
            for role in ("overseer", "A", "B"):
                self.assertIsNone(config.roles[role].session_id)
            self.assertFalse(hasattr(config, "goal_id"))
            self.assertFalse(config.capabilities.overseer_notices)


if __name__ == "__main__":
    unittest.main()
