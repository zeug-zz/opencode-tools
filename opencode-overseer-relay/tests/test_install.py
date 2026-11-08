#!/usr/bin/env python3
"""Offline tests for the gated, reversible artifact installer."""

from tests import support

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


INSTALLER_PATH = support.PACKAGE_ROOT / "scripts" / "install.py"
SPEC = importlib.util.spec_from_file_location("overseer_relay_installer", INSTALLER_PATH)
installer = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(installer)


def load_script(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


verify = load_script("overseer_relay_verify", support.PACKAGE_ROOT / "scripts" / "verify.py")
rollback = load_script("overseer_relay_rollback", support.PACKAGE_ROOT / "scripts" / "rollback.py")
CURRENT_VERSION = installer._package_version(installer._SOURCE_ROOT)
LEGACY_VERSION = "0.1.0"


class InstallTests(unittest.TestCase):
    def setUp(self):
        support.TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=support.TMP_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.target = self.root / "target"
        self.home = self.root / "fake-home"

    def invoke(self, *args, home=None):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = installer.main(list(args), home=self.home if home is None else home)
        return code, stdout.getvalue(), stderr.getvalue()

    def invoke_verify(self, target=None):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = verify.main(["--target-root", str(self.target if target is None else target)])
        return code, stdout.getvalue(), stderr.getvalue()

    def invoke_rollback(self, *options, target=None, home=None):
        stdout = io.StringIO()
        stderr = io.StringIO()
        args = ["--target-root", str(self.target if target is None else target), *options]
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = rollback.main(args, home=self.home if home is None else home)
        return code, stdout.getvalue(), stderr.getvalue()

    @staticmethod
    def snapshot_tree(root):
        if not root.exists():
            return None
        snapshot = {}
        for path in sorted(root.rglob("*")):
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                snapshot[relative] = ("symlink", os.readlink(path))
            elif path.is_dir():
                snapshot[relative] = ("directory",)
            elif path.is_file():
                snapshot[relative] = ("file", path.read_bytes())
            else:
                snapshot[relative] = ("other",)
        return snapshot

    @staticmethod
    def manifest_for_current_sources():
        artifacts = installer.collect_artifacts()
        return installer.validate_manifest(
            {
                "schema": installer.MANIFEST_SCHEMA,
                "schema_version": 1,
                "package": installer.PACKAGE_NAME,
                "package_version": artifacts[0].version,
                "install_id": "a" * 32,
                "records": [
                    {
                        "source": artifact.source,
                        "destination": artifact.destination,
                        "version": artifact.version,
                        "installed_sha256": artifact.sha256,
                        "prior_exists": False,
                        "prior_sha256": None,
                        "backup": None,
                        "backup_sha256": None,
                    }
                    for artifact in artifacts
                ],
            }
        )

    def apply_args(self, *options):
        return ("--target-root", str(self.target), "--apply", *options)

    def create_legacy_install(self, *, prior_destination=None, target=None):
        """Materialize a complete pre-0.2 install without managed helper files."""
        target = self.target if target is None else target
        install_id = "b" * 32
        artifacts = [
            artifact
            for artifact in installer.collect_artifacts()
            if not artifact.source.startswith("managed/dist/")
        ]
        records = []
        installed = {}
        backups = {}
        previous = b"legacy approved bytes\xff\x00"
        for artifact in artifacts:
            source = artifact.source
            content = artifact.content
            if source == "src/overseer_relay/__init__.py":
                content = b'"""Overseer relay package."""\n\n__version__ = "0.1.0"\n'
            destination = installer._expected_destination(source, LEGACY_VERSION)
            prior_exists = destination == prior_destination
            prior_hash = hashlib.sha256(previous).hexdigest() if prior_exists else None
            backup = f"overseer-relay/backups/{install_id}/{destination}" if prior_exists else None
            records.append(
                {
                    "source": source,
                    "destination": destination,
                    "version": LEGACY_VERSION,
                    "installed_sha256": hashlib.sha256(content).hexdigest(),
                    "prior_exists": prior_exists,
                    "prior_sha256": prior_hash,
                    "backup": backup,
                    "backup_sha256": prior_hash,
                }
            )
            installed[destination] = content
            if prior_exists:
                backups[backup] = previous

        manifest = installer.validate_manifest(
            {
                "schema": installer.MANIFEST_SCHEMA,
                "schema_version": 1,
                "package": installer.PACKAGE_NAME,
                "package_version": LEGACY_VERSION,
                "install_id": install_id,
                "records": records,
            }
        )
        for relative, content in installed.items():
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        for relative, content in backups.items():
            backup = target / relative
            backup.parent.mkdir(parents=True, exist_ok=True)
            backup.write_bytes(content)
        manifest_path = target / installer.MANIFEST_RELATIVE
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        return manifest, installed, backups, previous

    def copied_managed_dist(self, name):
        destination = self.root / name
        shutil.copytree(installer._MANAGED_DIST_ROOT, destination)
        return destination

    def test_preview_is_default_and_writes_nothing_for_missing_target(self):
        code, output, error = self.invoke("--target-root", str(self.target))

        self.assertEqual(code, 0, error)
        self.assertIn("preview:", output)
        self.assertIn("no writes", output)
        self.assertIn(f"overseer-relay/runtime/{CURRENT_VERSION}/src/overseer_relay/__init__.py", output)
        self.assertFalse(self.target.exists())

    def test_missing_target_root_is_a_cli_error(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
            installer.main([], home=self.home)
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("--target-root", stderr.getvalue())

    def test_apply_installs_fixed_runtime_and_both_complete_skills_with_hash_manifest(self):
        code, output, error = self.invoke(*self.apply_args())

        self.assertEqual(code, 0, error)
        artifacts = installer.collect_artifacts()
        manifest_path = self.target / installer.MANIFEST_RELATIVE
        manifest_bytes = manifest_path.read_bytes()
        manifest = installer.validate_manifest(json.loads(manifest_bytes))
        self.assertEqual(len(manifest["records"]), len(artifacts))
        records = {record["source"]: record for record in manifest["records"]}
        for artifact in artifacts:
            record = records[artifact.source]
            self.assertEqual(record["destination"], artifact.destination)
            self.assertEqual(record["version"], CURRENT_VERSION)
            self.assertEqual(record["installed_sha256"], hashlib.sha256(artifact.content).hexdigest())
            self.assertEqual((self.target / record["destination"]).read_bytes(), artifact.content)
            self.assertFalse(record["prior_exists"])
            self.assertIsNone(record["backup"])
            self.assertIsNone(record["backup_sha256"])

        expected_skills = {
            "skills/overseer-setup/SKILL.md",
            "skills/overseer-setup/references/setup-checklist.md",
            "skills/overseer-coordinate/SKILL.md",
            "skills/overseer-coordinate/references/protocol.md",
            "skills/overseer-coordinate/references/authority-and-goals.md",
            "skills/overseer-coordinate/references/recovery.md",
        }
        self.assertTrue(expected_skills.issubset(records))
        for source in expected_skills:
            self.assertTrue((self.target / source).is_file())
        self.assertTrue((self.target / f"overseer-relay/runtime/{CURRENT_VERSION}/src/overseer_relay/__init__.py").is_file())
        self.assertTrue((self.target / "overseer-relay/runtime/templates/campaign-config.json").is_file())
        self.assertTrue((self.target / "overseer-relay/runtime/scripts/install.py").is_file())
        self.assertTrue((self.target / "overseer-relay/runtime/scripts/verify.py").is_file())
        self.assertTrue((self.target / "overseer-relay/runtime/scripts/rollback.py").is_file())
        managed_records = [record for record in manifest["records"] if record["source"].startswith("managed/dist/")]
        self.assertEqual(len(managed_records), 26)
        for record in managed_records:
            relative = record["source"][len("managed/dist/") :]
            self.assertEqual(
                record["destination"],
                f"overseer-relay/runtime/{CURRENT_VERSION}/managed/dist/{relative}",
            )
            self.assertEqual(
                (self.target / record["destination"]).read_bytes(),
                (installer._MANAGED_DIST_ROOT / relative).read_bytes(),
            )
        self.assertFalse((self.target / ".overseer-relay-install.lock").exists())
        installed_paths = [path.relative_to(self.target).as_posix() for path in self.target.rglob("*")]
        self.assertFalse(any("__pycache__" in path or "/tests/" in path or "/tmp/" in path for path in installed_paths))
        self.assertIn("installed:", output)

    def test_installed_script_resolves_its_runtime_src_for_shared_helpers(self):
        code, _output, error = self.invoke(*self.apply_args())
        self.assertEqual(code, 0, error)
        installed_script = self.target / "overseer-relay/runtime/scripts/install.py"
        preview_target = self.root / "second-target"
        result = subprocess.run(
            [sys.executable, str(installed_script), "--target-root", str(preview_target)],
            check=False,
            capture_output=True,
            text=True,
            cwd=support.REPO_ROOT,
            env={**os.environ, "HOME": str(self.home)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("preview:", result.stdout)
        self.assertFalse(preview_target.exists())

    def test_installed_python_runtime_resolves_and_verifies_helper_without_running_it(self):
        code, _output, error = self.invoke(*self.apply_args())
        self.assertEqual(code, 0, error)
        installed_source = self.target / f"overseer-relay/runtime/{CURRENT_VERSION}/src"
        script = (
            "import sys; sys.path.insert(0, sys.argv[1]); "
            "from overseer_relay.transport import _managed_helper_path, _verify_managed_helper; "
            "path = _verify_managed_helper(); "
            "assert path == _managed_helper_path(); print(path)"
        )
        env = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
        result = subprocess.run(
            [sys.executable, "-B", "-c", script, str(installed_source)],
            check=False,
            capture_output=True,
            text=True,
            cwd=self.root,
            env=env,
        )
        expected = self.target / f"overseer-relay/runtime/{CURRENT_VERSION}/managed/dist/relay-managed.mjs"
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), str(expected))
        self.assertTrue(expected.is_file())

    def test_installed_verify_detects_managed_helper_hash_change_read_only(self):
        code, _output, error = self.invoke(*self.apply_args())
        self.assertEqual(code, 0, error)
        helper = self.target / f"overseer-relay/runtime/{CURRENT_VERSION}/managed/dist/relay-managed.mjs"
        helper.write_bytes(b"modified installed helper")
        before = self.snapshot_tree(self.target)
        verify_script = self.target / "overseer-relay/runtime/scripts/verify.py"
        env = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
        result = subprocess.run(
            [sys.executable, "-B", str(verify_script), "--target-root", str(self.target)],
            check=False,
            capture_output=True,
            text=True,
            cwd=self.root,
            env=env,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn(f'changed: "{helper.relative_to(self.target).as_posix()}"', result.stdout)
        self.assertEqual(self.snapshot_tree(self.target), before)

    def test_installed_verify_and_rollback_help_work_without_source_checkout(self):
        code, _output, error = self.invoke(*self.apply_args())
        self.assertEqual(code, 0, error)
        scripts = self.target / "overseer-relay/runtime/scripts"
        env = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
        env["HOME"] = str(self.home)
        for name in ("verify.py", "rollback.py"):
            with self.subTest(script=name):
                result = subprocess.run(
                    [sys.executable, str(scripts / name), "--help"],
                    check=False,
                    capture_output=True,
                    text=True,
                    cwd=self.root,
                    env=env,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("--target-root", result.stdout)
                self.assertNotIn("PYTHONPATH", env)
        self.assertFalse(any(path.name == "__pycache__" for path in scripts.parent.rglob("__pycache__")))

    def test_existing_file_requires_replace_flag_before_any_install_writes(self):
        artifact = installer.collect_artifacts()[0]
        destination = self.target / artifact.destination
        destination.parent.mkdir(parents=True)
        destination.write_bytes(b"owner-managed prior bytes")

        code, _output, error = self.invoke(*self.apply_args())

        self.assertEqual(code, 2)
        self.assertIn("--replace-existing", error)
        self.assertEqual(destination.read_bytes(), b"owner-managed prior bytes")
        self.assertFalse((self.target / installer.MANIFEST_RELATIVE).exists())
        self.assertFalse((self.target / installer.LOCK_RELATIVE).exists())

    def test_approved_replacement_is_backed_up_and_hash_verified(self):
        artifact = installer.collect_artifacts()[0]
        destination = self.target / artifact.destination
        destination.parent.mkdir(parents=True)
        previous = b"previous bytes, including non-UTF8: \xff\x00"
        destination.write_bytes(previous)

        code, _output, error = self.invoke(*self.apply_args("--replace-existing"))

        self.assertEqual(code, 0, error)
        manifest = installer.validate_manifest(json.loads((self.target / installer.MANIFEST_RELATIVE).read_bytes()))
        record = next(item for item in manifest["records"] if item["destination"] == artifact.destination)
        backup = self.target / record["backup"]
        self.assertTrue(record["prior_exists"])
        self.assertEqual(record["prior_sha256"], hashlib.sha256(previous).hexdigest())
        self.assertEqual(record["backup_sha256"], record["prior_sha256"])
        self.assertEqual(backup.read_bytes(), previous)
        self.assertEqual(hashlib.sha256(backup.read_bytes()).hexdigest(), record["backup_sha256"])
        self.assertEqual(destination.read_bytes(), artifact.content)

        verify_code, verify_output, verify_error = self.invoke_verify()
        self.assertEqual(verify_code, 0, verify_error)
        self.assertIn("verified:", verify_output)

        destination.unlink()
        backup.write_bytes(b"corrupt prior backup")
        verify_code, verify_output, verify_error = self.invoke_verify()
        self.assertEqual(verify_code, 2, verify_error)
        self.assertIn(f'missing: "{artifact.destination}"', verify_output)
        self.assertIn(f'changed backup: "{record["backup"]}"', verify_output)

    def test_total_prior_backup_bytes_are_bounded_before_apply_writes(self):
        artifact = installer.collect_artifacts()[0]
        destination = self.target / artifact.destination
        destination.parent.mkdir(parents=True)
        destination.write_bytes(b"123456")

        with patch.object(installer, "MAX_TOTAL_BACKUP_BYTES", 5):
            code, _output, error = self.invoke(*self.apply_args("--replace-existing"))

        self.assertEqual(code, 2)
        self.assertIn("backup size limit", error)
        self.assertEqual(destination.read_bytes(), b"123456")
        self.assertFalse((self.target / installer.MANIFEST_RELATIVE).exists())
        self.assertFalse((self.target / installer.LOCK_RELATIVE).exists())

    def test_global_apply_requires_separate_authorization_and_uses_injected_home(self):
        global_target = self.home / ".config" / "opencode"
        code, _output, error = self.invoke("--target-root", str(global_target), "--apply")
        self.assertEqual(code, 2)
        self.assertIn("--authorize-global-install", error)
        self.assertFalse(global_target.exists())

        code, _output, error = self.invoke(
            "--target-root",
            str(global_target),
            "--apply",
            "--authorize-global-install",
        )
        self.assertEqual(code, 0, error)
        self.assertTrue((global_target / installer.MANIFEST_RELATIVE).is_file())

    def test_lexical_escape_and_symlinked_target_components_are_rejected(self):
        escaped = self.root / "target" / ".." / "escape"
        code, _output, error = self.invoke("--target-root", str(escaped))
        self.assertEqual(code, 2)
        self.assertIn("traversal", error)
        self.assertFalse((self.root / "escape").exists())

        outside = self.root / "outside"
        outside.mkdir()
        link = self.root / "target-link"
        link.symlink_to(outside, target_is_directory=True)
        code, _output, error = self.invoke("--target-root", str(link / "nested"))
        self.assertEqual(code, 2)
        self.assertIn("symlink", error)
        self.assertFalse((outside / "nested").exists())

    def test_source_symlink_fifo_hardlink_and_oversized_reads_are_refused(self):
        source = self.root / "source.txt"
        source.write_bytes(b"source")
        symlink = self.root / "source-link.txt"
        symlink.symlink_to(source)
        with self.assertRaises(installer.InstallerError):
            installer._read_regular_file(symlink, limit=32)

        source_directory_link = self.root / "source-directory-link"
        source_directory_link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(installer.InstallerError):
            installer._read_regular_file(source_directory_link / "source.txt", limit=32)

        hardlink = self.root / "source-hardlink.txt"
        os.link(source, hardlink)
        with self.assertRaises(installer.InstallerError):
            installer._read_regular_file(hardlink, limit=32)

        oversized = self.root / "oversized.txt"
        oversized.write_bytes(b"12345")
        with self.assertRaises(installer.InstallerError):
            installer._read_regular_file(oversized, limit=4)

        if hasattr(os, "mkfifo"):
            fifo = self.root / "source-fifo"
            os.mkfifo(fifo)
            with self.assertRaises(installer.InstallerError):
                installer._read_regular_file(fifo, limit=32)

    def test_managed_inventory_rejects_missing_tampered_symlink_and_arbitrary_assets_before_writes(self):
        def expect_rejected(dist, label):
            target = self.root / f"target-{label}"
            with patch.object(installer, "_MANAGED_DIST_ROOT", dist):
                code, _output, error = self.invoke("--target-root", str(target))
            self.assertEqual(code, 2, label)
            self.assertIn("managed artifact", error, label)
            self.assertFalse(target.exists(), label)

        missing = self.copied_managed_dist("dist-missing")
        (missing / "relay-managed.mjs").unlink()
        expect_rejected(missing, "missing")

        tampered = self.copied_managed_dist("dist-tampered")
        (tampered / "core.mjs").write_bytes(b"tampered helper module\n")
        expect_rejected(tampered, "tampered")

        symlinked = self.copied_managed_dist("dist-symlinked")
        outside = self.root / "outside-module.mjs"
        outside.write_bytes(b"not a managed module")
        linked = symlinked / "contract.mjs"
        linked.unlink()
        linked.symlink_to(outside)
        expect_rejected(symlinked, "symlinked")

        unexpected = self.copied_managed_dist("dist-unexpected")
        (unexpected / "arbitrary-asset.mjs").write_text("export {};\n", encoding="utf-8")
        expect_rejected(unexpected, "arbitrary")

        user_dependency = self.copied_managed_dist("dist-node-modules")
        (user_dependency / "node_modules" / "unlisted").mkdir(parents=True)
        (user_dependency / "node_modules" / "unlisted" / "index.js").write_text("export {};\n", encoding="utf-8")
        expect_rejected(user_dependency, "node-modules")

        manifest_added = self.copied_managed_dist("dist-manifest-added")
        manifest_path = manifest_added / "artifact-manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        added_content = b"export {};\n"
        (manifest_added / "arbitrary-asset.mjs").write_bytes(added_content)
        manifest["files"].append(
            {
                "path": "arbitrary-asset.mjs",
                "size": len(added_content),
                "sha256": hashlib.sha256(added_content).hexdigest(),
            }
        )
        manifest["files"].sort(key=lambda entry: entry["path"])
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        expect_rejected(manifest_added, "manifest-added")

    def test_legacy_manifest_accepts_full_010_inventory_without_managed_helper_files(self):
        manifest, _installed, _backups, _previous = self.create_legacy_install()
        self.assertEqual(manifest["package_version"], LEGACY_VERSION)
        self.assertTrue(installer._REQUIRED_SOURCES.issubset({r["source"] for r in manifest["records"]}))
        self.assertFalse(any(r["source"].startswith("managed/dist/") for r in manifest["records"]))

        before = self.snapshot_tree(self.target)
        code, output, error = self.invoke_verify()

        self.assertEqual(code, 0, error)
        self.assertIn("package version 0.1.0", output)
        self.assertEqual(self.snapshot_tree(self.target), before)

    def test_legacy_backup_hash_and_escape_are_rejected_without_touching_install(self):
        destination = "skills/overseer-setup/SKILL.md"
        manifest, _installed, backups, _previous = self.create_legacy_install(prior_destination=destination)
        candidate = copy.deepcopy(manifest)
        prior_record = next(record for record in candidate["records"] if record["prior_exists"])
        prior_record["backup"] = "../escaped-backup"
        with self.assertRaises(installer.InstallerError):
            installer.validate_manifest(candidate)

        backup_path = self.target / next(iter(backups))
        backup_path.write_bytes(b"corrupt legacy backup")
        before = self.snapshot_tree(self.target)
        verify_code, verify_output, verify_error = self.invoke_verify()
        self.assertEqual(verify_code, 2, verify_error)
        self.assertIn(f'changed backup: "{next(iter(backups))}"', verify_output)

        rollback_code, _rollback_output, rollback_error = self.invoke_rollback("--apply")
        self.assertEqual(rollback_code, 2)
        self.assertIn("corrupt backup", rollback_error)
        self.assertEqual(self.snapshot_tree(self.target), before)
        self.assertTrue((self.target / installer.MANIFEST_RELATIVE).is_file())

    def test_legacy_rollback_restores_prior_bytes_and_preserves_old_receipts(self):
        destination = "skills/overseer-setup/SKILL.md"
        manifest, _installed, backups, previous = self.create_legacy_install(prior_destination=destination)
        old_receipt = self.target / "overseer-relay/rollback-receipts/older-install.json"
        old_receipt.parent.mkdir(parents=True, exist_ok=True)
        old_receipt_bytes = b'{"install_id":"older"}\n'
        old_receipt.write_bytes(old_receipt_bytes)

        verify_code, _verify_output, verify_error = self.invoke_verify()
        self.assertEqual(verify_code, 0, verify_error)
        rollback_code, output, rollback_error = self.invoke_rollback("--apply")

        self.assertEqual(rollback_code, 0, rollback_error)
        self.assertIn("backups retained", output)
        self.assertEqual((self.target / destination).read_bytes(), previous)
        self.assertEqual(old_receipt.read_bytes(), old_receipt_bytes)
        self.assertTrue((self.target / next(iter(backups))).is_file())
        self.assertFalse((self.target / installer.MANIFEST_RELATIVE).exists())
        new_receipt = self.target / "overseer-relay/rollback-receipts" / f"{manifest['install_id']}.json"
        self.assertTrue(new_receipt.is_file())
        self.assertEqual(json.loads(new_receipt.read_bytes())["package_version"], LEGACY_VERSION)

    def test_new_apply_refuses_existing_010_install_before_any_write(self):
        self.create_legacy_install()
        before = self.snapshot_tree(self.target)

        code, _output, error = self.invoke(*self.apply_args())

        self.assertEqual(code, 2)
        self.assertIn("rolled back with its matching 0.1.0 runtime", error)
        self.assertEqual(self.snapshot_tree(self.target), before)
        self.assertFalse((self.target / f"overseer-relay/runtime/{CURRENT_VERSION}").exists())

    def test_manifest_validator_rejects_absolute_traversal_and_credential_paths(self):
        valid = self.manifest_for_current_sources()
        for destination in ("/outside/file.py", "../outside.py", "C:/outside.py"):
            with self.subTest(destination=destination):
                candidate = copy.deepcopy(valid)
                candidate["records"][0]["destination"] = destination
                with self.assertRaises(installer.InstallerError):
                    installer.validate_manifest(candidate)

        candidate = copy.deepcopy(valid)
        candidate["token"] = "do-not-print"
        with self.assertRaises(installer.InstallerError):
            installer.validate_manifest(candidate)

        with self.assertRaises(installer.InstallerError):
            installer._expected_destination("tests/test_install.py", "0.1.0")

    def test_existing_manifest_allows_only_an_exact_unchanged_idempotent_noop(self):
        first_code, _output, first_error = self.invoke(*self.apply_args())
        self.assertEqual(first_code, 0, first_error)
        manifest_path = self.target / installer.MANIFEST_RELATIVE
        before = manifest_path.read_bytes()

        second_code, output, second_error = self.invoke(*self.apply_args())
        self.assertEqual(second_code, 0, second_error)
        self.assertIn("already installed", output)
        self.assertEqual(manifest_path.read_bytes(), before)

        artifact = installer.collect_artifacts()[0]
        destination = self.target / artifact.destination
        destination.write_bytes(b"intervening edit")
        third_code, _output, third_error = self.invoke(*self.apply_args("--replace-existing"))
        self.assertEqual(third_code, 2)
        self.assertIn("differs from its install manifest", third_error)
        self.assertEqual(destination.read_bytes(), b"intervening edit")
        self.assertEqual(manifest_path.read_bytes(), before)

    def test_incomplete_transaction_intent_is_preserved_after_failure(self):
        with patch.object(installer, "_atomic_install_file", side_effect=installer.InstallerError("injected failure")):
            code, _output, error = self.invoke(*self.apply_args())

        self.assertEqual(code, 2)
        self.assertIn("injected failure", error)
        intent = self.target / installer.INTENT_RELATIVE
        self.assertTrue(intent.is_file())
        self.assertFalse((self.target / installer.MANIFEST_RELATIVE).exists())
        self.assertFalse((self.target / installer.LOCK_RELATIVE).exists())

    def test_stale_lock_is_not_stolen(self):
        self.target.mkdir()
        lock = self.target / installer.LOCK_RELATIVE
        lock.write_text("stale", encoding="utf-8")

        code, _output, error = self.invoke(*self.apply_args())

        self.assertEqual(code, 2)
        self.assertIn("never stolen", error)
        self.assertEqual(lock.read_text(encoding="utf-8"), "stale")
        self.assertFalse((self.target / installer.MANIFEST_RELATIVE).exists())

    def test_oversized_manifest_load_is_bounded(self):
        manifest_path = self.target / installer.MANIFEST_RELATIVE
        manifest_path.parent.mkdir(parents=True)
        manifest_path.write_bytes(b" " * (installer.MAX_MANIFEST_BYTES + 1))

        code, _output, error = self.invoke("--target-root", str(self.target))

        self.assertEqual(code, 2)
        self.assertIn("unsafe or unreadable", error)

    def test_verify_reports_missing_changed_and_unexpected_without_writes(self):
        code, _output, error = self.invoke(*self.apply_args())
        self.assertEqual(code, 0, error)
        records = installer.validate_manifest(
            json.loads((self.target / installer.MANIFEST_RELATIVE).read_bytes())
        )["records"]
        missing = records[0]["destination"]
        changed = records[1]["destination"]
        (self.target / missing).unlink()
        (self.target / changed).write_bytes(b"edited after install")
        unexpected = "overseer-relay/runtime/unexpected.txt"
        (self.target / unexpected).write_text("not managed", encoding="utf-8")
        cache = self.target / f"overseer-relay/runtime/{CURRENT_VERSION}/src/overseer_relay/__pycache__/stale.pyc"
        cache.parent.mkdir(parents=True)
        cache.write_bytes(b"generated cache is not exempt")
        unrelated = self.target / "skills" / "unrelated" / "SKILL.md"
        unrelated.parent.mkdir(parents=True)
        unrelated.write_text("leave unrelated global skills alone", encoding="utf-8")
        before = self.snapshot_tree(self.target)

        verify_code, output, verify_error = self.invoke_verify()

        self.assertEqual(verify_code, 2, verify_error)
        self.assertIn(f'missing: "{missing}"', output)
        self.assertIn(f'changed: "{changed}"', output)
        self.assertIn(f'unexpected: "{unexpected}"', output)
        self.assertIn(f'unexpected: "overseer-relay/runtime/{CURRENT_VERSION}/src/overseer_relay/__pycache__/stale.pyc"', output)
        self.assertNotIn("skills/unrelated", output)
        self.assertEqual(self.snapshot_tree(self.target), before)
        self.assertFalse((self.target / installer.LOCK_RELATIVE).exists())

    def test_verify_is_read_only_when_all_installed_hashes_match(self):
        code, _output, error = self.invoke(*self.apply_args())
        self.assertEqual(code, 0, error)
        before = self.snapshot_tree(self.target)

        verify_code, output, verify_error = self.invoke_verify()

        self.assertEqual(verify_code, 0, verify_error)
        self.assertIn(f"package version {CURRENT_VERSION}", output)
        self.assertIn("no writes", output)
        self.assertEqual(self.snapshot_tree(self.target), before)

    def test_verify_rejects_unsafe_manifest_and_target_symlink(self):
        code, _output, error = self.invoke(*self.apply_args())
        self.assertEqual(code, 0, error)
        manifest_path = self.target / installer.MANIFEST_RELATIVE
        manifest = json.loads(manifest_path.read_bytes())
        manifest["records"][0]["destination"] = "../outside.py"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        outside = self.root / "outside.py"
        outside.write_text("leave unchanged", encoding="utf-8")
        manifest_before = manifest_path.read_bytes()

        verify_code, _output, verify_error = self.invoke_verify()

        self.assertEqual(verify_code, 2)
        self.assertIn("corrupt or unsafe", verify_error)
        self.assertNotIn("outside.py", verify_error)
        self.assertEqual(manifest_path.read_bytes(), manifest_before)
        self.assertEqual(outside.read_text(encoding="utf-8"), "leave unchanged")

        linked_target = self.root / "linked-target"
        linked_target.symlink_to(self.target, target_is_directory=True)
        verify_code, _output, verify_error = self.invoke_verify(target=linked_target)
        self.assertEqual(verify_code, 2)
        self.assertIn("symlink", verify_error)
        self.assertEqual(manifest_path.read_bytes(), manifest_before)

    def test_rollback_default_is_read_only_and_previews_all_actions(self):
        code, _output, error = self.invoke(*self.apply_args())
        self.assertEqual(code, 0, error)
        before = self.snapshot_tree(self.target)

        rollback_code, output, rollback_error = self.invoke_rollback()

        self.assertEqual(rollback_code, 0, rollback_error)
        self.assertIn("preview: rollback", output)
        self.assertIn("no writes", output)
        self.assertIn("remove installed file", output)
        self.assertEqual(self.snapshot_tree(self.target), before)
        self.assertFalse((self.target / installer.LOCK_RELATIVE).exists())

    def test_rollback_restores_approved_prior_skill_and_removes_new_files(self):
        prior_path = self.target / "skills/overseer-setup/SKILL.md"
        prior_path.parent.mkdir(parents=True)
        prior_bytes = b"owner's approved prior skill\xff\x00"
        prior_path.write_bytes(prior_bytes)
        code, _output, error = self.invoke(*self.apply_args("--replace-existing"))
        self.assertEqual(code, 0, error)
        manifest = installer.validate_manifest(
            json.loads((self.target / installer.MANIFEST_RELATIVE).read_bytes())
        )
        prior_record = next(record for record in manifest["records"] if record["destination"] == "skills/overseer-setup/SKILL.md")
        backup_path = self.target / prior_record["backup"]
        self.assertEqual(backup_path.read_bytes(), prior_bytes)
        verify_code, _output, verify_error = self.invoke_verify()
        self.assertEqual(verify_code, 0, verify_error)

        rollback_code, output, rollback_error = self.invoke_rollback("--apply")

        self.assertEqual(rollback_code, 0, rollback_error)
        self.assertIn("backups retained", output)
        self.assertEqual(prior_path.read_bytes(), prior_bytes)
        for record in manifest["records"]:
            destination = self.target / record["destination"]
            if record["destination"] != "skills/overseer-setup/SKILL.md":
                self.assertFalse(destination.exists(), record["destination"])
        self.assertFalse((self.target / installer.MANIFEST_RELATIVE).exists())
        receipt = self.target / "overseer-relay/rollback-receipts" / f"{manifest['install_id']}.json"
        self.assertTrue(receipt.is_file())
        receipt_value = json.loads(receipt.read_bytes())
        self.assertEqual(receipt_value["install_id"], manifest["install_id"])
        self.assertEqual(len(receipt_value["records"]), len(manifest["records"]))
        self.assertEqual(backup_path.read_bytes(), prior_bytes)
        self.assertFalse((self.target / installer.LOCK_RELATIVE).exists())

    def test_rollback_preflights_all_destinations_before_any_removal(self):
        code, _output, error = self.invoke(*self.apply_args())
        self.assertEqual(code, 0, error)
        manifest = installer.validate_manifest(
            json.loads((self.target / installer.MANIFEST_RELATIVE).read_bytes())
        )
        last_destination = manifest["records"][-1]["destination"]
        (self.target / last_destination).write_bytes(b"intervening owner edit")
        before = self.snapshot_tree(self.target)

        rollback_code, _output, rollback_error = self.invoke_rollback("--apply")

        self.assertEqual(rollback_code, 2)
        self.assertIn("intervening edit", rollback_error)
        self.assertEqual(self.snapshot_tree(self.target), before)
        self.assertFalse((self.target / installer.LOCK_RELATIVE).exists())

    def test_helper_edit_is_reported_by_verify_and_blocks_rollback(self):
        code, _output, error = self.invoke(*self.apply_args())
        self.assertEqual(code, 0, error)
        helper = self.target / f"overseer-relay/runtime/{CURRENT_VERSION}/managed/dist/relay-managed.mjs"
        helper.write_bytes(b"edited installed helper")
        before = self.snapshot_tree(self.target)

        verify_code, verify_output, verify_error = self.invoke_verify()
        self.assertEqual(verify_code, 2, verify_error)
        self.assertIn(f'changed: "{helper.relative_to(self.target).as_posix()}"', verify_output)

        rollback_code, _rollback_output, rollback_error = self.invoke_rollback("--apply")
        self.assertEqual(rollback_code, 2)
        self.assertIn("intervening edit", rollback_error)
        self.assertEqual(self.snapshot_tree(self.target), before)
        self.assertTrue((self.target / installer.MANIFEST_RELATIVE).is_file())

    def test_rollback_refuses_absent_or_corrupt_backup_before_any_change(self):
        for backup_state in ("missing", "corrupt"):
            with self.subTest(backup_state=backup_state):
                self.target = self.root / f"target-{backup_state}"
                prior_path = self.target / "skills/overseer-coordinate/references/recovery.md"
                prior_path.parent.mkdir(parents=True)
                prior_path.write_bytes(b"approved previous recovery reference")
                code, _output, error = self.invoke(*self.apply_args("--replace-existing"))
                self.assertEqual(code, 0, error)
                manifest = installer.validate_manifest(
                    json.loads((self.target / installer.MANIFEST_RELATIVE).read_bytes())
                )
                record = next(item for item in manifest["records"] if item["destination"] == "skills/overseer-coordinate/references/recovery.md")
                backup = self.target / record["backup"]
                if backup_state == "missing":
                    backup.unlink()
                else:
                    backup.write_bytes(b"corrupt backup")
                before = self.snapshot_tree(self.target)

                rollback_code, _output, rollback_error = self.invoke_rollback("--apply")

                self.assertEqual(rollback_code, 2)
                self.assertIn("backup", rollback_error)
                self.assertEqual(self.snapshot_tree(self.target), before)
                self.assertFalse((self.target / installer.LOCK_RELATIVE).exists())

    def test_rollback_uses_global_apply_authorization_gate(self):
        global_target = self.home / ".config" / "opencode"
        code, _output, error = self.invoke(
            "--target-root",
            str(global_target),
            "--apply",
            "--authorize-global-install",
        )
        self.assertEqual(code, 0, error)
        verify_code, _output, verify_error = self.invoke_verify(target=global_target)
        self.assertEqual(verify_code, 0, verify_error)
        before = self.snapshot_tree(global_target)

        rollback_code, _output, rollback_error = self.invoke_rollback(
            "--apply", target=global_target
        )

        self.assertEqual(rollback_code, 2)
        self.assertIn("--authorize-global-install", rollback_error)
        self.assertEqual(self.snapshot_tree(global_target), before)

        rollback_code, _output, rollback_error = self.invoke_rollback(
            "--apply",
            "--authorize-global-install",
            target=global_target,
        )
        self.assertEqual(rollback_code, 0, rollback_error)
        self.assertFalse((global_target / installer.MANIFEST_RELATIVE).exists())

    def test_rollback_rejects_unsafe_manifest_and_target_symlink(self):
        code, _output, error = self.invoke(*self.apply_args())
        self.assertEqual(code, 0, error)
        manifest_path = self.target / installer.MANIFEST_RELATIVE
        manifest = json.loads(manifest_path.read_bytes())
        manifest["records"][0]["destination"] = "../outside.py"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        before = self.snapshot_tree(self.target)

        rollback_code, _output, rollback_error = self.invoke_rollback("--apply")

        self.assertEqual(rollback_code, 2)
        self.assertIn("corrupt or unsafe", rollback_error)
        self.assertEqual(self.snapshot_tree(self.target), before)
        linked_target = self.root / "rollback-target-link"
        linked_target.symlink_to(self.target, target_is_directory=True)
        rollback_code, _output, rollback_error = self.invoke_rollback(target=linked_target)
        self.assertEqual(rollback_code, 2)
        self.assertIn("symlink", rollback_error)
        self.assertEqual(self.snapshot_tree(self.target), before)

    def test_rollback_does_not_steal_a_stale_installer_lock(self):
        code, _output, error = self.invoke(*self.apply_args())
        self.assertEqual(code, 0, error)
        lock = self.target / installer.LOCK_RELATIVE
        lock.write_text("stale lock evidence", encoding="utf-8")
        before = self.snapshot_tree(self.target)

        rollback_code, _output, rollback_error = self.invoke_rollback("--apply")

        self.assertEqual(rollback_code, 2)
        self.assertIn("never stolen", rollback_error)
        self.assertEqual(self.snapshot_tree(self.target), before)


if __name__ == "__main__":
    unittest.main()
