#!/usr/bin/env python3
"""Offline tests for queued Overseer prompt delivery and reconciliation."""

from tests import support

import contextlib
import copy
import io
import json
from pathlib import Path
import unittest

from overseer_relay.cli import main
from overseer_relay.config import LIMIT_BOUNDS, load_config
from overseer_relay.journal import Journal, atomic_write_json
from overseer_relay.mailbox import FRAME_SCHEMA, format_frame
from overseer_relay.paths import campaign_dir, resolve_common_dir
from overseer_relay.transport import (
    MAX_API_ARGUMENT_BYTES,
    MAX_API_INPUT_BYTES,
    MAX_RECONCILIATION_MESSAGE_PAGES,
    deliver_pending,
)
from overseer_relay.watcher import Watcher


FIXTURES = Path(__file__).parent / "fixtures" / "transport"
SESSION_INFO = json.loads((FIXTURES / "session-info.json").read_text(encoding="utf-8"))
PROMPT_RECEIPT = json.loads((FIXTURES / "prompt-admission.json").read_text(encoding="utf-8"))
INBOX_ITEM = json.loads((FIXTURES / "inbox-pending.json").read_text(encoding="utf-8"))
MESSAGE_PAGE = json.loads((FIXTURES / "messages-page.json").read_text(encoding="utf-8"))
CAMPAIGN = "transport-delivery-test"
SESSION_ID = "ses_overseer123"
SERVER = "http://127.0.0.1:4096"
SAMPLE_BATCH = "b-" + "0" * 64
RAW_REPORT_TEXT = "raw report text must not enter the queued prompt"


def _retarget_metadata(value, batch_id, *, campaign=CAMPAIGN):
    result = copy.deepcopy(value)
    metadata = None
    if "data" in result and isinstance(result["data"], list):
        items = result["data"]
        for item in items:
            metadata = (
                item.get("payload", {}).get("metadata")
                if "payload" in item
                else item.get("metadata")
            )
            if isinstance(metadata, dict):
                metadata["overseerRelay"] = {"campaign": campaign, "batchId": batch_id}
    elif isinstance(result.get("data"), dict):
        metadata = result["data"].get("payload", {}).get("metadata")
        if isinstance(metadata, dict):
            metadata["overseerRelay"] = {"campaign": campaign, "batchId": batch_id}
    return result


def _session_result():
    return support.FakeResult(stdout=json.dumps(copy.deepcopy(SESSION_INFO)))


def _post_body(call):
    argv = call[0]
    data_index = argv.index("--data")
    return json.loads(argv[data_index + 1])


def _api_result(value):
    return support.FakeResult(stdout=json.dumps(value))


def _empty_inbox():
    return {"data": []}


def _empty_message_page(*, next_cursor=None):
    return {"data": [], "cursor": {"previous": None, "next": next_cursor}}


class ScriptedRunner:
    """Handwritten fake which can synthesize a receipt from the exact request."""

    def __init__(self, responses=(), *, journal=None, batch_id=None):
        self.responses = list(responses)
        self.calls = []
        self.journal = journal
        self.batch_id = batch_id

    def __call__(self, argv, *, timeout=None, input=None):
        call = (list(argv), {"timeout": timeout, "input": input})
        self.calls.append(call)
        if not self.responses:
            raise AssertionError("fake runner response queue is empty")
        response = self.responses.pop(0)
        if callable(response):
            response = response(argv, call[1])
        if isinstance(response, BaseException):
            raise response
        if isinstance(response, support.FakeResult):
            return response
        return _api_result(response)

    def successful_receipt(self, argv, options):
        self.assert_post_was_journaled()
        request = _post_body((argv, options))
        receipt = copy.deepcopy(PROMPT_RECEIPT)
        data = receipt["data"]
        data["payload"]["text"] = request["text"]
        data["sessionID"] = SESSION_ID
        data["payload"]["metadata"] = copy.deepcopy(request["metadata"])
        data["id"] = "msg_admitted_1"
        return _api_result(receipt)

    def assert_post_was_journaled(self):
        if self.journal is not None and self.batch_id is not None:
            self_value = self.journal.load()["batches"][self.batch_id]["status"]
            if self_value != "send-intent":
                raise AssertionError("send intent was not durable before POST")


def _init_campaign(repo):
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
    config_data["roles"]["overseer"].update(
        session_id=SESSION_ID,
        directory="/workspace/repo",
        agent="build",
    )
    config_data["roles"]["A"]["directory"] = str(repo.root)
    config_data["connection"] = ["--server", SERVER]
    config_data["capabilities"].update(
        overseer_notices=True,
        owner_approved_notices=True,
    )
    atomic_write_json(root / "config.json", config_data)
    journal = Journal(common_dir, CAMPAIGN)
    return common_dir, root, journal, load_config(root / "config.json")


def _report_frame():
    return format_frame(
        {
            "schema": FRAME_SCHEMA,
            "campaign": CAMPAIGN,
            "role": "A",
            "generation": 1,
            "report_id": "report_delivery_1",
            "kind": "progress",
            "phase": "implementation",
            "task": "6.2",
            "summary": RAW_REPORT_TEXT,
            "recommendation": None,
            "evidence_paths": ["README.md"],
            "head": None,
            "blocker": None,
            "goal_state": "unknown",
            "batch_id": None,
        }
    )


def _first_pending(root, journal):
    with (root / "inbox" / "A.md").open("ab") as stream:
        stream.write(_report_frame())
    watcher = Watcher(load_config(root / "config.json"), journal)
    watcher.process_once()
    result = watcher.process_once()
    if result["batch_status"] != "snapshotted":
        raise AssertionError(f"test report did not settle: {result}")
    return result["batch_id"]


def _matching_inbox(batch_id, *, message_id="msg_fixture_1"):
    response = _retarget_metadata(INBOX_ITEM, batch_id)
    response["data"][0]["id"] = message_id
    return response


def _matching_message_page(batch_id, *, message_id="msg_fixture_1"):
    response = _retarget_metadata(MESSAGE_PAGE, batch_id)
    response["data"][0]["id"] = message_id
    return response


def _message_record(batch_id, message_id):
    page = _matching_message_page(batch_id, message_id=message_id)
    return page["data"][0]


def _api_paths(runner):
    return [call[0][call[0].index("api") + 2] for call in runner.calls]


def _post_calls(runner):
    return [call for call in runner.calls if call[0][call[0].index("api") + 1] == "post"]


class TransportDeliveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        support.TMP_ROOT.mkdir(parents=True, exist_ok=True)

    def test_exact_queued_prompt_request_and_receipt_admits_without_acknowledging(self):
        with support.TempGitRepo() as repo:
            _common, root, journal, config = _init_campaign(repo)
            batch_id = _first_pending(root, journal)
            runner = ScriptedRunner(
                [_session_result(), lambda argv, options: None],
                journal=journal,
                batch_id=batch_id,
            )
            runner.responses[1] = runner.successful_receipt

            result = deliver_pending(config, journal, runner=runner, sleep=lambda _seconds: None)

            self.assertEqual(result["status"], "admitted")
            self.assertEqual(result["batch_status"], "admitted")
            self.assertEqual(journal.load()["pending_batch"], batch_id)
            self.assertEqual(_api_paths(runner)[-1], f"/api/session/{SESSION_ID}/prompt")
            post = _post_calls(runner)
            self.assertEqual(len(post), 1)
            self.assertEqual(
                post[0][0][:6],
                ["opencode", "--server", SERVER, "api", "post", f"/api/session/{SESSION_ID}/prompt"],
            )
            self.assertEqual(post[0][0][6], "--data")
            self.assertIsNone(post[0][1]["input"])
            self.assertNotIn("--data", runner.calls[0][0])
            self.assertIsNone(runner.calls[0][1]["input"])
            self.assertEqual(post[0][1]["timeout"], config.limits.api_timeout_seconds)
            body = _post_body(post[0])
            encoded_body = post[0][0][7].encode("utf-8")
            self.assertLessEqual(len(encoded_body), MAX_API_INPUT_BYTES)
            self.assertLessEqual(
                sum(len(argument.encode("utf-8")) for argument in post[0][0]),
                MAX_API_ARGUMENT_BYTES,
            )
            self.assertEqual(
                set(body), {"text", "delivery", "resume", "metadata"}
            )
            self.assertNotIn("id", body)
            self.assertEqual(body["delivery"], "queue")
            self.assertIs(body["resume"], True)
            self.assertEqual(
                body["metadata"],
                {"overseerRelay": {"campaign": CAMPAIGN, "batchId": batch_id}},
            )
            self.assertIn(batch_id, body["text"])
            self.assertIn("inbox/A.md bytes [0,", body["text"])
            self.assertIn("sha256=", body["text"])
            self.assertIn(f"watcher/batches/{batch_id}/overseer-ack.md", body["text"])
            self.assertIn("overseer-coordinate", body["text"])
            self.assertIn("owner-visible summary", body["text"])
            self.assertIn("README.md", body["text"])
            self.assertNotIn(RAW_REPORT_TEXT, body["text"])

            receipt = journal.load()["batches"][batch_id]["receipt"]
            self.assertEqual(receipt["id"], "msg_admitted_1")
            self.assertEqual(receipt["delivery"], "queue")
            self.assertEqual(receipt["metadata"], body["metadata"])
            self.assertNotIn("text", receipt)
            self.assertNotIn(RAW_REPORT_TEXT, json.dumps(receipt))

            # Admission is not an acknowledgement and never causes a second call.
            no_call_runner = ScriptedRunner()
            unchanged = deliver_pending(config, journal, runner=no_call_runner)
            self.assertEqual(unchanged["status"], "admitted")
            self.assertEqual(no_call_runner.calls, [])

    def test_bounded_notice_and_pinned_server_fit_the_argument_budget(self):
        maximum_notice_bytes = LIMIT_BOUNDS["max_notice_bytes"][1]
        # The JSON body may escape each notice byte, while the pinned server
        # permits up to 2048 Unicode characters (four UTF-8 bytes each).
        minimum_budget = 2 * maximum_notice_bytes + 4 * 2048 + 512
        self.assertGreaterEqual(MAX_API_ARGUMENT_BYTES, minimum_budget)

    def test_preflight_backoff_is_bounded_and_post_occurs_once_after_success(self):
        with support.TempGitRepo() as repo:
            _common, root, journal, config = _init_campaign(repo)
            batch_id = _first_pending(root, journal)
            runner = ScriptedRunner(
                [TimeoutError("safe timeout"), _session_result(), None],
                journal=journal,
                batch_id=batch_id,
            )
            runner.responses[2] = runner.successful_receipt
            sleeps = []

            result = deliver_pending(config, journal, runner=runner, sleep=sleeps.append)

            self.assertEqual(result["status"], "admitted")
            self.assertEqual(sleeps, [1])
            self.assertEqual(len(_post_calls(runner)), 1)
            self.assertEqual(_api_paths(runner)[:2], [
                f"/api/session/{SESSION_ID}", f"/api/session/{SESSION_ID}"
            ])

    def test_idle_and_busy_sessions_receive_the_same_non_interrupting_queue_request(self):
        for busy in (False, True):
            with self.subTest(busy=busy), support.TempGitRepo() as repo:
                _common, root, journal, config = _init_campaign(repo)
                batch_id = _first_pending(root, journal)
                session = copy.deepcopy(SESSION_INFO)
                session["data"]["busy"] = busy
                runner = ScriptedRunner(
                    [
                        support.FakeResult(stdout=json.dumps(session)),
                        None,
                    ],
                    journal=journal,
                    batch_id=batch_id,
                )
                runner.responses[1] = runner.successful_receipt

                result = deliver_pending(config, journal, runner=runner)

                self.assertEqual(result["status"], "admitted")
                body = _post_body(_post_calls(runner)[0])
                self.assertEqual(body["delivery"], "queue")
                self.assertIs(body["resume"], True)
                self.assertEqual(len(_post_calls(runner)), 1)

    def test_nonzero_post_and_invalid_receipt_require_reconciliation(self):
        cases = ("nonzero-no-proof", "invalid-receipt-with-proof")
        for case in cases:
            with self.subTest(case=case), support.TempGitRepo() as repo:
                _common, root, journal, config = _init_campaign(repo)
                batch_id = _first_pending(root, journal)
                if case == "nonzero-no-proof":
                    post_result = support.FakeResult(
                        returncode=1,
                        stdout="not a receipt",
                        stderr="Bearer never-save-this",
                    )
                    responses = [
                        _session_result(),
                        post_result,
                        _empty_inbox(),
                        _empty_message_page(),
                    ]
                else:
                    def wrong_session_receipt(_argv, options):
                        request = _post_body((_argv, options))
                        receipt = copy.deepcopy(PROMPT_RECEIPT)
                        receipt["data"]["payload"]["text"] = request["text"]
                        receipt["data"]["payload"]["metadata"] = request["metadata"]
                        receipt["data"]["sessionID"] = "ses_other_session"
                        return _api_result(receipt)

                    responses = [
                        _session_result(),
                        wrong_session_receipt,
                        _empty_inbox(),
                        _matching_message_page(batch_id, message_id="msg_reconciled_after_invalid"),
                    ]
                runner = ScriptedRunner(responses)

                result = deliver_pending(config, journal, runner=runner)

                expected_status = "uncertain" if case == "nonzero-no-proof" else "admitted"
                self.assertEqual(result["status"], expected_status)
                self.assertEqual(len(_post_calls(runner)), 1)
                state_bytes = (root / "watcher" / "state.json").read_bytes()
                self.assertNotIn(b"never-save-this", state_bytes)

    def test_preflight_retry_exhaustion_holds_once_without_post(self):
        with support.TempGitRepo() as repo:
            _common, root, journal, config = _init_campaign(repo)
            batch_id = _first_pending(root, journal)
            runner = ScriptedRunner(
                [TimeoutError("Bearer never-store-this") for _ in range(4)]
            )
            sleeps = []

            result = deliver_pending(config, journal, runner=runner, sleep=sleeps.append)

            self.assertEqual(result["status"], "held")
            self.assertTrue(result["newly_surfaced_hold"])
            self.assertEqual(sleeps, [1, 2, 4])
            self.assertEqual(len(runner.calls), 4)
            self.assertEqual(_post_calls(runner), [])
            self.assertEqual(journal.load()["batches"][batch_id]["status"], "held")
            self.assertNotIn("never-store-this", (root / "watcher" / "state.json").read_text())

            repeated = deliver_pending(config, journal, runner=ScriptedRunner())
            self.assertEqual(repeated["status"], "held")
            self.assertFalse(repeated["newly_surfaced_hold"])

    def test_timeout_reconciliation_deduplicates_inbox_and_message_by_stable_id(self):
        with support.TempGitRepo() as repo:
            _common, root, journal, config = _init_campaign(repo)
            batch_id = _first_pending(root, journal)
            runner = ScriptedRunner(
                [
                    _session_result(),
                    TimeoutError("Bearer response text must not be persisted"),
                    _matching_inbox(batch_id),
                    _matching_message_page(batch_id),
                ]
            )

            result = deliver_pending(config, journal, runner=runner, sleep=lambda _seconds: None)

            self.assertEqual(result["status"], "admitted")
            self.assertEqual(journal.load()["batches"][batch_id]["status"], "admitted")
            self.assertEqual(len(_post_calls(runner)), 1)
            self.assertEqual(
                _api_paths(runner)[2:],
                [
                    f"/api/session/{SESSION_ID}/inbox",
                    f"/api/session/{SESSION_ID}/message?type=user&limit=100&order=desc",
                ],
            )
            for argv, options in runner.calls:
                if argv[argv.index("api") + 1] == "get":
                    self.assertNotIn("--data", argv)
                    self.assertIsNone(options["input"])
            receipt = journal.load()["batches"][batch_id]["receipt"]
            self.assertEqual(receipt["id"], "msg_fixture_1")
            self.assertTrue(receipt["reconciled"])
            self.assertNotIn("text", receipt)
            state_text = (root / "watcher" / "state.json").read_text(encoding="utf-8")
            self.assertNotIn("response text must not be persisted", state_text)

    def test_timeout_without_admission_proof_is_held_uncertain_and_never_resent(self):
        with support.TempGitRepo() as repo:
            common, root, journal, config = _init_campaign(repo)
            batch_id = _first_pending(root, journal)
            first_runner = ScriptedRunner(
                [
                    _session_result(),
                    TimeoutError("ambiguous POST"),
                    _empty_inbox(),
                    _empty_message_page(),
                ]
            )

            first = deliver_pending(config, journal, runner=first_runner)

            self.assertEqual(first["status"], "uncertain")
            self.assertTrue(first["newly_surfaced_hold"])
            self.assertEqual(journal.load()["batches"][batch_id]["status"], "uncertain")
            self.assertEqual(len(_post_calls(first_runner)), 1)
            self.assertEqual(journal.load()["batches"][batch_id]["hold"]["notice_emitted"], True)

            restarted_journal = Journal(common, CAMPAIGN)
            restart_runner = ScriptedRunner(
                [_session_result(), _empty_inbox(), _empty_message_page()]
            )
            restarted = deliver_pending(config, restarted_journal, runner=restart_runner)

            self.assertEqual(restarted["status"], "uncertain")
            self.assertFalse(restarted["newly_surfaced_hold"])
            self.assertEqual(len(restart_runner.calls), 3)
            self.assertEqual(_post_calls(restart_runner), [])
            self.assertEqual(restarted_journal.load()["pending_batch"], batch_id)

    def test_multiple_matching_ids_and_conflicting_duplicate_metadata_are_uncertain(self):
        cases = ("two-matches", "conflicting-metadata")
        for case in cases:
            with self.subTest(case=case), support.TempGitRepo() as repo:
                _common, root, journal, config = _init_campaign(repo)
                batch_id = _first_pending(root, journal)
                if case == "two-matches":
                    page = _matching_message_page(batch_id)
                    page["data"].append(_message_record(batch_id, "msg_fixture_2"))
                    responses = [_session_result(), TimeoutError(), _empty_inbox(), page]
                else:
                    inbox = _matching_inbox(batch_id, message_id="msg_shared_1")
                    page = _matching_message_page(batch_id, message_id="msg_shared_1")
                    page["data"][0]["metadata"]["overseerRelay"]["campaign"] = "other-campaign"
                    responses = [_session_result(), TimeoutError(), inbox, page]
                runner = ScriptedRunner(responses)

                result = deliver_pending(config, journal, runner=runner)

                self.assertEqual(result["status"], "uncertain")
                self.assertEqual(journal.load()["batches"][batch_id]["status"], "uncertain")
                self.assertEqual(len(_post_calls(runner)), 1)

    def test_incomplete_pagination_overrides_an_earlier_matching_message(self):
        with support.TempGitRepo() as repo:
            _common, root, journal, config = _init_campaign(repo)
            batch_id = _first_pending(root, journal)
            first_page = _matching_message_page(batch_id, message_id="msg_first_page")
            first_page["cursor"]["next"] = "page-two"
            runner = ScriptedRunner(
                [
                    _session_result(),
                    TimeoutError(),
                    _matching_inbox(batch_id, message_id="msg_first_page"),
                    first_page,
                    TimeoutError("next page unavailable"),
                ]
            )

            result = deliver_pending(config, journal, runner=runner)

            self.assertEqual(result["status"], "uncertain")
            self.assertEqual(len(_post_calls(runner)), 1)
            self.assertEqual(_api_paths(runner)[-1], f"/api/session/{SESSION_ID}/message?type=user&limit=100&cursor=page-two")

    def test_following_message_cursor_keeps_type_filter_and_drops_descending_order(self):
        with support.TempGitRepo() as repo:
            _common, root, journal, config = _init_campaign(repo)
            batch_id = _first_pending(root, journal)
            first_page = _empty_message_page(next_cursor="opaque/next")
            second_page = _matching_message_page(batch_id, message_id="msg_second_page")
            runner = ScriptedRunner(
                [
                    _session_result(),
                    TimeoutError(),
                    _empty_inbox(),
                    first_page,
                    second_page,
                ]
            )

            result = deliver_pending(config, journal, runner=runner)

            self.assertEqual(result["status"], "admitted")
            self.assertEqual(
                _api_paths(runner)[-2:],
                [
                    f"/api/session/{SESSION_ID}/message?type=user&limit=100&order=desc",
                    f"/api/session/{SESSION_ID}/message?type=user&limit=100&cursor=opaque%2Fnext",
                ],
            )

    def test_repeated_and_oversized_cursors_fail_closed(self):
        for cursor_mode in ("repeated", "oversized"):
            with self.subTest(cursor_mode=cursor_mode), support.TempGitRepo() as repo:
                _common, root, journal, config = _init_campaign(repo)
                batch_id = _first_pending(root, journal)
                first_page = _matching_message_page(batch_id)
                if cursor_mode == "repeated":
                    first_page["cursor"]["next"] = "repeat-me"
                    second_page = _empty_message_page(next_cursor="repeat-me")
                    responses = [
                        _session_result(), TimeoutError(), _empty_inbox(), first_page, second_page
                    ]
                else:
                    first_page["cursor"]["next"] = "x" * 513
                    responses = [_session_result(), TimeoutError(), _empty_inbox(), first_page]
                runner = ScriptedRunner(responses)

                result = deliver_pending(config, journal, runner=runner)

                self.assertEqual(result["status"], "uncertain")
                self.assertEqual(len(_post_calls(runner)), 1)

    def test_fixed_page_count_is_enforced_even_when_each_page_has_a_match(self):
        with support.TempGitRepo() as repo:
            _common, root, journal, config = _init_campaign(repo)
            batch_id = _first_pending(root, journal)
            pages = []
            for index in range(MAX_RECONCILIATION_MESSAGE_PAGES):
                page = _matching_message_page(batch_id, message_id=f"msg_page_{index}")
                page["cursor"]["next"] = f"cursor-{index + 1}"
                pages.append(page)
            runner = ScriptedRunner(
                [_session_result(), TimeoutError(), _empty_inbox(), *pages]
            )

            result = deliver_pending(config, journal, runner=runner)

            self.assertEqual(result["status"], "uncertain")
            self.assertEqual(len(_post_calls(runner)), 1)
            self.assertEqual(len(runner.calls), 2 + 1 + MAX_RECONCILIATION_MESSAGE_PAGES)

    def test_saved_config_is_revalidated_immediately_before_the_post(self):
        with support.TempGitRepo() as repo:
            _common, root, journal, config = _init_campaign(repo)
            batch_id = _first_pending(root, journal)
            changed = json.loads((root / "config.json").read_text(encoding="utf-8"))
            changed["capabilities"]["overseer_notices"] = False

            def preflight_then_revoke(_argv, _options):
                atomic_write_json(root / "config.json", changed)
                return _session_result()

            runner = ScriptedRunner([preflight_then_revoke])

            result = deliver_pending(config, journal, runner=runner)

            self.assertEqual(result["status"], "held")
            self.assertTrue(result["newly_surfaced_hold"])
            self.assertEqual(len(runner.calls), 1)
            self.assertEqual(_post_calls(runner), [])
            self.assertEqual(journal.load()["batches"][batch_id]["status"], "held")
            self.assertIsNotNone(journal.load()["hold"])

    def test_active_hold_on_unrelated_source_does_not_block_valid_a_batch(self):
        with support.TempGitRepo() as repo:
            _common, root, journal, config = _init_campaign(repo)
            batch_id = _first_pending(root, journal)
            transition = journal.set_hold("unrelated B source review", source="B")
            if transition["should_notify"]:
                journal.mark_hold_notice(source="B")
            runner = ScriptedRunner(
                [_session_result(), None], journal=journal, batch_id=batch_id
            )
            runner.responses[1] = runner.successful_receipt

            result = deliver_pending(config, journal, runner=runner)

            self.assertEqual(result["status"], "admitted")
            self.assertEqual(len(_post_calls(runner)), 1)

    def test_no_pending_batch_performs_no_api_operation(self):
        with support.TempGitRepo() as repo:
            _common, _root, journal, config = _init_campaign(repo)
            runner = ScriptedRunner()

            result = deliver_pending(config, journal, runner=runner)

            self.assertEqual(result["status"], "idle")
            self.assertEqual(runner.calls, [])


if __name__ == "__main__":
    unittest.main()
