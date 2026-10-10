# Isobar slow lane daemon

One serial subscription worker per host. The M2 Air is primary; the laptop is
standby. Machine settings and the scoped token live in owned mode-0600
`~/.local/state/isobar-chat-daemon/daemon.env`, never the plist or runner input.

The daemon posts to `/api/agent/claim`, replies with its host and opaque lease,
and releases unsuccessful work. `/pending` is retired. Polling and independent
heartbeats run every 20 seconds. `run.sh` applies `nice -n 10`. No API-key runner
exists. If capacity, login, network or supervisor access is unavailable, the job
stays queued. Expired leases are recovered by the next claim request.

Claude runs with the existing restricted archive MCP. Codex and Cursor require
a separate service account, a reviewed data copy and the trusted runtime
helper. Missing isolation disables fallbacks. Runtime priority is Claude → Codex
→ Cursor, using fresh, unexpired readings from `~/.local/bin/ai-capacity --json`.
A low Claude window or md3's busy signal yields the whole worker, including
cancelling active work at the next 20-second check. Stale busy files expire after
30 minutes; stale capacity never counts as headroom.

Deployment and supervisor setup is environment-specific and intentionally omitted
from this source projection.
`install.sh --install` only copies the LaunchAgent; it does not start it.

Offline checks from `web/`:

```sh
node_modules/.bin/vitest run tests/unit/agent.test.ts tests/unit/access-block.test.ts \
  tests/unit/chat-daemon.test.ts tests/unit/chat-daemon-ha.test.ts \
  tests/unit/chat-fallback.test.ts tests/unit/chat-health.test.ts
node_modules/.bin/tsc -p ../tools/chat-daemon/tsconfig.json
```

Tests use fake services and executables. No model, production database, login
flow or installed daemon is invoked. Local health is `node tools/chat-daemon/health.mjs` from the repository root; `--server` explicitly
opts into an authenticated health request.


### Evidence carried back to the conversation

The queue payload includes the original question, checked fast answer and gap
list. `SLOW.md` asks the runner to inventory archive stations/runs, sample 9–15
points for a region, read its relevant stations, and compare matching valid times
across runs. It returns a concise JSON `answer` plus `briefing.keyNumbers` and
`briefing.sources`; `runner.ts` strips the envelope before publishing. Plain-text
legacy output remains accepted. All fields are screened for private runtime data.

The server saves a successful slow reply and its per-thread briefing in one
transaction. That thread's later fast turns use Haiku with the saved evidence,
and request another archive check when it does not cover the new question.
Install the web `20261009140000_laptop_briefing` migration before deploying the
web code. No install, daemon restart, migration or publishing is part of local
tests. Mocked tests validate the prompt/payload contract, not live model coverage.
