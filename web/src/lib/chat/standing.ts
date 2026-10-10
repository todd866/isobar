/** Standing transitions. Degrade on the next message after a bad grade; recover after five interesting ones. */

import type { Grade, Tier } from './types';

const DOWN: Record<Tier, Tier> = { opus: 'sonnet', sonnet: 'haiku', haiku: 'haiku', off: 'off' };
const UP: Record<Tier, Tier> = { haiku: 'sonnet', sonnet: 'opus', opus: 'opus', off: 'off' };

export function parseTier(value: string | null | undefined): Tier | null {
  return value === 'opus' || value === 'sonnet' || value === 'haiku' || value === 'off' ? value : null;
}

export function parseGrade(value: string | null | undefined): Grade | null {
  return value === 'interesting' || value === 'ordinary' || value === 'off-purpose' || value === 'abusive' ? value : null;
}

/** How many interesting grades sit at the front of a newest-first list. */
export function interestingStreak(newestFirst: readonly Grade[]): number {
  let n = 0;
  for (const grade of newestFirst) {
    if (grade !== 'interesting') break;
    n += 1;
  }
  return n;
}

/**
 * The tier stored after this grade, which the next message reads.
 * `priorNewestFirst` is older grades, newest first, not including `grade`.
 * Off does not climb back on its own.
 */
export function standingAfterGrade(current: Tier, grade: Grade, priorNewestFirst: readonly Grade[] = []): Tier {
  if (grade === 'abusive') return 'off';
  if (current === 'off') return 'off';
  if (grade === 'off-purpose') return DOWN[current];
  if (grade === 'interesting') {
    const streak = interestingStreak(priorNewestFirst) + 1;
    if (streak >= 5 && streak % 5 === 0) return UP[current];
  }
  return current;
}

/** One step cheaper, for a watcher downgrade on this message only. */
export function downgradeTier(tier: Tier): Tier {
  return DOWN[tier];
}

/** Ceiling and similar drops. Haiku is the floor; off and rest are unchanged by the caller. */
export function dropOne(tier: Tier): Tier {
  return tier === 'opus' ? 'sonnet' : tier === 'sonnet' ? 'haiku' : tier;
}

const RANK: Record<Tier, number> = { opus: 0, sonnet: 1, haiku: 2, off: 3 };

/** The cheaper of two answering tiers. Off is cheaper than haiku. */
export function cheaperTier(a: Tier, b: Tier): Tier {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * No off-purpose or abusive grade in the last 10, and not suspended.
 * Daily pace must not walk this person off Opus. A stored lower tier
 * (a grade, a pin, a disposable address) still stands.
 */
export function inGoodStanding(newestFirst: readonly Grade[], suspended: boolean): boolean {
  if (suspended) return false;
  return !newestFirst.slice(0, 10).some((grade) => grade === 'off-purpose' || grade === 'abusive');
}

/** A new cluster member inherits the cluster, and a disposable address starts on Haiku. */
export function initialTier(clusterTier: Tier | null, disposable: boolean): Tier {
  const base = clusterTier ?? 'opus';
  if (!disposable) return base;
  return cheaperTier(base, 'haiku');
}

/**
 * Last line `interesting: reason`, `ordinary: reason`, `off-purpose: reason`, or `abusive: reason`.
 * Anything else is not a grade.
 */
export function parseGradeVerdict(output: string): { grade: Grade; reason: string } | null {
  const line = output.trim().split('\n').map((item) => item.trim()).filter(Boolean).at(-1) ?? '';
  const match = /^(interesting|ordinary|off-purpose|abusive)\s*[:—-]\s*(.*)$/i.exec(line);
  if (!match) return null;
  const grade = parseGrade(match[1].toLowerCase());
  if (!grade) return null;
  const reason = match[2].trim().slice(0, 200);
  if (!reason) return null;
  return { grade, reason };
}
