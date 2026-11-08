from tests.test_goal_resume import *
from tests.test_goal_resume import _managed_success


class GoalResumeCLITests(GoalResumeTests):
    def test_readonly_ledger_and_resume_cli_order_dry_run_force_and_failures(self):
        _common, root, journal, config, repo = self._campaign()
        self.assertEqual(journal.read_resume_ledger_readonly(), [])
        self.assertFalse((root / "controls").exists())

        runner = support.FakeRunner([_managed_success(), _managed_success()])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(["resume", "--campaign-dir", str(root), "--role", "B", "--role", "A",
                         "--role", "A", "--ruling", "cli-ruling", "--dry-run", "--json"], runner=runner)
        self.assertEqual(code, 0)
        self.assertEqual(runner.calls, [])
        self.assertFalse((root / "controls").exists())
        preview = json.loads(out.getvalue())
        self.assertEqual([r["role"] for r in preview["roles"]], ["A", "B"])

        runner = support.FakeRunner([_managed_success(), _managed_success()])
        with contextlib.redirect_stdout(io.StringIO()):
            code = main(["resume", "--campaign-dir", str(root), "--role", "B", "--role", "A",
                         "--role", "A", "--ruling", "cli-ruling", "--force"], runner=runner)
        self.assertEqual(code, 0)
        self.assertEqual(len(runner.calls), 2)
        self.assertEqual([json.loads(call[1]["input"])["binding"]["session_id"]
                          for call in runner.calls], [WORKER_SESSION, WORKER_B_SESSION])
        self.assertTrue(all(OVERSEER_SESSION not in call[1]["input"] for call in runner.calls))
        self.assertTrue(journal.read_resume_ledger_readonly())

    def test_required_arguments_and_capability_refusal(self):
        _common, root, journal, config, _repo = self._campaign()
        for args in (["resume", "--campaign-dir", str(root), "--ruling", "x"],
                     ["resume", "--campaign-dir", str(root), "--role", "A"]):
            with self.assertRaises(SystemExit):
                main(args)
        data = to_json_dict(config)
        data["capabilities"]["goal_resume"] = False
        atomic_write_json(root / "config.json", data)
        runner = support.FakeRunner()
        with contextlib.redirect_stdout(io.StringIO()):
            code = main(["resume", "--campaign-dir", str(root), "--role", "A",
                         "--ruling", "refused"], runner=runner)
        self.assertEqual(code, 1)
        self.assertEqual(runner.calls, [])
