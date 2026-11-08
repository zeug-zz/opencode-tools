#!/usr/bin/env python3
"""Offline tests for the worker-bound goal-resume transport and ledger."""

from tests import support

import contextlib
import io
import json
import os
from pathlib import Path
import re
import unittest
from dataclasses import replace

from overseer_relay.cli import main
from overseer_relay.config import load_config, parse_config, to_json_dict
from overseer_relay.journal import (
    MAX_RESUME_LEDGER_BYTES,
    MAX_RESUME_LEDGER_RECORDS,
    Journal,
    atomic_write_json,
)
from overseer_relay.paths import campaign_dir, resolve_common_dir
from overseer_relay.transport import (
    TransportError,
    _managed_helper_path,
    request_goal_resume,
)


CAMPAIGN = "goal-resume-test"
URL = "http://127.0.0.1:17777"
WORKER_SESSION = "ses_workerA123"
WORKER_B_SESSION = "ses_workerB123"
OVERSEER_SESSION = "ses_overseer999"
CANARY = "Bearer never-save-this-resume-canary"


def _init_goal_campaign(repo):
    stderr = io.StringIO()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
        result = main(
            [
                "init",
                "--repo",
                str(repo.root),
                "--campaign",
                CAMPAIGN,
                "--base-ref",
                "main",
                "--apply",
            ]
        )
    if result != 0:
        raise AssertionError(stderr.getvalue())

    common_dir = resolve_common_dir(repo.root)
    root = campaign_dir(common_dir, CAMPAIGN)
    config_data = json.loads((root / "config.json").read_text(encoding="utf-8"))
    config_data["schema_version"] = 2
    config_data["connection"] = {
        "mode": "managed-local",
        "expected_url": URL,
        "expected_pid": 12345,
    }
    config_data["roles"]["overseer"].update(
        session_id=OVERSEER_SESSION,
        directory="/workspace/overseer",
        agent="overseer",
    )
    config_data["roles"]["A"].update(
        session_id=WORKER_SESSION,
        directory=str(repo.root),
        agent="build",
    )
    config_data["roles"]["B"].update(
        session_id=WORKER_B_SESSION,
        directory=str(repo.root),
        agent="claude",
    )
    config_data["capabilities"]["goal_resume"] = True
    atomic_write_json(root / "config.json", config_data)
    return common_dir, root, Journal(common_dir, CAMPAIGN), load_config(root / "config.json")


def _managed_success(*, delivered=True):
    return support.FakeResult(
        stdout=json.dumps(
            {
                "ok": True,
                "data": {"delivered": delivered},
                "host_version": "2.2.7",
            }
        )
    )


def _managed_failure(code, post_started):
    return support.FakeResult(
        returncode=1,
        stdout=json.dumps(
            {"ok": False, "code": code, "post_started": post_started}
        ),
        stderr=CANARY,
    )


def _helper_input(runner, index=-1):
    return json.loads(runner.calls[index][1]["input"])


def _ledger(root):
    path = root / "controls" / "resume.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _record(ruling_id, request_id, attempt, outcome="attempt_started"):
    return {
        "ruling_id": ruling_id,
        "role": "A",
        "session_id": WORKER_SESSION,
        "timestamp": 1762550000000,
        "outcome_code": outcome,
        "request_id": request_id,
        "attempt": attempt,
    }


class GoalResumeTests(unittest.TestCase):
    def setUp(self):
        support.TMP_ROOT.mkdir(parents=True, exist_ok=True)

    def _campaign(self):
        repo = support.TempGitRepo()
        self.addCleanup(repo.__exit__, None, None, None)
        return (*_init_goal_campaign(repo), repo)

    def test_exact_worker_bound_helper_operation_and_success_ledger(self):
        _common, root, journal, config, _repo = self._campaign()
        runner = support.FakeRunner([_managed_success()])

        result = request_goal_resume(config, journal, "A", "ruling-3.1", runner=runner)

        self.assertEqual(result, {"status": "delivered"})
        self.assertEqual(len(runner.calls), 1)
        self.assertEqual(runner.calls[0][0], ["node", str(_managed_helper_path())])
        request = _helper_input(runner)
        self.assertEqual(
            set(request),
            {"schema_version", "operation", "connection", "binding", "campaign", "timeout_ms"},
        )
        self.assertEqual(request["operation"], "resume_goal")
        self.assertEqual(
            request["binding"],
            {"session_id": WORKER_SESSION, "directory": config.roles["A"].directory, "agent": "build"},
        )
        self.assertNotIn("data", request)
        self.assertNotIn(OVERSEER_SESSION, json.dumps(request))

        path = root / "controls" / "resume.jsonl"
        records = _ledger(root)
        self.assertEqual([entry["outcome_code"] for entry in records], ["attempt_started", "delivered"])
        self.assertTrue(all(set(entry) == set(_record("x", "0" * 32, 1)) for entry in records))
        self.assertEqual(records[0]["request_id"], records[1]["request_id"])
        self.assertEqual(records[0]["role"], "A")
        self.assertEqual(records[0]["session_id"], WORKER_SESSION)
        self.assertIs(type(records[0]["timestamp"]), int)
        self.assertRegex(records[0]["request_id"], re.compile(r"[0-9a-f]{32}\Z"))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(CANARY, path.read_text(encoding="utf-8"))
        self.assertNotIn("text", records[0])

    def test_duplicate_is_suppressed_and_force_starts_a_fresh_sequence(self):
        _common, root, journal, config, _repo = self._campaign()
        first_runner = support.FakeRunner([_managed_success()])
        self.assertEqual(
            request_goal_resume(config, journal, "A", "ruling-duplicate", runner=first_runner),
            {"status": "delivered"},
        )

        duplicate_runner = support.FakeRunner()
        self.assertEqual(
            request_goal_resume(config, journal, "A", "ruling-duplicate", runner=duplicate_runner),
            {"status": "duplicate"},
        )
        self.assertEqual(duplicate_runner.calls, [])

        forced_runner = support.FakeRunner([_managed_success()])
        self.assertEqual(
            request_goal_resume(
                config, journal, "A", "ruling-duplicate", runner=forced_runner, force=True
            ),
            {"status": "delivered"},
        )
        entries = _ledger(root)
        request_ids = [entry["request_id"] for entry in entries if entry["outcome_code"] == "attempt_started"]
        self.assertEqual(len(request_ids), 2)
        self.assertNotEqual(request_ids[0], request_ids[1])
        self.assertEqual(len(forced_runner.calls), 1)

    def test_same_ruling_is_deduplicated_independently_for_each_worker_role(self):
        _common, root, journal, config, _repo = self._campaign()
        runner_a = support.FakeRunner([_managed_success()])
        runner_b = support.FakeRunner([_managed_success()])

        self.assertEqual(
            request_goal_resume(config, journal, "A", "ruling-two-workers", runner=runner_a),
            {"status": "delivered"},
        )
        self.assertEqual(
            request_goal_resume(config, journal, "B", "ruling-two-workers", runner=runner_b),
            {"status": "delivered"},
        )

        self.assertEqual(_helper_input(runner_a)["binding"]["session_id"], WORKER_SESSION)
        self.assertEqual(_helper_input(runner_b)["binding"]["session_id"], WORKER_B_SESSION)
        self.assertNotIn(OVERSEER_SESSION, json.dumps(_helper_input(runner_b)))
        records = _ledger(root)
        self.assertEqual(
            {(entry["role"], entry["session_id"]) for entry in records},
            {("A", WORKER_SESSION), ("B", WORKER_B_SESSION)},
        )

    def test_capability_schema_binding_role_and_ruling_refusals_never_launch_helper(self):
        _common, _root, journal, config, _repo = self._campaign()
        disabled_data = to_json_dict(config)
        disabled_data["capabilities"]["goal_resume"] = False
        disabled = parse_config(disabled_data)
        unbound_data = to_json_dict(config)
        unbound_data["roles"]["A"]["agent"] = None
        unbound = parse_config(unbound_data)
        legacy = replace(config, schema_version=1, connection=("--server", URL))
        cases = (
            (disabled, "A", "ruling-disabled"),
            (legacy, "A", "ruling-legacy"),
            (unbound, "A", "ruling-unbound"),
            (config, "overseer", "ruling-overseer"),
            (config, "unknown", "ruling-unknown"),
            (config, "A", "../invalid"),
        )
        for selected_config, role, ruling_id in cases:
            with self.subTest(role=role, ruling_id=ruling_id):
                runner = support.FakeRunner()
                with self.assertRaises(TransportError):
                    request_goal_resume(
                        selected_config, journal, role, ruling_id, runner=runner
                    )
                self.assertEqual(runner.calls, [])

    def test_ambiguous_timeout_crash_and_malformed_results_retry_once(self):
        first_failures = (
            TimeoutError(CANARY),
            RuntimeError(CANARY),
            support.FakeResult(returncode=1, stdout=CANARY, stderr=CANARY),
            _managed_failure("post_failed", True),
            support.FakeResult(
                stdout=json.dumps(
                    {"ok": True, "data": {"delivered": 1}, "host_version": "2.2.7"}
                )
            ),
            support.FakeResult(
                stdout=json.dumps(
                    {
                        "ok": True,
                        "data": {"delivered": True, "extra": "not-allowed"},
                        "host_version": "2.2.7",
                    }
                )
            ),
        )
        for index, first in enumerate(first_failures):
            with self.subTest(kind=index):
                _common, root, journal, config, _repo = self._campaign()
                runner = support.FakeRunner([first, _managed_success()])

                result = request_goal_resume(
                    config, journal, "A", f"ruling-ambiguous-{index}", runner=runner
                )

                self.assertEqual(result, {"status": "delivered"})
                self.assertEqual(len(runner.calls), 2)
                self.assertEqual(
                    [_helper_input(runner, call)["operation"] for call in range(2)],
                    ["resume_goal", "resume_goal"],
                )
                records = _ledger(root)
                self.assertEqual(
                    [entry["outcome_code"] for entry in records],
                    ["attempt_started", "attempt_started", "delivered"],
                )
                self.assertEqual([entry["attempt"] for entry in records], [1, 2, 2])
                self.assertEqual(len({entry["request_id"] for entry in records}), 1)
                self.assertNotIn(CANARY, (root / "controls" / "resume.jsonl").read_text())

    def test_two_ambiguous_attempts_become_uncertain_and_are_not_retried_without_force(self):
        _common, root, journal, config, _repo = self._campaign()
        runner = support.FakeRunner([TimeoutError(CANARY), _managed_failure("post_failed", True)])

        result = request_goal_resume(config, journal, "A", "ruling-uncertain", runner=runner)

        self.assertEqual(result, {"status": "uncertain"})
        self.assertEqual(len(runner.calls), 2)
        self.assertEqual([entry["outcome_code"] for entry in _ledger(root)], [
            "attempt_started", "attempt_started", "uncertain",
        ])
        no_retry = support.FakeRunner()
        self.assertEqual(
            request_goal_resume(config, journal, "A", "ruling-uncertain", runner=no_retry),
            {"status": "uncertain"},
        )
        self.assertEqual(no_retry.calls, [])

    def test_proven_pre_post_refusal_is_recorded_without_retry(self):
        _common, root, journal, config, _repo = self._campaign()
        runner = support.FakeRunner([_managed_failure("session_binding_mismatch", False)])

        result = request_goal_resume(config, journal, "A", "ruling-not-started", runner=runner)

        self.assertEqual(result, {"status": "failed_not_started"})
        self.assertEqual(len(runner.calls), 1)
        self.assertEqual([entry["outcome_code"] for entry in _ledger(root)], [
            "attempt_started", "failed_not_started",
        ])

    def test_definitive_non_204_redirect_failure_is_not_retried(self):
        _common, root, journal, config, _repo = self._campaign()
        runner = support.FakeRunner([_managed_failure("redirect_blocked", True)])

        result = request_goal_resume(config, journal, "A", "ruling-redirect", runner=runner)

        self.assertEqual(result, {"status": "failed"})
        self.assertEqual(len(runner.calls), 1)
        self.assertEqual([entry["outcome_code"] for entry in _ledger(root)], [
            "attempt_started", "failed",
        ])

    def test_restart_with_first_attempt_intent_retries_once_with_same_request_id(self):
        _common, root, journal, config, _repo = self._campaign()
        request_id = "a" * 32
        journal.append_resume_record(_record("ruling-crash", request_id, 1))
        runner = support.FakeRunner([_managed_success()])

        result = request_goal_resume(config, journal, "A", "ruling-crash", runner=runner)

        self.assertEqual(result, {"status": "delivered"})
        self.assertEqual(len(runner.calls), 1)
        records = _ledger(root)
        self.assertEqual([entry["attempt"] for entry in records], [1, 2, 2])
        self.assertEqual({entry["request_id"] for entry in records}, {request_id})

    def test_restart_with_unresolved_attempt_two_marks_uncertain_without_call(self):
        _common, root, journal, config, _repo = self._campaign()
        request_id = "b" * 32
        journal.append_resume_record(_record("ruling-crash-two", request_id, 1))
        journal.append_resume_record(_record("ruling-crash-two", request_id, 2))
        runner = support.FakeRunner()

        result = request_goal_resume(config, journal, "A", "ruling-crash-two", runner=runner)

        self.assertEqual(result, {"status": "uncertain"})
        self.assertEqual(runner.calls, [])
        records = _ledger(root)
        self.assertEqual([entry["outcome_code"] for entry in records], [
            "attempt_started", "attempt_started", "uncertain",
        ])

    def test_ledger_limits_corruption_and_symlinked_controls_refuse_before_helper(self):
        _common, root, journal, config, _repo = self._campaign()
        controls = root / "controls"
        controls.mkdir(mode=0o700)
        ledger_path = controls / "resume.jsonl"

        # The record bound is checked before the transport can launch.
        records = [
            _record(f"ruling-{index}", f"{index:032x}", 1)
            for index in range(MAX_RESUME_LEDGER_RECORDS)
        ]
        ledger_path.write_bytes(
            b"".join(
                json.dumps(record, separators=(",", ":")).encode("ascii") + b"\n"
                for record in records
            )
        )
        os.chmod(ledger_path, 0o600)
        runner = support.FakeRunner()
        with self.assertRaises(TransportError):
            request_goal_resume(config, journal, "A", "ruling-new", runner=runner)
        self.assertEqual(runner.calls, [])

        # Exactly 256 KiB is a valid read but leaves no room for a new durable
        # attempt sequence; the extra padding is legal JSON whitespace.
        byte_repo = support.TempGitRepo()
        self.addCleanup(byte_repo.__exit__, None, None, None)
        _common, byte_root, byte_journal, byte_config = _init_goal_campaign(byte_repo)
        byte_controls = byte_root / "controls"
        byte_controls.mkdir(mode=0o700)
        byte_ledger = byte_controls / "resume.jsonl"
        row = _record("ruling-byte-bound", "c" * 32, 1)
        encoded = json.dumps(row, separators=(",", ":")).encode("ascii")
        raw = encoded + b" " * (MAX_RESUME_LEDGER_BYTES - len(encoded) - 1) + b"\n"
        self.assertEqual(len(raw), MAX_RESUME_LEDGER_BYTES)
        byte_ledger.write_bytes(raw)
        os.chmod(byte_ledger, 0o600)
        byte_runner = support.FakeRunner()
        with self.assertRaises(TransportError):
            request_goal_resume(
                byte_config, byte_journal, "A", "ruling-byte-bound", runner=byte_runner
            )
        self.assertEqual(byte_runner.calls, [])

        # A corrupt existing line is refused, never repaired or overwritten.
        corrupt_repo = support.TempGitRepo()
        self.addCleanup(corrupt_repo.__exit__, None, None, None)
        _common, corrupt_root, corrupt_journal, corrupt_config = _init_goal_campaign(corrupt_repo)
        corrupt_controls = corrupt_root / "controls"
        corrupt_controls.mkdir(mode=0o700)
        corrupt = corrupt_controls / "resume.jsonl"
        corrupt.write_bytes(b'{"ruling_id":\n')
        os.chmod(corrupt, 0o600)
        corrupt_runner = support.FakeRunner()
        with self.assertRaises(TransportError):
            request_goal_resume(
                corrupt_config, corrupt_journal, "A", "ruling-corrupt", runner=corrupt_runner
            )
        self.assertEqual(corrupt_runner.calls, [])

        # A directory symlink cannot redirect the ledger outside the campaign.
        symlink_repo = support.TempGitRepo()
        self.addCleanup(symlink_repo.__exit__, None, None, None)
        _common, symlink_root, symlink_journal, symlink_config = _init_goal_campaign(symlink_repo)
        (symlink_root / "controls").symlink_to(symlink_root / "inbox", target_is_directory=True)
        symlink_runner = support.FakeRunner()
        with self.assertRaises(TransportError):
            request_goal_resume(
                symlink_config, symlink_journal, "A", "ruling-symlink", runner=symlink_runner
            )
        self.assertEqual(symlink_runner.calls, [])
        self.assertFalse((symlink_root / "inbox" / "resume.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
