"""Package import and command help tests."""

import contextlib
import importlib
import io
from pathlib import Path
import sys
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SOURCE))


class PackageTests(unittest.TestCase):
    def test_package_and_modules_import(self):
        package = importlib.import_module("overseer_relay")
        self.assertEqual(package.__version__, "0.2.0")
        for name in ("cli", "config", "paths", "journal", "mailbox", "watcher", "transport"):
            importlib.import_module(f"overseer_relay.{name}")

    def test_help_lists_commands(self):
        cli = importlib.import_module("overseer_relay.cli")
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as raised:
            cli.main(["--help"])
        self.assertEqual(raised.exception.code, 0)
        for command in ("inspect", "init", "once", "watch", "status", "hold", "release"):
            self.assertIn(command, output.getvalue())
