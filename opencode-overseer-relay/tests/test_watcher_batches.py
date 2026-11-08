#!/usr/bin/env python3
"""Provider-free batch admission, acknowledgement, and restart tests."""

from tests import support

import contextlib
import io
import json
import os
import unittest

from overseer_relay.cli import main
from overseer_relay.config import load_config
from overseer_relay.journal import Journal, atomic_write_json, atomic_write_text
from overseer_relay.mailbox import FRAME_SCHEMA, format_frame
from overseer_relay.paths import campaign_dir, resolve_common_dir
from overseer_relay.watcher import Watcher


CAMPAIGN = "watcher-batches-test"


def _payload(role="A", report_id="report-1", **changes):
    result = {
        "schema": FRAME_SCHEMA,
        "campaign": CAMPAIGN,
        "role": role,
        "generation": 1,
        "report_id": report_id,
        "kind": "progress",
        "phase": None,
        "task": None,
        "summary": "bounded batch report",
        "recommendation": None,
        "evidence_paths": [],
        "head": None,
        "blocker": None,
        "goal_state": "unknown",
        "batch_id": None,
    }
    result.update(changes)
    return result


def _ack(batch_id, *, campaign=CAMPAIGN, generation=1, acknowledged_id=None, named_batch_id=None):
    return format_frame(
        _payload(
            "overseer",
            acknowledged_id or f"ack-{batch_id[2:14]}",
            campaign=campaign,
            generation=generation,
            kind="batch-ack",
            goal_state="not_applicable",
            batch_id=named_batch_id or batch_id,
            summary="",
        )
    )


def _init_campaign(repo, campaign_id=CAMPAIGN):
    stderr = io.StringIO()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
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


def _watcher(common_dir, campaign_id=CAMPAIGN):
    root = campaign_dir(common_dir, campaign_id)
    return Watcher(load_config(root / "config.json"), Journal(common_dir, campaign_id))


def _append(root, role, raw):
    with (root / "inbox" / f"{role}.md").open("ab") as stream:
        stream.write(raw)


def _first_pending(root, journal, *, role="A", frame=None):
    frame = frame or format_frame(_payload(role, f"{role.lower()}-first"))
    _append(root, role, frame)
    watcher = Watcher(load_config(root / "config.json"), journal)
    first = watcher.process_once()
    if first["status"] not in ("idle", "held"):
        raise AssertionError(f"first observation unexpectedly processed a batch: {first}")
    result = watcher.process_once()
    if result["batch_status"] != "snapshotted":
        raise AssertionError(f"source did not settle into one pending batch: {result}")
    return watcher, frame, result["batch_id"]


def _admit(journal, batch_id):
    journal.set_delivery_state(batch_id, "send-intent")
    journal.set_delivery_state(batch_id, "admitted", receipt={"accepted": True})


def _write_ack(root, batch_id, raw=None):
    ack_path = root / "watcher" / "batches" / batch_id / "overseer-ack.md"
    atomic_write_text(ack_path, (raw or _ack(batch_id)).decode("utf-8"))


class WatcherBatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        support.TMP_ROOT.mkdir(parents=True, exist_ok=True)

    def test_settled_a_and_b_coalesce_to_one_deterministic_snapshot(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            frame_a = format_frame(_payload("A", "a-one"))
            frame_b = format_frame(_payload("B", "b-one"))
            _append(root, "A", frame_a)
            _append(root, "B", frame_b)
            watcher = Watcher(load_config(root / "config.json"), journal)

            self.assertEqual(watcher.process_once()["batch_id"], None)
            settled = watcher.observe_sources()
            expected_id = journal.make_batch_id(settled)
            result = watcher.process_once()

            self.assertEqual(result["batch_id"], expected_id)
            self.assertEqual(result["batch_status"], "snapshotted")
            self.assertEqual(result["source_roles"], ["A", "B"])
            self.assertEqual(journal.load()["pending_batch"], expected_id)
            snapshot = journal.read_batch_snapshot(expected_id)
            self.assertEqual(set(snapshot["sources"]), {"A", "B"})
            self.assertEqual(snapshot["sources"]["A"]["content"].encode(), frame_a)
            self.assertEqual(snapshot["sources"]["B"]["content"].encode(), frame_b)
            metadata = snapshot["metadata"]["watcher"]
            self.assertEqual(metadata["classification"], "substantive")
            self.assertEqual(
                [entry["report_id"] for entry in metadata["entries"]],
                ["a-one", "b-one"],
            )
            self.assertEqual(
                len([path for path in (root / "watcher" / "batches").iterdir() if path.is_dir()]),
                1,
            )

    def test_crash_before_snapshot_and_after_snapshot_recover_without_loss_or_duplicate(self):
        crash_points = ("before_snapshot", "after_snapshot", "before_cursor_commit", "after_cursor_commit")
        for point in crash_points:
            with self.subTest(point=point), support.TempGitRepo() as repo:
                common_dir, root, journal = _init_campaign(repo)
                frame = format_frame(_payload("A", f"report-{point}"))
                _append(root, "A", frame)
                config = load_config(root / "config.json")

                def crash_hook(observed):
                    if observed == point:
                        raise RuntimeError("simulated interruption")

                crashing_journal = Journal(common_dir, CAMPAIGN, crash_hook=crash_hook)
                crashing_watcher = Watcher(config, crashing_journal)
                crashing_watcher.process_once()  # Persist the first settling observation.
                with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
                    crashing_watcher.process_once()

                restarted_journal = Journal(common_dir, CAMPAIGN)
                restarted = Watcher(config, restarted_journal).process_once()
                state = restarted_journal.load()
                batch_dirs = [
                    path for path in (root / "watcher" / "batches").iterdir() if path.is_dir()
                ]
                self.assertEqual(len(batch_dirs), 1)
                snapshot = restarted_journal.read_batch_snapshot(batch_dirs[0].name)
                self.assertEqual(snapshot["sources"]["A"]["content"].encode(), frame)
                self.assertEqual(state["sources"]["A"]["cursor"], len(frame))
                self.assertEqual(state["pending_batch"], batch_dirs[0].name)
                self.assertEqual(restarted["batch_id"], batch_dirs[0].name)
                self.assertEqual(restarted["batch_status"], "snapshotted")
                self.assertEqual(len(state["batches"]), 1)

    def test_pending_batch_keeps_complete_and_partial_appends_queued_until_ack(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            watcher, first_frame, batch_id = _first_pending(root, journal)
            _admit(journal, batch_id)

            later_a = format_frame(_payload("A", "a-later"))
            split = len(later_a) // 2
            later_b = format_frame(_payload("B", "b-later"))
            _append(root, "A", later_a[:split])
            _append(root, "B", later_b)
            before = journal.load()

            queued = watcher.process_once()
            self.assertEqual(queued["status"], "pending")
            self.assertEqual(queued["batch_id"], batch_id)
            self.assertEqual(journal.load()["sources"]["A"]["cursor"], len(first_frame))
            self.assertEqual(journal.load()["sources"]["B"]["cursor"], 0)
            self.assertEqual(before["pending_batch"], batch_id)

            _append(root, "A", later_a[split:])
            _write_ack(root, batch_id)
            ack_cycle = watcher.process_once()
            self.assertEqual(ack_cycle["acknowledged_batch_id"], batch_id)
            self.assertIsNone(journal.load()["pending_batch"])
            self.assertEqual(journal.load()["sources"]["A"]["cursor"], len(first_frame))
            self.assertEqual(journal.load()["sources"]["B"]["cursor"], 0)

            # The append is settled after admission/ack and the exact later
            # complete ranges are snapshotted together; neither cursor skipped.
            second_batch = watcher.process_once()
            self.assertEqual(second_batch["batch_status"], "snapshotted")
            self.assertNotEqual(second_batch["batch_id"], batch_id)
            snapshot = journal.read_batch_snapshot(second_batch["batch_id"])
            self.assertEqual(set(snapshot["sources"]), {"A", "B"})
            self.assertEqual(snapshot["sources"]["A"]["content"].encode(), later_a)
            self.assertEqual(snapshot["sources"]["B"]["content"].encode(), later_b)

    def test_only_admitted_batch_with_exact_ack_is_released(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            watcher, _frame, batch_id = _first_pending(root, journal)
            _write_ack(root, batch_id)
            watcher.process_once()
            self.assertEqual(journal.load()["pending_batch"], batch_id)
            self.assertEqual(journal.load()["batches"][batch_id]["status"], "snapshotted")

            _admit(journal, batch_id)
            result = watcher.process_once()
            self.assertEqual(result["acknowledged_batch_id"], batch_id)
            self.assertIsNone(journal.load()["pending_batch"])
            self.assertEqual(journal.load()["batches"][batch_id]["status"], "acknowledged")

    def test_malformed_and_wrong_identity_ack_files_hold_without_releasing(self):
        invalid_acks = {
            "malformed": b"not an acknowledgement frame\n",
            "campaign": lambda batch_id: _ack(batch_id, campaign="wrong-campaign"),
            "generation": lambda batch_id: _ack(batch_id, generation=2),
            "batch_id": lambda batch_id: _ack(batch_id, named_batch_id="b-" + "0" * 64),
        }
        for label, make_ack in invalid_acks.items():
            with self.subTest(ack=label), support.TempGitRepo() as repo:
                common_dir, root, journal = _init_campaign(repo)
                watcher, _frame, batch_id = _first_pending(root, journal)
                _admit(journal, batch_id)
                raw = make_ack(batch_id) if callable(make_ack) else make_ack
                _write_ack(root, batch_id, raw)

                result = watcher.process_once()
                state = journal.load()
                self.assertEqual(result["status"], "held")
                self.assertEqual(result["batch_id"], batch_id)
                self.assertEqual(state["pending_batch"], batch_id)
                self.assertEqual(state["batches"][batch_id]["status"], "admitted")
                self.assertIsNotNone(state["batches"][batch_id]["hold"])
                self.assertEqual(len(result["newly_surfaced_holds"]), 1)

                repeated = watcher.process_once()
                self.assertEqual(repeated["newly_surfaced_holds"], [])
                self.assertEqual(journal.load()["pending_batch"], batch_id)

                _write_ack(root, batch_id)
                corrected = watcher.process_once()
                corrected_state = journal.load()
                self.assertEqual(corrected["acknowledged_batch_id"], batch_id)
                self.assertIsNone(corrected_state["pending_batch"])
                self.assertTrue(corrected_state["batches"][batch_id]["hold"]["released"])

    def test_symlinked_acknowledgement_is_not_followed_and_keeps_batch_pending(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            watcher, _frame, batch_id = _first_pending(root, journal)
            _admit(journal, batch_id)
            external = repo.root / "external-ack.md"
            external.write_bytes(_ack(batch_id))
            ack_path = root / "watcher" / "batches" / batch_id / "overseer-ack.md"
            ack_path.symlink_to(external)

            result = watcher.process_once()

            self.assertEqual(result["status"], "held")
            self.assertEqual(journal.load()["pending_batch"], batch_id)
            self.assertEqual(external.read_bytes(), _ack(batch_id))

    def test_protocol_only_source_batch_is_durably_advanced_without_pending_notice(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            frame = format_frame(
                _payload("A", "setup-ack-one", kind="setup-ack", goal_state="not_applicable")
            )
            _append(root, "A", frame)
            watcher = Watcher(load_config(root / "config.json"), journal)
            watcher.process_once()
            result = watcher.process_once()

            state = journal.load()
            self.assertEqual(result["status"], "acknowledged")
            self.assertEqual(result["batch_status"], "acknowledged")
            self.assertIsNone(state["pending_batch"])
            self.assertEqual(state["sources"]["A"]["cursor"], len(frame))
            snapshot = journal.read_batch_snapshot(result["batch_id"])
            self.assertEqual(snapshot["metadata"]["watcher"]["classification"], "protocol-only")
            self.assertEqual(state["batches"][result["batch_id"]]["status"], "acknowledged")

    def test_protocol_only_orphan_recovery_does_not_resurrect_a_pending_notice(self):
        with support.TempGitRepo() as repo:
            common_dir, root, _journal = _init_campaign(repo)
            frame = format_frame(
                _payload("A", "setup-ack-crash", kind="setup-ack", goal_state="not_applicable")
            )
            _append(root, "A", frame)
            config = load_config(root / "config.json")

            def crash_hook(point):
                if point == "after_snapshot":
                    raise RuntimeError("simulated interruption")

            crashing = Watcher(config, Journal(common_dir, CAMPAIGN, crash_hook=crash_hook))
            crashing.process_once()
            with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
                crashing.process_once()

            recovered_journal = Journal(common_dir, CAMPAIGN)
            result = Watcher(config, recovered_journal).process_once()
            state = recovered_journal.load()
            self.assertEqual(len(state["batches"]), 1)
            batch_id = next(iter(state["batches"]))
            self.assertEqual(state["batches"][batch_id]["status"], "acknowledged")
            self.assertIsNone(state["pending_batch"])
            self.assertEqual(state["sources"]["A"]["cursor"], len(frame))
            self.assertEqual(result["recovered_batch_ids"], [batch_id])

    def test_send_intent_uncertain_and_admitted_states_survive_restart_without_resend(self):
        states = ("send-intent", "uncertain", "admitted")
        for delivery_state in states:
            with self.subTest(delivery_state=delivery_state), support.TempGitRepo() as repo:
                common_dir, root, journal = _init_campaign(repo)
                _watch, _frame, batch_id = _first_pending(root, journal)
                journal.set_delivery_state(batch_id, "send-intent")
                if delivery_state == "uncertain":
                    journal.set_delivery_state(batch_id, "uncertain")
                elif delivery_state == "admitted":
                    journal.set_delivery_state(batch_id, "admitted", receipt={"accepted": True})

                restarted = _watcher(common_dir).process_once()
                state = Journal(common_dir, CAMPAIGN).load()
                self.assertEqual(restarted["batch_id"], batch_id)
                self.assertEqual(state["pending_batch"], batch_id)
                self.assertEqual(state["batches"][batch_id]["status"], delivery_state)
                self.assertEqual(len(state["batches"]), 1)
                self.assertEqual(
                    len([path for path in (root / "watcher" / "batches").iterdir() if path.is_dir()]),
                    1,
                )

    def test_source_hold_is_reported_once_while_valid_a_is_still_snapshotted(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            frame = format_frame(_payload("A", "valid-a"))
            _append(root, "A", frame)
            outside = repo.root / "outside.md"
            outside.write_text("outside input\n", encoding="utf-8")
            b_path = root / "inbox" / "B.md"
            b_path.unlink()
            b_path.symlink_to(outside)
            watcher = Watcher(load_config(root / "config.json"), journal)

            first = watcher.process_once()
            self.assertEqual(first["status"], "held")
            self.assertEqual(first["newly_surfaced_holds"][0]["source"], "B")
            second = watcher.process_once()
            self.assertEqual(second["batch_status"], "snapshotted")
            self.assertEqual(second["source_roles"], ["A"])
            self.assertEqual(second["newly_surfaced_holds"], [])
            self.assertIsNotNone(journal.load()["sources"]["B"]["hold"])
            self.assertEqual(outside.read_text(encoding="utf-8"), "outside input\n")

    def test_held_secret_ranges_are_never_copied_into_batch_snapshots(self):
        with support.TempGitRepo() as repo:
            common_dir, root, journal = _init_campaign(repo)
            safe = format_frame(_payload("A", "safe-before-hold"))
            secret = format_frame(_payload("A", "secret-frame")).replace(
                b"bounded batch report", b"token=must-not-be-persisted"
            )
            _append(root, "A", safe + secret)
            watcher = Watcher(load_config(root / "config.json"), journal)
            watcher.process_once()
            result = watcher.process_once()

            self.assertEqual(result["batch_status"], "snapshotted")
            snapshot = journal.read_batch_snapshot(result["batch_id"])
            self.assertEqual(snapshot["sources"]["A"]["content"].encode(), safe)
            self.assertNotIn(b"must-not-be-persisted", (root / "watcher" / "state.json").read_bytes())
            self.assertNotIn(
                b"must-not-be-persisted",
                (root / "watcher" / "batches" / result["batch_id"] / "snapshot.json").read_bytes(),
            )

            _admit(journal, result["batch_id"])
            _write_ack(root, result["batch_id"])
            held = watcher.process_once()
            self.assertEqual(held["status"], "held")
            self.assertEqual(len(journal.load()["batches"]), 1)

    def test_batch_cap_defers_later_settled_candidate_without_holding_it(self):
        with support.TempGitRepo() as repo:
            common_dir, root, _journal = _init_campaign(repo)
            frame_a = format_frame(_payload("A", "large-a", summary="a" * 700))
            frame_b = format_frame(_payload("B", "large-b", summary="b" * 700))
            cap = max(len(frame_a), len(frame_b)) + 1
            config_data = json.loads((root / "config.json").read_text(encoding="utf-8"))
            config_data["limits"]["max_batch_snapshot_bytes"] = cap
            config_data["limits"]["max_new_bytes_per_observation"] = max(cap, len(frame_a), len(frame_b))
            atomic_write_json(root / "config.json", config_data)
            journal = Journal(common_dir, CAMPAIGN)
            _append(root, "A", frame_a)
            _append(root, "B", frame_b)
            watcher = Watcher(load_config(root / "config.json"), journal)

            watcher.process_once()
            first_batch = watcher.process_once()
            self.assertEqual(first_batch["source_roles"], ["A"])
            self.assertEqual(journal.load()["sources"]["B"]["cursor"], 0)
            self.assertIsNone(journal.load()["sources"]["B"]["hold"])
            self.assertEqual(set(journal.read_batch_snapshot(first_batch["batch_id"])["sources"]), {"A"})

            _admit(journal, first_batch["batch_id"])
            _write_ack(root, first_batch["batch_id"])
            second_batch = watcher.process_once()
            self.assertEqual(second_batch["source_roles"], ["B"])
            self.assertNotEqual(second_batch["batch_id"], first_batch["batch_id"])
            snapshot = journal.read_batch_snapshot(second_batch["batch_id"])
            self.assertEqual(snapshot["sources"]["B"]["content"].encode(), frame_b)
            self.assertEqual(journal.load()["sources"]["B"]["cursor"], len(frame_b))


if __name__ == "__main__":
    unittest.main()
