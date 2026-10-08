"""Fail-closed local gate tests use temporary Git repos and harmless subprocesses."""
import copy
import datetime as dt
import importlib.util
import json
import os
import plistlib
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("native_gate", ROOT / "tools/native-gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def receipt(source, policy):
    now = dt.datetime.now(dt.timezone.utc)
    return {"schema": 1, "policy": gate.POLICY, "status": "passed", "source": source,
            "policy_sha256": policy, "host": {"system": "Darwin", "clang": "fixture", "sdk": "fixture"},
            "environment": gate.FIXED_ENV,
            "started_at": (now - dt.timedelta(seconds=4)).isoformat().replace("+00:00", "Z"),
            "completed_at": now.isoformat().replace("+00:00", "Z"),
            "steps": [{"command": c, "exit_code": 0, "seconds": 1} for c in gate.COMMANDS]}


class GateStateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / "build/native-gate"
        self.directory.mkdir(parents=True)
        def git(*args):
            return gate.git(self.root, *args)
        self.git = git
        git("init", "-q")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        (self.root / ".gitignore").write_text("build/\n")
        for path in gate.POLICY_FILES:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("fixture source for " + path + "\n")
        git("add", ".")
        git("commit", "-qm", "fixture")
        self.source = gate.capture_source(self.root)
        self.policy = gate.policy_hash(self.root, self.source["commit"])
        self.result = receipt(self.source, self.policy)
        self.write_result()

    def write_result(self):
        (self.directory / "result.json").write_text(json.dumps(self.result))

    def test_exact_source_succeeds_and_other_push_sha_fails(self):
        gate.read_result(self.root, self.directory, self.source["commit"])
        with self.assertRaisesRegex(ValueError, "outgoing commit"):
            gate.read_result(self.root, self.directory, "0" * 40)

    def test_dirty_untracked_and_new_commit_invalidate_result(self):
        extra = self.root / "untracked.txt"
        extra.write_text("must be included in tested source")
        with self.assertRaisesRegex(ValueError, "clean checkout"):
            gate.read_result(self.root, self.directory)
        self.git("add", ".")
        self.git("commit", "-qm", "changed")
        with self.assertRaisesRegex(ValueError, "stale"):
            gate.read_result(self.root, self.directory)

    def test_expired_wrong_policy_wrong_tree_failed_and_reordered_results(self):
        changes = [lambda r: r.update(policy_sha256="bad"),
                   lambda r: r["source"].update(tree="bad"),
                   lambda r: r["steps"][1].update(exit_code=1),
                   lambda r: r.update(steps=list(reversed(r["steps"]))),
                   lambda r: r.update(steps=r["steps"][:-1]),
                   lambda r: r.update(completed_at="2020-01-01T00:00:00Z", started_at="2020-01-01T00:00:00Z")]
        for change in changes:
            with self.subTest(change=change):
                result = copy.deepcopy(self.result)
                change(result)
                with self.assertRaises(ValueError):
                    gate.validate_receipt(result, self.source, self.policy)

    def test_failed_and_interrupted_rerun_removes_previous_success(self):
        for error in [ValueError("failed fixture"), KeyboardInterrupt()]:
            with self.subTest(error=type(error).__name__):
                self.write_result()
                with mock.patch.object(gate.platform, "system", return_value="Darwin"), \
                     mock.patch.object(gate, "capture_source", return_value=self.source), \
                     mock.patch.object(gate, "policy_hash", return_value=self.policy), \
                     mock.patch.object(gate, "export_source"), \
                     mock.patch.object(gate.subprocess, "check_output", return_value="fixture"), \
                     mock.patch.object(gate, "run_step", side_effect=error):
                    with self.assertRaises(type(error)):
                        gate.run_gate(self.root, self.directory)
                self.assertFalse((self.directory / "result.json").exists())

    def test_source_change_during_run_cannot_record_success(self):
        changed = dict(self.source, tree="changed")
        with mock.patch.object(gate.platform, "system", return_value="Darwin"), \
             mock.patch.object(gate, "capture_source", side_effect=[self.source, changed]), \
             mock.patch.object(gate, "policy_hash", return_value=self.policy), \
             mock.patch.object(gate, "export_source"), \
             mock.patch.object(gate.subprocess, "check_output", return_value="fixture"), \
             mock.patch.object(gate, "run_step", return_value=self.result["steps"][0]):
            with self.assertRaisesRegex(ValueError, "Source changed"):
                gate.run_gate(self.root, self.directory)
        self.assertFalse((self.directory / "result.json").exists())

    def test_complete_gate_builds_in_os_temp_and_keeps_only_result_and_logs(self):
        original_output = subprocess.check_output
        snapshots = []
        def output(command, *args, **kwargs):
            if command[0] == "xcrun":
                return "fixture toolchain"
            return original_output(command, *args, **kwargs)
        def step(snapshot, command, log, timeout, env):
            self.assertEqual(snapshot.parent, Path(tempfile.gettempdir()))
            self.assertNotEqual(snapshot, self.root)
            self.assertEqual((snapshot / "build.sh").read_text(), "fixture source for build.sh\n")
            snapshots.append(snapshot)
            log.write_text("fixture passed\n")
            return {"command": command, "exit_code": 0, "seconds": 0.001}
        with mock.patch.object(gate.platform, "system", return_value="Darwin"), \
             mock.patch.object(gate.subprocess, "check_output", side_effect=output), \
             mock.patch.object(gate, "run_step", side_effect=step):
            result = gate.run_gate(self.root, self.directory)
        self.assertEqual(len(snapshots), len(gate.COMMANDS))
        self.assertTrue(all(not p.exists() for p in snapshots))
        self.assertEqual(result["status"], "passed")
        gate.read_result(self.root, self.directory)

    def test_snapshot_uses_commit_even_when_live_source_is_edited(self):
        original = (self.root / "build.sh").read_text()
        (self.root / "build.sh").write_text("uncommitted replacement")
        destination = self.directory / "snapshot"
        gate.export_source(self.root, self.source["commit"], destination)
        self.assertEqual((destination / "build.sh").read_text(), original)
        self.assertFalse((destination / ".git").exists())

    def test_replacement_refs_cannot_substitute_tested_source_or_policy(self):
        original = (self.root / "build.sh").read_text()
        (self.root / "build.sh").write_text("replacement source must never be tested")
        self.git("add", "build.sh")
        self.git("commit", "-qm", "replacement")
        replacement = self.git("rev-parse", "HEAD").decode().strip()
        self.git("reset", "--hard", self.source["commit"])
        self.git("replace", self.source["commit"], replacement)
        # Confirm that an ordinary Git read sees the substitution in this fixture.
        raw_env = dict(os.environ)
        raw_env.pop("GIT_NO_REPLACE_OBJECTS", None)
        substituted = subprocess.check_output(["git", "-C", str(self.root), "show",
            self.source["commit"] + ":build.sh"], env=raw_env).decode()
        self.assertEqual(substituted, "replacement source must never be tested")
        self.assertEqual(gate.capture_source(self.root), self.source)
        self.assertEqual(gate.policy_hash(self.root, self.source["commit"]), self.policy)
        destination = self.directory / "snapshot"
        gate.export_source(self.root, self.source["commit"], destination)
        self.assertEqual((destination / "build.sh").read_text(), original)
        proof = gate.prepare_attestation(self.root, self.directory)
        gate.verify_attestation(self.root, self.directory, proof)

    def test_replacement_ref_cannot_make_invalid_proof_valid(self):
        valid = gate.prepare_attestation(self.root, self.directory)
        invalid = gate.git(self.root, "commit-tree", self.source["tree"], "-p", self.source["commit"],
                           input=b"Missing receipt\n").decode().strip()
        self.git("replace", invalid, valid)
        with self.assertRaisesRegex(ValueError, "only add the result"):
            gate.verify_attestation(self.root, self.directory, invalid)

    def test_lock_rejects_concurrent_gate(self):
        with gate.gate_lock(self.directory):
            with self.assertRaisesRegex(ValueError, "already running"):
                with gate.gate_lock(self.directory):
                    self.fail("second gate acquired lock")

    def test_attestation_only_adds_receipt_and_preserves_index(self):
        old_index = self.git("ls-files", "--stage")
        proof = gate.prepare_attestation(self.root, self.directory)
        self.assertEqual(self.git("ls-files", "--stage"), old_index)
        self.assertEqual(gate.capture_source(self.root), self.source)
        gate.verify_attestation(self.root, self.directory, proof)
        with self.assertRaisesRegex(ValueError, "exactly the tested candidate"):
            gate.verify_attestation(self.root, self.directory, self.source["commit"])

    def test_native_only_receipt_cannot_replace_complete_local_checks(self):
        result = copy.deepcopy(self.result)
        result["policy"] = "isobar-native-v1"
        result["steps"] = result["steps"][1:]
        with self.assertRaises(ValueError):
            gate.validate_receipt(result, self.source, self.policy)

    def test_publish_orders_proof_before_exact_source_and_rechecks_source(self):
        proof = "a" * 40
        ref = "refs/heads/local-ci/native-" + self.source["commit"]
        private = b"https://github.com/todd866/isobar-private.git\n"
        for existing in [b"", f"{proof}\t{ref}\n".encode()]:
            with self.subTest(existing=bool(existing)), \
                 mock.patch.object(gate, "verify_attestation") as verify, \
                 mock.patch.object(gate, "read_result", return_value=self.result) as read, \
                 mock.patch.object(gate, "git", side_effect=[private, private, existing]), \
                 mock.patch.object(gate.subprocess, "run") as push:
                gate.publish_source(self.root, self.directory, proof)
                verify.assert_called_once_with(self.root, self.directory, proof)
                read.assert_has_calls([mock.call(self.root, self.directory),
                    mock.call(self.root, self.directory, self.source["commit"])])
                expected = [] if existing else [["git", "-C", str(self.root), "push", "--no-follow-tags",
                    "--force-with-lease=" + ref + ":", "origin", proof + ":" + ref]]
                expected.append(["git", "-C", str(self.root), "push", "--no-follow-tags", "origin",
                    self.source["commit"] + ":refs/heads/main"])
                self.assertEqual([call.args[0] for call in push.call_args_list], expected)
                for call in push.call_args_list:
                    self.assertTrue(call.kwargs["check"])
                    self.assertEqual(call.kwargs["env"]["GIT_NO_REPLACE_OBJECTS"], "1")

    def test_publish_refuses_public_or_multiple_remotes_and_changed_proof(self):
        private = b"https://github.com/todd866/isobar-private.git\n"
        public = b"https://github.com/todd866/isobar.git\n"
        for answers in [[public, private], [private + public, private], [private, public],
                        [private, private, b"different refs/heads/local-ci/native-wrong\n"]]:
            with self.subTest(answers=answers), \
                 mock.patch.object(gate, "verify_attestation"), \
                 mock.patch.object(gate, "read_result", return_value=self.result), \
                 mock.patch.object(gate, "git", side_effect=answers), \
                 mock.patch.object(gate.subprocess, "run") as push:
                with self.assertRaises(ValueError):
                    gate.publish_source(self.root, self.directory, "a" * 40)
                push.assert_not_called()

    def test_publish_does_not_send_source_after_failure_or_source_change(self):
        private = b"https://github.com/todd866/isobar-private.git\n"
        for failure in ["proof", "source"]:
            with self.subTest(failure=failure), \
                 mock.patch.object(gate, "verify_attestation"), \
                 mock.patch.object(gate, "read_result", side_effect=[self.result, ValueError("changed")]), \
                 mock.patch.object(gate, "git", side_effect=[private, private, b""]), \
                 mock.patch.object(gate.subprocess, "run", side_effect=(
                     subprocess.CalledProcessError(1, "push") if failure == "proof" else None)) as push:
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    gate.publish_source(self.root, self.directory, "a" * 40)
                self.assertEqual(push.call_count, 1)

    def test_push_guard_checks_source_proofs_and_preserves_private_boundary(self):
        # Exercise the real hook's dispatch without running native checks.
        stub = self.root / "tools/native-gate.py"
        stub.write_text("import sys\nfrom pathlib import Path\nPath('build/hook-call').write_text(' '.join(sys.argv[1:]))\nraise SystemExit(0 if sys.argv[-1] != 'bad' else 1)\n")
        hook = ROOT / "tools/git-hooks/pre-push-private"
        marker = self.root / "build/hook-call"
        def push(remote, target, sha="a" * 40):
            marker.unlink(missing_ok=True)
            return subprocess.run(["sh", str(hook), "origin", remote], cwd=self.root,
                input=f"refs/heads/main {sha} {target} {'0' * 40}\n", text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        remote = "https://github.com/todd866/isobar-private.git"
        self.assertEqual(push(remote, "refs/heads/main").returncode, 0)
        self.assertEqual(marker.read_text(), "verify " + "a" * 40)
        self.assertEqual(push(remote, "refs/heads/local-ci/native-" + "a" * 40).returncode, 0)
        self.assertEqual(marker.read_text(), "verify-proof " + "a" * 40)
        self.assertNotEqual(push(remote, "refs/heads/main", "bad").returncode, 0)
        self.assertEqual(push(remote, "refs/heads/main", "0" * 40).returncode, 0)
        self.assertFalse(marker.exists())
        self.assertEqual(push("https://github.com/todd866/isobar-data-private.git", "refs/heads/main").returncode, 0)
        self.assertFalse(marker.exists())
        self.assertNotEqual(push("https://github.com/todd866/isobar.git", "refs/heads/main").returncode, 0)
        self.assertFalse(marker.exists())


class SubprocessTests(unittest.TestCase):
    def test_artifact_checks_reject_invalid_outputs_even_with_python_optimization(self):
        namespace = {"__name__": "artifact_check_fixture"}
        source = (ROOT / "tools/check-native-build.py").read_text()
        exec(compile(source, "artifact-check-fixture", "exec", optimize=1), namespace)
        info = plistlib.dumps({"CFBundleShortVersionString": "1.9.0", "LSMinimumSystemVersion": "15.0"})
        for outputs in [["wrong"], ["Isobar 1.9.0", "missing help"],
                        ["Isobar 1.9.0", "animated weather maps", "minos 14.0"]]:
            with self.subTest(outputs=outputs), \
                 mock.patch.object(Path, "read_bytes", return_value=info), \
                 mock.patch.object(subprocess, "check_output", side_effect=outputs):
                with self.assertRaises(RuntimeError):
                    namespace["main"]()

    def test_failure_timeout_and_process_group_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "exit 7"):
                gate.run_step(root, [sys.executable, "-c", "raise SystemExit(7)"], root / "failed.log", 5, os.environ)
            marker = root / "child-stopped"
            # The child uses a SIGTERM handler so timeout cleanup is observable.
            code = ("import signal,time,pathlib; "
                    f"signal.signal(signal.SIGTERM,lambda *args:(pathlib.Path({str(marker)!r}).write_text('stopped'),exit(0))); "
                    "time.sleep(60)")
            with self.assertRaises(subprocess.TimeoutExpired):
                gate.run_step(root, [sys.executable, "-c", code], root / "timeout.log", 0.5, os.environ)
            self.assertEqual(marker.read_text(), "stopped")

    def test_override_environment_is_removed(self):
        with mock.patch.dict(os.environ, {"ISOBAR_QA_STORE": "/owner/archive", "CC": "/fake/compiler", "ISOBAR_ADHOC": "0", "PYTHONOPTIMIZE": "1", "C_INCLUDE_PATH": "/fake/headers", "GH_TOKEN": "fixture-token"}):
            env = gate.gate_environment()
        self.assertNotIn("ISOBAR_QA_STORE", env)
        self.assertNotIn("CC", env)
        self.assertNotIn("PYTHONOPTIMIZE", env)
        self.assertNotIn("C_INCLUDE_PATH", env)
        self.assertNotIn("GH_TOKEN", env)
        for key, value in gate.FIXED_ENV.items():
            self.assertEqual(env[key], value)


if __name__ == "__main__":
    unittest.main()
