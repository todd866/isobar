/**
 * One Isobar-wide cap on API spend. It overrides standing and the public
 * pools. Signed-in users are cut by recent grades (`throttledTier`); the
 * owner, signed-out visitors, the watcher and the digest follow this cap.
 * The slow lane is the subscription and is never capped. Outside the
 * credit window, or with a ledger that cannot be priced, every API lane
 * rests. Over pace steps the global cap one model; twice pace, two. The
 * cap stays down until a full hour has been under pace.
 *
 * Spend itself also steps it (owner, 9 Oct: "aggressively drop down to
 * Haiku when API spend adds up"): a quarter of the allowance used caps the
 * public at Sonnet, half at Haiku. Signed-in users drop one model at half
 * and reach Haiku at three quarters.
 */

import { applyTierDrop, ceilingDrop, gradeGroup, type GradeGroup } from './budgets';
import { cheaperTier } from './standing';
import type { Grade, LiveTier } from './types';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export type ApiCap = 'opus' | 'sonnet' | 'haiku' | 'rest';

export interface GovernorRow {
  at: Date;
  costUsd: number | null;
  /** Subscription work. Anything else is API spend. */
  lane?: 'api' | 'slow' | string | null;
}

export interface GovernorDecision {
  fast: ApiCap;
  watcher: 'haiku' | 'rest';
  digest: 'sonnet' | 'haiku' | 'rest';
  slow: 'uncapped' | 'rest';
  /** 0, 1, or 2 while the window and the ledger are known. */
  steps: 0 | 1 | 2 | null;
  /** Burn ÷ allowance behind `steps`, including a held hour. 0 when unknown. */
  pressure: number;
  /** Window spend ÷ allowance. 0 when unknown. */
  share: number;
  reason: 'ok' | 'pace' | 'spend' | 'recovering' | 'window' | 'unknown' | 'supervisor';
}

export function ledgerSince(now: Date, windowStart: Date | null): Date {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let since = month;
  if (windowStart && windowStart < since) since = windowStart;
  const day = new Date(now.getTime() - 26 * HOUR_MS);
  if (day < since) since = day;
  return since;
}

export function capTier<T extends LiveTier>(tier: T, cap: ApiCap): T | 'rest' {
  if (tier === 'off' || tier === 'rest') return tier;
  if (cap === 'rest') return 'rest';
  return cheaperTier(tier, cap) as T;
}

interface Priced {
  at: number;
  cost: number;
}

function priced(rows: readonly GovernorRow[], windowStart: number, now: number): Priced[] | null {
  const out: Priced[] = [];
  for (const row of rows) {
    if (row.lane === 'slow') continue;
    const at = row.at.getTime();
    if (!Number.isFinite(at) || at < windowStart || at > now) continue;
    if (row.costUsd == null || !Number.isFinite(row.costUsd) || row.costUsd < 0) return null;
    out.push({ at, cost: row.costUsd });
  }
  return out;
}

function sumBetween(events: readonly Priced[], fromExclusive: number, toInclusive: number, windowStart: number): number {
  let total = 0;
  for (const event of events) {
    if (event.at < windowStart || event.at <= fromExclusive || event.at > toInclusive) continue;
    total += event.cost;
  }
  return total;
}

function spentUntil(events: readonly Priced[], windowStart: number, t: number): number {
  let total = 0;
  for (const event of events) {
    if (event.at >= windowStart && event.at <= t) total += event.cost;
  }
  return total;
}

function ratio(burn: number, allowance: number): number {
  if (allowance > 0) return burn / allowance;
  return burn > 0 ? Number.POSITIVE_INFINITY : 0;
}

/** Exclusive start of a lookback. A window that begins mid-lookback still counts its first row. */
function lookbackStart(t: number, span: number, windowStart: number): number {
  const from = t - span;
  return from < windowStart ? windowStart - 1 : from;
}

/** Burn ÷ allowance at one instant. Nothing left, or no time left, is an infinite overrun. */
function paceRatio(events: readonly Priced[], t: number, windowStart: number, windowEnd: number, total: number): number {
  const timeLeft = windowEnd - t;
  if (!(timeLeft > 0)) return Number.POSITIVE_INFINITY;
  const remaining = total - spentUntil(events, windowStart, t);
  if (remaining <= 0) return Number.POSITIVE_INFINITY;
  const hourAllow = remaining * Math.min(HOUR_MS, timeLeft) / timeLeft;
  const dayAllow = remaining * Math.min(DAY_MS, timeLeft) / timeLeft;
  const hourBurn = sumBetween(events, lookbackStart(t, HOUR_MS, windowStart), t, windowStart);
  const dayBurn = sumBetween(events, lookbackStart(t, DAY_MS, windowStart), t, windowStart);
  return Math.max(ratio(hourBurn, hourAllow), ratio(dayBurn, dayAllow));
}

/** Exact pace is not over. Twice pace is two steps. */
function stepsOf(pressure: number): 0 | 1 | 2 {
  if (!(pressure > 1)) return 0;
  if (pressure >= 2) return 2;
  return 1;
}

function capOf(steps: 0 | 1 | 2): ApiCap {
  if (steps === 0) return 'opus';
  if (steps === 1) return 'sonnet';
  return 'haiku';
}

/** Public steps by window spend. */
export function shareSteps(share: number): 0 | 1 | 2 {
  if (share >= 0.5) return 2;
  if (share >= 0.25) return 1;
  return 0;
}

/** Signed-in steps by window spend: one model gentler than the public. */
export function signedInShareSteps(share: number): 0 | 1 | 2 {
  if (share >= 0.75) return 2;
  if (share >= 0.5) return 1;
  return 0;
}

function decide(paceSteps: 0 | 1 | 2, reason: GovernorDecision['reason'], pressure: number, share: number): GovernorDecision {
  const byShare = shareSteps(share);
  const steps = byShare > paceSteps ? byShare : paceSteps;
  if (byShare > paceSteps) reason = 'spend';
  const cap = capOf(steps);
  return {
    fast: cap,
    watcher: 'haiku',
    digest: cap === 'haiku' ? 'haiku' : 'sonnet',
    slow: 'uncapped',
    steps,
    reason: steps === 0 ? 'ok' : reason,
    pressure,
    share,
  };
}

function resting(reason: 'window' | 'unknown'): GovernorDecision {
  return { fast: 'rest', watcher: 'rest', digest: 'rest', slow: 'uncapped', steps: null, reason, pressure: 0, share: 0 };
}

export function govern(input: {
  rows: readonly GovernorRow[];
  accessBlocked?: boolean;
  now: Date;
  totalUsd: number | null;
  windowStart: Date | null;
  windowEnd: Date | null;
}): GovernorDecision {
  if (input.accessBlocked) return { ...resting('unknown'), slow: 'rest', reason: 'supervisor' };
  const total = input.totalUsd;
  const start = input.windowStart;
  const end = input.windowEnd;
  if (total == null || !Number.isFinite(total) || total <= 0 || !start || !end || !(start.getTime() < end.getTime())) return resting('unknown');
  const now = input.now.getTime();
  if (!Number.isFinite(now)) return resting('unknown');
  if (now < start.getTime() || now >= end.getTime()) return resting('window');
  const events = priced(input.rows, start.getTime(), now);
  if (!events) return resting('unknown');

  const share = spentUntil(events, start.getTime(), now) / total;
  const nowPressure = paceRatio(events, now, start.getTime(), end.getTime(), total);
  const nowSteps = stepsOf(nowPressure);
  if (nowSteps > 0) return decide(nowSteps, 'pace', nowPressure, share);

  const marks: number[] = [];
  for (const event of events) {
    for (const mark of [event.at, event.at + HOUR_MS - 1, event.at + DAY_MS - 1]) {
      if (mark > now - HOUR_MS && mark <= now && mark >= start.getTime() && mark < end.getTime()) marks.push(mark);
    }
  }
  marks.sort((a, b) => a - b);
  let held: 0 | 1 | 2 = 0;
  let heldPressure = 0;
  for (const mark of marks) {
    const pressure = paceRatio(events, mark, start.getTime(), end.getTime(), total);
    const steps = stepsOf(pressure);
    if (steps > 0) {
      held = steps;
      heldPressure = pressure;
    }
  }
  if (held > 0) return decide(held, 'recovering', heldPressure, share);
  return decide(0, 'ok', nowPressure, share);
}

/**
 * Over pace drops the bottom group one tier, 1.25× the middle, 1.5×
 * everyone. Twice pace drops two. Exact pace does not.
 */
function governorStepsFor(group: GradeGroup, pressure: number): 0 | 1 | 2 {
  if (!(pressure > 1)) return 0;
  if (pressure >= 2) return 2;
  return ceilingDrop(group, pressure);
}

/**
 * Fast-lane model after the ceiling and the governor. `base` is the tier
 * before either cut. Signed-in users take the larger cut. The owner and
 * signed-out visitors follow the global cap. The owner is exempt from the
 * grade cut.
 */
export function throttledTier(input: {
  base: LiveTier;
  grades: readonly Grade[];
  ceilingRatio: number;
  pressure: number;
  /** Window spend ÷ allowance (`GovernorDecision.share`). */
  share?: number;
  owner: boolean;
  signedIn: boolean;
  globalCap: ApiCap;
}): LiveTier {
  if (input.base === 'off' || input.base === 'rest') return input.base;
  if (input.globalCap === 'rest') return 'rest';
  if (!input.signedIn || input.owner) return capTier(input.base, input.globalCap);
  const group = gradeGroup(input.grades);
  const steps = Math.max(ceilingDrop(group, input.ceilingRatio), governorStepsFor(group, input.pressure),
    signedInShareSteps(input.share ?? 0));
  return applyTierDrop(input.base, steps);
}
