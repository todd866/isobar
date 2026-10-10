/** Merging a device's progress with the account's. Pure; runs in the browser
 * (claim and sync) and in tests. Neither side is ever dropped: per-card memory
 * keeps the side with more reviews, streaks keep the later day, bests keep the
 * faster time, stages keep the further stage, sets are unions. Settings are
 * last-writer-wins per key, by the time each key was set. */

import type { CardMemory } from '../../../../training/src/scheduler.ts';
import type { ProgressFile, ProgressFlag } from '../../../../training/src/progress.ts';
import type { E6BRecord, Stage } from '../../../../training/src/instruments/e6b/skills.ts';
import type { SkillBook, SkillState } from '../../../../training/src/adaptive.ts';

export type DocKind = 'settings' | 'training' | 'e6b';
export const DOC_KINDS: readonly DocKind[] = ['settings', 'training', 'e6b'];

import { SPEEDS } from '../playback';
export { SPEEDS };

export interface SettingsValues {
  /** Atomic pair: account merges never combine unrelated limits. */
  kiteBand?: { min: number; max: number };
  theme?: 'light' | 'dark';
  place?: string;
  speed?: number;
  /** Saved places, most recently selected first. */
  places?: string[];
  /** Display units. Stored weather is unchanged. */
  units?: 'aus' | 'us' | 'local';
}
export type SettingKey = keyof SettingsValues;
export const SETTING_KEYS: readonly SettingKey[] = ['theme', 'place', 'speed', 'places', 'units', 'kiteBand'];

export interface SettingsDoc {
  values: SettingsValues;
  /** ISO time each key was last set. A key with no time loses to one with a time. */
  at: Partial<Record<SettingKey, string>>;
}

const time = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

export function mergeSettings(a: SettingsDoc | null | undefined, b: SettingsDoc | null | undefined): SettingsDoc {
  const out: SettingsDoc = { values: {}, at: {} };
  for (const key of SETTING_KEYS) {
    const av = a?.values?.[key];
    const bv = b?.values?.[key];
    const at = time(a?.at?.[key]);
    const bt = time(b?.at?.[key]);
    // b wins only when it is strictly newer, or a has no value.
    const pickB = bv !== undefined && (av === undefined || bt > at);
    const value = pickB ? bv : av;
    const stamp = pickB ? b?.at?.[key] : a?.at?.[key];
    if (value !== undefined) (out.values as Record<string, unknown>)[key] = value;
    if (value !== undefined && stamp) out.at[key] = stamp;
  }
  return out;
}

/** The memory with more evidence: more reviews, then the later review. */
export function mergeMemory(a: CardMemory | undefined, b: CardMemory | undefined): CardMemory | undefined {
  if (!a) return b;
  if (!b) return a;
  if (b.totalReviews !== a.totalReviews) return b.totalReviews > a.totalReviews ? b : a;
  return time(b.lastReview) > time(a.lastReview) ? b : a;
}

function mergeRecord<T>(a: Record<string, T> | undefined, b: Record<string, T> | undefined, pick: (x: T | undefined, y: T | undefined) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const value = pick(a?.[key], b?.[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function mergeStreak(a: { count: number; lastDay: string | null } | undefined, b: { count: number; lastDay: string | null } | undefined) {
  if (!a) return b ?? { count: 0, lastDay: null };
  if (!b) return a;
  if ((a.lastDay ?? '') !== (b.lastDay ?? '')) return (b.lastDay ?? '') > (a.lastDay ?? '') ? b : a;
  return b.count > a.count ? b : a;
}

function mergeFlags(a: ProgressFlag[] | undefined, b: ProgressFlag[] | undefined): ProgressFlag[] | undefined {
  if (!a && !b) return undefined;
  const seen = new Map<string, ProgressFlag>();
  for (const flag of [...(a ?? []), ...(b ?? [])]) seen.set(`${flag.cardId}\u0000${flag.at}\u0000${flag.note}`, flag);
  return [...seen.values()].sort((x, y) => time(x.at) - time(y.at));
}

function mergeSkill(a: SkillState | undefined, b: SkillState | undefined): SkillState | undefined {
  if (!a) return b;
  if (!b) return a;
  const at = time(a.lastAt);
  const bt = time(b.lastAt);
  if (bt !== at) return bt > at ? b : a;
  return b.closed + b.transfers + b.retests > a.closed + a.transfers + a.retests ? b : a;
}

const STAGE_ORDER: Record<Stage, number> = { watch: 0, guided: 1, solo: 2, done: 3 };
const furtherStage = (a: Stage | undefined, b: Stage | undefined): Stage | undefined => {
  if (!a) return b;
  if (!b) return a;
  return STAGE_ORDER[b] > STAGE_ORDER[a] ? b : a;
};

export function mergeE6B(a: E6BRecord | null | undefined, b: E6BRecord | null | undefined): E6BRecord | null {
  if (!a || a.version !== 1) return b && b.version === 1 ? b : null;
  if (!b || b.version !== 1) return a;
  const bests = mergeRecord<number>(a.bests as Record<string, number>, b.bests as Record<string, number>, (x, y) => (x == null ? y : y == null ? x : Math.min(x, y)));
  const curriculum = (a.curriculum || b.curriculum)
    ? mergeRecord(a.curriculum, b.curriculum, (x, y) => {
      if (!x) return y;
      if (!y) return x;
      return { stage: furtherStage(x.stage, y.stage)!, solved: [...new Set([...x.solved, ...y.solved])] };
    })
    : undefined;
  let daily = a.daily;
  if (!daily) daily = b.daily;
  else if (b.daily) {
    if (b.daily.day !== daily.day) daily = b.daily.day > daily.day ? b.daily : daily;
    else if (b.daily.done > daily.done) daily = b.daily;
  }
  const out: E6BRecord = {
    version: 1,
    memories: mergeRecord(a.memories, b.memories, mergeMemory),
    stages: mergeRecord<Stage>(a.stages as Record<string, Stage>, b.stages as Record<string, Stage>, furtherStage) as E6BRecord['stages'],
    bests: bests as E6BRecord['bests'],
    daily,
    streak: mergeStreak(a.streak, b.streak),
  };
  if (a.firstContact || b.firstContact) out.firstContact = true;
  if (curriculum) out.curriculum = curriculum;
  return out;
}

export function mergeTraining(a: ProgressFile | null | undefined, b: ProgressFile | null | undefined): ProgressFile | null {
  if (!a || a.version !== 1) return b && b.version === 1 ? b : null;
  if (!b || b.version !== 1) return a;
  const out: ProgressFile = {
    version: 1,
    cards: mergeRecord(a.cards, b.cards, mergeMemory),
    streak: mergeStreak(a.streak, b.streak),
  };
  const flags = mergeFlags(a.flags, b.flags);
  if (flags) out.flags = flags;
  const e6b = mergeE6B(a.e6b, b.e6b);
  if (e6b) out.e6b = e6b;
  if (a.skills || b.skills) out.skills = mergeRecord<SkillState>(a.skills as SkillBook, b.skills as SkillBook, mergeSkill);
  const learn = newerLearn(a.learn, b.learn);
  if (learn) out.learn = learn;
  return out;
}

function newerLearn(a: ProgressFile['learn'], b: ProgressFile['learn']): ProgressFile['learn'] {
  if (!a || a.version !== 1) return b && b.version === 1 ? b : undefined;
  if (!b || b.version !== 1) return a;
  return (b.updatedAt || '') > (a.updatedAt || '') ? b : a;
}

export function mergeDoc(kind: DocKind, a: unknown, b: unknown): unknown {
  if (kind === 'settings') return mergeSettings(a as SettingsDoc, b as SettingsDoc);
  if (kind === 'training') return mergeTraining(a as ProgressFile, b as ProgressFile);
  return mergeE6B(a as E6BRecord, b as E6BRecord);
}

/** Order-insensitive deep equality for JSON values (object key order differs between sides). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((value, i) => sameJson(value, bb[i]));
  }
  const ak = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const bk = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
