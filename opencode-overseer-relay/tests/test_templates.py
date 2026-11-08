"""Contract checks for the project-neutral relay templates."""

from tests import support

import json
from pathlib import Path
import re
import unittest

from overseer_relay.config import ManagedConnection, parse_config
from overseer_relay.mailbox import parse


TEMPLATES = Path(__file__).resolve().parents[1] / "templates"


class TemplateTests(unittest.TestCase):
    def test_campaign_config_is_valid_unbound_and_disabled(self):
        config = json.loads((TEMPLATES / "campaign-config.json").read_text())
        parsed = parse_config(config)
        self.assertEqual(parsed.campaign_id, "example-campaign")
        self.assertEqual(parsed.common_dir, "/example/project/.git")
        self.assertEqual(parsed.connection, ())
        self.assertEqual(
            set(parsed.roles), {"overseer", "A", "B"},
        )
        for binding in parsed.roles.values():
            self.assertEqual(binding.generation, 1)
            self.assertIsNone(binding.session_id)
            self.assertIsNone(binding.directory)
            self.assertIsNone(binding.branch)
            self.assertIsNone(binding.agent)
        self.assertFalse(parsed.capabilities.overseer_notices)
        self.assertFalse(parsed.capabilities.owner_approved_notices)
        self.assertFalse(parsed.capabilities.worker_delivery)
        self.assertFalse(parsed.capabilities.worker_steers)
        self.assertFalse(parsed.capabilities.goal_resume)

    def test_managed_campaign_config_is_valid_unbound_and_disabled(self):
        config = json.loads((TEMPLATES / "managed-campaign-config.json").read_text())
        parsed = parse_config(config)
        self.assertEqual(parsed.schema_version, 2)
        self.assertEqual(
            parsed.connection,
            ManagedConnection(expected_url="http://127.0.0.1:17777"),
        )
        self.assertNotIn("expected_pid", config["connection"])
        for binding in parsed.roles.values():
            self.assertIsNone(binding.session_id)
            self.assertIsNone(binding.directory)
            self.assertIsNone(binding.agent)
        self.assertFalse(parsed.capabilities.overseer_notices)
        self.assertFalse(parsed.capabilities.owner_approved_notices)
        self.assertFalse(parsed.capabilities.worker_delivery)
        self.assertFalse(parsed.capabilities.worker_steers)
        self.assertFalse(parsed.capabilities.goal_resume)

        readme = (TEMPLATES.parents[0] / "README.md").read_text()
        documented = re.search(
            r"(?m)^## Schema-v2 managed-local configuration\n.*?```json\n(\{.*?\})\n```",
            readme,
            re.DOTALL,
        )
        self.assertIsNotNone(documented)
        self.assertEqual(json.loads(documented.group(1)), config["connection"])

    def test_report_frame_is_extracted_and_parsed(self):
        text = (TEMPLATES / "report-frame.md").read_text()
        match = re.search(
            r"(?m)^<!-- overseer-relay:begin example-report-1 -->\n```json\n"
            r"(\{.*?\})\n```\n<!-- overseer-relay:end example-report-1 -->\n",
            text,
            re.DOTALL,
        )
        self.assertIsNotNone(match)
        payload = json.loads(match.group(1))
        result = parse(match.group(0).encode(), "example-campaign", "A", 1)
        self.assertEqual(result.consumed, len(match.group(0).encode()))
        self.assertEqual(len(result.entries), 1)
        self.assertEqual(result.entries[0].classification, "report")
        self.assertEqual(payload["kind"], "progress")

    def test_handoff_and_ruling_have_required_operational_concepts(self):
        handoff = (TEMPLATES / "handoff.md").read_text()
        for concept in (
            "Current campaign", "Common directory", "Project policy", "Bindings",
            "Last batch and summary reference", "Outstanding decisions",
            "Delivery holds", "Next eligible action",
        ):
            self.assertIn(concept, handoff)
        ruling = (TEMPLATES / "ruling.md").read_text()
        for concept in (
            "UTC timestamp", "Ruling ID", "generation", "Campaign ID",
            "Evidence paths", "Verified head", "Authority/source", "Decision",
            "Resolved prerequisites", "Remaining stops", "Owner-visible summary pointer",
            "Phase 1 does not provide worker delivery", "worker control execution",
        ):
            self.assertIn(concept, ruling)


if __name__ == "__main__":
    unittest.main()
