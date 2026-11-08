from pathlib import Path
import re
import sys
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SKILL = PACKAGE_ROOT / "skills" / "overseer-setup" / "SKILL.md"
REFERENCE = PACKAGE_ROOT / "skills" / "overseer-setup" / "references" / "setup-checklist.md"
COORDINATE = PACKAGE_ROOT / "skills" / "overseer-coordinate" / "SKILL.md"
COORDINATE_REFERENCES = COORDINATE.parent / "references"
sys.path.insert(0, str(PACKAGE_ROOT / "src"))
from overseer_relay.mailbox import parse


class SetupSkillContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = SKILL.read_text(encoding="utf-8")
        cls.reference = REFERENCE.read_text(encoding="utf-8")

    def test_frontmatter_contract(self):
        match = re.match(r"\A---\n(.*?)\n---\n", self.skill, re.DOTALL)
        self.assertIsNotNone(match)
        fields = dict(
            (key.strip(), value.strip())
            for line in match.group(1).splitlines()
            if ":" in line
            for key, value in (line.split(":", 1),)
        )
        self.assertEqual(fields.get("name"), "overseer-setup")
        self.assertIn("two A/B orchestrator worktrees and goals", fields.get("description", ""))
        self.assertIn("Overseer relay", fields.get("description", ""))

    def test_short_skill_links_to_existing_reference(self):
        self.assertLess(len(self.skill.splitlines()), 100)
        links = re.findall(r"\[[^]]+\]\(([^)]+)\)", self.skill)
        self.assertEqual(links, ["references/setup-checklist.md"])
        self.assertTrue((SKILL.parent / links[0]).is_file())

    def test_setup_safety_contracts(self):
        for phrase in (
            "one\n   precise confirmation",
            "never reset, rebase, stash",
            "nono why --self --path <path> --op <read|write|readwrite>",
            "exact session IDs",
            "The relay sends no prompts to workers in phase 1",
            "do not create an Overseer goal just\n   to poll",
            "baseline now",
            "`--apply`",
            "`--deliver-notices`",
            "Do not poll models",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, self.reference)

    def test_commands_match_cli_and_runtime_path_is_explicit(self):
        for command in (
            "inspect --repo <main>",
            "init",
            "once --campaign-dir <campaign>",
            "watch --campaign-dir <campaign>",
        ):
            with self.subTest(command=command):
                self.assertIn(command, self.reference)
        self.assertIn("PYTHONPATH=packages/opencode-overseer-relay/src", self.reference)
        self.assertIn("<target-root>/overseer-relay/runtime/0.2.0", self.reference)
        self.assertIn("python3 -B -m overseer_relay", self.reference)


class CoordinateSkillContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = COORDINATE.read_text(encoding="utf-8")
        cls.protocol = (COORDINATE_REFERENCES / "protocol.md").read_text(encoding="utf-8")
        cls.authority = (COORDINATE_REFERENCES / "authority-and-goals.md").read_text(encoding="utf-8")
        cls.recovery = (COORDINATE_REFERENCES / "recovery.md").read_text(encoding="utf-8")

    def test_short_skill_frontmatter_and_relative_links(self):
        self.assertLess(len(self.skill.splitlines()), 100)
        match = re.match(r"\A---\n(.*?)\n---\n", self.skill, re.DOTALL)
        self.assertIsNotNone(match)
        fields = dict((key.strip(), value.strip()) for line in match.group(1).splitlines() if ":" in line for key, value in (line.split(":", 1),))
        self.assertEqual(fields.get("name"), "overseer-coordinate")
        self.assertIn("A/B", fields.get("description", ""))
        self.assertIn("report", fields.get("description", ""))
        links = re.findall(r"\[[^]]+\]\(([^)]+)\)", self.skill)
        self.assertEqual(links, [
            "references/protocol.md",
            "references/authority-and-goals.md",
            "references/recovery.md",
        ])
        self.assertTrue(all((COORDINATE.parent / link).is_file() for link in links))

    def test_batch_ack_example_is_a_valid_protocol_frame(self):
        match = re.search(r"<!-- overseer-relay:begin (ack-batch-001) -->\s*```json\s*(.*?)\s*```\s*<!-- overseer-relay:end ack-batch-001 -->", self.protocol, re.DOTALL)
        self.assertIsNotNone(match)
        data = (
            f"<!-- overseer-relay:begin {match.group(1)} -->\n```json\n"
            f"{match.group(2)}\n```\n<!-- overseer-relay:end {match.group(1)} -->\n"
        ).encode("utf-8")
        parsed = parse(data, "example-campaign", "overseer", 1, worktree=None)
        self.assertEqual(parsed.entries[0].classification, "protocol")
        self.assertEqual(parsed.entries[0].kind, "batch-ack")
        self.assertRegex(parsed.entries[0].batch_id, r"\Ab-[0-9a-f]{64}\Z")

    def test_coordination_policy_and_recovery_boundaries(self):
        for phrase in (
            "worker-directed delivery beyond this fixed resume", "steers", "pause\ncontrols",
            "one concrete owner question", "never waive the gate", "Wait quietly",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, self.authority)
        for phrase in (
            "watcher/state.json", "stale-looking campaign lock", "uncertain",
            "blindly resend", "release", "once --campaign-dir", "status --campaign-dir",
            "controls/resume.jsonl", "do not loop",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, self.recovery)
        self.assertIn("resume --campaign-dir", self.authority)
        self.assertIn("resume --campaign-dir", self.protocol)
        for forbidden in ("steers", "pauses", "worker prompts"):
            self.assertIn(forbidden, self.authority)


if __name__ == "__main__":
    unittest.main()
