# Isobar AI billing

Implemented locally, 9 October 2026. No live Stripe account, database migration,
deployment, push or payment has been performed by this change.

Isobar AI costs **US$5/month or US$50/year**, plus applicable tax. The selling
business is **Coherence Dynamics Australia Pty Ltd**. Stripe Checkout and Customer
Portal collect payment information; Isobar never receives card details. Business
identity, invoice footer and ABN come from the Stripe account settings.

## Owner/Claude setup after the Stripe account exists

1. In Stripe, enter the legal business details and invoice footer/ABN. Configure
   Stripe Tax's business address, appropriate product tax treatment and applicable
   registrations, including Australian GST. Checkout enables automatic tax and
   collects billing address/tax IDs; overseas calculation follows Stripe Tax's
   configured rules. Enabling `automatic_tax` does not create tax registrations.
2. Supply `STRIPE_SECRET_KEY` and `BILLING_SITE_URL=https://isobar.md` to the
   process environment, then run `cd web && npm run billing:setup`. Do not paste
   keys into a shell command, source file or committed env file. This **writes to
   Stripe**: it creates/reuses the Isobar AI product and the USD 500-cent monthly
   and 5000-cent yearly Prices, then configures the default Customer Portal for
   payment methods, invoices, interval changes and period-end cancellation.
   It validates reused Price terms and prints only their IDs. It does not set
   the merchant's identity or invoice footer.
3. Register `https://isobar.md/api/billing/webhook` in Stripe, using API version
   `2024-06-20`. Subscribe to `customer.subscription.created`, `.updated`,
   `.deleted`, `checkout.session.completed`, `.async_payment_succeeded`,
   `.async_payment_failed`, `invoice.paid`, and `invoice.payment_failed`.
4. Claude sets these **sensitive Vercel environment variables** after the owner
   supplies the account: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`. IDs are supplied by the script,
   never embedded in code. All four must exist to offer the paid tier.
   `BILLING_SITE_URL` is optional nonsecret configuration, defaulting to
   `https://isobar.md`; set it explicitly for another deployment. Payment POSTs
   require that exact browser Origin, and return URLs never trust Host headers.
5. Apply `web/prisma/migrations/20261009160000_billing` through the normal manual
   `npm run db:migrate` flow, then build/deploy only with separate authorization.
   Existing tables and records are unchanged; `Entitlement` and `BillingEvent`
   are additive. Regenerate Prisma client locally with `prisma generate`.
6. Before live use, verify the configured Stripe test-mode Checkout, tax,
   invoices, portal interval changes, cancellation, webhook delivery and deletion.
   This implementation's tests mock all provider calls; they do not verify the
   owner's future account settings or create any test/live Stripe objects.

## State and access

Checkout and Portal require the authenticated user and same-origin POST. Neither
accepts a user ID, customer ID or Price ID from the browser. A successful return
URL is only a hint to refresh the Account row, never proof of payment.

A verified webhook maps the Stripe customer to the existing account and reads
current subscriptions from Stripe. Recognized Price, quantity, customer and user
metadata must agree. Entitlement changes and the event receipt commit in one
transaction under a per-user row lock. Duplicate deliveries do no work; historical
payloads cannot overwrite current state. Failed provider/database calls return
503 so Stripe retries. Raw signature verification accepts a five-minute timestamp
window, multiple v1 signatures for key rotation, and at most 1 MiB of body data.

`active` with a recognized plan and a current period grants access. Scheduled
cancellation keeps the subscription active until its end. `past_due`, `unpaid`,
`incomplete`, `incomplete_expired`, `trialing`, immediate `canceled`, deletion and
expired periods do not grant paid access. The period check still expires access
if the ending webhook is delayed. Payment recovery can restore it.

Checkout creation uses provider idempotency keys, reuses open sessions and checks
current subscriptions before creating another. A missing local Checkout response
can be recovered from the customer's open sessions. Customer binding commits
before the Checkout operation. Account deletion expires pending sessions and
deletes the Stripe customer, which cancels all subscriptions, including an
in-flight Checkout. Local deletion occurs only after provider success or confirmed
prior customer deletion. Failure leaves the account intact for retry. Invoice
records may remain with Stripe. Do not remove keys before canceling existing
subscriptions: local deletion deliberately fails if a linked customer cannot be
managed.

The provider read deliberately occurs under the user lock so concurrent and
out-of-order events cannot commit stale snapshots. Each provider call times out
after 10 seconds; lock admission is 10 seconds and the transaction limit is 60
seconds. A timeout rolls back and returns a retryable error. Monitor Stripe's
failed deliveries; this trades a short per-user lock for consistent access.

## AI allowance

Constants live in `web/src/lib/billing/budgets.ts`. With billing enabled, free
signed-in accounts and signed-out devices use a US$1 UTC-calendar-month budget:
short Haiku replies from $0.80, rest at $1. A plain free-limit Upgrade link is
atomically claimed at most once per UTC day per account/device. Anonymous daily
sign-in quotas remain in force. Account is the sole ordinary upgrade placement.

The integrated fast lane remains Haiku for everyone unless the operator explicitly
lifts `ISOBAR_CHAT_FAST_CAP`. Paid budget ceilings are Opus below $5, Sonnet below
$8, Haiku below $10, then short Haiku; they never lift that fast cap. Existing
safety standing, suspensions and the global governor still apply. Every admitted
signed-in answer retains its automatic laptop check, including reduced standing
tiers, with at most one pending/claimed job per user. Topic gaps, current-conversation
briefings, device blocks and cancellation/lease checks remain unchanged. Paid users
receive slow-queue priority after the owner and before free users, FIFO within each group. Both queue selection and
claim keep existing authorization/block checks.

Paid spend resets on monthly subscription anniversaries, including monthly
slices of yearly billing. Month-end anchors clamp to February's last day and
return to the original day in longer months. The owner remains outside personal
budgets. Watchers, grades and billed failures count; slow-lane work does not.
The $10 point is a **soft ceiling** because the specified Haiku-short band still
uses the API. Spend gates use the recorded ledger, not reservations: concurrent
in-flight replies can cross a threshold before their usage is recorded.

## Local verification

`web/tests/unit/billing.test.ts`, `billing-routes.test.ts`, `billing-chat.test.ts`
and the billing section in `chat.test.ts` cover signature tampering/replay,
transaction rollback/idempotency, current-state reconciliation, access expiry,
yearly monthly windows, customer isolation, tax fields, creation/reuse, deletion
retry, paid bands, the default Haiku cap and automatic laptop checks, free daily
notices and priority.
The provider is an injected mock; no network is used.

`web/tests/e2e/billing.spec.ts` uses mocked APIs and headless Playwright. It covers
checkout/portal actions, hidden self-host billing, errors/retry, disposal, delayed
webhook-shaped state, Escape, and laptop/phone/light/dark/text-enlarged viewports.
It supports `ISOBAR_E2E_FILES=1` after a build; screenshots target
`build/billing-qa/`. Actual captures are required before UI acceptance.

Reapplied onto integration `484e907` on branch `codex/billing-2`.
`npm test -- --maxWorkers=1` passes: **81 files, 808 tests, 3 fixture skips**.
The first unrestricted run timed out only in unchanged CIFP parsing and particle
lifetime tests; both pass with one worker and the existing five-second limits.
Prisma generation and `cd training && npm run build` also pass. Logs are local,
under `build/billing-qa/` (`unit-serial.log`, `tsc.log`, `build.log`,
`resources.log`, `browser.log`, `native.log`).

The production build and `tsc --noEmit` pass. The mocked billing browser suite
cannot start Chromium: macOS denies `MachPortRendezvousServer` registration in
this sandbox. No screenshots were produced. `./tests.sh` reaches the GPU map
check and stops at `FAIL Metal field view is available`; preceding Python/native
checks pass or explicitly skip their absent Metal device.

Claude's remaining acceptance work:

- Run `cd web && npm run test:e2e -- tests/e2e/billing.spec.ts --project=chromium --workers=1` with headless Chromium permitted. Inspect actual viewport captures
  under `build/billing-qa/`: 1280×720, 390×844, 844×390, both themes and 200% text.
  Verify Upgrade/Manage, delayed confirmation, retry, Escape and late-response
  disposal; provider APIs are mocked by that spec.
- Check the integrated map surfaces with `chat-topic.spec.ts`, `chat-escalation.spec.ts`,
  `chat-ux.spec.ts`, `desktop-header.spec.ts`, `phone-layout.spec.ts`,
  `traffic-symbology.spec.ts`, `traffic.spec.ts`, `sounding-ground.spec.ts`
  and `fly-anywhere.spec.ts`. Keep place links, Earlier,
  cancel/reply-ready controls, header close buttons, phone fit, traffic D and the
  ground-level profile. The existing suites and their source are unchanged here.
- Rerun `./tests.sh` where Metal is available. This billing branch changes no
  native/sky source. Integration `484e907` has no Mac sky-resource target; its
  existing resource builder is `cd training && npm run build`. The separate
  painted-cloud feature and its sky bundle were not copied into this branch.

The standing refuter's merge concerns were checked against the code. Billing
activation uses the same environment policy in production chat and queue stores;
signed-out device blocks still prevent admission, and signed-out answers never
queue laptop work. Stripe subscriptions must carry matching account metadata;
importing pre-existing provider customers is outside this implementation.
A separate pre-existing follow-up remains: device hashes are checked at admission,
but not passed to the live stop-switch checks between provider rounds. This
reapplication preserves that behavior; it does not claim to fix mid-request
signed-out device blocking.
