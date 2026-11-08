"""Tests for shared offline test helpers."""

from pathlib import Path
import os
import subprocess
import unittest

from tests.support import FakeClock, FakeResult, FakeRunner, REPO_ROOT, TMP_ROOT, TempGitRepo


class SupportTests(unittest.TestCase):
    def test_temp_git_repo_and_worktree_are_cleaned_up(self):
        repo = TempGitRepo()
        root = repo.root
        worktree = None
        try:
            self.assertTrue(root.is_relative_to(REPO_ROOT / "tmp"))
            common_dir = Path(repo.git("rev-parse", "--git-common-dir"))
            self.assertTrue((root / common_dir).is_dir())
            worktree = repo.add_worktree("worker", "worker")
            self.assertEqual(
                repo.git("rev-parse", "--path-format=absolute", "--git-common-dir"),
                subprocess_git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"),
            )
        finally:
            repo.__exit__(None, None, None)
        self.assertFalse(root.exists())
        self.assertIsNotNone(worktree)
        self.assertFalse(worktree.exists())
        self.assertFalse(TMP_ROOT.exists() and any(TMP_ROOT.iterdir()))

    def test_fake_runner_records_returns_raises_and_exhausts(self):
        result = FakeResult(stdout="ok")
        runner = FakeRunner([result, ValueError("queued")])
        self.assertIs(runner(["git", "status"], timeout=3, input="data"), result)
        self.assertEqual(runner.calls, [(["git", "status"], {"timeout": 3, "input": "data"})])
        with self.assertRaisesRegex(ValueError, "queued"):
            runner(["git", "log"])
        with self.assertRaisesRegex(AssertionError, "empty"):
            runner(["git", "diff"])

    def test_fake_clock_advances(self):
        clock = FakeClock(1.5)
        self.assertEqual(clock(), 1.5)
        clock.advance(2.25)
        self.assertEqual(clock(), 3.75)


def subprocess_git(cwd, *args):
    env = os.environ.copy()
    env.update(GIT_CONFIG_NOSYSTEM="1", HOME=str(cwd))
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True,
                          capture_output=True, text=True).stdout.strip()


if __name__ == "__main__":
    unittest.main()
