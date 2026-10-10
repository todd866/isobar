/**
 * Spend gates. Public pools are split and paced. A signed-in user has a
 * monthly backstop, not a daily step-down. The cheaper of budget and
 * standing is the tier that answers, unless they are in good standing.
 * The signed-in ceiling cuts by recent grades, lowest standing first.
 */

import { daysLeftInMonth, monthStart, utcDay, type Grade, type LiveTier, type Tier } from './types';
import { dropOne, cheaperTier } from './standing';
import { modelFamily } from './pricing';

export const PUBLIC_CAPS = { opus: 20, sonnet: 20, haiku: 10 } as const;
export const USER_CAP_USD = 20;
export const SIGNED_IN_TOTAL_USD = 200;
/** Grading stops while this much of today's allowance is still left. Chat continues. */
export const GRADER_STOP_USD = 0.05;
export const NEW_VISITOR_FRACTION = 0.7;

export interface PoolSpend {
  monthBeforeToday: number;
  today: number;
}

export interface SpendRow {
  userId: string | null;
  deviceHash?: string | null;
  model: string | null;
  costUsd: number | null;
  createdAt: Date;
  /** True for the owner's own messages, which sit outside every personal budget. */
  owner?: boolean;
  /** Slow-lane rows are the subscription, not this API ledger. */
  lane?: string | null;
}

export function envUsd(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function dailyAllowance(monthlyCap: number, monthBeforeToday: number, now: Date): number {
  const remaining = Math.max(0, monthlyCap - monthBeforeToday);
  const days = daysLeftInMonth(now);
  return days > 0 ? remaining / days : 0;
}

export function emptySpend(): PoolSpend {
  return { monthBeforeToday: 0, today: 0 };
}

function add(spend: PoolSpend, row: SpendRow, now: Date): PoolSpend | null {
  if (row.costUsd == null || !Number.isFinite(row.costUsd)) return null;
  const day = utcDay(now);
  const rowDay = utcDay(row.createdAt);
  if (rowDay === day) return { ...spend, today: spend.today + row.costUsd };
  if (row.createdAt >= monthStart(now) && row.createdAt < now) return { ...spend, monthBeforeToday: spend.monthBeforeToday + row.costUsd };
  return spend;
}

export interface SplitSpend {
  opus: PoolSpend;
  sonnet: PoolSpend;
  haiku: PoolSpend;
  /** A priced row with no cost closes the lane. */
  incomplete: boolean;
}

function split(rows: SpendRow[], now: Date): SplitSpend {
  const out: SplitSpend = { opus: emptySpend(), sonnet: emptySpend(), haiku: emptySpend(), incomplete: false };
  for (const row of rows) {
    const family = modelFamily(row.model);
    if (!family) continue;
    if (row.createdAt < monthStart(now) || row.createdAt >= now) continue;
    const next = add(out[family], row, now);
    if (!next) out.incomplete = true;
    else out[family] = next;
  }
  return out;
}

export function publicSpend(rows: readonly SpendRow[], now: Date): SplitSpend {
  return split(rows.filter((row) => row.userId == null), now);
}

export function userSpend(rows: readonly SpendRow[], userId: string, now: Date): { spend: PoolSpend; incomplete: boolean } {
  let spend = emptySpend();
  let incomplete = false;
  for (const row of rows) {
    if (row.userId !== userId || row.owner) continue;
    if (row.createdAt < monthStart(now) || row.createdAt >= now) continue;
    const next = add(spend, row, now);
    if (!next) incomplete = true;
    else spend = next;
  }
  return { spend, incomplete };
}

/** Signed-in spend this month, owner excluded. Null when a row cannot be priced. */
export function signedInTotal(rows: readonly SpendRow[], now: Date): number | null {
  let total = 0;
  const start = monthStart(now);
  for (const row of rows) {
    if (row.userId == null || row.owner) continue;
    if (row.createdAt < start || row.createdAt >= now) continue;
    if (row.costUsd == null || !Number.isFinite(row.costUsd)) return null;
    total += row.costUsd;
  }
  return total;
}

function spentToday(spend: PoolSpend, allowance: number): boolean {
  return !(allowance > 0) || spend.today >= allowance;
}

/**
 * Public tier for this message. Each pool is paced; a spent pool cascades down.
 * A new visitor, past 70% of the open pool's day, starts one tier lower.
 * An incomplete ledger rests.
 */
export function publicTier(input: {
  now: Date;
  caps: { opus: number; sonnet: number; haiku: number };
  spend: SplitSpend;
  newVisitor: boolean;
}): 'opus' | 'sonnet' | 'haiku' | 'rest' {
  if (input.spend.incomplete) return 'rest';
  const order = ['opus', 'sonnet', 'haiku'] as const;
  const allowanceOf = (tier: 'opus' | 'sonnet' | 'haiku') => dailyAllowance(input.caps[tier], input.spend[tier].monthBeforeToday, input.now);
  let open: 'opus' | 'sonnet' | 'haiku' | 'rest' = 'rest';
  for (const tier of order) {
    const allowance = allowanceOf(tier);
    if (!spentToday(input.spend[tier], allowance)) { open = tier; break; }
  }
  if (open === 'rest') return 'rest';
  if (!input.newVisitor) return open;
  const allowance = allowanceOf(open);
  if (!(allowance > 0) || input.spend[open].today / allowance < NEW_VISITOR_FRACTION) return open;
  let stepped: 'opus' | 'sonnet' | 'haiku' | 'rest' = open === 'opus' ? 'sonnet' : open === 'sonnet' ? 'haiku' : 'rest';
  while (stepped !== 'rest' && spentToday(input.spend[stepped], allowanceOf(stepped))) {
    stepped = stepped === 'sonnet' ? 'haiku' : 'rest';
  }
  return stepped;
}

/**
 * Signed-in backstop. Daily pace does not step the model down.
 * At the monthly cap the lane rests until the month rolls over.
 * An incomplete ledger rests. `now` is unused; the month is already split.
 */
export function userBudgetTier(spend: PoolSpend, monthlyCap: number, now: Date, incomplete = false): 'opus' | 'rest' {
  void now;
  if (incomplete) return 'rest';
  if (!(monthlyCap > 0)) return 'rest';
  if (spend.monthBeforeToday + spend.today >= monthlyCap) return 'rest';
  return 'opus';
}

export function graderOpen(remainingUsd: number): boolean {
  return remainingUsd > GRADER_STOP_USD;
}

export type GradeGroup = 'bottom' | 'middle' | 'top';

/**
 * Last 10 grades, newest first. Mostly interesting is the top group;
 * mostly ordinary, off-purpose or abusive is the bottom. Mostly means
 * more than half of the grades on hand. No grades is the middle.
 */
export function gradeGroup(newestFirst: readonly Grade[]): GradeGroup {
  const recent = newestFirst.slice(0, 10);
  if (recent.length === 0) return 'middle';
  let interesting = 0;
  let weak = 0;
  for (const grade of recent) {
    if (grade === 'interesting') interesting += 1;
    else weak += 1;
  }
  if (interesting * 2 > recent.length) return 'top';
  if (weak * 2 > recent.length) return 'bottom';
  return 'middle';
}

/** Bottom at 1×, middle at 1.25×, top at 1.5×. An unknown overrun cuts every group. */
export function ceilingDrop(group: GradeGroup, ratio: number): 0 | 1 {
  if (Number.isNaN(ratio) || ratio < 0) return 0;
  if (ratio === Number.POSITIVE_INFINITY) return 1;
  const line = group === 'bottom' ? 1 : group === 'middle' ? 1.25 : 1.5;
  return ratio >= line ? 1 : 0;
}

/** Signed-in spend divided by the ceiling. Unknown spend or a non-positive cap is an infinite overrun. */
export function signedInRatio(total: number | null, cap: number): number {
  if (total == null || !(cap > 0)) return Number.POSITIVE_INFINITY;
  return total / cap;
}

/** Steps down from Opus or Sonnet. Haiku is the floor; off and rest stay put. */
export function applyTierDrop(tier: LiveTier, steps: number): LiveTier {
  let next = tier;
  for (let i = 0; i < steps; i += 1) {
    if (next !== 'opus' && next !== 'sonnet') break;
    next = dropOne(next);
  }
  return next;
}

export function haikuRemainingToday(spend: PoolSpend, monthlyCap: number, now: Date): number {
  return dailyAllowance(monthlyCap, spend.monthBeforeToday, now) - spend.today;
}

export interface TierChoice {
  tier: LiveTier;
  /** The tier before this ceiling cut. The governor starts from here. */
  beforeCut: LiveTier;
  /** Set when the signed-in ceiling has been reached. The owner is never included. */
  ceiling: boolean;
}

function baseChoice(input: {
  owner: boolean;
  suspended: boolean;
  standing: Tier;
  pinned: Tier | null;
  budget: 'opus' | 'sonnet' | 'haiku' | 'rest';
  ceiling: boolean;
  goodStanding?: boolean;
}): TierChoice {
  if (input.owner) return { tier: 'opus', beforeCut: 'opus', ceiling: false };
  if (input.suspended || input.standing === 'off') return { tier: 'off', beforeCut: 'off', ceiling: input.ceiling };
  if (input.budget === 'rest') return { tier: 'rest', beforeCut: 'rest', ceiling: input.ceiling };
  const standing = input.pinned ?? input.standing;
  if (standing === 'off') return { tier: 'off', beforeCut: 'off', ceiling: input.ceiling };
  const budget: Tier = input.goodStanding && input.pinned == null ? 'opus' : input.budget;
  const tier = cheaperTier(standing, budget);
  return { tier, beforeCut: tier, ceiling: input.ceiling };
}

/**
 * Standing and budget. The cheaper one answers. The owner is Opus, outside
 * every personal budget. A person in good standing is not walked down by a
 * pace tier; the monthly rest and a pin still apply. Past a group's line the
 * signed-in ceiling takes one tier: bottom at 1×, middle at 1.25×, mostly
 * interesting at 1.5×. The owner is exempt. Suspension and standing `off`
 * pause chat.
 */
export function chooseTier(input: {
  owner: boolean;
  suspended: boolean;
  standing: Tier;
  pinned: Tier | null;
  budget: 'opus' | 'sonnet' | 'haiku' | 'rest';
  ceiling: boolean;
  /** Signed-in spend ÷ ceiling. Omit to treat a reached ceiling as exactly 1×. */
  ceilingRatio?: number;
  /** Newest first. */
  grades?: readonly Grade[];
  goodStanding?: boolean;
}): TierChoice {
  const base = baseChoice(input);
  if (input.owner || base.tier === 'off' || base.tier === 'rest') return base;
  const ratio = input.ceilingRatio ?? (input.ceiling ? 1 : 0);
  return { ...base, tier: applyTierDrop(base.tier, ceilingDrop(gradeGroup(input.grades ?? []), ratio)) };
}
