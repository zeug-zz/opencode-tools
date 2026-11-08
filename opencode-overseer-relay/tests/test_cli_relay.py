#!/usr/bin/env python3
"""Public CLI tests for read-only previews and foreground relay operations."""

from tests import support

import contextlib
import copy
import io
import json
import os
from pathlib import Path
import stat
import unittest

from overseer_relay.cli import main
from overseer_relay.journal import Journal, atomic_write_json
from overseer_relay.mailbox import FRAME_SCHEMA, format_frame
from overseer_relay.paths import campaign_dir, resolve_common_dir


FIXTURES = Path(__file__).parent / "fixtures" / "transport"
SESSION_INFO = json.loads((FIXTURES / "session-info.json").read_text(encoding="utf-8"))
PROMPT_RECEIPT = json.loads((FIXTURES / "prompt-admission.json").read_text(encoding="utf-8"))
CAMPAIGN = "cli-relay-test"
SESSION_ID = "ses_overseer123"
SERVER = "http://127.0.0.1:4096"


def _capture(*args, runner=None, sleep=None):
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        result = main([str(arg) for arg in args], runner=runner, sleep=sleep)
    return result, stdout.getvalue(), stderr.getvalue()


def _snapshot(root: Path):
    """Capture campaign contents, modes, mtimes, and symlinks without following."""
    result = {}
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
                value = ("file", path.read_bytes(), stat.S_IMODE(metadata.st_mode), metadata.st_mtime_ns)
            else:
                value = ("other", metadata.st_mode, metadata.st_mtime_ns)
            result[relative] = value
    return result


def _init_campaign(repo, campaign_id=CAMPAIGN, *, approved=False):
    result, _out, error = _capture(
        "init",
        "--repo",
        repo.root,
        "--campaign",
        campaign_id,
        "--base-ref",
        "main",
        "--apply",
    )
    if result != 0:
        raise AssertionError(error)
    common = resolve_common_dir(repo.root)
    root = campaign_dir(common, campaign_id)
    raw = json.loads((root / "config.json").read_text(encoding="utf-8"))
    raw["roles"]["overseer"].update(
        session_id=SESSION_ID,
        directory="/workspace/repo",
        agent="build",
    )
    raw["roles"]["A"]["directory"] = str(repo.root)
    raw["connection"] = ["--server", SERVER]
    if approved:
        raw["capabilities"].update(
            overseer_notices=True,
            owner_approved_notices=True,
        )
    atomic_write_json(root / "config.json", raw)
    return common, root, Journal(common, campaign_id)


def _report_frame(campaign_id=CAMPAIGN, *, role="A", report_id="report-one"):
    return format_frame(
        {
            "schema": FRAME_SCHEMA,
            "campaign": campaign_id,
            "role": role,
            "generation": 1,
            "report_id": report_id,
            "kind": "progress",
            "phase": "implementation",
            "task": "6.3",
            "summary": "bounded report for offline CLI testing",
            "recommendation": None,
            "evidence_paths": [],
            "head": None,
            "blocker": None,
            "goal_state": "unknown",
            "batch_id": None,
        }
    )


def _setup_ack_frame(campaign_id=CAMPAIGN):
    return format_frame(
        {
            "schema": FRAME_SCHEMA,
            "campaign": campaign_id,
            "role": "A",
            "generation": 1,
            "report_id": "setup-ack-one",
            "kind": "setup-ack",
            "phase": None,
            "task": None,
            "summary": "",
            "recommendation": None,
            "evidence_paths": [],
            "head": None,
            "blocker": None,
            "goal_state": "not_applicable",
            "batch_id": None,
        }
    )


def _append_report(root, campaign_id=CAMPAIGN, *, role="A", report_id="report-one"):
    frame = _report_frame(campaign_id, role=role, report_id=report_id)
    with (root / "inbox" / f"{role}.md").open("ab") as stream:
        stream.write(frame)
    return frame


def _settle_via_cli(root, campaign_id=CAMPAIGN):
    for _ in range(2):
        result, _out, error = _capture(
            "once", "--campaign-dir", root, "--apply", "--json"
        )
        if result != 0:
            raise AssertionError(error)
    common = root.parents[2]
    state = Journal(common, campaign_id).read_state_readonly()
    if state["pending_batch"] is None:
        raise AssertionError("report did not settle into a pending batch")
    return Journal(common, campaign_id), state["pending_batch"]


class _DeliveryRunner:
    """Fake the qualified session API and synthesize its exact POST receipt."""

    def __init__(self, *, on_preflight=None, reconcile_empty=False):
        self.calls = []
        self.on_preflight = on_preflight
        self.reconcile_empty = reconcile_empty

    def __call__(self, argv, *, timeout=None, input=None):
        self.calls.append((list(argv), {"timeout": timeout, "input": input}))
        method_index = argv.index("api") + 1
        method = argv[method_index]
        route = argv[method_index + 1]
        if method == "get" and route == f"/api/session/{SESSION_ID}":
            if self.on_preflight is not None:
                self.on_preflight()
            return support.FakeResult(stdout=json.dumps(copy.deepcopy(SESSION_INFO)))
        if method == "post":
            self.post_body = json.loads(argv[argv.index("--data") + 1])
            receipt = copy.deepcopy(PROMPT_RECEIPT)
            data = receipt["data"]
            data["sessionID"] = SESSION_ID
            data["payload"]["text"] = self.post_body["text"]
            data["payload"]["metadata"] = self.post_body["metadata"]
            data["id"] = "msg_cli_admitted"
            return support.FakeResult(stdout=json.dumps(receipt))
        if method == "get" and route == f"/api/session/{SESSION_ID}/inbox":
            return support.FakeResult(stdout=json.dumps({"data": []}))
        if method == "get" and route.startswith(f"/api/session/{SESSION_ID}/message?"):
            return support.FakeResult(
                stdout=json.dumps({"data": [], "cursor": {"previous": None, "next": None}})
            )
        raise AssertionError(f"unexpected fake API call: {method} {route}")

    @property
    def api_paths(self):
        return [call[0][call[0].index("api") + 2] for call in self.calls]

    @property
    def post_calls(self):
        return [
            call
            for call in self.calls
            if call[0][call[0].index("api") + 1] == "post"
        ]


class CLIRelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        support.TMP_ROOT.mkdir(parents=True, exist_ok=True)

    def test_once_default_and_status_are_strictly_read_only(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo)
            (root / "inbox" / "A.md").write_bytes(_report_frame())
            before = _snapshot(root)

            result, stdout, stderr = _capture("once", "--campaign-dir", root)
            self.assertEqual(result, 0, stderr)
            self.assertIn("Dry run: no transport, lock, or state writes.", stdout)
            self.assertIn("queued=[0,", stdout)
            self.assertFalse((root / "watcher" / "lock").exists())
            self.assertEqual(_snapshot(root), before)

            result, stdout, stderr = _capture("status", "--campaign-dir", root, "--json")
            self.assertEqual(result, 0, stderr)
            status = json.loads(stdout)
            self.assertEqual(status["sources"]["A"]["queued_range"], [0, len(_report_frame())])
            self.assertEqual(status["pending_batch"], None)
            self.assertIn("watcher/state.json is the source of truth", status["holds_json"])
            self.assertEqual(_snapshot(root), before)
            self.assertFalse((root / "watcher" / "lock").exists())

    def test_read_only_status_reports_corrupt_state_without_migration_or_lock(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo)
            state_path = root / "watcher" / "state.json"
            state_path.write_bytes(b'{"schema_version":1,"schema_version":1}\n')
            before = _snapshot(root)

            result, _stdout, stderr = _capture("status", "--campaign-dir", root)

            self.assertEqual(result, 2)
            self.assertIn("journal state is corrupt", stderr)
            self.assertEqual(_snapshot(root), before)
            self.assertFalse((root / "watcher" / "lock").exists())

    def test_campaign_directory_must_be_exact_and_symlink_free(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo)
            outside = repo.root / "not-a-campaign"
            outside.mkdir()
            result, _stdout, stderr = _capture("status", "--campaign-dir", outside)
            self.assertEqual(result, 2)
            self.assertIn("campaign directory", stderr)

            link = repo.root / "campaign-link"
            link.symlink_to(root, target_is_directory=True)
            result, _stdout, stderr = _capture("status", "--campaign-dir", link)
            self.assertEqual(result, 2)
            self.assertIn("campaign directory is invalid or unsafe", stderr)

    def test_once_apply_settles_one_batch_but_does_not_deliver_by_default(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo, approved=True)
            _append_report(root)
            runner = support.FakeRunner()

            result, _stdout, stderr = _capture(
                "once", "--campaign-dir", root, "--apply", runner=runner
            )
            self.assertEqual(result, 0, stderr)
            self.assertEqual(runner.calls, [])
            result, _stdout, stderr = _capture(
                "once", "--campaign-dir", root, "--apply", runner=runner
            )
            self.assertEqual(result, 0, stderr)
            self.assertEqual(runner.calls, [])

            state = Journal(resolve_common_dir(repo.root), CAMPAIGN).read_state_readonly()
            self.assertIsNotNone(state["pending_batch"])
            self.assertEqual(state["batches"][state["pending_batch"]]["status"], "snapshotted")

    def test_explicit_delivery_routes_one_queued_notice_only_to_the_overseer(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo, approved=True)
            _append_report(root)
            journal, batch_id = _settle_via_cli(root)
            runner = _DeliveryRunner()

            result, stdout, stderr = _capture(
                "once",
                "--campaign-dir",
                root,
                "--apply",
                "--deliver-notices",
                "--json",
                runner=runner,
                sleep=lambda _seconds: None,
            )

            self.assertEqual(result, 0, stderr)
            self.assertEqual(len(runner.post_calls), 1)
            self.assertEqual(runner.api_paths, [
                f"/api/session/{SESSION_ID}",
                f"/api/session/{SESSION_ID}/prompt",
            ])
            post = runner.post_calls[0]
            self.assertEqual(post[0][post[0].index("api") + 1], "post")
            self.assertEqual(post[0][post[0].index("--data") + 1], json.dumps(runner.post_body, ensure_ascii=False, separators=(",", ":")))
            self.assertEqual(runner.post_body["delivery"], "queue")
            self.assertIs(runner.post_body["resume"], True)
            self.assertEqual(
                runner.post_body["metadata"],
                {"overseerRelay": {"campaign": CAMPAIGN, "batchId": batch_id}},
            )
            self.assertNotIn("id", runner.post_body)
            self.assertEqual(journal.read_state_readonly()["batches"][batch_id]["status"], "admitted")
            self.assertNotIn("goal", stdout.lower())

    def test_watch_reports_admitted_batch_waiting_for_ack_once(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo, approved=True)
            _append_report(root)
            journal, batch_id = _settle_via_cli(root)
            delivery_runner = _DeliveryRunner()
            result, _stdout, stderr = _capture(
                "once",
                "--campaign-dir",
                root,
                "--apply",
                "--deliver-notices",
                runner=delivery_runner,
                sleep=lambda _seconds: None,
            )
            self.assertEqual(result, 0, stderr)
            self.assertEqual(journal.read_state_readonly()["batches"][batch_id]["status"], "admitted")

            watch_runner = support.FakeRunner()
            sleeps = 0

            def interrupt_after_two_cycles(_interval):
                nonlocal sleeps
                sleeps += 1
                if sleeps == 2:
                    raise KeyboardInterrupt

            result, stdout, stderr = _capture(
                "watch",
                "--campaign-dir",
                root,
                "--deliver-notices",
                runner=watch_runner,
                sleep=interrupt_after_two_cycles,
            )

            self.assertEqual(result, 0, stderr)
            message = f"Delivery: admitted; batch={batch_id}; awaiting Overseer acknowledgement"
            self.assertEqual(stdout.count(message), 1)
            self.assertEqual(watch_runner.calls, [])
            self.assertEqual(journal.read_state_readonly()["batches"][batch_id]["status"], "admitted")

    def test_delivery_opt_in_without_saved_capability_makes_zero_calls(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo, approved=False)
            _append_report(root)
            _settle_via_cli(root)
            runner = support.FakeRunner()

            result, stdout, stderr = _capture(
                "once",
                "--campaign-dir",
                root,
                "--apply",
                "--deliver-notices",
                runner=runner,
            )

            self.assertEqual(result, 0, stderr)
            self.assertEqual(runner.calls, [])
            self.assertIn("Delivery: not-authorized", stdout)
            self.assertIn("disabled", stdout)

    def test_opted_in_empty_and_protocol_only_cycles_make_zero_transport_calls(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo, approved=True)
            runner = support.FakeRunner()

            result, _stdout, stderr = _capture(
                "once",
                "--campaign-dir",
                root,
                "--apply",
                "--deliver-notices",
                runner=runner,
            )
            self.assertEqual(result, 0, stderr)
            self.assertEqual(runner.calls, [])

            with (root / "inbox" / "A.md").open("ab") as stream:
                stream.write(_setup_ack_frame())
            for _ in range(2):
                result, _stdout, stderr = _capture(
                    "once",
                    "--campaign-dir",
                    root,
                    "--apply",
                    "--deliver-notices",
                    runner=runner,
                )
                self.assertEqual(result, 0, stderr)
            state = Journal(resolve_common_dir(repo.root), CAMPAIGN).read_state_readonly()
            self.assertIsNone(state["pending_batch"])
            self.assertEqual(len(state["batches"]), 1)
            self.assertEqual(next(iter(state["batches"].values()))["status"], "acknowledged")
            self.assertEqual(runner.calls, [])

    def test_dry_run_delivery_flag_requires_apply(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo, approved=True)
            before = _snapshot(root)
            runner = support.FakeRunner()

            result, _stdout, stderr = _capture(
                "once", "--campaign-dir", root, "--deliver-notices", runner=runner
            )

            self.assertEqual(result, 2)
            self.assertIn("requires --apply", stderr)
            self.assertEqual(runner.calls, [])
            self.assertEqual(_snapshot(root), before)

    def test_colliding_campaign_and_role_names_are_isolated_by_common_directory(self):
        with support.TempGitRepo() as repo_a, support.TempGitRepo() as repo_b:
            common_a, root_a, _journal_a = _init_campaign(repo_a, campaign_id="same-campaign")
            common_b, root_b, _journal_b = _init_campaign(repo_b, campaign_id="same-campaign")
            self.assertNotEqual(common_a, common_b)
            _append_report(root_a, "same-campaign", report_id="a-only")
            before_b = _snapshot(root_b)

            for _ in range(2):
                result, _stdout, stderr = _capture(
                    "once", "--campaign-dir", root_a, "--apply"
                )
                self.assertEqual(result, 0, stderr)

            state_a = Journal(common_a, "same-campaign").read_state_readonly()
            state_b = Journal(common_b, "same-campaign").read_state_readonly()
            self.assertIsNotNone(state_a["pending_batch"])
            self.assertIsNone(state_b["pending_batch"])
            self.assertEqual(_snapshot(root_b), before_b)

    def test_status_shows_pending_ranges_ack_delivery_state_and_holds(self):
        with support.TempGitRepo() as repo:
            _common, root, journal = _init_campaign(repo)
            frame = _append_report(root)
            _journal, batch_id = _settle_via_cli(root)
            journal.set_hold("operator requested review", batch_id=batch_id)

            result, stdout, stderr = _capture("status", "--campaign-dir", root, "--json")

            self.assertEqual(result, 0, stderr)
            status = json.loads(stdout)
            self.assertEqual(status["pending_batch"], batch_id)
            batch = status["batches"][0]
            self.assertEqual(batch["status"], "snapshotted")
            self.assertEqual(batch["ranges"], {"A": [0, len(frame)]})
            self.assertEqual(batch["acknowledgement"], "missing")
            self.assertEqual(batch["hold"]["reason"], "operator requested review")
            self.assertTrue(batch["unresolved_outcome"] is False)
            self.assertFalse((root / "watcher" / "lock").exists())

    def test_hold_release_persists_and_pre_post_failure_can_safely_requeue(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo)
            _append_report(root)
            journal, batch_id = _settle_via_cli(root)
            journal.set_delivery_state(batch_id, "held")

            result, stdout, stderr = _capture(
                "status", "--campaign-dir", root, "--json"
            )
            self.assertEqual(result, 0, stderr)
            before_release = json.loads(stdout)["batches"][0]
            self.assertEqual(before_release["status"], "held")
            self.assertFalse(before_release["send_intent_recorded"])

            result, _stdout, stderr = _capture(
                "release", "--campaign-dir", root, "--batch-id", batch_id
            )
            self.assertEqual(result, 0, stderr)
            state = journal.read_state_readonly()
            self.assertEqual(state["batches"][batch_id]["status"], "snapshotted")
            self.assertFalse(state["batches"][batch_id]["send_intent_recorded"])
            self.assertTrue(state["batches"][batch_id]["hold"]["released"])

    def test_uncertain_release_allows_only_one_reconciliation_not_a_post(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo, approved=True)
            _append_report(root)
            journal, batch_id = _settle_via_cli(root)
            journal.set_delivery_state(batch_id, "send-intent")
            journal.set_delivery_state(batch_id, "uncertain")

            result, _stdout, stderr = _capture(
                "release", "--campaign-dir", root, "--batch-id", batch_id
            )
            self.assertEqual(result, 0, stderr)
            released = journal.read_state_readonly()["batches"][batch_id]
            self.assertEqual(released["status"], "uncertain")
            self.assertTrue(released["send_intent_recorded"])
            self.assertTrue(released["hold"]["released"])

            runner = _DeliveryRunner()
            result, _stdout, stderr = _capture(
                "once",
                "--campaign-dir",
                root,
                "--apply",
                "--deliver-notices",
                runner=runner,
            )
            self.assertEqual(result, 0, stderr)
            self.assertEqual(runner.post_calls, [])
            self.assertEqual(runner.api_paths, [
                f"/api/session/{SESSION_ID}",
                f"/api/session/{SESSION_ID}/inbox",
                f"/api/session/{SESSION_ID}/message?type=user&limit=100&order=desc",
            ])
            after = journal.read_state_readonly()["batches"][batch_id]
            self.assertEqual(after["status"], "uncertain")
            self.assertTrue(after["send_intent_recorded"])
            self.assertFalse(after["hold"]["released"])

            second_runner = support.FakeRunner()
            result, stdout, stderr = _capture(
                "once",
                "--campaign-dir",
                root,
                "--apply",
                "--deliver-notices",
                runner=second_runner,
            )
            self.assertEqual(result, 0, stderr)
            self.assertEqual(second_runner.calls, [])
            self.assertIn("explicit operator release", stdout)

    def test_source_hold_release_and_secret_reason_rejection(self):
        with support.TempGitRepo() as repo:
            _common, root, journal = _init_campaign(repo)
            before = _snapshot(root)

            result, _stdout, stderr = _capture(
                "hold",
                "--campaign-dir",
                root,
                "--reason",
                "token=must-not-be-stored",
                "--source",
                "A",
            )
            self.assertEqual(result, 2)
            self.assertNotIn("must-not-be-stored", stderr)
            self.assertEqual(_snapshot(root), before)

            result, stdout, stderr = _capture(
                "hold",
                "--campaign-dir",
                root,
                "--reason",
                "operator review requested",
                "--source",
                "A",
            )
            self.assertEqual(result, 0, stderr)
            self.assertNotIn("operator review requested", stdout)
            self.assertFalse(journal.read_state_readonly()["sources"]["A"]["hold"]["released"])

            result, _stdout, stderr = _capture(
                "hold",
                "--campaign-dir",
                root,
                "--reason",
                "campaign-wide operator review",
            )
            self.assertEqual(result, 0, stderr)
            self.assertEqual(
                journal.read_state_readonly()["hold"]["reason"],
                "campaign-wide operator review",
            )

            result, _stdout, stderr = _capture("release", "--campaign-dir", root)
            self.assertEqual(result, 0, stderr)
            self.assertTrue(journal.read_state_readonly()["hold"]["released"])

            result, _stdout, stderr = _capture(
                "release", "--campaign-dir", root, "--source", "A"
            )
            self.assertEqual(result, 0, stderr)
            self.assertTrue(journal.read_state_readonly()["sources"]["A"]["hold"]["released"])

    def test_old_held_batch_without_send_marker_is_treated_as_ambiguous(self):
        with support.TempGitRepo() as repo:
            common, root, journal = _init_campaign(repo)
            _append_report(root)
            journal, batch_id = _settle_via_cli(root)
            journal.set_delivery_state(batch_id, "held")
            state_path = root / "watcher" / "state.json"
            raw_state = json.loads(state_path.read_text(encoding="utf-8"))
            raw_state["batches"][batch_id].pop("send_intent_recorded")
            atomic_write_json(state_path, raw_state)

            result, _stdout, stderr = _capture(
                "release", "--campaign-dir", root, "--batch-id", batch_id
            )

            self.assertEqual(result, 0, stderr)
            state = Journal(common, CAMPAIGN).read_state_readonly()
            batch = state["batches"][batch_id]
            self.assertEqual(batch["status"], "uncertain")
            self.assertTrue(batch["send_intent_recorded"])
            self.assertTrue(batch["hold"]["released"])

    def test_watch_is_foreground_interruption_releases_lock_and_hold_logs_once(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo)
            _append_report(root, campaign_id="other-campaign", report_id="wrong-campaign")
            runner = support.FakeRunner()
            sleeps = 0

            def interrupt_after_two_cycles(_interval):
                nonlocal sleeps
                sleeps += 1
                if sleeps == 2:
                    raise KeyboardInterrupt

            result, stdout, stderr = _capture(
                "watch",
                "--campaign-dir",
                root,
                runner=runner,
                sleep=interrupt_after_two_cycles,
            )

            self.assertEqual(result, 0, stderr)
            self.assertEqual(runner.calls, [])
            self.assertEqual(sleeps, 2)
            self.assertEqual(stdout.count("New hold (A):"), 1)
            self.assertIn("Watch stopped", stdout)
            self.assertFalse((root / "watcher" / "lock").exists())

    def test_watch_reloads_revoked_capability_before_another_live_call(self):
        with support.TempGitRepo() as repo:
            _common, root, _journal = _init_campaign(repo, approved=True)
            _append_report(root)
            journal, batch_id = _settle_via_cli(root)
            config_path = root / "config.json"
            original = json.loads(config_path.read_text(encoding="utf-8"))
            revoked = copy.deepcopy(original)
            revoked["capabilities"]["overseer_notices"] = False

            def revoke_after_preflight():
                atomic_write_json(config_path, revoked)

            runner = _DeliveryRunner(on_preflight=revoke_after_preflight)
            sleeps = 0

            def continue_then_interrupt(_interval):
                nonlocal sleeps
                sleeps += 1
                if sleeps == 1:
                    return
                raise KeyboardInterrupt

            result, stdout, stderr = _capture(
                "watch",
                "--campaign-dir",
                root,
                "--deliver-notices",
                runner=runner,
                sleep=continue_then_interrupt,
            )

            self.assertEqual(result, 0, stderr)
            self.assertEqual(len(runner.calls), 1)
            self.assertEqual(runner.api_paths, [f"/api/session/{SESSION_ID}"])
            self.assertEqual(runner.post_calls, [])
            self.assertIn("Delivery disabled", stdout)
            self.assertEqual(journal.read_state_readonly()["batches"][batch_id]["status"], "held")
            self.assertFalse((root / "watcher" / "lock").exists())

    def test_help_has_no_goal_control_or_worker_delivery_command(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), self.assertRaises(SystemExit) as raised:
            main(["--help"])
        self.assertEqual(raised.exception.code, 0)
        help_text = stdout.getvalue()
        for command in ("inspect", "init", "once", "watch", "status", "hold", "release"):
            self.assertIn(command, help_text)
        self.assertNotIn("resume-goal", help_text)
        self.assertNotIn("worker-delivery", help_text)


if __name__ == "__main__":
    unittest.main()
