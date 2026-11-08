#!/usr/bin/env python3
"""Provider-free tests for source settling, identity, bounds, and baselines."""

from tests import support

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import unittest

from overseer_relay.cli import main
from overseer_relay.config import load_config
from overseer_relay.journal import Journal, JournalError, atomic_write_json
from overseer_relay.mailbox import FRAME_SCHEMA, format_frame
from overseer_relay.paths import campaign_dir, resolve_common_dir
from overseer_relay.watcher import Watcher


def _payload(role="A", report_id="report-1", **changes):
    result = {
        "schema": FRAME_SCHEMA,
        "campaign": "watcher-test",
        "role": role,
        "generation": 1,
        "report_id": report_id,
        "kind": "progress",
        "phase": None,
        "task": None,
        "summary": "bounded test report",
        "recommendation": None,
        "evidence_paths": [],
        "head": None,
        "blocker": None,
        "goal_state": "unknown",
        "batch_id": None,
    }
    result.update(changes)
    return result


def _init_campaign(repo, campaign_id="watcher-test"):
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
    root = campaign_dir(common_dir, campaign_id)
    return common_dir, root, Journal(common_dir, campaign_id)


def _watcher(common_dir, campaign_id):
    root = campaign_dir(common_dir, campaign_id)
    return Watcher(load_config(root / "config.json"), Journal(common_dir, campaign_id))


def _append(path: Path, raw: bytes) -> None:
    with path.open("ab") as stream:
        stream.write(raw)


def _settled_candidate(watcher, role):
    first = watcher.observe_sources()
    if role in first:
        return first[role]
    second = watcher.observe_sources()
    if role not in second:
        raise AssertionError(f"{role} did not settle")
    return second[role]


class WatcherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        support.TMP_ROOT.mkdir(parents=True, exist_ok=True)

    def test_ab_appends_require_two_observations_and_match_commit_batch_api(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            frame_a = format_frame(_payload("A", "a-one"))
            frame_b = format_frame(_payload("B", "b-one"))
            _append(root / "inbox" / "A.md", frame_a)
            _append(root / "inbox" / "B.md", frame_b)

            first_watcher = Watcher(load_config(root / "config.json"), journal)
            self.assertEqual(first_watcher.observe_sources(), {})
            state = journal.load()
            self.assertIsNotNone(state["sources"]["A"]["identity"])
            self.assertIsNotNone(state["sources"]["B"]["identity"])
            self.assertIsNotNone(state["sources"]["A"]["observation"])
            self.assertIsNotNone(state["sources"]["B"]["observation"])

            # The second observation survives process/object reconstruction.
            watcher_after_restart = _watcher(common_dir, "watcher-test")
            candidates = watcher_after_restart.observe_sources()
            self.assertEqual(set(candidates), {"A", "B"})
            expected_fields = {
                "start", "end", "prefix_before", "prefix_after", "identity", "content", "frame_ids",
            }
            for role, frame, frame_id in (
                ("A", frame_a, "a-one"),
                ("B", frame_b, "b-one"),
            ):
                candidate = candidates[role]
                self.assertEqual(set(candidate), expected_fields)
                self.assertEqual(candidate["start"], 0)
                self.assertEqual(candidate["end"], len(frame))
                self.assertEqual(candidate["content"].encode("utf-8"), frame)
                self.assertEqual(candidate["frame_ids"], [frame_id])
                self.assertEqual(candidate["identity"], state["sources"][role]["identity"])

            # Watcher returns source records only; the durable API accepts them
            # directly and performs the later task's snapshot/cursor operation.
            batch_id = journal.commit_batch(candidates)
            self.assertRegex(batch_id, r"^b-[0-9a-f]{64}$")
            self.assertEqual(journal.load()["sources"]["A"]["cursor"], len(frame_a))
            self.assertEqual(journal.load()["sources"]["B"]["cursor"], len(frame_b))

    def test_unchanged_empty_inputs_pin_identity_and_return_no_candidates(self):
        with support.TempGitRepo() as repo:
            _common_dir, _root, journal = _init_campaign(repo)
            watcher = Watcher(load_config(journal.campaign_root / "config.json"), journal)

            self.assertEqual(watcher.observe_sources(), {})
            first_state = journal.load()
            self.assertEqual(watcher.observe_sources(), {})
            second_state = journal.load()
            for role in ("A", "B"):
                self.assertIsNotNone(first_state["sources"][role]["identity"])
                self.assertEqual(
                    first_state["sources"][role]["identity"],
                    second_state["sources"][role]["identity"],
                )
                self.assertIsNone(second_state["sources"][role]["observation"])
            # No transport is constructed or invoked by the watcher path.

    def test_utf8_split_stays_unconsumed_until_frame_is_complete(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            frame = format_frame(_payload(summary="café is complete"))
            split_at = frame.index(b"\xc3\xa9") + 1
            path = root / "inbox" / "A.md"
            path.write_bytes(frame[:split_at])
            watcher = Watcher(load_config(root / "config.json"), journal)

            self.assertEqual(watcher.observe_sources(), {})
            self.assertEqual(watcher.observe_sources(), {})
            self.assertEqual(journal.load()["sources"]["A"]["cursor"], 0)
            self.assertIsNone(journal.load()["sources"]["A"]["observation"])

            _append(path, frame[split_at:])
            self.assertEqual(watcher.observe_sources(), {})
            candidate = watcher.observe_sources()["A"]
            self.assertEqual(candidate["content"].encode("utf-8"), frame)
            self.assertEqual(candidate["end"], len(frame))

    def test_complete_leading_frame_settles_before_incomplete_frame_suffix(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            first_frame = format_frame(_payload("A", "first"))
            second_frame = format_frame(_payload("A", "second"))
            partial = second_frame[: second_frame.index(b"<!-- overseer-relay:end") + 12]
            path = root / "inbox" / "A.md"
            path.write_bytes(first_frame + partial)
            watcher = Watcher(load_config(root / "config.json"), journal)

            self.assertEqual(watcher.observe_sources(), {})
            candidate = watcher.observe_sources()["A"]
            self.assertEqual(candidate["start"], 0)
            self.assertEqual(candidate["end"], len(first_frame))
            self.assertEqual(candidate["content"].encode("utf-8"), first_frame)
            self.assertEqual(candidate["frame_ids"], ["first"])

            journal.commit_batch({"A": candidate})
            self.assertEqual(watcher.observe_sources(), {})
            _append(path, second_frame[len(partial) :])
            self.assertEqual(watcher.observe_sources(), {})
            completed_second = watcher.observe_sources()["A"]
            self.assertEqual(completed_second["start"], len(first_frame))
            self.assertEqual(completed_second["content"].encode("utf-8"), second_frame)

    def test_truncation_same_inode_rewrite_and_file_replacement_hold_only_source(self):
        mutations = ("truncate", "rewrite", "replace")
        for mutation in mutations:
            with self.subTest(mutation=mutation), support.TempGitRepo() as repo:
                common_dir, root, journal = _init_campaign(repo)
                path = root / "inbox" / "A.md"
                frame = format_frame(_payload("A", f"{mutation}-frame"))
                _append(path, frame)
                watcher = Watcher(load_config(root / "config.json"), journal)
                candidate = _settled_candidate(watcher, "A")
                journal.commit_batch({"A": candidate})

                if mutation == "truncate":
                    path.write_bytes(b"")
                elif mutation == "rewrite":
                    original_identity = (path.stat().st_dev, path.stat().st_ino)
                    with path.open("r+b") as stream:
                        stream.write(b"#")
                    self.assertEqual((path.stat().st_dev, path.stat().st_ino), original_identity)
                else:
                    moved = path.with_name("A.old")
                    path.rename(moved)
                    path.write_bytes(frame)

                watcher.observe_sources()
                state = journal.load()
                self.assertIsNotNone(state["sources"]["A"]["hold"])
                self.assertIsNone(state["sources"]["B"]["hold"])

    def test_symlink_file_directory_and_fifo_are_held_without_following_or_blocking(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            watcher = Watcher(load_config(root / "config.json"), journal)
            watcher.observe_sources()  # Pin both empty regular files.

            outside = repo.root / "outside.md"
            outside.write_text("outside remains unchanged\n", encoding="utf-8")
            a_path = root / "inbox" / "A.md"
            a_path.unlink()
            a_path.symlink_to(outside)
            watcher.observe_sources()
            self.assertIsNotNone(journal.load()["sources"]["A"]["hold"])
            self.assertEqual(outside.read_text(encoding="utf-8"), "outside remains unchanged\n")

        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            watcher = Watcher(load_config(root / "config.json"), journal)
            watcher.observe_sources()
            inbox = root / "inbox"
            moved = root / "inbox-original"
            inbox.rename(moved)
            outside_dir = repo.root / "outside-inbox"
            outside_dir.mkdir()
            (outside_dir / "A.md").write_text("A\n", encoding="utf-8")
            (outside_dir / "B.md").write_text("B\n", encoding="utf-8")
            inbox.symlink_to(outside_dir, target_is_directory=True)

            watcher.observe_sources()
            state = journal.load()
            self.assertIsNotNone(state["sources"]["A"]["hold"])
            self.assertIsNotNone(state["sources"]["B"]["hold"])
            self.assertEqual((outside_dir / "A.md").read_text(encoding="utf-8"), "A\n")

        if hasattr(os, "mkfifo"):
            with support.TempGitRepo() as repo:
                common_dir, root, journal = _init_campaign(repo)
                watcher = Watcher(load_config(root / "config.json"), journal)
                watcher.observe_sources()
                fifo = root / "inbox" / "A.md"
                fifo.unlink()
                os.mkfifo(fifo)

                watcher.observe_sources()

                self.assertIsNotNone(journal.load()["sources"]["A"]["hold"])

    def test_valid_a_candidate_is_returned_while_b_is_held(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            frame = format_frame(_payload("A", "valid-a"))
            _append(root / "inbox" / "A.md", frame)
            outside = repo.root / "outside.md"
            outside.write_text("do not follow\n", encoding="utf-8")
            b_path = root / "inbox" / "B.md"
            b_path.unlink()
            b_path.symlink_to(outside)
            watcher = Watcher(load_config(root / "config.json"), journal)

            self.assertEqual(watcher.observe_sources(), {})
            candidates = watcher.observe_sources()

            self.assertEqual(set(candidates), {"A"})
            self.assertEqual(candidates["A"]["content"].encode("utf-8"), frame)
            state = journal.load()
            self.assertIsNone(state["sources"]["A"]["hold"])
            self.assertIsNotNone(state["sources"]["B"]["hold"])

    def test_wrong_identity_evidence_path_and_secret_ranges_are_held_content_free(self):
        cases = (
            (
                format_frame(_payload("B", "wrong-role")),
                "wrong-role",
            ),
            (
                format_frame(_payload("A", "wrong-campaign", campaign="other-campaign")),
                "wrong-campaign",
            ),
            (
                format_frame(_payload("A", "path-frame")).replace(
                    b'"evidence_paths": []', b'"evidence_paths": ["../outside.md"]'
                ),
                "../outside.md",
            ),
            (
                format_frame(_payload("A", "secret-frame")).replace(
                    b"bounded test report", b"token=raw-secret-value"
                ),
                "raw-secret-value",
            ),
            (b"Bearer ", "Bearer "),
            (
                format_frame(_payload("A", "unbound-evidence", evidence_paths=["report.md"])),
                "report.md",
            ),
        )
        for raw, forbidden in cases:
            with self.subTest(forbidden=forbidden), support.TempGitRepo() as repo:
                common_dir, root, journal = _init_campaign(repo)
                _append(root / "inbox" / "A.md", raw)
                watcher = Watcher(load_config(root / "config.json"), journal)

                self.assertEqual(watcher.observe_sources(), {})
                state_bytes = (root / "watcher" / "state.json").read_bytes()
                self.assertIsNotNone(journal.load()["sources"]["A"]["hold"])
                self.assertNotIn(forbidden.encode("utf-8"), state_bytes)

    def test_valid_relative_evidence_path_requires_and_uses_bound_worktree(self):
        with support.TempGitRepo() as repo:
            worker_a = repo.add_worktree("worker-a", "worker-a")
            worker_b = repo.add_worktree("worker-b", "worker-b")
            common_dir = resolve_common_dir(repo.root)
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = main(
                    [
                        "init",
                        "--repo",
                        str(repo.root),
                        "--campaign",
                        "watcher-test",
                        "--base-ref",
                        "main",
                        "--worktree-a",
                        str(worker_a),
                        "--worktree-b",
                        str(worker_b),
                        "--apply",
                    ]
                )
            self.assertEqual(result, 0, stderr.getvalue())
            root = campaign_dir(common_dir, "watcher-test")
            (worker_a / "evidence.md").write_text("A evidence\n", encoding="utf-8")
            frame = format_frame(_payload("A", "bound-evidence", evidence_paths=["evidence.md"]))
            _append(root / "inbox" / "A.md", frame)
            journal = Journal(common_dir, "watcher-test")
            watcher = Watcher(load_config(root / "config.json"), journal)

            watcher.observe_sources()
            candidate = watcher.observe_sources()["A"]

            self.assertEqual(candidate["frame_ids"], ["bound-evidence"])
            self.assertIsNone(journal.load()["sources"]["A"]["hold"])

    def test_duplicate_ids_are_review_only_and_never_repeated_in_frame_ids(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            raw = format_frame(_payload("A", "duplicate")) + format_frame(
                _payload("A", "duplicate", summary="duplicate frame")
            )
            _append(root / "inbox" / "A.md", raw)
            watcher = Watcher(load_config(root / "config.json"), journal)
            watcher.observe_sources()
            candidate = watcher.observe_sources()["A"]

            self.assertEqual(candidate["frame_ids"], ["duplicate"])
            entries = watcher.entry_metadata["A"]["entries"]
            self.assertEqual(entries[0]["classification"], "report")
            self.assertEqual(entries[1]["classification"], "review")
            self.assertEqual(entries[1]["reason"], "duplicate_frame_or_report_id")

    def test_protocol_only_candidate_is_classified_without_transport(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            frame = format_frame(
                _payload("A", "setup-ack", kind="setup-ack", goal_state="not_applicable")
            )
            _append(root / "inbox" / "A.md", frame)
            watcher = Watcher(load_config(root / "config.json"), journal)
            watcher.observe_sources()
            candidate = watcher.observe_sources()["A"]

            self.assertEqual(candidate["frame_ids"], ["setup-ack"])
            self.assertEqual(watcher.entry_metadata["A"]["classification"], "protocol")
            # Classification is returned to the caller; no transport is part
            # of Watcher and no send is attempted here.

    def test_read_and_coalesced_batch_bounds_are_enforced(self):
        with support.TempGitRepo() as repo:
            common_dir, root, _journal = _init_campaign(repo)
            config_data = json.loads((root / "config.json").read_text(encoding="utf-8"))
            config_data["limits"]["max_new_bytes_per_observation"] = 16
            config_data["limits"]["max_batch_snapshot_bytes"] = 20
            atomic_write_json(root / "config.json", config_data)
            journal = Journal(common_dir, "watcher-test")
            a_path = root / "inbox" / "A.md"
            b_path = root / "inbox" / "B.md"
            a_path.write_bytes(b"A" * 80)
            b_path.write_bytes(b"B" * 80)
            watcher = Watcher(load_config(root / "config.json"), journal)

            self.assertEqual(watcher.observe_sources(), {})
            first_candidates = watcher.observe_sources()
            self.assertEqual(set(first_candidates), {"A"})
            self.assertLessEqual(len(first_candidates["A"]["content"].encode("utf-8")), 16)
            self.assertLessEqual(
                sum(item["end"] - item["start"] for item in first_candidates.values()), 20
            )
            journal.commit_batch(first_candidates)

            later_candidates = watcher.observe_sources()
            self.assertEqual(set(later_candidates), {"B"})
            self.assertLessEqual(len(later_candidates["B"]["content"].encode("utf-8")), 16)

    def test_incomplete_frame_at_observation_bound_is_held_once_without_content(self):
        with support.TempGitRepo() as repo:
            common_dir, root, _journal = _init_campaign(repo)
            frame = format_frame(_payload(summary="raw-secret-value"))
            partial = frame[:80]
            config_data = json.loads((root / "config.json").read_text(encoding="utf-8"))
            config_data["limits"]["max_new_bytes_per_observation"] = len(partial)
            atomic_write_json(root / "config.json", config_data)
            path = root / "inbox" / "A.md"
            path.write_bytes(partial)
            journal = Journal(common_dir, "watcher-test")
            watcher = Watcher(load_config(root / "config.json"), journal)

            watcher.observe_sources()
            watcher.observe_sources()
            state = journal.load()
            self.assertEqual(state["sources"]["A"]["cursor"], 0)
            self.assertIsNotNone(state["sources"]["A"]["hold"])
            state_bytes = (root / "watcher" / "state.json").read_bytes()
            self.assertNotIn(b"raw-secret-value", state_bytes)
            hold = state["sources"]["A"]["hold"]
            surfaced = list(watcher.newly_surfaced_holds)

            watcher.observe_sources()
            state = journal.load()
            self.assertEqual(state["sources"]["A"]["hold"], hold)
            self.assertEqual(watcher.newly_surfaced_holds, surfaced)
            self.assertEqual(state["sources"]["A"]["cursor"], 0)

    def test_complete_frame_exactly_at_observation_bound_settles(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            frame = format_frame(_payload("A", "exact-bound"))
            config_data = json.loads((root / "config.json").read_text(encoding="utf-8"))
            config_data["limits"]["max_new_bytes_per_observation"] = len(frame)
            atomic_write_json(root / "config.json", config_data)
            _append(root / "inbox" / "A.md", frame)
            watcher = Watcher(load_config(root / "config.json"), journal)

            self.assertEqual(watcher.observe_sources(), {})
            candidate = watcher.observe_sources()["A"]
            self.assertEqual(candidate["content"].encode("utf-8"), frame)
            self.assertEqual(candidate["frame_ids"], ["exact-bound"])

    def test_oversized_frame_is_bounded_review_not_a_report(self):
        with support.TempGitRepo() as repo:
            common_dir, root, _journal = _init_campaign(repo)
            config_data = json.loads((root / "config.json").read_text(encoding="utf-8"))
            config_data["limits"]["max_frame_bytes"] = 100
            config_data["limits"]["max_new_bytes_per_observation"] = 4096
            config_data["limits"]["max_batch_snapshot_bytes"] = 4096
            atomic_write_json(root / "config.json", config_data)
            journal = Journal(common_dir, "watcher-test")
            frame = format_frame(_payload(summary="x" * 400))
            _append(root / "inbox" / "A.md", frame)
            watcher = Watcher(load_config(root / "config.json"), journal)

            watcher.observe_sources()
            candidate = watcher.observe_sources()["A"]

            self.assertEqual(candidate["frame_ids"], [])
            self.assertEqual(watcher.entry_metadata["A"]["classification"], "review")
            self.assertEqual(watcher.entry_metadata["A"]["entries"][0]["reason"], "frame_too_large")
            self.assertLessEqual(
                candidate["end"] - candidate["start"],
                load_config(root / "config.json").limits.max_batch_snapshot_bytes,
            )

    def test_explicit_baseline_range_is_processed_then_scanning_continues_at_end(self):
        with support.TempGitRepo() as repo:
            common_dir, root, _journal = _init_campaign(repo)
            path = root / "inbox" / "A.md"
            ignored = b"owner-selected prefix\n"
            baseline_frame = format_frame(_payload("A", "baseline-report"))
            raw = ignored + baseline_frame
            path.write_bytes(raw)
            baseline_end = len(raw)

            config_data = json.loads((root / "config.json").read_text(encoding="utf-8"))
            range_digest = hashlib.sha256(raw[:baseline_end]).hexdigest()
            config_data["baseline"]["A"] = {
                "mode": "range",
                "start": len(ignored),
                "end": baseline_end,
                "prefix_sha256": range_digest,
            }
            atomic_write_json(root / "config.json", config_data)
            state_path = root / "watcher" / "state.json"
            state_data = json.loads(state_path.read_text(encoding="utf-8"))
            state_data["sources"]["A"] = {"cursor": baseline_end, "prefix_sha256": range_digest}
            atomic_write_json(state_path, state_data)

            journal = Journal(common_dir, "watcher-test")
            watcher = Watcher(load_config(root / "config.json"), journal)
            self.assertEqual(watcher.observe_sources(), {})
            initialized = journal.load()["sources"]["A"]
            self.assertEqual(initialized["cursor"], len(ignored))
            self.assertEqual(initialized["prefix_sha256"], hashlib.sha256(ignored).hexdigest())
            baseline_candidate = watcher.observe_sources()["A"]
            self.assertEqual(baseline_candidate["start"], len(ignored))
            self.assertEqual(baseline_candidate["end"], baseline_end)
            self.assertEqual(baseline_candidate["content"].encode("utf-8"), baseline_frame)
            self.assertEqual(baseline_candidate["prefix_before"], hashlib.sha256(ignored).hexdigest())
            self.assertEqual(baseline_candidate["prefix_after"], range_digest)

            journal.commit_batch({"A": baseline_candidate})
            later_frame = format_frame(_payload("A", "after-baseline"))
            _append(path, later_frame)
            self.assertEqual(watcher.observe_sources(), {})
            later_candidate = watcher.observe_sources()["A"]
            self.assertEqual(later_candidate["start"], baseline_end)
            self.assertEqual(later_candidate["content"].encode("utf-8"), later_frame)

    def test_changed_explicit_baseline_range_is_held_without_content_persistence(self):
        with support.TempGitRepo() as repo:
            common_dir, root, _journal = _init_campaign(repo)
            path = root / "inbox" / "A.md"
            original = format_frame(_payload("A", "original"))
            path.write_bytes(original)
            config_data = json.loads((root / "config.json").read_text(encoding="utf-8"))
            config_data["baseline"]["A"] = {
                "mode": "range",
                "start": 0,
                "end": len(original),
                "prefix_sha256": hashlib.sha256(original).hexdigest(),
            }
            atomic_write_json(root / "config.json", config_data)
            state_path = root / "watcher" / "state.json"
            state_data = json.loads(state_path.read_text(encoding="utf-8"))
            state_data["sources"]["A"] = {
                "cursor": len(original),
                "prefix_sha256": hashlib.sha256(original).hexdigest(),
            }
            atomic_write_json(state_path, state_data)
            path.write_bytes(format_frame(_payload("A", "changed")))

            journal = Journal(common_dir, "watcher-test")
            watcher = Watcher(load_config(root / "config.json"), journal)

            self.assertEqual(watcher.observe_sources(), {})
            state = journal.load()
            self.assertIsNotNone(state["sources"]["A"]["hold"])
            self.assertEqual(state["sources"]["A"]["cursor"], len(original))
            self.assertNotIn("changed", (root / "watcher" / "state.json").read_text(encoding="utf-8"))

    def test_campaign_root_replacement_is_rejected_by_journal(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            watcher = Watcher(load_config(root / "config.json"), journal)
            watcher.observe_sources()
            moved = root.with_name(root.name + "-old")
            root.rename(moved)
            root.mkdir()
            try:
                with self.assertRaises(JournalError):
                    watcher.observe_sources()
            finally:
                shutil.rmtree(root)
                moved.rename(root)


if __name__ == "__main__":
    unittest.main()
