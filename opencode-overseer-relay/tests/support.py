"""Shared offline test helpers for the relay package."""

from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
SRC = PACKAGE_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

TMP_ROOT = REPO_ROOT / "tmp" / "overseer-relay-tests"


class TempGitRepo:
    def __init__(self):
        TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(dir=TMP_ROOT))
        self.worktrees = []
        self._env = os.environ.copy()
        self._env.update(GIT_CONFIG_NOSYSTEM="1", HOME=str(self.root))
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Relay Test")
        self.git("config", "user.email", "relay-test@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        (self.root / "README.md").write_text("Relay test repository\n")
        self.git("add", "README.md")
        self.git("commit", "-q", "-m", "initial commit")

    def git(self, *args):
        result = subprocess.run(
            ["git", *args], check=True, capture_output=True, text=True,
            cwd=self.root, env=self._env,
        )
        return result.stdout.strip()

    def add_worktree(self, name, branch):
        path = self.root.parent / (self.root.name + "-" + name)
        self.git("worktree", "add", "-q", "-b", branch, str(path))
        self.worktrees.append(path)
        return path

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        for path in [*self.worktrees, self.root]:
            if path.exists():
                shutil.rmtree(path, ignore_errors=False)


@dataclass
class FakeResult:
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""


class FakeRunner:
    def __init__(self, responses=None):
        self.responses = list(responses or [])
        self.calls = []

    def __call__(self, argv, *, timeout=None, input=None):
        self.calls.append((list(argv), {"timeout": timeout, "input": input}))
        if not self.responses:
            raise AssertionError("FakeRunner response queue is empty")
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


class FakeClock:
    def __init__(self, now=0.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds
