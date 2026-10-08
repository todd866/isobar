#!/usr/bin/env python3
"""Run complete private native/Python checks and attest the exact tested commit.

Only the explicit publish action pushes, through normal Git hooks. Private
automatic hosted checks are off; this is an owner's local test result, not
independent hosted execution or server-enforced branch protection.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import tempfile
import tarfile
import time

POLICY = "isobar-local-v2"
POLICY_FILES = ["tools/native-gate.py", "tools/check-native-build.py", "build.sh",
                "tests.sh", "tools/sanitize.sh", "tools/prepare-local-python.sh",
                "tools/run-python-tests.py", "wall/pyproject.toml",
                ".github/workflows/native.yml", ".github/workflows/python.yml"]
COMMANDS = [["sh", "tools/prepare-local-python.sh"],
            ["build/ci-python/bin/python", "tools/run-python-tests.py", "Tests", "test_*.py"],
            ["build/ci-python/bin/python", "-m", "pytest", "wall", "-q", "--timeout=90", "--timeout-method=signal"],
            ["./build.sh"],
            ["python3", "tools/check-native-build.py"], ["./tools/sanitize.sh"]]
TIMEOUTS = [720, 360, 360, 1800, 60, 900]
MAX_AGE_SECONDS = 7 * 24 * 60 * 60
RECEIPT_PATH = ".ci/native-gate-receipt.json"
FIXED_ENV = {"ISOBAR_ADHOC": "1", "ISOBAR_BUNDLE_COLLECTOR": "0", "ISOBAR_CI_SLOW": "1",
             "ISOBAR_ARCHS": "native", "ISOBAR_PYTEST_TIMEOUT": "90"}


def git_environment(env=None):
    # A receipt names real Git objects, never a local refs/replace substitution.
    return dict(os.environ if env is None else env, GIT_NO_REPLACE_OBJECTS="1")


def git(root, *args, input=None, env=None):
    return subprocess.check_output(["git", "-C", str(root), *args], input=input,
                                   env=git_environment(env))


def capture_source(root):
    if git(root, "status", "--porcelain", "--untracked-files=all").strip():
        raise ValueError("Commit all source changes first; the native gate requires a clean checkout.")
    return {"commit": git(root, "rev-parse", "HEAD").decode().strip(),
            "tree": git(root, "rev-parse", "HEAD^{tree}").decode().strip()}


def policy_hash(root, sha):
    digest = hashlib.sha256()
    for path in POLICY_FILES:
        digest.update(path.encode() + b"\0" + git(root, "show", sha + ":" + path) + b"\0")
    return digest.hexdigest()


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def validate_receipt(receipt, source, expected_policy_hash, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    if receipt.get("schema") != 1 or receipt.get("policy") != POLICY or receipt.get("status") != "passed":
        raise ValueError("Native gate result is missing or unsuccessful.")
    if receipt.get("source") != source or receipt.get("policy_sha256") != expected_policy_hash:
        raise ValueError("Native gate result is stale: source or gate policy changed.")
    if receipt.get("environment") != FIXED_ENV or receipt.get("host", {}).get("system") != "Darwin":
        raise ValueError("Native gate environment does not match the macOS policy.")
    steps = receipt.get("steps", [])
    if len(steps) != len(COMMANDS):
        raise ValueError("Native gate result is incomplete.")
    for step, command, limit in zip(steps, COMMANDS, TIMEOUTS):
        elapsed = step.get("seconds")
        if (step.get("command") != command or step.get("exit_code") != 0
                or not isinstance(elapsed, (int, float)) or not 0 < elapsed <= limit + 10):
            raise ValueError("Native gate checks are missing, failed or out of order.")
    start = dt.datetime.fromisoformat(receipt["started_at"].replace("Z", "+00:00"))
    end = dt.datetime.fromisoformat(receipt["completed_at"].replace("Z", "+00:00"))
    if (start.tzinfo is None or end.tzinfo is None or start > end or end > now + dt.timedelta(minutes=5)
            or (now - end).total_seconds() > MAX_AGE_SECONDS
            or (end - start).total_seconds() > sum(TIMEOUTS) + 60
            or sum(s["seconds"] for s in steps) > (end - start).total_seconds() + 5):
        raise ValueError("Native gate result is expired or has invalid timestamps.")


@contextlib.contextmanager
def gate_lock(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError("A native gate is already running in this checkout.") from exc
        yield


def run_step(root, command, log, timeout, env):
    started = time.monotonic()
    with log.open("w") as output:
        child = subprocess.Popen(command, cwd=root, env=env, stdout=output,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = child.wait(timeout=timeout)
        except BaseException:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            raise
    if code:
        raise ValueError(f"{' '.join(command)} failed (exit {code}); read {log}")
    return {"command": command, "exit_code": code, "seconds": time.monotonic() - started}


def gate_environment():
    # Keep only normal process/locale plumbing. Shell build flags, Python
    # optimization/import overrides, test selectors and credentials cannot
    # silently change the gate's execution or leak into fixture subprocesses.
    allowed = {"PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM"}
    env = {key: value for key, value in os.environ.items() if key in allowed}
    env.update(FIXED_ENV)
    return env


def export_source(root, sha, destination):
    # Compile an immutable commit snapshot, never an editor's live checkout.
    archive = git(root, "archive", "--format=tar", sha)
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        source.extractall(destination, filter="data")


def run_gate(root, directory):
    # Remove previous success before any check; errors/interruption cannot leave it reusable.
    result = directory / "result.json"
    result.unlink(missing_ok=True)
    if platform.system() != "Darwin":
        raise ValueError("The complete native gate must run on macOS.")
    source = capture_source(root)
    env = gate_environment()
    receipt = {"schema": 1, "policy": POLICY, "status": "running", "source": source,
               "policy_sha256": policy_hash(root, source["commit"]), "started_at": utc_now(),
               "environment": FIXED_ENV, "host": {"system": platform.system(),
               "release": platform.release(), "machine": platform.machine(),
               "clang": subprocess.check_output(["xcrun", "clang", "--version"], text=True, env=env).strip(),
               "sdk": subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-version"], text=True, env=env).strip()},
               "steps": []}
    # Keep generated .app bundles out of cloud-managed Documents folders:
    # Finder metadata injected there makes strict ad-hoc signing fail. Logs
    # and the receipt stay in the checkout; only the immutable build is temporary.
    with tempfile.TemporaryDirectory(prefix="isobar-native-source-") as temporary:
        snapshot = Path(temporary)
        export_source(root, source["commit"], snapshot)
        for number, (command, timeout) in enumerate(zip(COMMANDS, TIMEOUTS), 1):
            log = directory / f"{number}.log"
            print(f"native gate {number}/{len(COMMANDS)}: {' '.join(command)} (log: {log})", flush=True)
            receipt["steps"].append(run_step(snapshot, command, log, timeout, env))
            if number == 1:
                # Native helper scripts also use the declared Python 3.12 env.
                env["PATH"] = str(snapshot / "build/ci-python/bin") + os.pathsep + env.get("PATH", "")
            if capture_source(root) != source:
                raise ValueError("Source changed while native checks were running; rerun on the final commit.")
    receipt.update(status="passed", completed_at=utc_now())
    validate_receipt(receipt, source, policy_hash(root, source["commit"]))
    temporary = directory / "result.tmp"
    temporary.write_text(json.dumps(receipt, indent=2) + "\n")
    temporary.replace(result)
    print(f"Native gate passed for {source['commit']}; result: {result}")
    return receipt


def read_result(root, directory, expected_sha=None):
    source = capture_source(root)
    if expected_sha and source["commit"] != expected_sha:
        raise ValueError("The outgoing commit is not this checkout's tested HEAD.")
    try:
        receipt = json.loads((directory / "result.json").read_text())
    except (OSError, ValueError) as exc:
        raise ValueError("No successful local native result. Run python3 tools/native-gate.py run.") from exc
    validate_receipt(receipt, source, policy_hash(root, source["commit"]))
    return receipt


def prepare_attestation(root, directory):
    receipt = read_result(root, directory)
    sha = receipt["source"]["commit"]
    # A temporary index leaves the owner's index and checkout untouched.
    if subprocess.run(["git", "-C", str(root), "cat-file", "-e", sha + ":" + RECEIPT_PATH],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                      env=git_environment()).returncode == 0:
        raise ValueError("The source tree must not contain the attestation receipt path.")
    with tempfile.TemporaryDirectory(prefix="isobar-native-proof-") as tmp:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(tmp) / "index"))
        git(root, "read-tree", sha, env=env)
        blob = git(root, "hash-object", "-w", "--stdin", input=(json.dumps(receipt, indent=2) + "\n").encode()).decode().strip()
        git(root, "update-index", "--add", "--cacheinfo", "100644", blob, RECEIPT_PATH, env=env)
        tree = git(root, "write-tree", env=env).decode().strip()
        proof = git(root, "commit-tree", tree, "-p", sha, input=f"Attest complete local native checks for {sha}\n".encode()).decode().strip()
    print(f"Receipt commit: {proof}\nPublish verified proof and exact source through normal Git hooks:\n  python3 tools/native-gate.py publish {proof}")
    return proof


def verify_attestation(root, directory, proof):
    receipt = read_result(root, directory)
    sha = receipt["source"]["commit"]
    parents = git(root, "rev-list", "--parents", "-n", "1", proof).decode().split()
    if len(parents) != 2 or parents[1] != sha:
        raise ValueError("Receipt commit must have exactly the tested candidate as parent.")
    diff = git(root, "diff-tree", "--no-commit-id", "--name-status", "-r", sha, proof).decode().strip()
    if diff != "A\t" + RECEIPT_PATH:
        raise ValueError("Receipt commit must only add the result file.")
    published = json.loads(git(root, "show", proof + ":" + RECEIPT_PATH))
    if published != receipt:
        raise ValueError("Receipt commit does not contain the current validated result.")


def publish_source(root, directory, proof):
    """Publish only verified source to private main; never disable normal hooks."""
    if not re.fullmatch(r"[0-9a-f]{40}", proof):
        raise ValueError("Publish requires the full receipt commit SHA.")
    verify_attestation(root, directory, proof)
    # Check every configured push destination, including pushurl overrides.
    urls = git(root, "remote", "get-url", "--push", "--all", "origin").decode().splitlines()
    allowed = {"https://github.com/todd866/isobar-private.git",
               "git@github.com:todd866/isobar-private.git",
               "ssh://git@github.com/todd866/isobar-private.git"}
    fetch_url = git(root, "remote", "get-url", "origin").decode().strip()
    if len(urls) != 1 or urls[0] not in allowed or fetch_url not in allowed:
        raise ValueError("Publish requires one canonical private Isobar origin push URL.")
    source = read_result(root, directory)["source"]
    ref = "refs/heads/local-ci/native-" + source["commit"]
    # A previous successful proof publication can be resumed, but not replaced.
    existing = git(root, "ls-remote", "--refs", "origin", ref).decode().split()
    if existing:
        if existing != [proof, ref]:
            raise ValueError("An existing proof ref differs; never overwrite it.")
    else:
        subprocess.run(["git", "-C", str(root), "push", "--no-follow-tags",
                        "--force-with-lease=" + ref + ":", "origin", proof + ":" + ref],
                       check=True, env=git_environment())
    # Recheck after network work; a changed/dirty source cannot reach main.
    read_result(root, directory, source["commit"])
    subprocess.run(["git", "-C", str(root), "push", "--no-follow-tags", "origin",
                    source["commit"] + ":refs/heads/main"], check=True, env=git_environment())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["run", "verify", "attest", "verify-proof", "publish"])
    parser.add_argument("sha", nargs="?")
    args = parser.parse_args()
    root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").decode().strip())
    directory = root / "build/native-gate"
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f"signal {signum}")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        if args.action == "publish":
            if not args.sha:
                raise ValueError("publish requires a receipt commit SHA.")
            # Git's installed pre-push guard acquires the gate lock itself.
            # Do not hold it across push or the normal hook would deadlock/fail.
            publish_source(root, directory, args.sha)
            return 0
        with gate_lock(directory):
            if args.action == "run":
                run_gate(root, directory)
            elif args.action == "verify":
                read_result(root, directory, args.sha)
                print("Exact-source local native result verified.")
            elif args.action == "verify-proof":
                if not args.sha:
                    raise ValueError("verify-proof requires a receipt commit SHA.")
                verify_attestation(root, directory, args.sha)
                print("Exact-source local native/Python proof commit verified.")
            else:
                prepare_attestation(root, directory)
    except (ValueError, KeyError, OSError, subprocess.SubprocessError, KeyboardInterrupt) as exc:
        print(f"native gate: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
