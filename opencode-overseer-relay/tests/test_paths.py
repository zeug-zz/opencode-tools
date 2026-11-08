#!/usr/bin/env python3
"""Tests for campaign path resolution and filesystem identity checks."""

from tests import support

import shutil
import tempfile
from pathlib import Path
import os
import unittest

from overseer_relay.paths import (
    GIT_TIMEOUT_SECONDS,
    PathError,
    assert_same_identity,
    campaign_dir,
    check_no_symlinks,
    confine_relative,
    file_identity,
    resolve_common_dir,
    validate_campaign_id,
)


class PathTests(unittest.TestCase):
    def setUp(self):
        support.TMP_ROOT.mkdir(parents=True, exist_ok=True)

    def test_main_repo_and_worktree_resolve_same_common_directory(self):
        with support.TempGitRepo() as repo:
            worktree = repo.add_worktree("worker", "worker")
            expected = Path(
                repo.git("rev-parse", "--path-format=absolute", "--git-common-dir")
            ).resolve()

            self.assertEqual(resolve_common_dir(repo.root), expected)
            self.assertEqual(resolve_common_dir(worktree), expected)

    def test_resolver_uses_bounded_argument_array_runner(self):
        with support.TempGitRepo() as repo:
            common_dir = Path(
                repo.git("rev-parse", "--path-format=absolute", "--git-common-dir")
            )
            runner = support.FakeRunner(
                [support.FakeResult(stdout=f"{common_dir}\n")]
            )

            self.assertEqual(resolve_common_dir(repo.root, runner=runner), common_dir)
            self.assertEqual(
                runner.calls,
                [(
                    ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
                    {"timeout": GIT_TIMEOUT_SECONDS, "input": None},
                )],
            )

    def test_non_repository_fails_without_echoing_git_output(self):
        with tempfile.TemporaryDirectory(dir=support.TMP_ROOT) as temporary:
            previous_git_dir = os.environ.get("GIT_DIR")
            os.environ["GIT_DIR"] = str(Path(temporary) / "not-a-git-directory")
            try:
                with self.assertRaises(PathError) as raised:
                    resolve_common_dir(Path(temporary))
            finally:
                if previous_git_dir is None:
                    os.environ.pop("GIT_DIR", None)
                else:
                    os.environ["GIT_DIR"] = previous_git_dir
        self.assertNotIn("fatal", str(raised.exception).lower())

    def test_campaign_id_validation_and_campaign_location(self):
        valid_ids = ("a", "0", "campaign-1", "phase1-worker2")
        for campaign_id in valid_ids:
            with self.subTest(campaign_id=campaign_id):
                self.assertEqual(validate_campaign_id(campaign_id), campaign_id)

        with tempfile.TemporaryDirectory(dir=support.TMP_ROOT) as temporary:
            self.assertEqual(
                campaign_dir(Path(temporary), "campaign-1"),
                Path(temporary) / "overseer-relay" / "campaigns" / "campaign-1",
            )

        invalid_ids = (
            "",
            ".",
            "..",
            "Upper",
            "has.dot",
            "-leading",
            "trailing-",
            "double--hyphen",
            "with/slash",
            "with\\backslash",
            "with space",
            "x" * 65,
        )
        for campaign_id in invalid_ids:
            with self.subTest(campaign_id=campaign_id):
                with self.assertRaises(PathError):
                    validate_campaign_id(campaign_id)

    def test_relative_confinement_rejects_absolute_and_invalid_paths(self):
        with tempfile.TemporaryDirectory(dir=support.TMP_ROOT) as temporary:
            root = Path(temporary)
            self.assertEqual(
                confine_relative(root, "reports/A.md"), root / "reports" / "A.md"
            )
            invalid_paths = (
                "../x",
                "a/../../x",
                str(root / "inside"),
                "",
                "a\x00b",
                "a//b",
                "a/./b",
                "C:/outside",
                "a\\b",
            )
            for relative_path in invalid_paths:
                with self.subTest(relative_path=relative_path):
                    with self.assertRaises(PathError):
                        confine_relative(root, relative_path)

    def test_symlinked_directory_and_file_components_are_rejected(self):
        with support.TempGitRepo() as repo:
            root = repo.root
            outside = root.parent / f"{root.name}-outside"
            outside.mkdir()
            directory_link = root / "linked-directory"
            file_link = root / "linked-file"
            directory_link.symlink_to(outside, target_is_directory=True)
            file_link.symlink_to(root / "README.md")
            try:
                with self.assertRaises(PathError):
                    check_no_symlinks(root, directory_link / "new.md", allow_missing=True)
                with self.assertRaises(PathError):
                    check_no_symlinks(root, file_link)
                with self.assertRaises(PathError):
                    file_identity(file_link)
            finally:
                shutil.rmtree(outside)

    def test_symlinked_root_is_rejected(self):
        with support.TempGitRepo() as repo:
            root_link = repo.root.parent / f"{repo.root.name}-root-link"
            root_link.symlink_to(repo.root, target_is_directory=True)
            try:
                with self.assertRaises(PathError):
                    check_no_symlinks(root_link, root_link / "README.md")
            finally:
                root_link.unlink()

    def test_replaced_root_is_detected_by_identity(self):
        with support.TempGitRepo() as repo:
            root = repo.root
            old_root = root.with_name(f"{root.name}-old")
            identity = file_identity(root)
            assert_same_identity(root, identity)

            root.rename(old_root)
            root.mkdir()
            try:
                with self.assertRaises(PathError):
                    assert_same_identity(root, identity)
            finally:
                shutil.rmtree(old_root)

    def test_missing_descendants_require_allow_missing(self):
        with support.TempGitRepo() as repo:
            target = repo.root / "not-created" / "nested" / "report.md"
            with self.assertRaises(PathError):
                check_no_symlinks(repo.root, target)
            check_no_symlinks(repo.root, target, allow_missing=True)


if __name__ == "__main__":
    unittest.main()
