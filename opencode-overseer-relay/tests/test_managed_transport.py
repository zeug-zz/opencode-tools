#!/usr/bin/env python3
"""Offline tests for the schema-v2 managed helper transport boundary."""

from tests import support

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from overseer_relay.config import default_config, parse_config, to_json_dict
from overseer_relay.journal import atomic_write_json
from overseer_relay.transport import (
    MAX_API_STDOUT_BYTES,
    TransportError,
    _api_request,
    _managed_helper_path,
    _message_record,
    _validated_post_receipt,
    deliver_pending,
    preflight_session,
)


SESSION_ID = "ses_overseer123"
DIRECTORY = "/workspace/repo"
AGENT = "build"
CAMPAIGN = "managed-test"
BATCH_ID = "b-" + "1" * 64
URL = "http://127.0.0.1:17777"
PID = 12345
PROMPT = "bounded managed notice\n"
CANARY = "Bearer never-print-this-managed-canary"


def _managed_config(*, expected_pid=PID):
    source = default_config(CAMPAIGN, "/repo/.git", "main")
    source["schema_version"] = 2
    source["connection"] = {
        "mode": "managed-local",
        "expected_url": URL,
    }
    if expected_pid is not None:
        source["connection"]["expected_pid"] = expected_pid
    source["roles"]["overseer"].update(
        session_id=SESSION_ID,
        directory=DIRECTORY,
        agent=AGENT,
    )
    source["capabilities"].update(
        overseer_notices=True,
        owner_approved_notices=True,
    )
    return parse_config(source)


def _session_projection():
    return {
        "data": {
            "id": SESSION_ID,
            "agent": AGENT,
            "location": {"directory": DIRECTORY},
            "time": {"created": 1762550000000, "updated": 1762550001000},
        }
    }


def _managed_result(data, *, version="2.2.7"):
    return support.FakeResult(
        stdout=json.dumps({"ok": True, "data": data, "host_version": version})
    )


def _protocol_input(runner):
    return json.loads(runner.calls[-1][1]["input"])


class ManagedTransportTests(unittest.TestCase):
    def setUp(self):
        self.config = _managed_config()

    def test_preflight_uses_fixed_helper_stdin_protocol_and_accepts_compatible_version(self):
        source = to_json_dict(self.config)
        source["limits"]["api_timeout_seconds"] = 120
        config = parse_config(source)
        runner = support.FakeRunner([_managed_result(_session_projection(), version="2.2.7")])

        identity = preflight_session(config, runner=runner)

        self.assertEqual((identity.session_id, identity.agent, identity.directory), (SESSION_ID, AGENT, DIRECTORY))
        argv, options = runner.calls[0]
        self.assertEqual(argv, ["node", str(_managed_helper_path())])
        self.assertNotIn(URL, argv)
        self.assertFalse(any(argument == "opencode" or argument == "api" for argument in argv))
        self.assertEqual(options["timeout"], 30)
        request = json.loads(options["input"])
        self.assertEqual(
            request,
            {
                "schema_version": 1,
                "operation": "session",
                "connection": {"mode": "managed-local", "expected_url": URL, "expected_pid": PID},
                "binding": {"session_id": SESSION_ID, "directory": DIRECTORY, "agent": AGENT},
                "campaign": CAMPAIGN,
                "timeout_ms": 30000,
            },
        )
        self.assertNotIn("password", options["input"])
        self.assertNotIn("authorization", options["input"])

    def test_url_only_managed_connection_omits_pid_from_helper_input(self):
        config = _managed_config(expected_pid=None)
        runner = support.FakeRunner([_managed_result(_session_projection())])

        preflight_session(config, runner=runner)

        request = _protocol_input(runner)
        self.assertEqual(
            request["connection"],
            {"mode": "managed-local", "expected_url": URL},
        )
        self.assertNotIn("expected_pid", request["connection"])

    def test_each_fixed_route_maps_to_its_helper_operation_and_prompt_receipt_is_rechecked(self):
        inbox = {
            "data": [{
                "id": "msg_inbox1",
                "sessionID": SESSION_ID,
                "type": "user",
                "time": {"created": 1762550002000},
                "delivery": "queue",
                "payload": {"text": "", "metadata": {"overseerRelay": {"campaign": CAMPAIGN, "batchId": BATCH_ID}}},
            }]
        }
        runner = support.FakeRunner([_managed_result(inbox)])
        response = _api_request(self.config, runner, "get", f"/api/session/{SESSION_ID}/inbox")
        self.assertEqual(_protocol_input(runner)["operation"], "inbox")
        self.assertEqual(_message_record(response["data"][0], source="inbox", session_id=SESSION_ID)["created"], 1762550002000)

        messages = {"data": [], "cursor": {"previous": None, "next": None}}
        runner = support.FakeRunner([_managed_result(messages)])
        _api_request(
            self.config,
            runner,
            "get",
            f"/api/session/{SESSION_ID}/message?type=user&limit=100&cursor=opaque%2Fnext",
        )
        request = _protocol_input(runner)
        self.assertEqual(request["operation"], "messages")
        self.assertEqual(request["cursor"], "opaque/next")

        runner = support.FakeRunner([_managed_result(messages)])
        _api_request(
            self.config,
            runner,
            "get",
            f"/api/session/{SESSION_ID}/message?type=user&limit=100&order=desc",
        )
        self.assertIsNone(_protocol_input(runner)["cursor"])

        metadata = {"overseerRelay": {"campaign": CAMPAIGN, "batchId": BATCH_ID}}
        prompt_response = {
            "data": {
                "id": "msg_admitted1",
                "sessionID": SESSION_ID,
                "type": "user",
                "time": {"created": 1762550003000},
                "delivery": "queue",
                "payload": {"metadata": metadata},
            }
        }
        runner = support.FakeRunner([_managed_result(prompt_response)])
        api_body = json.dumps({
            "text": PROMPT,
            "delivery": "queue",
            "resume": True,
            "metadata": metadata,
        })
        response = _api_request(
            self.config,
            runner,
            "post",
            f"/api/session/{SESSION_ID}/prompt",
            data=api_body,
        )
        request = _protocol_input(runner)
        self.assertEqual(request["operation"], "prompt")
        self.assertEqual(request["data"], {"text": PROMPT, "batch_id": BATCH_ID})
        receipt = _validated_post_receipt(
            response,
            session_id=SESSION_ID,
            text=PROMPT,
            metadata=metadata,
            managed=True,
        )
        self.assertEqual(receipt["metadata"], metadata)
        self.assertNotIn("text", receipt)

    def test_wrong_route_method_destination_and_prompt_body_never_reach_runner(self):
        valid_prompt = json.dumps({
            "text": PROMPT,
            "delivery": "queue",
            "resume": True,
            "metadata": {"overseerRelay": {"campaign": CAMPAIGN, "batchId": BATCH_ID}},
        })
        cases = (
            ("get", "/api/session/ses_another", None),
            ("get", f"/api/session/{SESSION_ID}/prompt", None),
            ("get", f"/api/session/{SESSION_ID}/message?type=assistant&limit=100&order=desc", None),
            ("post", f"/api/session/ses_another/prompt", valid_prompt),
            ("post", f"/api/session/{SESSION_ID}/inbox", valid_prompt),
            ("delete", f"/api/session/{SESSION_ID}", None),
            ("post", f"/api/session/{SESSION_ID}/prompt", '{"text":"x","text":"y"}'),
            ("post", f"/api/session/{SESSION_ID}/prompt", json.dumps({"text": PROMPT, "delivery": "queue", "resume": False, "metadata": {"overseerRelay": {"campaign": CAMPAIGN, "batchId": BATCH_ID}}})),
            ("post", f"/api/session/{SESSION_ID}/prompt", json.dumps({"text": PROMPT, "delivery": "queue", "resume": True, "metadata": {"overseerRelay": {"campaign": "other", "batchId": BATCH_ID}}})),
            ("post", f"/api/session/{SESSION_ID}/prompt", json.dumps({"text": PROMPT, "delivery": "queue", "resume": True, "metadata": {"overseerRelay": {"campaign": CAMPAIGN, "batchId": BATCH_ID}}, "headers": {"authorization": CANARY}})),
        )
        for method, route, body in cases:
            with self.subTest(method=method, route=route, body=body):
                runner = support.FakeRunner()
                with self.assertRaises(TransportError):
                    _api_request(self.config, runner, method, route, data=body)
                self.assertEqual(runner.calls, [])

    def test_helper_failures_are_static_typed_and_never_expose_stdout_or_stderr_canaries(self):
        runner = support.FakeRunner([support.FakeResult(
            returncode=1,
            stdout=json.dumps({"ok": False, "code": "identity_mismatch", "post_started": False}),
            stderr=CANARY,
        )])
        with self.assertRaises(TransportError) as raised:
            preflight_session(self.config, runner=runner)
        self.assertEqual(raised.exception.code, "identity_mismatch")
        self.assertFalse(raised.exception.post_started)
        self.assertEqual(str(raised.exception), "Managed service identity does not match configuration")
        self.assertNotIn(CANARY, str(raised.exception))

        unknown = support.FakeRunner([support.FakeResult(
            returncode=1,
            stdout=json.dumps({"ok": False, "code": CANARY, "post_started": False}),
            stderr=CANARY,
        )])
        with self.assertRaises(TransportError) as malformed:
            preflight_session(self.config, runner=unknown)
        self.assertNotIn(CANARY, str(malformed.exception))
        self.assertEqual(unknown.calls[0][0][0], "node")

        metadata = {"overseerRelay": {"campaign": CAMPAIGN, "batchId": BATCH_ID}}
        runner = support.FakeRunner([support.FakeResult(
            returncode=1,
            stdout=json.dumps({"ok": False, "code": "post_failed", "post_started": True}),
        )])
        with self.assertRaises(TransportError) as ambiguous:
            _api_request(
                self.config,
                runner,
                "post",
                f"/api/session/{SESSION_ID}/prompt",
                data=json.dumps({
                    "text": PROMPT,
                    "delivery": "queue",
                    "resume": True,
                    "metadata": metadata,
                }),
            )
        self.assertEqual(ambiguous.exception.code, "post_failed")
        self.assertIs(ambiguous.exception.post_started, True)

    def test_missing_helper_or_invalid_inventory_fails_without_any_runner_or_cli_fallback(self):
        support.TMP_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=support.TMP_ROOT) as temporary:
            missing = Path(temporary) / "managed" / "dist" / "relay-managed.mjs"
            with patch("overseer_relay.transport._managed_helper_path", return_value=missing):
                runner = support.FakeRunner()
                with self.assertRaises(TransportError) as raised:
                    preflight_session(self.config, runner=runner)
            self.assertEqual(raised.exception.code, "helper_missing")
            self.assertEqual(runner.calls, [])

            dist = missing.parent
            dist.mkdir(parents=True)
            (dist / "relay-managed.mjs").write_text("export {};\n", encoding="utf-8")
            (dist / "artifact-manifest.json").write_text(json.dumps({
                "schemaVersion": 1,
                "hashAlgorithm": "SHA-256",
                "files": [{"path": "relay-managed.mjs", "size": 10, "sha256": "0" * 64}],
            }), encoding="utf-8")
            with patch("overseer_relay.transport._managed_helper_path", return_value=missing):
                runner = support.FakeRunner()
                with self.assertRaises(TransportError) as raised:
                    preflight_session(self.config, runner=runner)
            self.assertEqual(raised.exception.code, "helper_invalid")
            self.assertEqual(runner.calls, [])

    def test_duplicate_nonfinite_oversized_and_unprojected_helper_outputs_fail_closed(self):
        bad_outputs = (
            '{"ok":true,"ok":true}',
            '{"ok":true,"data":{"data":{}},"host_version":NaN}',
            json.dumps({"ok": True, "data": {"data": {**_session_projection()["data"], "projectID": CANARY}}, "host_version": "2.2.7"}),
            "x" * (MAX_API_STDOUT_BYTES + 1),
        )
        for output in bad_outputs:
            with self.subTest(size=len(output)):
                runner = support.FakeRunner([support.FakeResult(stdout=output)])
                with self.assertRaises(TransportError) as raised:
                    preflight_session(self.config, runner=runner)
                self.assertNotIn(CANARY, str(raised.exception))

    def test_managed_message_and_prompt_projections_reject_raw_text(self):
        inbox = {"data": [{
            "id": "msg_inbox1",
            "sessionID": SESSION_ID,
            "type": "user",
            "time": {"created": 1762550002000},
            "delivery": "queue",
            "payload": {"text": CANARY, "metadata": {}},
        }]}
        messages = {"data": [{
            "id": "msg_inbox1",
            "sessionID": SESSION_ID,
            "type": "user",
            "time": {"created": 1762550002000},
            "text": CANARY,
            "metadata": {},
        }], "cursor": {"previous": None, "next": None}}
        prompt = {"data": {
            "id": "msg_admitted1",
            "sessionID": SESSION_ID,
            "type": "user",
            "time": {"created": 1762550003000},
            "delivery": "queue",
            "payload": {"text": CANARY, "metadata": {"overseerRelay": {"campaign": CAMPAIGN, "batchId": BATCH_ID}}},
        }}
        requests = (
            ("get", f"/api/session/{SESSION_ID}/inbox", inbox, None),
            ("get", f"/api/session/{SESSION_ID}/message?type=user&limit=100&order=desc", messages, None),
            ("post", f"/api/session/{SESSION_ID}/prompt", prompt, json.dumps({
                "text": PROMPT,
                "delivery": "queue",
                "resume": True,
                "metadata": {"overseerRelay": {"campaign": CAMPAIGN, "batchId": BATCH_ID}},
            })),
        )
        for method, route, result, body in requests:
            with self.subTest(route=route):
                runner = support.FakeRunner([_managed_result(result)])
                with self.assertRaises(TransportError) as raised:
                    _api_request(self.config, runner, method, route, data=body)
                self.assertNotIn(CANARY, str(raised.exception))
                self.assertEqual(len(runner.calls), 1)

    def test_inbox_accepts_optional_documented_time_and_delivery_and_preserves_old_fixture_shape(self):
        old_shape = {"id": "msg_old", "type": "user", "payload": {"text": "", "metadata": {}}}
        old_record = _message_record(old_shape, source="inbox", session_id=SESSION_ID)
        self.assertIsNone(old_record["created"])

        current_shape = {
            **old_shape,
            "sessionID": SESSION_ID,
            "time": {"created": 1762550002000},
            "delivery": "steer",
        }
        current_record = _message_record(current_shape, source="inbox", session_id=SESSION_ID)
        self.assertEqual(current_record["created"], 1762550002000)
        self.assertEqual(current_record["session_id"], SESSION_ID)

        for field, invalid_value in (("time", {"created": True}), ("delivery", "unknown")):
            with self.subTest(field=field):
                malformed = copy.deepcopy(current_shape)
                malformed[field] = invalid_value
                with self.assertRaises(TransportError):
                    _message_record(malformed, source="inbox", session_id=SESSION_ID)

    def test_managed_pin_or_session_binding_mismatch_holds_pending_batch_without_post(self):
        from tests.test_transport_delivery import _first_pending, _init_campaign

        for failure_code in ("identity_mismatch", "session_binding_mismatch"):
            with self.subTest(code=failure_code), support.TempGitRepo() as repo:
                _common, root, journal, legacy_config = _init_campaign(repo)
                managed_data = to_json_dict(legacy_config)
                managed_data["schema_version"] = 2
                managed_data["connection"] = {
                    "mode": "managed-local",
                    "expected_url": URL,
                    "expected_pid": PID,
                }
                atomic_write_json(root / "config.json", managed_data)
                from overseer_relay.config import load_config

                config = load_config(root / "config.json")
                batch_id = _first_pending(root, journal)
                runner = support.FakeRunner([support.FakeResult(
                    returncode=1,
                    stdout=json.dumps({"ok": False, "code": failure_code, "post_started": False}),
                )])

                outcome = deliver_pending(config, journal, runner=runner, sleep=lambda _seconds: None)

                self.assertEqual(outcome["status"], "held")
                self.assertEqual(journal.load()["batches"][batch_id]["status"], "held")
                self.assertEqual(len(runner.calls), 1)
                self.assertEqual(runner.calls[0][0], ["node", str(_managed_helper_path())])
                self.assertEqual(runner.calls[0][0][0], "node")


if __name__ == "__main__":
    unittest.main()
