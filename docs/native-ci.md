# Private local validation

Private native and Python checks run on the local Mac. Automatic pushes and pull
requests in `todd866/isobar-private` allocate **no native or Python Actions runner**:
the shared workflows can appear as skipped runs, but every job is skipped. Public
`todd866/isobar` pushes and pull requests retain the complete automatic native and
Python job bodies. Private Pages and weather collection remain intentionally
paused and are not changed by this policy.

## Test and publish an exact commit

Requirements: macOS 15+, Xcode Command Line Tools, `python3`, `python3.12`, and
FFmpeg/ffprobe in PATH. The gate creates a disposable Python 3.12 virtual environment
and installs pytest, pytest-timeout, Pillow, NumPy and SciPy. Package versions are
recorded in the first log. Installation needs package-index access; it changes no
global Python installation. Dependencies are resolved at run time, as in the
existing hosted workflow; an exact source receipt does not claim a locked dependency
environment. Node is needed only for workflow-routing regression checks.

1. Commit final changes in an isolated worktree. The gate rejects dirty or
   untracked source. Run `python3 tools/native-gate.py run`.
2. The gate exports the exact Git commit to OS temporary storage and runs six
   ordered, required stages. No stage is optional:

   | Stage | Complete command | Timeout |
   |---|---|---|
   | Python environment | `sh tools/prepare-local-python.sh` | 12 minutes |
   | Python unit tests | `build/ci-python/bin/python tools/run-python-tests.py Tests 'test_*.py'` | 6 minutes; 90 seconds per test |
   | Wall tests | `build/ci-python/bin/python -m pytest wall -q --timeout=90 --timeout-method=signal` | 6 minutes; 90 seconds per test |
   | Native build/tests | `./build.sh` | 30 minutes |
   | Native artifact checks | `python3 tools/check-native-build.py` | 1 minute |
   | Sanitizers | `./tools/sanitize.sh` | 15 minutes |

   Native helpers use the same prepared Python 3.12 environment. The unchanged
   build runs native assertions, offscreen playback/jank and layer/app acceptance.
   Artifact checks cover version, help and deployment target. Sanitizers retain
   ASan, UBSan and ThreadSanitizer. The app is ad-hoc signed, excludes the collector,
   and is never installed or launched as the interactive app.
3. The result and six logs are under ignored `build/native-gate/`. A new run
   invalidates old success before doing work. Failure, interruption, timeout or
   source changes leave no reusable success. Child process groups and temporary
   source/virtual environments are cleaned up. No real weather archive or TV wall
   cache is needed; fixture tests stay in the background.
4. Run `python3 tools/native-gate.py attest`. It creates a receipt-only Git commit
   with the tested commit as its sole parent, without changing checkout or index.
   The proof ref is candidate-specific: `local-ci/native-<source-sha>`; the name is
   retained for compatibility, but policy `isobar-local-v2` now requires Python
   **and** native results. The source tree must not contain
   `.ci/native-gate-receipt.json`.
5. Run `python3 tools/native-gate.py publish <full-receipt-commit-sha>`. This is the
   only gate action that pushes. It verifies clean exact source, complete local
   results and the receipt-only child commit, accepts only the canonical private
   Isobar origin, and publishes proof before the exact tested SHA to `main`.
   Normal Git hooks remain enabled. Proof creation uses a create-only lease;
   an identical existing proof can be resumed, but a differing ref is refused.
   Git replacement refs are ignored throughout source/proof verification and
   publication. Both pushes explicitly disable automatic tag following, so only
   the named proof and main refs are published.
   Main uses a normal fast-forward push, never force. Concurrent main changes
   require integration and a fresh exact-source gate. A changed checkout between
   proof and source publication is rejected. Do not edit or rerun the gate in
   the same worktree while publishing.

Receipts bind the exact commit/tree, gate-policy source hash, all ordered successful
commands, fixed environment and timestamps. They expire after seven days. An older
native-only result, rebase, squash or merge needs a new complete result. Expired
published proof refs are not replaced; create and validate a new candidate commit.
The existing private pre-push guard also validates outgoing branch source/proofs
when installed. Do not bypass it if it refuses.

## Trust and enforcement

These are owner-run local results, not independent hosted execution. The local
publish command fails closed, but **there is no server-side proof verifier** after
this change. A direct Git/API push can bypass the local procedure; a clone without
an installed hook has no hook enforcement. Old worktrees run their own older gate
policy until updated. This change does not install shared hooks, alter branch
protection or prevent a repository writer from deliberately forging a receipt.
Use the current reviewed publish command for private main. Git author metadata
is not authentication, and candidate-specific refs are not protected against a
writer deliberately rewriting them outside this procedure.

A failed rerun invalidates local success only. An already-published proof remains
readable until expiry; if later testing finds a defect, repair and validate a new
commit before publication. Local macOS/Python 3.12 replaces the hosted Ubuntu/Python
3.12 Python environment: the tests and timeout assertions are retained, but Linux
platform coverage is no longer automatic. Existing optional real-archive test skips
remain explicit. Local CPU, time and availability replace included Actions minutes.

## Manual fallback and regression checks

Manually dispatch Native macOS build for both complete native jobs, or Python for
its full Ubuntu suite, when a platform difference needs investigation. These
private manual runs consume allowance and do not create a local receipt. Public
mirror automatic job bodies remain unchanged. Do not enable private Pages/weather.

`python3 -m unittest discover -s Tests -p test_native_gate.py` checks source/policy
binding, incomplete/failed/stale results, interruption, process cleanup, receipts
and private publication ordering/refusal. `node --test tools/test-native-proof.cjs`
checks that every private automatic job skips, public checks remain enabled and
manual fallbacks retain their full commands. Python gate tests also run inside
both complete Python discovery and the native suite.

## Rollback

Restore automatic private validation by removing the public/manual conditions from
native `build`/`sanitize` and Python `test`. Keep all test bodies. Alternatively
restore the prior complete workflow policy and its matching receipt verifier
from version control. Keep private/public history guards and paused service
workflows. Rollback does not require an application, data or public-mirror change.
