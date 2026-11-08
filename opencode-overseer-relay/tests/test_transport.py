#!/usr/bin/env python3
"""Offline tests for the bounded, read-only Overseer session preflight."""

from tests import support

import copy
from dataclasses import replace
import json
from pathlib import Path
import sys
import tempfile
import unittest

from overseer_relay.config import default_config, parse_config, to_json_dict
from overseer_relay.transport import (
    MAX_API_STDERR_BYTES,
    MAX_API_STDOUT_BYTES,
    CommandResult,
    SessionIdentity,
    TransportError,
    preflight_session,
    subprocess_runner,
)


FIXTURE = Path(__file__).parent / "fixtures" / "transport" / "session-info.json"


class TransportTests(unittest.TestCase):
    def setUp(self):
        source = default_config("campaign-1", "/repo/.git", "main")
        source["roles"]["overseer"].update(
            session_id="ses_overseer123",
            directory="/workspace/repo",
            agent="build",
        )
        source["roles"]["A"].update(
            session_id="ses_workerA",
            directory="/workers/A",
            agent="codex",
        )
        source["roles"]["B"].update(
            session_id="ses_workerB",
            directory="/workers/B",
            agent="claude",
        )
        source["connection"] = ["--server", "http://127.0.0.1:4096"]
        source["capabilities"].update(
            overseer_notices=True,
            owner_approved_notices=True,
        )
        self.config = parse_config(source)
        self.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def _info(self):
        return copy.deepcopy(self.fixture["data"])

    def _invoke(self, runner=None):
        if runner is None:
            from tests.support import FakeResult, FakeRunner

            runner = FakeRunner([FakeResult(stdout=json.dumps(self.fixture))])
        return preflight_session(self.config, runner=runner), runner

    def _assert_rejected(self, response, expected_message=None):
        from tests.support import FakeResult, FakeRunner

        runner = FakeRunner([FakeResult(stdout=response)])
        with self.assertRaises(TransportError) as raised:
            preflight_session(self.config, runner=runner)
        if expected_message is not None:
            self.assertEqual(str(raised.exception), expected_message)
        self.assertEqual(len(runner.calls), 1)

    def test_preflight_uses_the_pinned_server_and_only_the_overseer_context(self):
        identity, runner = self._invoke()

        self.assertEqual(
            identity,
            SessionIdentity("ses_overseer123", "build", "/workspace/repo"),
        )
        self.assertEqual(
            runner.calls,
            [
                (
                    [
                        "opencode",
                        "--server",
                        "http://127.0.0.1:4096",
                        "api",
                        "get",
                        "/api/session/ses_overseer123",
                    ],
                    {"timeout": 30, "input": None},
                )
            ],
        )
        argv = runner.calls[0][0]
        self.assertNotIn("ses_workerA", argv)
        self.assertNotIn("ses_workerB", argv)
        self.assertNotIn("/workers/A", argv)
        self.assertNotIn("/workers/B", argv)
        self.assertNotIn("serve", argv)
        self.assertEqual(argv[3:5], ["api", "get"])

    def test_missing_subpath_uses_location_directory_directly(self):
        info = self._info()
        info["location"]["directory"] = "/workspace/repo"
        del info["subpath"]
        from tests.support import FakeResult, FakeRunner

        runner = FakeRunner([FakeResult(stdout=json.dumps({"data": info}))])
        identity = preflight_session(self.config, runner=runner)
        self.assertEqual(identity.directory, "/workspace/repo")

    def test_zero_archive_timestamp_is_not_archived(self):
        info = self._info()
        info["time"]["archived"] = 0
        from tests.support import FakeResult, FakeRunner

        runner = FakeRunner([FakeResult(stdout=json.dumps({"data": info}))])
        identity = preflight_session(self.config, runner=runner)
        self.assertFalse(identity.archived)

    def test_positive_archive_timestamp_blocks_preflight(self):
        info = self._info()
        info["time"]["archived"] = 1762550002000
        self._assert_rejected(
            json.dumps({"data": info}),
            "Overseer session is archived",
        )

    def test_wrong_session_id_agent_directory_and_subpath_fail_closed(self):
        cases = (
            ("id", "ses_someoneelse", None),
            ("agent", "plan", None),
            ("location", {"directory": "/elsewhere"}, None),
            ("subpath", "another-repo", None),
        )
        for field, value, nested in cases:
            with self.subTest(field=field):
                info = self._info()
                if nested is None:
                    info[field] = value
                else:
                    info[field][nested] = value
                self._assert_rejected(json.dumps({"data": info}))

    def test_relative_location_directory_is_malformed(self):
        info = self._info()
        info["location"]["directory"] = "workspace"
        self._assert_rejected(
            json.dumps({"data": info}),
            "Overseer session directory is invalid",
        )

    def test_subpath_must_be_confined_and_canonical(self):
        for subpath in ("../repo", "/workspace/repo", "", "./repo", "a//b"):
            with self.subTest(subpath=subpath):
                info = self._info()
                info["subpath"] = subpath
                self._assert_rejected(json.dumps({"data": info}))

    def test_never_uses_a_guessed_top_level_directory_field(self):
        info = self._info()
        info["directory"] = "/workspace/repo"
        self._assert_rejected(json.dumps({"data": info}), "OpenCode API response is invalid")

    def test_local_symlink_path_drift_is_rejected(self):
        support.TMP_ROOT.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=support.TMP_ROOT)
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        actual = root / "real" / "repo"
        actual.mkdir(parents=True)
        alias = root / "alias"
        alias.symlink_to(root / "real", target_is_directory=True)

        source = to_json_dict(self.config)
        source["roles"]["overseer"]["directory"] = str(actual)
        config = parse_config(source)
        info = self._info()
        info["location"]["directory"] = str(alias)
        info["subpath"] = "repo"
        from tests.support import FakeResult, FakeRunner

        runner = FakeRunner([FakeResult(stdout=json.dumps({"data": info}))])
        with self.assertRaises(TransportError) as raised:
            preflight_session(config, runner=runner)
        self.assertEqual(str(raised.exception), "Overseer session directory is invalid")

    def test_missing_or_invalid_identity_and_time_fields_block(self):
        mutations = (
            lambda info: info.pop("id"),
            lambda info: info.pop("agent"),
            lambda info: info.update(agent=None),
            lambda info: info.pop("location"),
            lambda info: info["location"].pop("directory"),
            lambda info: info.pop("time"),
            lambda info: info["time"].pop("created"),
            lambda info: info["time"].pop("updated"),
            lambda info: info["time"].update(created=True),
            lambda info: info["time"].update(archived=None),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate.__code__.co_firstlineno):
                info = self._info()
                mutate(info)
                self._assert_rejected(json.dumps({"data": info}))

    def test_malformed_wrapper_json_and_duplicate_keys_are_rejected(self):
        for response in (
            "not json",
            "{}",
            '{"data":{"id":"ses_overseer123","id":"ses_overseer123"}}',
            '{"data":null}',
            '{"data":{},"error":"contradictory"}',
        ):
            with self.subTest(response=response[:20]):
                self._assert_rejected(response)

    def test_runner_timeout_and_auth_or_service_errors_are_value_free(self):
        from tests.support import FakeResult, FakeRunner

        runner = FakeRunner([TimeoutError("Bearer do-not-print-this-token")])
        with self.assertRaises(TransportError) as timeout_error:
            preflight_session(self.config, runner=runner)
        self.assertEqual(str(timeout_error.exception), "OpenCode API request timed out")
        self.assertNotIn("do-not-print-this-token", str(timeout_error.exception))

        runner = FakeRunner([RuntimeError("Bearer do-not-print-this-token")])
        with self.assertRaises(TransportError) as runner_error:
            preflight_session(self.config, runner=runner)
        self.assertEqual(str(runner_error.exception), "OpenCode API command failed")
        self.assertNotIn("do-not-print-this-token", str(runner_error.exception))

        runner = FakeRunner([TransportError("Bearer do-not-print-this-token")])
        with self.assertRaises(TransportError) as transport_error:
            preflight_session(self.config, runner=runner)
        self.assertEqual(str(transport_error.exception), "OpenCode API command failed")
        self.assertNotIn("do-not-print-this-token", str(transport_error.exception))

        for error_text in (
            "401 Authorization: do-not-print-this-token",
            "connection refused: do-not-print-this-token",
        ):
            with self.subTest(error_text=error_text.split()[0]):
                runner = FakeRunner(
                    [FakeResult(returncode=1, stderr=error_text)]
                )
                with self.assertRaises(TransportError) as raised:
                    preflight_session(self.config, runner=runner)
                self.assertEqual(str(raised.exception), "OpenCode API command failed")
                self.assertNotIn("do-not-print-this-token", str(raised.exception))

    def test_unapproved_or_unbound_config_makes_no_runner_call(self):
        for condition in ("approval", "binding", "server"):
            with self.subTest(condition=condition):
                source = to_json_dict(self.config)
                if condition == "approval":
                    source["capabilities"]["owner_approved_notices"] = False
                elif condition == "binding":
                    source["roles"]["overseer"]["agent"] = None
                else:
                    source["connection"] = []
                config = parse_config(source)
                from tests.support import FakeRunner

                runner = FakeRunner()
                with self.assertRaises(TransportError):
                    preflight_session(config, runner=runner)
                self.assertEqual(runner.calls, [])

    def test_only_a_validated_server_option_is_forwarded(self):
        from tests.support import FakeRunner

        invalid_configs = (
            replace(self.config, connection=("--standalone",)),
            replace(
                self.config,
                connection=("--server", "https://user:do-not-print-this@example.invalid"),
            ),
        )
        for config in invalid_configs:
            runner = FakeRunner()
            with self.assertRaises(TransportError) as raised:
                preflight_session(config, runner=runner)
            self.assertNotIn("do-not-print-this", str(raised.exception))
            self.assertEqual(runner.calls, [])

    def test_fake_runner_output_limits_are_checked_before_json_parsing(self):
        from tests.support import FakeResult, FakeRunner

        for stdout, stderr in (
            ("x" * (MAX_API_STDOUT_BYTES + 1), ""),
            ("{}", "x" * (MAX_API_STDERR_BYTES + 1)),
        ):
            with self.subTest(output="stdout" if len(stdout) > 100 else "stderr"):
                runner = FakeRunner([FakeResult(stdout=stdout, stderr=stderr)])
                with self.assertRaises(TransportError) as raised:
                    preflight_session(self.config, runner=runner)
                self.assertEqual(
                    str(raised.exception),
                    "OpenCode API output exceeded the size limit",
                )

    def test_default_subprocess_runner_bounds_output_and_timeout(self):
        result = subprocess_runner(
            [sys.executable, "-c", "print('offline-runner-ok')"],
            timeout=2,
        )
        self.assertIsInstance(result, CommandResult)
        self.assertEqual(result.stdout, b"offline-runner-ok\n")

        with self.assertRaises(TransportError) as timeout_error:
            subprocess_runner(
                [sys.executable, "-c", "import time; time.sleep(10)"],
                timeout=0.2,
            )
        self.assertEqual(str(timeout_error.exception), "OpenCode API request timed out")

        with self.assertRaises(TransportError) as output_error:
            subprocess_runner(
                [
                    sys.executable,
                    "-c",
                    f"import sys; sys.stdout.write('x' * {MAX_API_STDOUT_BYTES + 1})",
                ],
                timeout=2,
            )
        self.assertEqual(
            str(output_error.exception),
            "OpenCode API output exceeded the size limit",
        )


if __name__ == "__main__":
    unittest.main()
