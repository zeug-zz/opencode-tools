#!/usr/bin/env python3
"""Provider-free delivery certainty tests for managed-local transport."""

from tests import support

import contextlib
import io
import json
import unittest
from unittest.mock import patch

from overseer_relay.cli import main
from overseer_relay.config import load_config
from overseer_relay.journal import Journal, atomic_write_json
from overseer_relay.paths import campaign_dir, resolve_common_dir
from overseer_relay.transport import (
    TransportError,
    _managed_helper_path,
    deliver_pending,
)
from tests.test_transport_delivery import (
    CAMPAIGN,
    SESSION_ID,
    _first_pending,
    _init_campaign,
)


URL = "http://127.0.0.1:17777"
PID = 12345
DIRECTORY = "/workspace/repo"
AGENT = "build"
CANARY = "Bearer never-store-this-managed-canary"


def _managed_campaign(repo):
    common, root, journal, _legacy_config = _init_campaign(repo)
    batch_id = _first_pending(root, journal)
    raw = json.loads((root / "config.json").read_text(encoding="utf-8"))
    raw["schema_version"] = 2
    raw["connection"] = {
        "mode": "managed-local",
        "expected_url": URL,
        "expected_pid": PID,
    }
    atomic_write_json(root / "config.json", raw)
    return common, root, journal, load_config(root / "config.json"), batch_id


def _result(data, *, version="2.3.0"):
    return support.FakeResult(
        stdout=json.dumps({"ok": True, "data": data, "host_version": version})
    )


def _failure(code, post_started, *, stderr=""):
    return support.FakeResult(
        returncode=1,
        stdout=json.dumps({"ok": False, "code": code, "post_started": post_started}),
        stderr=stderr,
    )


def _session_projection():
    return {
        "data": {
            "id": SESSION_ID,
            "agent": AGENT,
            "location": {"directory": DIRECTORY},
            "time": {"created": 1762550000000, "updated": 1762550001000},
        }
    }


def _prompt_projection(batch_id, *, campaign=CAMPAIGN, session_id=SESSION_ID):
    return {
        "data": {
            "id": "msg_managed_admitted",
            "sessionID": session_id,
            "type": "user",
            "time": {"created": 1762550003000},
            "delivery": "queue",
            "payload": {
                "metadata": {
                    "overseerRelay": {"campaign": campaign, "batchId": batch_id}
                }
            },
        }
    }


def _inbox(batch_id, *, message_id="msg_reconciled", campaign=CAMPAIGN):
    return {
        "data": [
            {
                "id": message_id,
                "sessionID": SESSION_ID,
                "type": "user",
                "time": {"created": 1762550003000},
                "delivery": "queue",
                "payload": {
                    "text": "",
                    "metadata": {
                        "overseerRelay": {"campaign": campaign, "batchId": batch_id}
                    },
                },
            }
        ]
    }


def _messages(batch_id, *, message_id="msg_reconciled", campaign=CAMPAIGN, next_cursor=None):
    return {
        "data": [
            {
                "id": message_id,
                "sessionID": SESSION_ID,
                "type": "user",
                "time": {"created": 1762550003000},
                "text": "",
                "metadata": {
                    "overseerRelay": {"campaign": campaign, "batchId": batch_id}
                },
            }
        ],
        "cursor": {"previous": None, "next": next_cursor},
    }


def _empty_inbox():
    return {"data": []}


def _empty_messages():
    return {"data": [], "cursor": {"previous": None, "next": None}}


class ManagedRunner:
    """A fixed-protocol fake that observes the durable state at prompt time."""

    def __init__(self, responses=(), *, journal=None, batch_id=None):
        self.responses = list(responses)
        self.journal = journal
        self.batch_id = batch_id
        self.calls = []
        self.requests = []

    def __call__(self, argv, *, timeout=None, input=None):
        if argv != ["node", str(_managed_helper_path())]:
            raise AssertionError("managed transport invoked a non-helper command")
        request = json.loads(input)
        if request["operation"] == "prompt":
            if self.journal is None or self.batch_id is None:
                raise AssertionError("prompt was invoked without a journal assertion")
            batch = self.journal.read_state_readonly()["batches"][self.batch_id]
            if batch["status"] != "send-intent":
                raise AssertionError("send intent was not durable before helper prompt")
            if batch["last_attempt_proven_unsent"]:
                raise AssertionError("the previous no-POST proof was not reset before retry")
        self.calls.append((list(argv), {"timeout": timeout, "input": input}))
        self.requests.append(request)
        if not self.responses:
            raise AssertionError("managed fake response queue is empty")
        response = self.responses.pop(0)
        if callable(response):
            response = response(request)
        if isinstance(response, BaseException):
            raise response
        if isinstance(response, support.FakeResult):
            return response
        raise AssertionError("managed fake responses must be FakeResult or exceptions")

    @property
    def operations(self):
        return [request["operation"] for request in self.requests]

    @property
    def prompt_count(self):
        return self.operations.count("prompt")


def _cli(*args, runner=None, sleep=None):
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = main([str(arg) for arg in args], runner=runner, sleep=sleep)
    return code, stdout.getvalue(), stderr.getvalue()


class ManagedDeliveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        support.TMP_ROOT.mkdir(parents=True, exist_ok=True)

    def test_managed_admission_is_durable_without_ack_and_repeat_makes_no_call(self):
        with support.TempGitRepo() as repo:
            _common, _root, journal, config, batch_id = _managed_campaign(repo)
            runner = ManagedRunner(
                [
                    _result(_session_projection(), version="2.2.7"),
                    _result(_prompt_projection(batch_id), version="2.3.0"),
                ],
                journal=journal,
                batch_id=batch_id,
            )

            result = deliver_pending(config, journal, runner=runner, sleep=lambda _s: None)

            batch = journal.load()["batches"][batch_id]
            self.assertEqual(result["status"], "admitted")
            self.assertEqual(batch["status"], "admitted")
            self.assertTrue(batch["send_intent_recorded"])
            self.assertFalse(batch["last_attempt_proven_unsent"])
            self.assertEqual(journal.load()["pending_batch"], batch_id)
            self.assertEqual(runner.operations, ["session", "prompt"])
            self.assertEqual(runner.prompt_count, 1)
            self.assertTrue(all(call[0][0] == "node" for call in runner.calls))
            self.assertTrue(all("opencode" not in call[0] for call in runner.calls))
            self.assertEqual(runner.requests[1]["campaign"], CAMPAIGN)
            self.assertEqual(runner.requests[1]["data"]["batch_id"], batch_id)

            repeat_runner = ManagedRunner()
            repeated = deliver_pending(config, journal, runner=repeat_runner)
            self.assertEqual(repeated["status"], "admitted")
            self.assertEqual(repeat_runner.calls, [])

    def test_valid_false_prompt_envelope_holds_without_reconciliation_then_release_retries_safely(self):
        with support.TempGitRepo() as repo:
            _common, root, journal, config, batch_id = _managed_campaign(repo)
            runner = ManagedRunner(
                [
                    _result(_session_projection()),
                    _failure("contract_invalid", False, stderr=CANARY),
                ],
                journal=journal,
                batch_id=batch_id,
            )

            result = deliver_pending(config, journal, runner=runner)

            batch = journal.load()["batches"][batch_id]
            self.assertEqual(result["status"], "held")
            self.assertEqual(runner.operations, ["session", "prompt"])
            self.assertEqual(batch["status"], "held")
            self.assertTrue(batch["send_intent_recorded"])
            self.assertTrue(batch["last_attempt_proven_unsent"])
            state_text = (root / "watcher" / "state.json").read_text(encoding="utf-8")
            self.assertNotIn(CANARY, state_text)
            self.assertNotIn(CANARY, str(result))

            code, _stdout, stderr = _cli(
                "release", "--campaign-dir", root, "--batch-id", batch_id
            )
            self.assertEqual(code, 0, stderr)
            released = journal.load()["batches"][batch_id]
            self.assertEqual(released["status"], "snapshotted")
            self.assertTrue(released["send_intent_recorded"])
            self.assertTrue(released["last_attempt_proven_unsent"])

            retry = ManagedRunner(
                [
                    _result(_session_projection()),
                    _result(_prompt_projection(batch_id)),
                ],
                journal=journal,
                batch_id=batch_id,
            )
            code, stdout, stderr = _cli(
                "once",
                "--campaign-dir",
                root,
                "--apply",
                "--deliver-notices",
                "--json",
                runner=retry,
                sleep=lambda _s: None,
            )
            self.assertEqual(code, 0, stderr)
            self.assertIn('"status": "admitted"', stdout)
            self.assertEqual(retry.operations, ["session", "prompt"])
            self.assertEqual(retry.prompt_count, 1)
            self.assertEqual(journal.load()["batches"][batch_id]["status"], "admitted")

    def test_helper_disappearing_after_session_preflight_is_proven_unsent(self):
        with support.TempGitRepo() as repo:
            _common, _root, journal, config, batch_id = _managed_campaign(repo)
            runner = ManagedRunner(
                [_result(_session_projection())],
                journal=journal,
                batch_id=batch_id,
            )
            with patch(
                "overseer_relay.transport._verify_managed_helper",
                side_effect=[
                    _managed_helper_path(),
                    TransportError("Managed helper is unavailable", code="helper_missing"),
                ],
            ):
                result = deliver_pending(config, journal, runner=runner)

            batch = journal.load()["batches"][batch_id]
            self.assertEqual(result["status"], "held")
            self.assertEqual(runner.operations, ["session"])
            self.assertTrue(batch["send_intent_recorded"])
            self.assertTrue(batch["last_attempt_proven_unsent"])

    def test_preflight_identity_or_contract_failure_holds_without_retry_or_prompt(self):
        for code in ("identity_mismatch", "contract_invalid"):
            with self.subTest(code=code), support.TempGitRepo() as repo:
                _common, _root, journal, config, batch_id = _managed_campaign(repo)
                runner = ManagedRunner([_failure(code, False)])
                sleeps = []

                result = deliver_pending(config, journal, runner=runner, sleep=sleeps.append)

                batch = journal.load()["batches"][batch_id]
                self.assertEqual(result["status"], "held")
                self.assertEqual(runner.operations, ["session"])
                self.assertEqual(sleeps, [])
                self.assertFalse(batch["send_intent_recorded"])
                self.assertFalse(batch["last_attempt_proven_unsent"])
                self.assertEqual(batch["status"], "held")

    def test_ambiguous_prompt_failures_never_become_no_post_proof_or_trigger_resend(self):
        malformed_projection = _result({"data": {"unexpected": "projection"}})
        malformed_json = support.FakeResult(
            stdout=CANARY,
            stderr=CANARY,
        )
        unknown_enum = support.FakeResult(
            returncode=1,
            stdout=json.dumps({"ok": False, "code": "unknown_helper_state", "post_started": False}),
            stderr=CANARY,
        )
        wrong_returncode = support.FakeResult(
            returncode=0,
            stdout=json.dumps({"ok": False, "code": "contract_invalid", "post_started": False}),
        )
        cases = (
            ("timeout", TimeoutError(CANARY)),
            ("crash", RuntimeError(f"post_started=false {CANARY}")),
            ("non-json", malformed_json),
            ("bad-projection", malformed_projection),
            ("unknown-enum", unknown_enum),
            ("wrong-returncode", wrong_returncode),
        )
        for label, prompt_outcome in cases:
            with self.subTest(case=label), support.TempGitRepo() as repo:
                _common, root, journal, config, batch_id = _managed_campaign(repo)
                runner = ManagedRunner(
                    [
                        _result(_session_projection()),
                        prompt_outcome,
                        _result(_empty_inbox()),
                        _result(_empty_messages()),
                    ],
                    journal=journal,
                    batch_id=batch_id,
                )

                result = deliver_pending(config, journal, runner=runner)

                batch = journal.load()["batches"][batch_id]
                self.assertEqual(result["status"], "uncertain")
                self.assertEqual(runner.operations, ["session", "prompt", "inbox", "messages"])
                self.assertEqual(runner.prompt_count, 1)
                self.assertEqual(batch["status"], "uncertain")
                self.assertTrue(batch["send_intent_recorded"])
                self.assertFalse(batch["last_attempt_proven_unsent"])
                self.assertNotIn(CANARY, (root / "watcher" / "state.json").read_text())
                self.assertNotIn(CANARY, str(result))
                self.assertTrue(all(call[0] == ["node", str(_managed_helper_path())] for call in runner.calls))

    def test_true_prompt_failure_reconciles_exact_metadata_and_deduplicates_shared_id(self):
        with support.TempGitRepo() as repo:
            _common, _root, journal, config, batch_id = _managed_campaign(repo)
            runner = ManagedRunner(
                [
                    _result(_session_projection()),
                    _failure("post_failed", True),
                    _result(_inbox(batch_id)),
                    _result(_messages(batch_id)),
                ],
                journal=journal,
                batch_id=batch_id,
            )

            result = deliver_pending(config, journal, runner=runner)

            batch = journal.load()["batches"][batch_id]
            self.assertEqual(result["status"], "admitted")
            self.assertEqual(runner.operations, ["session", "prompt", "inbox", "messages"])
            self.assertEqual(runner.prompt_count, 1)
            self.assertEqual(batch["status"], "admitted")
            self.assertFalse(batch["last_attempt_proven_unsent"])
            self.assertEqual(batch["receipt"]["metadata"], {
                "overseerRelay": {"campaign": CAMPAIGN, "batchId": batch_id}
            })
            self.assertTrue(batch["receipt"]["reconciled"])

    def test_wrong_batch_campaign_contradiction_and_partial_history_stay_uncertain(self):
        cases = ("wrong-campaign", "wrong-batch", "contradiction", "partial-pagination")
        for case in cases:
            with self.subTest(case=case), support.TempGitRepo() as repo:
                _common, _root, journal, config, batch_id = _managed_campaign(repo)
                wrong_batch = "b-" + "f" * 64
                if case == "wrong-campaign":
                    responses = [
                        _result(_session_projection()),
                        _failure("post_failed", True),
                        _result(_inbox(batch_id, campaign="other-campaign")),
                        _result(_empty_messages()),
                    ]
                elif case == "wrong-batch":
                    responses = [
                        _result(_session_projection()),
                        _failure("post_failed", True),
                        _result(_inbox(wrong_batch)),
                        _result(_empty_messages()),
                    ]
                elif case == "contradiction":
                    responses = [
                        _result(_session_projection()),
                        _failure("post_failed", True),
                        _result(_inbox(batch_id, message_id="msg_shared")),
                        _result(_messages(batch_id, message_id="msg_shared", campaign="other-campaign")),
                    ]
                else:
                    first_page = _messages(batch_id, next_cursor="next-page")
                    responses = [
                        _result(_session_projection()),
                        _failure("post_failed", True),
                        _result(_inbox(batch_id)),
                        _result(first_page),
                        TimeoutError(CANARY),
                    ]
                runner = ManagedRunner(responses, journal=journal, batch_id=batch_id)

                result = deliver_pending(config, journal, runner=runner)

                batch = journal.load()["batches"][batch_id]
                self.assertEqual(result["status"], "uncertain")
                self.assertEqual(batch["status"], "uncertain")
                self.assertTrue(batch["send_intent_recorded"])
                self.assertFalse(batch["last_attempt_proven_unsent"])
                self.assertEqual(runner.prompt_count, 1)
                self.assertNotIn(CANARY, str(result))

    def test_restart_send_intent_and_cli_release_of_uncertain_only_reconcile(self):
        with support.TempGitRepo() as repo:
            common, root, journal, config, batch_id = _managed_campaign(repo)
            journal.set_delivery_state(batch_id, "send-intent")
            restarted = Journal(common, CAMPAIGN)
            restart_runner = ManagedRunner(
                [
                    _result(_session_projection()),
                    _result(_empty_inbox()),
                    _result(_empty_messages()),
                ],
                journal=restarted,
                batch_id=batch_id,
            )

            restarted_result = deliver_pending(config, restarted, runner=restart_runner)

            self.assertEqual(restarted_result["status"], "uncertain")
            self.assertEqual(restart_runner.operations, ["session", "inbox", "messages"])
            self.assertEqual(restart_runner.prompt_count, 0)
            self.assertTrue(restarted.load()["batches"][batch_id]["send_intent_recorded"])

            code, _stdout, stderr = _cli(
                "release", "--campaign-dir", root, "--batch-id", batch_id
            )
            self.assertEqual(code, 0, stderr)
            released = journal.read_state_readonly()["batches"][batch_id]
            self.assertEqual(released["status"], "uncertain")
            self.assertTrue(released["send_intent_recorded"])

            cli_runner = ManagedRunner(
                [
                    _result(_session_projection()),
                    _result(_empty_inbox()),
                    _result(_empty_messages()),
                ],
                journal=journal,
                batch_id=batch_id,
            )
            code, _stdout, stderr = _cli(
                "once",
                "--campaign-dir",
                root,
                "--apply",
                "--deliver-notices",
                "--json",
                runner=cli_runner,
            )
            self.assertEqual(code, 0, stderr)
            self.assertEqual(cli_runner.operations, ["session", "inbox", "messages"])
            self.assertEqual(cli_runner.prompt_count, 0)
            self.assertEqual(journal.read_state_readonly()["batches"][batch_id]["status"], "uncertain")

    def test_success_receipt_wrong_metadata_is_not_admitted(self):
        with support.TempGitRepo() as repo:
            _common, _root, journal, config, batch_id = _managed_campaign(repo)
            wrong_batch = "b-" + "e" * 64
            runner = ManagedRunner(
                [
                    _result(_session_projection()),
                    _result(_prompt_projection(wrong_batch)),
                    _result(_empty_inbox()),
                    _result(_empty_messages()),
                ],
                journal=journal,
                batch_id=batch_id,
            )

            result = deliver_pending(config, journal, runner=runner)

            batch = journal.load()["batches"][batch_id]
            self.assertEqual(result["status"], "uncertain")
            self.assertEqual(runner.operations, ["session", "prompt", "inbox", "messages"])
            self.assertEqual(runner.prompt_count, 1)
            self.assertEqual(batch["status"], "uncertain")
            self.assertFalse(batch["last_attempt_proven_unsent"])


if __name__ == "__main__":
    unittest.main()
