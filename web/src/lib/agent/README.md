# Personal agent API

All endpoints use POST with `Authorization: Bearer <token>`. No browser
session or raw token is accepted in the body. Responses are private/no-store.
Tokens are random 256-bit secrets stored only as domain-separated AUTH_SECRET
HMACs. Revoked/deleted tokens cannot publish a reply. Rotating AUTH_SECRET
invalidates all tokens.

The operator runs `web/node_modules/.bin/tsx web/scripts/agent-token.ts --email
ADDRESS --label Laptop [--scope user|owner]` with the private database,
AUTH_SECRET and ISOBAR_OWNER_EMAIL in the environment. It prints the token once.
This local script is the only minting surface; no account UI/API is added.
Only the configured owner's exact email may receive owner scope. Store the token
in the daemon's private env file, never in a repo or a command argument. Revoke
by setting the token row's revokedAt. Account deletion cascades its tokens.

- `/api/agent/claim`: `{host, role, standbyMs?}` returns null or `{id, question, context, thread, user,
  leaseId, leaseUntil}`. A claim lasts 15 minutes. The opaque leaseId identifies
  this attempt, including when the same token/host reclaims an expired job.
  `role` is primary or standby; standby waits at least 90,000 ms (a larger
  `standbyMs` is allowed). Host is a stable machine identifier, not a credential.
  Retired `/api/agent/pending` returns 410, preventing an old daemon bypass.
- `/api/agent/reply`: `{id, leaseId, host, text, model, toolsUsed, images?, usage?}`.
  Text is at most 20,000 characters. Optional images are at most two inline PNGs
  (512 KB each, at most 2048×2048), `{src, alt}`; URL attachments are refused.
  Optional usage has promptTokens, completionTokens and latencyMs; absent values
  remain null. All visible text uses the fast lane's hard leak screen. A rejected
  answer returns 422 without storing it. A lost/expired lease returns 409.
- `/api/agent/release`: `{id, leaseId, host}`. Returns the held message to pending.
  Expiry is swept on the next claim request. Duplicate replies/releases fail.

- `/api/agent/heartbeat`: owner-only `{host, role, runtime, version}` updates
  the server-clock `lastSeen`. Host/token pairs retain independent history.
- `/api/agent/health`: owner-only aggregate backlog, delivery timestamp and
  host heartbeats; no conversation or token details. Neither endpoint claims work.

User tokens can claim only their own signed-in thread. Owner tokens serve the
owner first, then other pending jobs in creation order. Eligibility uses the
current effective Opus standing (pinned tier wins) and cluster suspension; the
owner is exempt from standing/suspension, but never from `AiAccessBlock`.
Active global/user blocks exclude claims and prevent delivery to the blocked
recipient. Releases remain allowed to clear work after a block. This follows the fast lane's existing access policy; there is
no separate invitation field yet. API budget pacing is never consulted.

A pending message stores its send-time map context. Older hand-offs recover that
snapshot from the preceding user question. Agents receive up to six exchanges,
with bounded content, never watcher/grade rows, emails, or account identifiers.
Learner level/goal are explicitly null until the product has such profile fields.
Model, tool names, optional tokens/latency, answer and inline images remain in the
private database. costUsd is API dollars: slow subscription replies write zero
and are excluded from the API spend ledger; no subscription price is inferred.

`GET /api/chat/thread[?id=THREAD]` requires a signed-in session, selects only that
user's thread (latest by default), and returns display-safe messages. Held bodies,
watcher rows, leases and private context are never returned. Polls use the shared
DB throttle. The panel polls only while its signed-in thread has an archive job.

Apply `20261008150000_agent_slow_lane` and `20261009130000_slow_lane_ha` separately before serving these routes.
The migration is intentionally not applied by the build or token script. The
lease tests exercise production Prisma predicates using an atomic in-memory
adapter and forced contention; they do not claim PostgreSQL integration coverage.
