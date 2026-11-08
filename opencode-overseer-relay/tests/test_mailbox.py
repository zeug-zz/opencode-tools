"""Offline tests for bounded mailbox framing and classification."""

import json
from pathlib import Path
import tempfile
import unittest

from tests import support

from overseer_relay.mailbox import FRAME_SCHEMA, format_frame, parse


def payload(**changes):
    result = {
        "schema": FRAME_SCHEMA,
        "campaign": "example-campaign",
        "role": "A",
        "generation": 1,
        "report_id": "report-1",
        "kind": "progress",
        "phase": None,
        "task": None,
        "summary": "completed a bounded check",
        "recommendation": None,
        "evidence_paths": [],
        "head": None,
        "blocker": None,
        "goal_state": "unknown",
        "batch_id": None,
    }
    result.update(changes)
    return result


def raw_frame(json_text, *, frame_id="report-1", end_id=None):
    end_id = frame_id if end_id is None else end_id
    return (
        f"<!-- overseer-relay:begin {frame_id} -->\n```json\n".encode("ascii")
        + json_text.encode("utf-8")
        + f"\n```\n<!-- overseer-relay:end {end_id} -->\n".encode("ascii")
    )


def make_raw(payload_value, *, frame_id=None, end_id=None):
    if frame_id is None:
        frame_id = payload_value.get("report_id", "report-1")
    return raw_frame(json.dumps(payload_value, ensure_ascii=False), frame_id=frame_id, end_id=end_id)


class MailboxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        support.TMP_ROOT.mkdir(parents=True, exist_ok=True)

    def parse_one(self, raw, **overrides):
        args = {
            "expected_campaign": "example-campaign",
            "expected_role": "A",
            "expected_generation": 1,
        }
        args.update(overrides)
        return parse(raw, **args)

    def test_valid_a_and_b_reports_have_byte_ranges_only(self):
        a = format_frame(payload())
        b = format_frame(payload(role="B", report_id="report-2", summary="B result"))
        raw = a + b

        result = self.parse_one(raw, expected_role="A")
        self.assertEqual(result.consumed, len(raw))
        self.assertEqual([(item.start, item.end) for item in result.entries], [(0, len(a)), (len(a), len(raw))])
        self.assertEqual([item.classification for item in result.entries], ["report", "held"])
        self.assertEqual(result.entries[0].report_id, "report-1")
        self.assertFalse(hasattr(result.entries[0], "payload"))
        self.assertFalse(hasattr(result.entries[0], "raw"))

        b_result = self.parse_one(b, expected_role="B")
        self.assertEqual(b_result.entries[0].classification, "report")

    def test_setup_ack_and_overseer_batch_ack_are_protocol_only(self):
        setup = format_frame(
            payload(role="A", report_id="setup-1", kind="setup-ack", goal_state="not_applicable")
        )
        setup_result = self.parse_one(setup, expected_role="A")
        self.assertEqual(setup_result.entries[0].classification, "protocol")
        self.assertEqual(setup_result.entries[0].kind, "setup-ack")

        batch = format_frame(
            payload(
                role="overseer",
                report_id="ack-1",
                kind="batch-ack",
                batch_id="batch-0123456789abcdef",
                goal_state="not_applicable",
            )
        )
        batch_result = parse(
            batch,
            "example-campaign",
            "overseer",
            1,
            expected_batch_id="batch-0123456789abcdef",
        )
        self.assertEqual(batch_result.entries[0].classification, "protocol")
        self.assertEqual(batch_result.entries[0].batch_id, "batch-0123456789abcdef")
        self.assertEqual(batch_result.consumed, len(batch))

        no_expected_batch = parse(batch, "example-campaign", "overseer", 1)
        self.assertEqual(no_expected_batch.entries[0].classification, "protocol")

    def test_wrong_role_campaign_and_generation_are_held(self):
        cases = (
            (payload(role="B", report_id="wrong-role"), {"expected_role": "A"}),
            (payload(campaign="other-campaign", report_id="wrong-campaign"), {}),
            (payload(generation=2, report_id="stale-generation"), {}),
        )
        for value, options in cases:
            with self.subTest(value=value):
                entry = self.parse_one(format_frame(value), **options).entries[0]
                self.assertEqual(entry.classification, "held")
                self.assertEqual(entry.reason, "identity_mismatch")

    def test_malformed_json_duplicates_nonfinite_and_mismatched_ids_are_review(self):
        malformed = raw_frame("{not-json")
        duplicate = json.dumps(payload())[:-1] + ',"summary":"duplicate"}'
        nonfinite = json.dumps(payload()).replace('"generation": 1', '"generation": NaN')
        mismatched_end = make_raw(payload(), end_id="different-id")
        mismatched_payload = make_raw(payload(report_id="different-id"), frame_id="report-1")

        for raw in (
            malformed,
            raw_frame(duplicate),
            raw_frame(nonfinite),
            mismatched_end,
            mismatched_payload,
        ):
            with self.subTest(raw=raw[:64]):
                result = self.parse_one(raw)
                self.assertEqual(result.entries[0].classification, "review")
                self.assertEqual(result.consumed, len(raw))

    def test_incomplete_utf8_and_frame_suffixes_remain_unconsumed(self):
        complete = format_frame(payload())
        second = format_frame(payload(report_id="report-2"))

        utf8_result = self.parse_one(complete + b"\xe2\x82")
        self.assertEqual(utf8_result.consumed, len(complete))
        self.assertEqual([entry.classification for entry in utf8_result.entries], ["report"])

        invalid_then_partial = self.parse_one(complete + b"\xff\xe2\x82")
        self.assertEqual(invalid_then_partial.consumed, len(complete) + 1)
        self.assertEqual(
            [entry.classification for entry in invalid_then_partial.entries], ["report", "review"]
        )

        partial_frame = second[: second.index(b"<!-- overseer-relay:end") + 30]
        frame_result = self.parse_one(complete + partial_frame)
        self.assertEqual(frame_result.consumed, len(complete))
        self.assertEqual([entry.classification for entry in frame_result.entries], ["report"])

    def test_complete_leading_frame_is_consumed_before_partial_begin_marker(self):
        complete = format_frame(payload())
        partial = b"<!-- overseer-relay:begin report-"
        result = self.parse_one(complete + partial)
        self.assertEqual(result.consumed, len(complete))
        self.assertEqual(len(result.entries), 1)

        distinctive_prefix = b"<!-- overseer-relay:beg"
        prefix_result = self.parse_one(complete + distinctive_prefix)
        self.assertEqual(prefix_result.consumed, len(complete))
        self.assertEqual(len(prefix_result.entries), 1)

    def test_arbitrary_angle_bracket_prose_is_not_an_incomplete_marker(self):
        raw = b"ordinary prose ending with < and <not-a-relay-marker"
        result = self.parse_one(raw)
        self.assertEqual(result.consumed, len(raw))
        self.assertEqual(result.entries[0].classification, "review")

    def test_unsupported_kind_and_wrong_ack_role_do_not_become_protocol(self):
        unsupported = make_raw(payload(kind="resume-goal", report_id="unsupported"))
        bad_ack = make_raw(
            payload(kind="batch-ack", batch_id="batch-1", report_id="bad-ack"),
        )
        self.assertEqual(self.parse_one(unsupported).entries[0].classification, "review")
        self.assertEqual(self.parse_one(bad_ack).entries[0].classification, "held")

    def test_batch_ack_must_name_the_expected_batch(self):
        raw = format_frame(
            payload(
                role="overseer",
                report_id="ack-1",
                kind="batch-ack",
                batch_id="batch-1",
                goal_state="not_applicable",
            )
        )
        result = parse(raw, "example-campaign", "overseer", 1, expected_batch_id="batch-2")
        self.assertEqual(result.entries[0].classification, "held")
        self.assertEqual(result.entries[0].reason, "batch_id_mismatch")

    def test_bool_generation_is_not_accepted_as_integer(self):
        raw = make_raw(payload(generation=True))
        self.assertEqual(self.parse_one(raw).entries[0].classification, "review")

    def test_evidence_escape_and_symlink_are_held(self):
        escape = make_raw(payload(evidence_paths=["../outside.md"], report_id="escape"))
        self.assertEqual(self.parse_one(escape).entries[0].classification, "held")

        with tempfile.TemporaryDirectory(dir=support.TMP_ROOT) as directory:
            worktree = Path(directory)
            outside = worktree.parent / (worktree.name + "-outside.md")
            outside.write_text("outside\n", encoding="utf-8")
            (worktree / "linked.md").symlink_to(outside)
            raw = format_frame(payload(evidence_paths=["linked.md"], report_id="symlink"))
            result = self.parse_one(raw, worktree=worktree)
            self.assertEqual(result.entries[0].classification, "held")
            outside.unlink()

    def test_oversized_frame_is_reviewed_with_marker_bytes_in_size(self):
        frame = format_frame(payload(summary="x" * 600))
        result = self.parse_one(frame, max_frame_bytes=len(frame) - 1)
        self.assertEqual(result.entries[0].classification, "review")
        self.assertEqual(result.entries[0].reason, "frame_too_large")
        self.assertEqual((result.entries[0].start, result.entries[0].end), (0, len(frame)))
        self.assertEqual(result.consumed, len(frame))

    def test_credential_like_input_is_held_without_copying_the_value(self):
        secret = "Bearer ultra-secret-value"
        raw = make_raw(payload(summary=secret, report_id="credential"))
        entry = self.parse_one(raw).entries[0]
        self.assertEqual(entry.classification, "held")
        self.assertNotIn(secret, repr(entry))

    def test_formatter_rejects_invalid_shapes_and_credential_text(self):
        with self.assertRaises(ValueError):
            format_frame(payload(generation=True))
        with self.assertRaises(ValueError):
            format_frame(payload(summary="Bearer do-not-copy"))


if __name__ == "__main__":
    unittest.main()
