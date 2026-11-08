#!/usr/bin/env python3
"""Tests for strict, credential-free campaign configuration parsing."""

from tests import support

import copy
from dataclasses import FrozenInstanceError
import json
from pathlib import Path
import tempfile
import unittest

from overseer_relay.config import (
    MAX_CONFIG_BYTES,
    ConfigError,
    ManagedConnection,
    default_config,
    goal_resume_target,
    load_config,
    notices_deliverable,
    parse_config,
    to_json_dict,
)


class ConfigTests(unittest.TestCase):
    def setUp(self):
        support.TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.config = default_config("campaign-1", "/repo/.git", "main")

    def _write_json(self, value):
        temporary = tempfile.TemporaryDirectory(dir=support.TMP_ROOT)
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / "config.json"
        path.write_text(value, encoding="utf-8")
        return path

    def _with_complete_overseer(self, config):
        config["roles"]["overseer"].update(
            session_id="ses_abc123",
            directory="/repo",
            agent="opencode",
        )
        return config

    def _managed_config(self, *, expected_url="http://127.0.0.1:4096", expected_pid=12345):
        config = copy.deepcopy(self.config)
        config["schema_version"] = 2
        config["connection"] = {
            "mode": "managed-local",
            "expected_url": expected_url,
        }
        if expected_pid is not None:
            config["connection"]["expected_pid"] = expected_pid
        return config

    def test_valid_default_round_trips_without_inventing_bindings(self):
        parsed = parse_config(self.config)
        self.assertEqual(to_json_dict(parsed), self.config)
        self.assertEqual(parsed.schema_version, 1)
        self.assertEqual(parsed.connection, ())
        self.assertEqual(parsed.roles["overseer"].session_id, None)
        self.assertEqual(parsed.roles["A"].directory, None)
        with self.assertRaises((AttributeError, TypeError)):
            parsed.roles["A"] = parsed.roles["overseer"]

    def test_load_config_accepts_default_json(self):
        path = self._write_json(json.dumps(self.config))
        self.assertEqual(to_json_dict(load_config(path)), self.config)

    def test_role_keys_are_exact(self):
        missing_role = copy.deepcopy(self.config)
        del missing_role["roles"]["B"]
        with self.assertRaisesRegex(ConfigError, r"\$\.roles\.B"):
            parse_config(missing_role)

        extra_role = copy.deepcopy(self.config)
        extra_role["roles"]["C"] = copy.deepcopy(extra_role["roles"]["A"])
        with self.assertRaisesRegex(ConfigError, r"\$\.roles\.C: unknown field"):
            parse_config(extra_role)

    def test_partial_bindings_remain_explicit_and_are_never_filled(self):
        partial = copy.deepcopy(self.config)
        partial["roles"]["A"].update(session_id="ses_worker1", agent="codex")
        parsed = parse_config(partial)
        round_trip = to_json_dict(parsed)
        self.assertEqual(round_trip["roles"]["A"]["session_id"], "ses_worker1")
        self.assertIsNone(round_trip["roles"]["A"]["directory"])
        self.assertIsNone(round_trip["roles"]["A"]["branch"])
        self.assertEqual(round_trip["roles"]["A"]["agent"], "codex")

    def test_session_id_uses_a_conservative_format(self):
        invalid = copy.deepcopy(self.config)
        invalid["roles"]["A"]["session_id"] = "session-123"
        with self.assertRaisesRegex(ConfigError, r"\$\.roles\.A\.session_id"):
            parse_config(invalid)

    def test_unknown_top_level_and_nested_fields_fail_closed(self):
        top_level = copy.deepcopy(self.config)
        top_level["debug"] = True
        with self.assertRaisesRegex(ConfigError, r"\$\.debug: unknown field"):
            parse_config(top_level)

        nested = copy.deepcopy(self.config)
        nested["limits"]["unbounded"] = True
        with self.assertRaisesRegex(ConfigError, r"\$\.limits\.unbounded: unknown field"):
            parse_config(nested)

    def test_schema_version_and_phase_are_exact(self):
        wrong_version = copy.deepcopy(self.config)
        wrong_version["schema_version"] = 3
        with self.assertRaisesRegex(ConfigError, r"\$\.schema_version: unsupported schema version"):
            parse_config(wrong_version)

        wrong_phase = copy.deepcopy(self.config)
        wrong_phase["phase"] = 2
        with self.assertRaisesRegex(ConfigError, r"\$\.phase: unsupported phase"):
            parse_config(wrong_phase)

    def test_duplicate_json_keys_are_rejected_with_a_safe_path(self):
        text = json.dumps(self.config)
        text = text.replace(
            '"schema_version": 1,',
            '"schema_version": 1, "schema_version": 1,',
            1,
        )
        with self.assertRaisesRegex(ConfigError, r"\$\.schema_version: duplicate key"):
            load_config(self._write_json(text))

    def test_config_file_size_is_bounded(self):
        path = self._write_json(" " * (MAX_CONFIG_BYTES + 1))
        with self.assertRaisesRegex(ConfigError, "size limit"):
            load_config(path)

    def test_credential_like_keys_and_values_are_rejected_without_echoing_values(self):
        with_key = copy.deepcopy(self.config)
        with_key["roles"]["A"]["api_key"] = "do-not-print-this-value"
        with self.assertRaises(ConfigError) as key_error:
            parse_config(with_key)
        self.assertIn("$.roles.A.api_key", str(key_error.exception))
        self.assertNotIn("do-not-print-this-value", str(key_error.exception))

        for credential_value in (
            "Bearer do-not-print-this-token",
            "sk-test-do-not-print-this-key",
        ):
            with self.subTest(value_kind=credential_value.split("-")[0]):
                with_value = copy.deepcopy(self.config)
                with_value["base_ref"] = credential_value
                with self.assertRaises(ConfigError) as value_error:
                    parse_config(with_value)
                self.assertIn("$.base_ref", str(value_error.exception))
                self.assertNotIn(credential_value, str(value_error.exception))

    def test_userinfo_and_token_query_urls_are_rejected(self):
        for address in (
            "http://user:do-not-print@example.invalid:4096",
            "https://relay.example.invalid/?access_token=do-not-print",
        ):
            with self.subTest(address_kind="userinfo" if "@" in address else "query"):
                config = copy.deepcopy(self.config)
                config["connection"] = ["--server", address]
                with self.assertRaises(ConfigError) as raised:
                    parse_config(config)
                self.assertNotIn("do-not-print", str(raised.exception))

    def test_schema_v2_managed_connection_round_trips_and_is_immutable(self):
        data = self._managed_config()
        parsed = parse_config(data)
        self.assertEqual(
            parsed.connection,
            ManagedConnection(expected_url="http://127.0.0.1:4096", expected_pid=12345),
        )
        self.assertEqual(to_json_dict(parsed), data)
        with self.assertRaises(FrozenInstanceError):
            parsed.connection.expected_pid = 54321

        ipv6 = parse_config(self._managed_config(expected_url="https://[::1]:443", expected_pid=1))
        self.assertEqual(ipv6.connection.expected_url, "https://[::1]:443")
        self.assertEqual(ipv6.connection.expected_pid, 1)

    def test_schema_v2_url_only_managed_connection_round_trips_without_pid(self):
        data = self._managed_config(expected_pid=None)
        parsed = parse_config(data)
        self.assertEqual(
            parsed.connection,
            ManagedConnection(expected_url="http://127.0.0.1:4096"),
        )
        self.assertIsNone(parsed.connection.expected_pid)
        self.assertEqual(to_json_dict(parsed), data)
        self.assertNotIn("expected_pid", to_json_dict(parsed)["connection"])

    def test_managed_url_requires_canonical_explicit_ip_loopback_and_empty_path(self):
        for address in (
            "http://localhost:4096",
            "http://127.0.0.2:4096",
            "http://127.1:4096",
            "https://[::2]:4096",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://127.0.0.1:65536",
            "http://127.0.0.1:04096",
            "http://127.0.0.1:4096/",
            "http://127.0.0.1:4096?mode=local",
            "http://127.0.0.1:4096#fragment",
        ):
            with self.subTest(address=address):
                with self.assertRaisesRegex(ConfigError, r"\$\.connection\.expected_url"):
                    parse_config(self._managed_config(expected_url=address))

    def test_managed_pid_is_a_positive_bounded_integer_not_a_boolean(self):
        for pid in (0, -1, True, (1 << 31)):
            with self.subTest(pid=pid):
                with self.assertRaisesRegex(ConfigError, r"\$\.connection\.expected_pid"):
                    parse_config(self._managed_config(expected_pid=pid))

    def test_schema_v2_rejects_expected_version_unknown_and_mixed_fields(self):
        for extra_field in ("expected_version", "server", "url", "pid"):
            with self.subTest(extra_field=extra_field):
                config = self._managed_config()
                config["connection"][extra_field] = "2.2.6"
                with self.assertRaisesRegex(
                    ConfigError,
                    rf"\$\.connection\.{extra_field}: unknown field",
                ):
                    parse_config(config)

        wrong_mode = self._managed_config()
        wrong_mode["connection"]["mode"] = "managed"
        with self.assertRaisesRegex(ConfigError, r"\$\.connection\.mode: must be 'managed-local'"):
            parse_config(wrong_mode)

        legacy_shape_in_v2 = self._managed_config()
        legacy_shape_in_v2["connection"] = ["--server", "http://127.0.0.1:4096"]
        with self.assertRaisesRegex(ConfigError, r"\$\.connection: must be an object"):
            parse_config(legacy_shape_in_v2)

        managed_shape_in_v1 = copy.deepcopy(self.config)
        managed_shape_in_v1["connection"] = {
            "mode": "managed-local",
            "expected_url": "http://127.0.0.1:4096",
            "expected_pid": 12345,
        }
        with self.assertRaisesRegex(ConfigError, r"\$\.connection: must be a bounded list"):
            parse_config(managed_shape_in_v1)

    def test_managed_connection_rejects_credentials_without_echoing_them(self):
        for address in (
            "http://user:do-not-print@127.0.0.1:4096",
            "http://127.0.0.1:4096/?access_token=do-not-print",
        ):
            with self.subTest(address_kind="userinfo" if "@" in address else "query"):
                with self.assertRaises(ConfigError) as raised:
                    parse_config(self._managed_config(expected_url=address))
                self.assertNotIn("do-not-print", str(raised.exception))

    def test_reserved_worker_capabilities_must_remain_disabled(self):
        for capability in ("worker_delivery", "worker_steers"):
            with self.subTest(capability=capability):
                config = copy.deepcopy(self.config)
                config["capabilities"][capability] = True
                with self.assertRaisesRegex(
                    ConfigError,
                    rf"\$\.capabilities\.{capability}: reserved later-phase capability",
                ):
                    parse_config(config)

    def test_goal_resume_requires_managed_schema_v2_and_defaults_false(self):
        self.assertFalse(parse_config(self.config).capabilities.goal_resume)
        managed = self._managed_config()
        managed["capabilities"]["goal_resume"] = True
        self.assertTrue(parse_config(managed).capabilities.goal_resume)

        legacy = copy.deepcopy(self.config)
        legacy["capabilities"]["goal_resume"] = True
        with self.assertRaises(ConfigError) as raised:
            parse_config(legacy)
        self.assertIn("$.capabilities.goal_resume", str(raised.exception))
        self.assertNotIn("127.0.0.1", str(raised.exception))

    def test_goal_resume_target_requires_enabled_complete_selected_worker(self):
        disabled = parse_config(self._managed_config())
        self.assertEqual(goal_resume_target(disabled, "A"), (False, "Goal resume is disabled"))

        enabled_data = self._managed_config()
        enabled_data["capabilities"]["goal_resume"] = True
        enabled_data["roles"]["A"].update(
            session_id="ses_worker1", directory="/repo", agent="codex"
        )
        enabled = parse_config(enabled_data)
        self.assertEqual(goal_resume_target(enabled, "A"), (True, "Goal resume to A is approved"))

        incomplete_data = copy.deepcopy(enabled_data)
        incomplete_data["roles"]["A"]["agent"] = None
        incomplete = parse_config(incomplete_data)
        self.assertEqual(
            goal_resume_target(incomplete, "A"),
            (False, "Goal resume worker binding is incomplete"),
        )
        self.assertFalse(goal_resume_target(enabled, "overseer")[0])
        self.assertFalse(goal_resume_target(enabled, "C")[0])

    def test_limits_enforce_hard_bounds_and_boolean_is_not_an_integer(self):
        too_large = copy.deepcopy(self.config)
        too_large["limits"]["max_frame_bytes"] += 1
        with self.assertRaisesRegex(ConfigError, r"\$\.limits\.max_frame_bytes"):
            parse_config(too_large)

        boolean_limit = copy.deepcopy(self.config)
        boolean_limit["limits"]["max_notice_bytes"] = True
        with self.assertRaisesRegex(ConfigError, r"\$\.limits\.max_notice_bytes: must be an integer"):
            parse_config(boolean_limit)

    def test_baseline_ranges_reject_negative_and_reversed_bounds(self):
        negative = copy.deepcopy(self.config)
        negative["baseline"]["A"] = {
            "mode": "range",
            "start": -1,
            "end": 3,
            "prefix_sha256": "0" * 64,
        }
        with self.assertRaisesRegex(ConfigError, r"\$\.baseline\.A\.start"):
            parse_config(negative)

        reversed_range = copy.deepcopy(self.config)
        reversed_range["baseline"]["B"] = {
            "mode": "range",
            "start": 4,
            "end": 4,
            "prefix_sha256": "0" * 64,
        }
        with self.assertRaisesRegex(ConfigError, r"\$\.baseline\.B\.end"):
            parse_config(reversed_range)

    def test_notices_require_complete_overseer_binding_and_owner_approval(self):
        unbound = parse_config(self.config)
        self.assertEqual(notices_deliverable(unbound), (False, "Overseer binding is incomplete"))

        unapproved_data = self._with_complete_overseer(copy.deepcopy(self.config))
        unapproved_data["capabilities"]["overseer_notices"] = True
        unapproved = parse_config(unapproved_data)
        self.assertEqual(
            notices_deliverable(unapproved),
            (False, "Overseer notice delivery lacks owner approval"),
        )

        approved_data = self._with_complete_overseer(copy.deepcopy(self.config))
        approved_data["capabilities"].update(
            overseer_notices=True,
            owner_approved_notices=True,
        )
        approved_data["connection"] = ["--server", "http://127.0.0.1:4096"]
        approved = parse_config(approved_data)
        self.assertEqual(
            notices_deliverable(approved),
            (True, "Overseer notice delivery is approved"),
        )

        managed_approved_data = self._with_complete_overseer(self._managed_config())
        managed_approved_data["capabilities"].update(
            overseer_notices=True,
            owner_approved_notices=True,
        )
        managed_approved = parse_config(managed_approved_data)
        self.assertEqual(
            notices_deliverable(managed_approved),
            (True, "Overseer notice delivery is approved"),
        )

        unpinned_data = copy.deepcopy(approved_data)
        unpinned_data["connection"] = []
        unpinned = parse_config(unpinned_data)
        self.assertEqual(
            notices_deliverable(unpinned),
            (False, "Pinned server is not configured"),
        )


if __name__ == "__main__":
    unittest.main()
