/**
 * POST /api/chat, without Next or Prisma. The route supplies the session,
 * the store and fetch. Grading comes back as `later` so the route can run it
 * from `after()` and the stream is never held for it.
 */

import { ACCESS_REST_LINE } from './access-block';
import { FREE_MONTHLY_USD, freeTier, isPaid, paidTier, spendForIdentity, upgradeNoticeId } from '../billing/budgets';
import { billingEnabled as billingPolicyEnabled, monthlyWindow, type Entitlement } from '../billing/policy';
import { randomUUID } from 'node:crypto';
import { ARCHIVE_CHECKING, archiveRow, parseArchiveGaps } from './archive';
import { readBriefing } from './briefing';
import { AnthropicError, completeAnthropic, modelFor, type ToolSpec } from './anthropic';
import {
  PUBLIC_CAPS, SIGNED_IN_TOTAL_USD, USER_CAP_USD, chooseTier, envUsd, graderOpen, haikuRemainingToday,
  publicSpend, publicTier, signedInRatio, signedInTotal, userBudgetTier, userSpend,
} from './budgets';
import { accountFlagged, clusterEmail, isDisposableEmail, nextBlock, resolveClusterId } from './cluster';
import { captureContext, type ReleaseIdentity } from './context';
import { exampleBlock, exampleContext } from './examples';
import { capTier, govern, ledgerSince, throttledTier, type GovernorDecision } from './governor';
import { handoffInstead, questionNeedsArchive } from './handoff';
import { clientIp, cookieHeader, cookieValue, DEVICE_COOKIE, hashSecret, newDevice, readDevice } from './identity';
import { anchorsFromTools } from './links';
import { messageCostUsd } from './pricing';
import { AUS_UNITS, unitsSystemLine } from '../units';
import { buildChatPrompt, REPORT_CHAT_GUIDANCE, systemPrompt } from './prompt';
import { currentConversation } from './topic';
import { anonDecision, quotaKeys } from './quota';
import { downgradeTier, inGoodStanding, initialTier, parseGrade, parseGradeVerdict, parseTier, standingAfterGrade } from './standing';
import type { ChatStore, ClusterRow, StoredMessage } from './store';
import { MAX_TOOL_ROUNDS, reportToolSpec, runTool, toolSpecs, type PublishedChart } from './tools';
import { LINES, monthRestLine, utcDay, type ChatContext, type Grade, type Tier } from './types';
import {
  buildGradePrompt, buildPostCheckPrompt, buildPreScreenPrompt, complexQuestion, parsePostCheck, parsePreScreen, postScreen, HARD_LINES,
} from './watcher';

/** Short questions only (owner: "restrict messages to relatively short input"). */
export const MAX_SIGNED_IN_CHARS = 1_500;
export const MAX_ANON_CHARS = 500;
/** How long an address a suspended cluster used starts newcomers on Haiku. */
export const IP_FLAG_MS = 7 * 24 * 60 * 60_000;

export interface ChatSession {
  userId: string;
  email: string | null;
  createdAt: Date;
}

export interface ChatDeps {
  now: Date;
  apiKey: string | undefined;
  authSecret: string;
  ownerEmail: string | null;
  publicCaps: { opus: number; sonnet: number; haiku: number };
  userCap: number;
  signedInTotal: number;
  resendKey: string | null;
  emailFrom: string | null;
  governor: { totalUsd: number | null; windowStart: Date | null; windowEnd: Date | null };
  /** Highest fast-lane model. Haiku unless ISOBAR_CHAT_FAST_CAP lifts it. */
  fastCap?: 'opus' | 'sonnet' | 'haiku';
  store: ChatStore;
  chart: PublishedChart;
  release: ReleaseIdentity;
  fetchImpl: typeof fetch;
  originBlocked: boolean;
  secureCookie: boolean;
  session: ChatSession | null;
  /** Stripe is opt-in; absent keeps the pre-billing chat behavior. */
  billingEnabled?: boolean;
  entitlement?: Entitlement | null;
  /** Signed-in report command, backed by the server report service. */
  reportCommand?: (input: unknown, threadId: string) => Promise<unknown>;
}

export interface ChatOutcome {
  response: Response;
  later?: () => Promise<void>;
}

function json(body: unknown, status: number, cookie?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'private, no-store' });
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

type Emit = (event: Record<string, unknown>) => void;
type StreamResult = { meta: Record<string, unknown>; later?: () => Promise<void> };

/** Start delivery before any model call. Keep persistence/checking alive on disconnect. */
function streamReply(run: (emit: Emit) => Promise<StreamResult>, cookie?: string): ChatOutcome {
  const encoder = new TextEncoder();
  let cancelled = false;
  let work: Promise<StreamResult | undefined>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit: Emit = (event) => { if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
      work = run(emit).then((result) => {
        emit({ done: true, ...result.meta });
        return result;
      }).catch(() => { emit({ done: true, replace: LINES.failed, failed: true }); return undefined; })
        .finally(() => { if (!cancelled) controller.close(); });
    },
    cancel() { cancelled = true; },
  });
  const headers = new Headers({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'private, no-store, no-transform', 'x-accel-buffering': 'no' });
  if (cookie) headers.set('set-cookie', cookie);
  return { response: new Response(body, { status: 200, headers }), later: async () => { const result = await work; await result?.later?.(); } };
}

/** Labels describe the tool being executed, never a timer's guessed progress. */
export function toolStatus(name: string, input: unknown, chart: PublishedChart): string {
  const row = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (name === 'find_place') return `Finding ${String(row.name ?? 'the place').slice(0, 60)}…`;
  if (name === 'aerodrome_weather') return `Checking METAR/TAF ${String(row.icao ?? '').toUpperCase().slice(0, 4)}…`;
  if (name === 'sample_region') return 'Sampling the region…';
  if (name === 'run_info') return 'Reading the forecast run…';
  if (name === 'request_archive_analysis') return 'Requesting archive analysis…';
  const place = chart.places.find((place) => typeof row.lat === 'number' && typeof row.lon === 'number'
    && Math.abs(place[1] - row.lat) < 0.05 && Math.abs(place[2] - row.lon) < 0.05)?.[0];
  return name === 'point_profile' ? `Reading ${place ? `${place}’s` : 'the'} profile…`
    : `Reading the ${place ? `${place} ` : ''}chart…`;
}

export function chatAvailability(apiKey: string | undefined): Response {
  if (!apiKey) return json({ unavailable: true }, 503);
  return json({ ok: true }, 200);
}

export function chatEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    apiKey: env.ISOBAR_ANTHROPIC_API_KEY,
    authSecret: env.AUTH_SECRET ?? '',
    ownerEmail: clusterEmail(env.ISOBAR_OWNER_EMAIL),
    publicCaps: {
      opus: envUsd(env.ISOBAR_CHAT_PUBLIC_OPUS_USD, PUBLIC_CAPS.opus),
      sonnet: envUsd(env.ISOBAR_CHAT_PUBLIC_SONNET_USD, PUBLIC_CAPS.sonnet),
      haiku: envUsd(env.ISOBAR_CHAT_PUBLIC_HAIKU_USD, PUBLIC_CAPS.haiku),
    },
    userCap: envUsd(env.ISOBAR_CHAT_USER_USD, USER_CAP_USD),
    signedInTotal: envUsd(env.ISOBAR_CHAT_SIGNED_IN_TOTAL_USD, SIGNED_IN_TOTAL_USD),
    resendKey: env.RESEND_API_KEY ?? null,
    emailFrom: env.EMAIL_FROM ?? null,
    fastCap: env.ISOBAR_CHAT_FAST_CAP === 'opus' || env.ISOBAR_CHAT_FAST_CAP === 'sonnet' ? env.ISOBAR_CHAT_FAST_CAP : 'haiku',
    governor: {
      totalUsd: envTotal(env.ISOBAR_CHAT_TOTAL_USD),
      windowStart: envDate(env.ISOBAR_CHAT_CREDIT_START),
      windowEnd: envDate(env.ISOBAR_CHAT_CREDIT_END),
    },
    billingEnabled: billingPolicyEnabled(env),
  };
}

function envDate(raw: string | undefined): Date | null {
  if (!raw?.trim()) return null;
  const date = new Date(raw.trim());
  return Number.isFinite(date.getTime()) ? date : null;
}

function envTotal(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isOwner(email: string | null, ownerEmail: string | null): boolean {
  return !!ownerEmail && clusterEmail(email) === ownerEmail;
}

async function haikuCall(deps: ChatDeps, system: string, prompt: string) {
  if (await deps.store.accessBlocked(deps.session?.userId ?? null)) return null;
  const model = modelFor('haiku');
  try {
    const done = await completeAnthropic({
      // Haiku 5.5 thinks before it answers; effort low and room to finish, or the
      // verdict line never arrives and every reply is held.
      apiKey: deps.apiKey ?? '', model: model.model, effort: 'low', maxTokens: 2_000, system,
      messages: [{ role: 'user', content: prompt }], fetchImpl: deps.fetchImpl,
    });
    return {
      text: done.text, promptTokens: done.promptTokens, completionTokens: done.completionTokens,
      cost: messageCostUsd(model.model, done.promptTokens, done.completionTokens), model: model.model,
    };
  } catch (error) {
    // A billed failure is still spend: record it (empty text parses as no verdict).
    if (error instanceof AnthropicError && (error.promptTokens ?? 0) + (error.completionTokens ?? 0) > 0) {
      const promptTokens = error.promptTokens ?? 0;
      const completionTokens = error.completionTokens ?? 0;
      return { text: '', promptTokens, completionTokens, cost: messageCostUsd(model.model, promptTokens, completionTokens), model: model.model };
    }
    return null;
  }
}

export function earlierTurns(history: StoredMessage[], context: unknown, now: Date): { question: string; answer: string }[] {
  history = currentConversation(history.filter((item) => item.role === 'user' || item.role === 'assistant'), { context, createdAt: now });
  const turns: { question: string; answer: string }[] = [];
  for (let i = 0; i < history.length; i += 1) {
    if (history[i].role !== 'user') continue;
    const end = history.findIndex((item, index) => index > i && item.role === 'user');
    const answer = history.slice(i + 1, end < 0 ? undefined : end).find((item) => item.role === 'assistant' && item.lane === 'fast' && item.status === 'complete' && item.content);
    if (answer) turns.push({ question: history[i].content, answer: answer.content });
  }
  return turns.slice(-6);
}

async function writeTier(store: ChatStore, userIds: string[], tier: string): Promise<void> {
  for (const userId of userIds) {
    const current = await store.standing(userId);
    await store.setStanding(userId, tier, current?.pinnedTier ?? null);
  }
}

export async function postChat(request: Request, deps: ChatDeps): Promise<ChatOutcome> {
  if (deps.originBlocked) return { response: json({ error: 'origin' }, 403) };
  if (await deps.store.accessBlocked(deps.session?.userId ?? null)) return { response: json({ line: ACCESS_REST_LINE, resting: true }, 200) };
  if (!deps.apiKey) return { response: json({ unavailable: true }, 503) };

  let body: unknown;
  try { body = await request.json(); } catch { return { response: json({ error: 'body' }, 400) }; }
  const row = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  const message = typeof row?.message === 'string' ? row.message.trim() : '';
  const maxChars = deps.session ? MAX_SIGNED_IN_CHARS : MAX_ANON_CHARS;
  if (!message) return { response: json({ error: 'message' }, 400) };
  if (message.length > maxChars) return { response: json({ error: 'message', line: `Keep it under ${maxChars} characters` }, 400) };
  const context = captureContext(row?.context, deps.release);
  if (!context) return { response: json({ error: 'context' }, 400) };

  const ip = clientIp(request);
  let cookieOut: string | undefined;
  let deviceId: string | null = null;
  if (deps.authSecret) {
    deviceId = readDevice(cookieValue(request.headers.get('cookie'), DEVICE_COOKIE), deps.authSecret);
    if (!deviceId) {
      const minted = newDevice(deps.authSecret);
      deviceId = minted.id;
      cookieOut = cookieHeader(minted.cookie, deps.secureCookie);
    }
  }
  const deviceHash = deps.authSecret && deviceId ? hashSecret(deps.authSecret, 'device', deviceId) : null;
  const ipHash = deps.authSecret ? hashSecret(deps.authSecret, 'ip', ip) : null;
  const email = clusterEmail(deps.session?.email);
  const owner = isOwner(deps.session?.email ?? null, deps.ownerEmail);
  const entitlement = deps.billingEnabled && deps.session
    ? (deps.entitlement === undefined ? await deps.store.entitlement?.(deps.session.userId) ?? null : deps.entitlement)
    : null;
  const paid = !owner && isPaid(entitlement, deps.now);
  if (!deps.session && !deviceHash) return { response: json({ line: LINES.signIn, signIn: true }, 200, cookieOut) };
  if (deviceHash && await deps.store.accessBlocked(deps.session?.userId ?? null, deviceHash)) return { response: json({ line: ACCESS_REST_LINE, resting: true }, 200, cookieOut) };

  // A shared address (campus, carrier NAT) is not an identity: IP hashes only
  // rate-limit and never link accounts, so a stranger cannot get a genuine user
  // on the same network blocked or downgraded.
  const links = await deps.store.linksMatching(deviceHash, null, email);
  const matched = resolveClusterId({
    deviceHash, ipHash: null, email, signedUpAtMs: deps.session ? deps.session.createdAt.getTime() : null,
  }, links, []);
  const clusterId = matched.clusterId ?? randomUUID();
  const cluster = await deps.store.ensureCluster(clusterId);
  if (deviceHash && !links.some((link) => link.kind === 'device' && link.hash === deviceHash)) await deps.store.addLink(clusterId, 'device', deviceHash);
  if (email && !links.some((link) => link.kind === 'email' && link.hash === email)) await deps.store.addLink(clusterId, 'email', email);
  if (deps.session) await deps.store.setUserCluster(deps.session.userId, clusterId);

  const memberIds = deps.session ? await deps.store.clusterUserIds(clusterId) : [];
  if (deps.session && !memberIds.includes(deps.session.userId)) memberIds.push(deps.session.userId);

  let standingTier: Tier = 'opus';
  let pinned: Tier | null = null;
  if (deps.session) {
    const mine = await deps.store.standing(deps.session.userId);
    if (mine) {
      standingTier = parseTier(mine.tier) ?? 'haiku';
      pinned = parseTier(mine.pinnedTier);
    } else {
      const known = (await Promise.all(memberIds.map((id) => deps.store.standing(id))))
        .map((item) => parseTier(item?.tier ?? null))
        .filter((item): item is Tier => !!item);
      const clusterTier: Tier | null = known.includes('off') ? 'off' : known.includes('haiku') ? 'haiku' : known.includes('sonnet') ? 'sonnet' : known[0] ?? null;
      standingTier = initialTier(clusterTier, isDisposableEmail(email));
      // A fresh account from an address a suspended cluster used in the last week
      // starts on Haiku: ban evasion costs little, and nobody existing is touched.
      if (ipHash && standingTier !== 'off' && await deps.store.ipFlagged(ipHash, new Date(deps.now.getTime() - IP_FLAG_MS))) standingTier = 'haiku';
      await deps.store.setStanding(deps.session.userId, standingTier, null);
    }
  }

  const since = ledgerSince(deps.now, deps.governor.windowStart);
  const calendarStart = new Date(Date.UTC(deps.now.getUTCFullYear(), deps.now.getUTCMonth(), 1));
  const billingStart = deps.billingEnabled
    ? (paid ? monthlyWindow(entitlement, deps.now).start : calendarStart)
    : since;
  const queryStart = billingStart < since ? billingStart : since;
  const spend = await deps.store.spendSince(queryStart, deps.now);
  const ceilingTotal = signedInTotal(spend, deps.now);
  const ceilingReached = ceilingTotal == null || ceilingTotal >= deps.signedInTotal;
  const ceilingRatio = deps.session && !owner ? signedInRatio(ceilingTotal, deps.signedInTotal) : 0;
  if (deps.session && !owner && ceilingTotal != null && ceilingTotal >= deps.signedInTotal) await notifyCeiling(deps, ceilingTotal);

  const day = utcDay(deps.now);
  const keys = deviceHash && ipHash ? quotaKeys(deviceHash, ipHash) : null;
  // Count this message before deciding, atomically, so parallel requests cannot
  // all read the same count and slip past the daily quota.
  let deviceCount = 0;
  let ipCount = 0;
  if (!deps.session && keys) {
    deviceCount = (await deps.store.bumpAnon(keys.device, day)) - 1;
    ipCount = (await deps.store.bumpAnon(keys.ip, day)) - 1;
  }

  const prior = (deps.session ? await deps.store.grades(deps.session.userId, 10) : [])
    .map((item) => parseGrade(item)).filter((item): item is Grade => !!item);
  const goodStanding = !!deps.session && inGoodStanding(prior, cluster.suspended && !owner);
  let monthHit = false;
  let billingShort = false;
  let budget: 'opus' | 'sonnet' | 'haiku' | 'rest' = 'opus';
  if (!owner) {
    if (deps.billingEnabled) {
      const identitySpend = spendForIdentity(spend, deps.session?.userId ?? null, deviceHash, deps.now, entitlement);
      const tier = paid ? paidTier(identitySpend) : freeTier(identitySpend);
      billingShort = tier === 'haiku-short';
      monthHit = !paid && identitySpend != null && identitySpend >= FREE_MONTHLY_USD;
      budget = tier === 'rest' ? 'rest' : tier === 'opus' ? 'opus' : tier === 'sonnet' ? 'sonnet' : 'haiku';
    } else if (!deps.session) {
      budget = publicTier({
        now: deps.now, caps: deps.publicCaps, spend: publicSpend(spend, deps.now),
        newVisitor: keys ? deviceCount === 0 && ipCount === 0 : true,
      });
    } else {
      const mine = userSpend(spend, deps.session.userId, deps.now);
      budget = userBudgetTier(mine.spend, deps.userCap, deps.now, mine.incomplete);
      monthHit = !mine.incomplete && mine.spend.monthBeforeToday + mine.spend.today >= deps.userCap;
    }
  }
  const choice = chooseTier({
    owner, suspended: cluster.suspended && !owner, standing: standingTier, pinned, budget,
    ceiling: !!(deps.session && !owner && ceilingReached), ceilingRatio, grades: prior,
    goodStanding: deps.billingEnabled ? false : goodStanding,
  });
  if (choice.tier === 'off') return { response: json({ line: LINES.paused, paused: true }, 200, cookieOut) };
  if (!deps.session && keys && anonDecision(deviceCount, ipCount) === 'sign-in') {
    return { response: json({ line: LINES.signIn, signIn: true }, 200, cookieOut) };
  }
  if (choice.tier === 'rest') {
    let line = monthHit ? monthRestLine(deps.now) : LINES.resting;
    let upgrade = false;
    if (deps.billingEnabled && !paid && monthHit) {
      const identity = deps.session?.userId ?? deviceHash;
      if (identity && await deps.store.claimNotice?.(upgradeNoticeId(deps.now, identity))) {
        line = "You've hit this month's free AI limit";
        upgrade = true;
      }
    }
    return { response: json({ line, resting: true, month: monthHit || undefined, ...(deps.billingEnabled ? { upgrade } : {}) }, 200, cookieOut) };
  }
  const decision = govern({
    accessBlocked: await deps.store.accessBlocked(deps.session?.userId ?? null),
    rows: spend.map((row) => ({ at: row.createdAt, costUsd: row.costUsd, lane: row.lane === 'slow' ? 'slow' as const : 'api' as const })),
    now: deps.now, totalUsd: deps.governor.totalUsd, windowStart: deps.governor.windowStart, windowEnd: deps.governor.windowEnd,
  });
  if (decision.reason === 'supervisor') return { response: json({ line: ACCESS_REST_LINE, resting: true }, 200, cookieOut) };
  if (decision.reason === 'pace' || decision.reason === 'recovering') await notifyThrottle(deps, decision);
  // People we don't know get Haiku until they sign in (owner, 9 Oct: "public
  // queries should go to Haiku until we've established they're real users").
  // Sonnet and Opus are for signed-in users. Flagging uses this tier, before
  // the governor, so a pace cut alone does not mark them.
  let flaggedTier = choice.tier;
  if (!deps.session && !owner && (flaggedTier === 'opus' || flaggedTier === 'sonnet')) flaggedTier = 'haiku';
  // The fast lane is Haiku for everyone; the thinking comes from the laptop
  // (owner, 9 Oct: "we can run isobar on haiku + laptop backend. It should be
  // smart enough."). ISOBAR_CHAT_FAST_CAP=sonnet|opus lifts it if ever needed.
  const throttled = throttledTier({
    base: !deps.session && !owner ? flaggedTier : choice.beforeCut,
    grades: prior, ceilingRatio, pressure: decision.pressure, share: decision.share, owner, signedIn: !!deps.session, globalCap: decision.fast,
  });
  const fast = capTier(throttled, deps.fastCap ?? 'haiku');
  const thread = await deps.store.thread(deps.session?.userId ?? null, deviceHash);
  const history = currentConversation((await deps.store.history(thread.id, 100))
    .filter((item) => item.role === 'user' || item.role === 'assistant'), { context, createdAt: deps.now });
  const candidate = deps.session ? readBriefing(thread.laptopBriefing) : null;
  const briefing = candidate && history.some((item) => item.id === candidate.messageId && item.lane === 'slow' && item.status === 'complete') ? candidate : null;
  const fastCap = fast === 'opus' || fast === 'sonnet' || fast === 'haiku' ? fast : 'rest';
  const hard = questionNeedsArchive(message);
  if ((!briefing || fastCap === 'rest') && handoffInstead({ signedIn: !!deps.session, fastCap, hard })) {
    return handoffArchive(deps, {
      message, context, cookieOut, deviceHash, owner, cluster, day, ipHash,
      screen: decision.watcher !== 'rest',
      flagged: accountFlagged({
        tier: flaggedTier, blockCount: cluster.blockCount, grades: prior, disposable: isDisposableEmail(email),
      }),
    });
  }
  if (fast !== 'opus' && fast !== 'sonnet' && fast !== 'haiku') {
    return { response: json({ line: LINES.governor, resting: true }, 200, cookieOut) };
  }

  const userMessage = await deps.store.insert({ threadId: thread.id, role: 'user', content: message, status: 'complete', lane: 'fast', context });
  const flagged = accountFlagged({
    tier: flaggedTier, blockCount: cluster.blockCount, grades: prior, disposable: isDisposableEmail(email),
  });
  return streamReply(async (emit) => {
    emit({ status: 'Checking the question…' });
    const screen = await haikuCall(
      deps, 'You only screen. You do not answer.',
      buildPreScreenPrompt(message, history.filter((item) => item.role === 'user' || item.role === 'assistant').map((item) => ({ role: item.role, content: item.content }))),
    );
    const verdict = screen ? parsePreScreen(screen.text, flagged) : { action: 'downgrade' as const, reason: 'malformed verdict' };
    if (screen) {
      await deps.store.insert({
        threadId: thread.id, role: 'screen', content: verdict.action, status: 'complete', lane: 'fast',
        model: screen.model, promptTokens: screen.promptTokens, completionTokens: screen.completionTokens, costUsd: screen.cost,
      });
    }
    if (verdict.action === 'block') {
      const blockedReply = await deps.store.insert({ threadId: thread.id, role: 'assistant', content: LINES.blocked, status: 'complete', lane: 'fast', context });
      if (!owner) {
        const next = nextBlock(cluster, day);
        await deps.store.saveCluster({ ...cluster, ...next });
        if (next.suspended && ipHash) await deps.store.flagIp(ipHash, cluster.id);
      }
      return { meta: { replace: LINES.blocked, blocked: true, messageId: blockedReply.id, userMessageId: userMessage.id } };
    }

    if (deps.session && deps.reportCommand && verdict.action === 'allow' && screen && complexQuestion(screen.text)) {
      return { meta: await offerReport(deps, thread.id, userMessage.id, context) };
    }

    let tier: 'opus' | 'sonnet' | 'haiku' = briefing ? 'haiku' : fast;
    if (verdict.action === 'downgrade') {
      const dropped = downgradeTier(tier);
      const next = dropped === 'off' ? 'haiku' : dropped;
      const capped = deps.session && !owner ? next : capTier(next, decision.fast);
      tier = capped === 'opus' || capped === 'sonnet' || capped === 'haiku' ? capped : 'haiku';
    }
    const belowOpus = fast === 'sonnet' || fast === 'haiku';
    const archive = !!deps.session && (owner || !cluster.suspended);
    let archiveRequest: string | null = null;
    let slowQueued = false;
    let archiveId: string | null = null;
    const toolResults: unknown[] = [];
    const toolCalls: { name: string; input: unknown; output: unknown }[] = [];
    const started = Date.now();
    const spec = modelFor(tier);
    const maxTokens = billingShort ? Math.min(spec.maxTokens, 1_000) : spec.maxTokens;
    const tools = [...toolSpecs(archive), ...(deps.session && deps.reportCommand ? [reportToolSpec()] : [])] as ToolSpec[];
    const examples = await deps.store.examples(5);
    const capNote = belowOpus && deps.session && !briefing
      ? 'The fast lane is capped below Opus. If this question needs the archive, observations, or yesterday, call request_archive_analysis. Answer the parts supported by the available evidence.'
      : '';
    const system = [systemPrompt(), deps.session && deps.reportCommand ? REPORT_CHAT_GUIDANCE : '', unitsSystemLine(context.units ?? AUS_UNITS), exampleBlock(examples.map((item) => ({
      question: item.question, context: exampleContext(item.context), reply: item.reply,
    }))), capNote, billingShort ? 'Keep the answer under 100 words. Give the direct answer and only the essential caveat.' : ''].filter(Boolean).join('\n\n');
    const messages: unknown[] = [{ role: 'user', content: buildChatPrompt({ context, earlier: earlierTurns(history, context, deps.now), message, briefing }) }];
    let promptTokens = 0;
    let completionTokens = 0;
    let answer = '';
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        emit({ status: 'Writing…', ...(round > 0 ? { replace: '' } : {}) });
        if (await deps.store.accessBlocked(deps.session?.userId ?? null)) throw new Error('chat resting');
        const done = await completeAnthropic({
          apiKey: deps.apiKey!, model: spec.model, effort: billingShort ? 'low' : spec.effort, maxTokens,
          system, messages, tools, fetchImpl: deps.fetchImpl,
          onText: (delta) => emit({ delta }),
          // The last round answers from what the tools already returned.
          toolChoice: round === MAX_TOOL_ROUNDS ? 'none' : 'auto',
        });
        promptTokens += done.promptTokens;
        completionTokens += done.completionTokens;
        if (done.stop !== 'tool_use' || done.calls.length === 0) {
          if (done.stop !== 'end_turn' && done.stop !== 'stop_sequence') throw new AnthropicError(`anthropic stopped: ${done.stop}`, 0, 0);
          if (!done.text) throw new AnthropicError('anthropic returned no answer', 0, 0);
          answer = done.text;
          break;
        }
        if (round === MAX_TOOL_ROUNDS) throw new AnthropicError('anthropic tool loop limit reached without an answer', 0, 0);
        messages.push({ role: 'assistant', content: done.rawContent });
        const results = [];
        for (const call of done.calls) {
          emit({ status: toolStatus(call.name, call.input, deps.chart) });
          const output = await runTool(call.name, call.input, deps.chart, {
            archive,
            queueArchive: async (question) => {
              if (!archive || archiveRequest || !deps.session || await deps.store.accessBlocked(deps.session.userId) || await deps.store.pendingSlow(deps.session.userId)) return false;
              // Defer admission until the checked fast answer is saved, so the
              // daemon always receives the original question, answer and gaps.
              archiveRequest = question;
              return true;
            },
            reportCommand: deps.reportCommand,
            threadId: thread.id,
          });
          toolCalls.push({ name: call.name, input: call.input, output });
          toolResults.push(output);
          results.push({ type: 'tool_result' as const, tool_use_id: call.id, content: JSON.stringify(output).slice(0, 8_000) });
          if (call.name === 'manage_reports' && (call.input as {action?:string})?.action !== 'list' && typeof (output as {line?:unknown})?.line === 'string') { answer=(output as {line:string}).line; break; }
        }
        if(answer) break; // A committed mutation needs no second model call to confirm it.
        messages.push({ role: 'user', content: results });
      }
      if (!answer) throw new AnthropicError('anthropic returned no answer', 0, 0);
    } catch (error) {
      // Earlier rounds are already counted; the failing call's own billed usage adds to them.
      if (error instanceof AnthropicError) {
        promptTokens += error.promptTokens ?? 0;
        completionTokens += error.completionTokens ?? 0;
      }
      const failedReply = await deps.store.insert({
        threadId: thread.id, role: 'assistant', content: '', status: 'failed', lane: 'fast',
        model: spec.model, effort: spec.effort, promptTokens, completionTokens,
        // Never null (an unknown cost rests the whole ledger). completeAnthropic
        // reports a conservative estimate when a call may have been billed.
        costUsd: messageCostUsd(spec.model, promptTokens, completionTokens) ?? 0,
        latencyMs: Date.now() - started, failureReason: (error instanceof AnthropicError ? error.message : 'tool').slice(0, 120),
        context, toolCalls,
      });
      return { meta: { replace: LINES.failed, failed: true, messageId: failedReply.id, userMessageId: userMessage.id, archiveId } };
    }

    // Mutation confirmations come from the service, never a model's sales copy.
    const reportResult = [...toolCalls].reverse().find(call => call.name === 'manage_reports' && (call.input as {action?:string})?.action !== 'list')?.output as {line?:string;reportId?:string} | undefined;
    if (reportResult?.line) answer = reportResult.line;
    if (reportResult?.reportId) { archiveId=reportResult.reportId; slowQueued=true; }
    emit({ status: 'Checking the answer…' });
    const evidence = JSON.stringify({ tools: toolResults, context, ...(briefing ? { laptopBriefing: briefing } : {}) });
    const screened = postScreen(answer, evidence);
    const leaks = screened.hard;
    const post = leaks.length || decision.watcher === 'rest' ? null : await haikuCall(deps, 'You only check. You do not answer.', buildPostCheckPrompt(message, answer, evidence, undefined, screened.unverified, archive));
    const checked = leaks.length
      ? { ok: false as const, severity: 'hard' as const, reason: leaks[0], line: HARD_LINES.leak }
      : parsePostCheck(post?.text ?? '');
    const hard = !checked.ok && checked.severity === 'hard';
    const soft = !checked.ok && checked.severity === 'soft';
    if (post) {
      await deps.store.insert({
        threadId: thread.id, role: 'screen', content: checked.ok ? 'pass' : hard ? 'hold' : 'soft', status: 'complete', lane: 'fast',
        model: post.model, promptTokens: post.promptTokens, completionTokens: post.completionTokens, costUsd: post.cost,
      });
    }
    // Keep the original answer and reason for the owner. Public hydration reads
    // only the safe replacement/caveat from context; holding never lowers standing.
    const check = checked.ok ? null : { severity: checked.severity, line: checked.line };
    const saved = await deps.store.insert({
      threadId: thread.id, role: 'assistant', content: answer, status: hard ? 'held' : 'complete', lane: 'fast',
      model: spec.model, effort: spec.effort, promptTokens, completionTokens,
      costUsd: messageCostUsd(spec.model, promptTokens, completionTokens), latencyMs: Date.now() - started,
      gradeReason: checked.ok ? null : `${hard ? 'held' : 'soft'}: ${checked.reason}`.slice(0, 200),
      context: { ...context, anchors: anchorsFromTools(toolResults), check, userMessageId: userMessage.id }, toolCalls,
    });
    if (archive && deps.session && !hard && !reportResult) {
      const gaps = parseArchiveGaps(post?.text ?? '');
      try {
        const queued = await deps.store.queueSlow(deps.session.userId, archiveRow({
          threadId: thread.id, userMessageId: userMessage.id, answerId: saved.id,
          question: message, answer, context: { ...context, ...(briefing ? { laptopBriefing: briefing } : {}) },
          gaps: gaps.length ? gaps : [archiveRequest ?? 'Check, extend and correct this answer from the archive.'], source: archiveRequest ? 'tool' : 'automatic',
        }));
        slowQueued = queued.status === 'queued';
        archiveId = slowQueued ? queued.messageId ?? null : null;
        if (slowQueued) await deps.store.update(saved.id, { context: {
          ...context, anchors: anchorsFromTools(toolResults), check, userMessageId: userMessage.id,
          archiveId, archiveLine: ARCHIVE_CHECKING,
        } });
      } catch { /* A queue outage must not discard the useful checked answer. Dig deeper can retry. */ }
    }
    const users = deps.session ? [deps.session.userId] : [];
    const later = checked.ok ? () => gradeExchange(deps, thread.id, saved.id, message, answer, standingTier, prior, users) : undefined;
    return { meta: { replace: hard && !checked.ok ? checked.line : answer,
      caveat: soft && !checked.ok ? checked.line : undefined,
      model: spec.model, anchors: hard ? undefined : anchorsFromTools(toolResults), archive: slowQueued, held: hard,
      threadId: thread.id, messageId: saved.id, userMessageId: userMessage.id, archiveId,
      archiveLine: reportResult?.reportId ? 'Preparing your report…' : slowQueued ? ARCHIVE_CHECKING : undefined }, later };
  }, cookieOut);
}

async function gradeExchange(
  deps: ChatDeps, threadId: string, messageId: string, question: string, answer: string,
  standingTier: Tier, prior: Grade[], userIds: string[],
): Promise<void> {
  const since = ledgerSince(deps.now, deps.governor.windowStart);
  const spend = await deps.store.spendSince(since, deps.now);
  const decision = govern({
    accessBlocked: await deps.store.accessBlocked(deps.session?.userId ?? null),
    rows: spend.map((row) => ({ at: row.createdAt, costUsd: row.costUsd, lane: row.lane === 'slow' ? 'slow' as const : 'api' as const })),
    now: deps.now, totalUsd: deps.governor.totalUsd, windowStart: deps.governor.windowStart, windowEnd: deps.governor.windowEnd,
  });
  if (decision.watcher === 'rest') return;
  const remaining = deps.session
    ? haikuRemainingToday(userSpend(spend, deps.session.userId, deps.now).spend, deps.userCap, deps.now)
    : haikuRemainingToday(publicSpend(spend, deps.now).haiku, deps.publicCaps.haiku, deps.now);
  if (!graderOpen(remaining)) return;
  const graded = await haikuCall(deps, 'You only grade. You do not answer.', buildGradePrompt(question, answer));
  if (!graded) return;
  await deps.store.insert({
    threadId, role: 'grade', content: graded.text.slice(0, 500), status: 'complete', lane: 'fast',
    model: graded.model, promptTokens: graded.promptTokens, completionTokens: graded.completionTokens, costUsd: graded.cost,
  });
  const parsed = parseGradeVerdict(graded.text);
  if (!parsed) return;
  await deps.store.update(messageId, { grade: parsed.grade, gradeReason: parsed.reason });
  if (userIds.length) await writeTier(deps.store, userIds, standingAfterGrade(standingTier, parsed.grade, prior));
}

async function notifyCeiling(deps: ChatDeps, total: number): Promise<void> {
  const id = `ceiling-${deps.now.getUTCFullYear()}-${String(deps.now.getUTCMonth() + 1).padStart(2, '0')}`;
  try {
    if (await deps.store.hasNotice(id)) return;
    if (!deps.resendKey || !deps.emailFrom || !deps.ownerEmail) return;
    const response = await deps.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: deps.emailFrom, to: deps.ownerEmail, subject: 'Isobar chat ceiling',
        text: `Signed-in chat spend reached $${total.toFixed(2)} this month. The cut follows recent grades, lowest standing first.`,
      }),
    });
    if (response.ok) await deps.store.markNotice(id);
  } catch { /* the next signed-in message tries again */ }
}

async function notifyThrottle(deps: ChatDeps, decision: GovernorDecision): Promise<void> {
  const id = `throttle-${utcDay(deps.now)}`;
  try {
    if (await deps.store.hasNotice(id)) return;
    if (!deps.resendKey || !deps.emailFrom || !deps.ownerEmail) return;
    const response = await deps.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: deps.emailFrom, to: deps.ownerEmail, subject: 'Isobar chat throttle',
        text: `Chat spend is over pace. Public lanes are capped at ${decision.fast}. Signed-in users are cut by recent grades.`,
      }),
    });
    if (response.ok) await deps.store.markNotice(id);
  } catch { /* the next message tries again */ }
}

/** Save an offer only. A separate authenticated tap creates the report run. */
async function offerReport(deps: ChatDeps, threadId: string, userMessageId: string, context: ChatContext) {
  const known = deps.chart.manifest.places.find(place => place.id === context.place?.id);
  const location = context.point ?? known ?? context.camera;
  const points = location ? [{ name: (context.point?.name ?? known?.name ?? 'Map view').slice(0, 80), lat: location.lat, lon: location.lon }] : [];
  const saved = await deps.store.insert({ threadId, role: 'assistant', content: LINES.reportOffer,
    status: 'complete', lane: 'fast', costUsd: 0,
    context: { ...context, userMessageId, reportOffer: true, reportDraft: { places: points, timezone: context.place?.zone ?? 'UTC' } },
  });
  return { line: LINES.reportOffer, replace: LINES.reportOffer, reportOffer: true, threadId, messageId: saved.id, userMessageId };
}

async function handoffArchive(deps: ChatDeps, input: {
  message: string;
  context: ChatContext;
  cookieOut?: string;
  deviceHash: string | null;
  owner: boolean;
  cluster: ClusterRow;
  day: string;
  ipHash: string | null;
  screen: boolean;
  flagged: boolean;
}): Promise<ChatOutcome> {
  const thread = await deps.store.thread(deps.session?.userId ?? null, input.deviceHash);
  const history = currentConversation((await deps.store.history(thread.id, 12))
    .filter((item) => item.role === 'user' || item.role === 'assistant'), { context: input.context, createdAt: deps.now });
  const userMessage = await deps.store.insert({
    threadId: thread.id, role: 'user', content: input.message, status: 'complete', lane: 'fast', context: input.context,
  });
  if (input.screen) {
    const screen = await haikuCall(
      deps, 'You only screen. You do not answer.',
      buildPreScreenPrompt(input.message, history.filter((item) => item.role === 'user' || item.role === 'assistant').map((item) => ({ role: item.role, content: item.content }))),
    );
    const verdict = screen ? parsePreScreen(screen.text, input.flagged) : { action: 'downgrade' as const, reason: 'malformed verdict' };
    if (screen) {
      await deps.store.insert({
        threadId: thread.id, role: 'screen', content: verdict.action, status: 'complete', lane: 'fast',
        model: screen.model, promptTokens: screen.promptTokens, completionTokens: screen.completionTokens, costUsd: screen.cost,
      });
    }
    if (verdict.action === 'block') {
      await deps.store.insert({
        threadId: thread.id, role: 'assistant', content: LINES.blocked, status: 'complete', lane: 'fast', context: input.context,
      });
      if (!input.owner) {
        const next = nextBlock(input.cluster, input.day);
        await deps.store.saveCluster({ ...input.cluster, ...next });
        if (next.suspended && input.ipHash) await deps.store.flagIp(input.ipHash, input.cluster.id);
      }
      return { response: json({ line: LINES.blocked, blocked: true }, 200, input.cookieOut) };
    }
    if (deps.session && deps.reportCommand && verdict.action === 'allow' && screen && complexQuestion(screen.text)) {
      return { response: json(await offerReport(deps, thread.id, userMessage.id, input.context), 200, input.cookieOut) };
    }
  }
  const userId = deps.session?.userId;
  if (await deps.store.accessBlocked(userId ?? null)) return { response: json({ line: ACCESS_REST_LINE, resting: true }, 200, input.cookieOut) };
  const result = userId ? await deps.store.queueSlow(userId, archiveRow({
    threadId: thread.id, userMessageId: userMessage.id, question: input.message, answer: '',
    context: input.context, gaps: ['Answer from archive observations, history or run comparisons.'], source: 'handoff',
  })) : { status: 'denied' as const };
  const queued = result.status === 'queued';
  const line = queued ? ARCHIVE_CHECKING : result.status === 'pending' ? 'One archive question is already in flight' : 'Archive unavailable';
  const saved = await deps.store.insert({
    threadId: thread.id, role: 'assistant', content: line, status: 'complete', lane: 'fast',
    context: { ...input.context, userMessageId: userMessage.id, archiveId: queued ? result.messageId : null }, toolCalls: [],
  });
  return { response: json({ line, archive: queued, threadId: thread.id, messageId: saved.id,
    userMessageId: userMessage.id, archiveId: queued ? result.messageId : null }, 200, input.cookieOut) };
}
