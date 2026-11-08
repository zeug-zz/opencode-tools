#!/usr/bin/env python3
"""Crash recovery, atomic persistence, and lock tests for the campaign journal."""

from tests import support

import contextlib
import hashlib
import io
import json
from pathlib import Path
import shutil
import threading
import unittest

from overseer_relay.cli import main
from overseer_relay.journal import (
    MAX_STATE_BYTES,
    Journal,
    JournalError,
    atomic_write_json,
    atomic_write_text,
)
from overseer_relay.paths import campaign_dir, file_identity, resolve_common_dir


def _init_campaign(repo, campaign_id="journal-test"):
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        result = main(
            [
                "init",
                "--repo",
                str(repo.root),
                "--campaign",
                campaign_id,
                "--base-ref",
                "main",
                "--apply",
            ]
        )
    if result != 0:
        raise AssertionError(stderr.getvalue())
    common_dir = resolve_common_dir(repo.root)
    return common_dir, campaign_dir(common_dir, campaign_id)


def _append_source(campaign_root, role="A", content=b"one report\n"):
    path = campaign_root / "inbox" / f"{role}.md"
    path.write_bytes(content)
    return {
        "start": 0,
        "end": len(content),
        "prefix_before": hashlib.sha256(b"").hexdigest(),
        "prefix_after": hashlib.sha256(content).hexdigest(),
        "identity": file_identity(path),
        "content": content.decode("utf-8"),
        "frame_ids": [f"{role.lower()}-frame-1"],
    }


def _set_legacy_cursor(campaign_root, role, prefix):
    """Arrange a migrated setup state whose source cursor consumes prefix."""
    (campaign_root / "inbox" / f"{role}.md").write_bytes(prefix)
    state_path = campaign_root / "watcher" / "state.json"
    state = json.loads(state_path.read_text())
    state["sources"][role] = {
        "cursor": len(prefix),
        "prefix_sha256": hashlib.sha256(prefix).hexdigest(),
    }
    state_path.write_text(json.dumps(state) + "\n")


class JournalTests(unittest.TestCase):
    def test_minimal_cli_state_migrates_with_identity_observation_and_hold_defaults(self):
        with support.TempGitRepo() as repo:
            common_dir, root = _init_campaign(repo)
            initial = json.loads((root / "watcher" / "state.json").read_text())
            self.assertEqual(set(initial), {"schema_version", "sources", "batches"})

            journal = Journal(common_dir, "journal-test")
            state = journal.load()

            self.assertEqual(state["campaign_id"], "journal-test")
            self.assertEqual(state["common_dir"], str(common_dir))
            self.assertEqual(state["campaign_identity"], {
                "device": root.stat().st_dev,
                "inode": root.stat().st_ino,
            })
            self.assertIsNone(state["hold"])
            for role in ("A", "B"):
                self.assertEqual(set(state["sources"][role]), {
                    "cursor", "prefix_sha256", "identity", "observation", "hold",
                })
                self.assertIsNone(state["sources"][role]["identity"])
                self.assertIsNone(state["sources"][role]["observation"])
                self.assertIsNone(state["sources"][role]["hold"])
            persisted = json.loads((root / "watcher" / "state.json").read_text())
            self.assertEqual(persisted, state)

    def test_atomic_helpers_replace_json_and_refuse_symlink_targets(self):
        with support.TempGitRepo() as repo:
            common_dir, root = _init_campaign(repo)
            target = root / "watcher" / "atomic.json"
            atomic_write_json(target, {"generation": 1})
            original = target.read_bytes()
            atomic_write_text(target, '{"generation": 2}\n')
            self.assertEqual(json.loads(target.read_text()), {"generation": 2})
            atomic_write_json(target, {"generation": 2})
            self.assertEqual(json.loads(target.read_text()), {"generation": 2})
            self.assertNotEqual(target.read_bytes(), original)

            external = repo.root / "outside-target.json"
            external.write_text("unchanged\n")
            link = root / "watcher" / "linked.json"
            link.symlink_to(external)
            with self.assertRaises(JournalError):
                atomic_write_text(link, "must not follow\n")
            self.assertEqual(external.read_text(), "unchanged\n")

    def test_failed_atomic_replace_preserves_previous_complete_json(self):
        from unittest.mock import patch

        with support.TempGitRepo() as repo:
            _common_dir, root = _init_campaign(repo)
            target = root / "watcher" / "atomic.json"
            atomic_write_json(target, {"old": True})
            previous = target.read_bytes()
            with patch("overseer_relay.journal.os.replace", side_effect=OSError("injected")):
                with self.assertRaises(JournalError):
                    atomic_write_json(target, {"new": True})
            self.assertEqual(target.read_bytes(), previous)
            self.assertFalse(list(target.parent.glob(".atomic.json.*.tmp")))

    def test_crash_points_preserve_or_replay_batch_exactly_once(self):
        crash_points = (
            "before_snapshot",
            "after_snapshot",
            "before_cursor_commit",
            "after_cursor_commit",
        )
        for point in crash_points:
            with self.subTest(point=point), support.TempGitRepo() as repo:
                common_dir, root = _init_campaign(repo, f"journal-{point.replace('_', '-')}")
                source = _append_source(root)

                def crash_hook(observed):
                    if observed == point:
                        raise RuntimeError("simulated interruption")

                journal = Journal(
                    common_dir,
                    f"journal-{point.replace('_', '-')}",
                    crash_hook=crash_hook,
                )
                with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
                    journal.commit_batch({"A": source})

                recovered_journal = Journal(common_dir, f"journal-{point.replace('_', '-')}")
                before_recovery = recovered_journal.load()
                snapshot_dirs = [
                    path for path in (root / "watcher" / "batches").iterdir()
                    if path.is_dir()
                ]
                if point == "before_snapshot":
                    self.assertEqual(before_recovery["sources"]["A"]["cursor"], 0)
                    self.assertEqual(snapshot_dirs, [])
                    self.assertEqual(recovered_journal.recover_batches(), [])
                    continue

                self.assertEqual(len(snapshot_dirs), 1)
                snapshot = json.loads((snapshot_dirs[0] / "snapshot.json").read_text())
                batch_id = snapshot["batch_id"]
                if point in ("after_snapshot", "before_cursor_commit"):
                    self.assertEqual(before_recovery["sources"]["A"]["cursor"], 0)
                    self.assertEqual(recovered_journal.recover_batches(), [batch_id])
                    replayed = recovered_journal.load()
                    self.assertEqual(replayed["sources"]["A"]["cursor"], len(b"one report\n"))
                    self.assertEqual(replayed["pending_batch"], batch_id)
                    self.assertEqual(replayed["batches"][batch_id]["status"], "snapshotted")
                    self.assertEqual(recovered_journal.recover_batches(), [])
                    self.assertEqual(recovered_journal.load()["sources"]["A"]["cursor"], len(b"one report\n"))
                else:
                    self.assertEqual(before_recovery["sources"]["A"]["cursor"], len(b"one report\n"))
                    self.assertEqual(before_recovery["pending_batch"], batch_id)
                    self.assertEqual(recovered_journal.recover_batches(), [])

    def test_recovery_refuses_snapshot_if_mailbox_range_changed(self):
        with support.TempGitRepo() as repo:
            common_dir, root = _init_campaign(repo)
            source = _append_source(root)

            def crash_hook(point):
                if point == "after_snapshot":
                    raise RuntimeError("simulated interruption")

            journal = Journal(common_dir, "journal-test", crash_hook=crash_hook)
            with self.assertRaises(RuntimeError):
                journal.commit_batch({"A": source})
            (root / "inbox" / "A.md").write_bytes(b"tampered!!\n")
            recovered = Journal(common_dir, "journal-test")
            with self.assertRaisesRegex(JournalError, "source range"):
                recovered.recover_batches()
            self.assertEqual(recovered.load()["sources"]["A"]["cursor"], 0)

    def test_commit_reads_exact_range_when_later_mailbox_bytes_already_exist(self):
        with support.TempGitRepo() as repo:
            common_dir, root = _init_campaign(repo)
            prefix = b"already consumed\n"
            settled = b"settled report\n"
            later = b"unfinished next frame"
            _set_legacy_cursor(root, "A", prefix)
            path = root / "inbox" / "A.md"
            path.write_bytes(prefix + settled + later)
            source = {
                "start": len(prefix),
                "end": len(prefix) + len(settled),
                "prefix_before": hashlib.sha256(prefix).hexdigest(),
                "prefix_after": hashlib.sha256(prefix + settled).hexdigest(),
                "identity": file_identity(path),
                "content": settled.decode("utf-8"),
            }
            journal = Journal(common_dir, "journal-test")

            batch_id = journal.commit_batch({"A": source})

            state = journal.load()
            self.assertEqual(state["sources"]["A"]["cursor"], source["end"])
            self.assertEqual(path.read_bytes(), prefix + settled + later)
            snapshot = json.loads(
                (root / "watcher" / "batches" / batch_id / "snapshot.json").read_text()
            )
            self.assertEqual(snapshot["sources"]["A"]["content"], settled.decode("utf-8"))

    def test_append_after_snapshot_does_not_block_cursor_recovery(self):
        with support.TempGitRepo() as repo:
            common_dir, root = _init_campaign(repo)
            settled = b"settled report\n"
            source = _append_source(root, content=settled)

            def append_at_snapshot(point):
                if point == "after_snapshot":
                    with (root / "inbox" / "A.md").open("ab") as mailbox:
                        mailbox.write(b"unfinished later frame")
                    raise RuntimeError("simulated interruption")

            journal = Journal(common_dir, "journal-test", crash_hook=append_at_snapshot)
            with self.assertRaises(RuntimeError):
                journal.commit_batch({"A": source})

            recovered = Journal(common_dir, "journal-test")
            self.assertEqual(len(recovered.recover_batches()), 1)
            state = recovered.load()
            self.assertEqual(state["sources"]["A"]["cursor"], len(settled))
            self.assertEqual(
                (root / "inbox" / "A.md").read_bytes(),
                settled + b"unfinished later frame",
            )

    def test_commit_rejects_same_inode_consumed_prefix_rewrite(self):
        with support.TempGitRepo() as repo:
            common_dir, root = _init_campaign(repo)
            prefix = b"old-prefix\n"
            settled = b"settled report\n"
            _set_legacy_cursor(root, "A", prefix)
            path = root / "inbox" / "A.md"
            path.write_bytes(prefix + settled)
            original_identity = file_identity(path)
            source = {
                "start": len(prefix),
                "end": len(prefix) + len(settled),
                "prefix_before": hashlib.sha256(prefix).hexdigest(),
                "prefix_after": hashlib.sha256(prefix + settled).hexdigest(),
                "identity": original_identity,
                "content": settled.decode("utf-8"),
            }
            with path.open("r+b") as mailbox:
                mailbox.write(b"new-prefix\n")
            self.assertEqual(file_identity(path), original_identity)

            journal = Journal(common_dir, "journal-test")
            with self.assertRaisesRegex(JournalError, "consumed source prefix"):
                journal.commit_batch({"A": source})

    def test_commit_rejects_wrong_prefix_after_changed_range_and_truncation(self):
        for mutation in ("prefix_after", "range", "truncate"):
            with self.subTest(mutation=mutation), support.TempGitRepo() as repo:
                common_dir, root = _init_campaign(repo)
                content = b"one report\n"
                source = _append_source(root, content=content)
                path = root / "inbox" / "A.md"
                if mutation == "prefix_after":
                    source["prefix_after"] = hashlib.sha256(b"different\n").hexdigest()
                elif mutation == "range":
                    path.write_bytes(b"bad report\n")
                else:
                    path.write_bytes(b"short")
                journal = Journal(common_dir, "journal-test")
                with self.assertRaises(JournalError):
                    journal.commit_batch({"A": source})

    def test_corrupt_duplicate_nonfinite_and_oversized_state_fails_closed(self):
        corruptions = (
            b'{"schema_version":1,"schema_version":1}',
            b'{"schema_version":NaN}',
            b" " * (MAX_STATE_BYTES + 1),
        )
        for raw in corruptions:
            with self.subTest(length=len(raw)), support.TempGitRepo() as repo:
                common_dir, root = _init_campaign(repo)
                state_path = root / "watcher" / "state.json"
                state_path.write_bytes(raw)
                journal = Journal(common_dir, "journal-test")
                with self.assertRaises(JournalError) as raised:
                    journal.load()
                self.assertNotIn("NaN", str(raised.exception))
                self.assertNotIn("schema_version", str(raised.exception))

    def test_stale_looking_lock_is_never_stolen_and_nested_lock_is_refused(self):
        with support.TempGitRepo() as repo:
            common_dir, root = _init_campaign(repo)
            lock_path = root / "watcher" / "lock"
            stale_bytes = json.dumps({
                "schema_version": 1,
                "pid": 99999999,
                "created_ns": 1,
                "token": "old-owner-token",
            }).encode() + b"\n"
            lock_path.write_bytes(stale_bytes)
            journal = Journal(common_dir, "journal-test")
            with self.assertRaisesRegex(JournalError, "never stolen"):
                with journal.lock():
                    self.fail("stale lock was acquired")
            self.assertEqual(lock_path.read_bytes(), stale_bytes)
            lock_path.unlink()

            with journal.lock():
                with self.assertRaisesRegex(JournalError, "nested"):
                    with journal.lock():
                        pass
            self.assertFalse(lock_path.exists())

    def test_held_journal_lock_cannot_be_used_from_another_thread(self):
        with support.TempGitRepo() as repo:
            common_dir, _root = _init_campaign(repo)
            journal = Journal(common_dir, "journal-test")
            errors = []

            def read_from_other_thread():
                try:
                    journal.load()
                except JournalError as error:
                    errors.append(str(error))

            with journal.lock():
                worker = threading.Thread(target=read_from_other_thread)
                worker.start()
                worker.join(timeout=2)
                self.assertFalse(worker.is_alive())
            self.assertEqual(errors, ["campaign lock is owned by another thread"])

    def test_replaced_campaign_root_is_rejected(self):
        with support.TempGitRepo() as repo:
            common_dir, root = _init_campaign(repo)
            journal = Journal(common_dir, "journal-test")
            journal.load()
            moved = root.with_name(root.name + "-old")
            root.rename(moved)
            root.mkdir()
            try:
                with self.assertRaisesRegex(JournalError, "identity"):
                    journal.load()
            finally:
                shutil.rmtree(root)
                moved.rename(root)

    def test_symlinked_journal_file_is_not_followed(self):
        with support.TempGitRepo() as repo:
            common_dir, root = _init_campaign(repo)
            state_path = root / "watcher" / "state.json"
            state_path.unlink()
            sentinel = repo.root / "sentinel.json"
            sentinel.write_text('{"sentinel":true}\n')
            state_path.symlink_to(sentinel)
            with self.assertRaises(JournalError):
                Journal(common_dir, "journal-test")
            self.assertEqual(sentinel.read_text(), '{"sentinel":true}\n')

    def test_delivery_uncertainty_hold_and_release_never_authorize_resend(self):
        with support.TempGitRepo() as repo:
            common_dir, root = _init_campaign(repo)
            journal = Journal(common_dir, "journal-test")
            batch_id = journal.commit_batch({"A": _append_source(root)})
            self.assertRegex(batch_id, r"^b-[0-9a-f]{64}$")
            journal.set_delivery_state(batch_id, "send-intent")
            journal.set_delivery_state(batch_id, "uncertain")
            uncertain = journal.load()["batches"][batch_id]
            self.assertEqual(uncertain["status"], "uncertain")
            self.assertIsNotNone(uncertain["hold"])
            self.assertTrue(journal.release_hold(batch_id=batch_id))
            self.assertFalse(journal.release_hold(batch_id=batch_id))
            with self.assertRaisesRegex(JournalError, "transition"):
                journal.set_delivery_state(batch_id, "send-intent")
            self.assertEqual(journal.load()["batches"][batch_id]["status"], "uncertain")
            journal.set_delivery_state(batch_id, "admitted", receipt={"accepted": True})
            journal.set_delivery_state(batch_id, "acknowledged")
            self.assertIsNone(journal.load()["pending_batch"])

    def test_hold_notice_is_once_per_unchanged_condition_and_release_is_visible(self):
        with support.TempGitRepo() as repo:
            common_dir, _root = _init_campaign(repo)
            journal = Journal(common_dir, "journal-test")
            first = journal.set_hold("source changed", source="A")
            self.assertTrue(first["should_notify"])
            journal.mark_hold_notice(source="A")
            second = journal.set_hold("source changed", source="A")
            self.assertFalse(second["should_notify"])
            self.assertTrue(journal.release_hold(source="A"))
            self.assertTrue(journal.load()["sources"]["A"]["hold"]["released"])
            repeated = journal.set_hold("source changed", source="A")
            self.assertFalse(repeated["should_notify"])
            self.assertFalse(repeated["hold"]["released"])


if __name__ == "__main__":
    unittest.main()
