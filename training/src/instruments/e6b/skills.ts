/** Per-skill memory for the E6-B, on the trainer's scheduler (Cohort memory
 * projector): each skill is a card `e6b:<shape>` reviewed by every solo,
 * practice and mission problem. From it come the skill's state (new, learning,
 * fluent), the Daily E6-B set (retrieval, spacing, interleaving), personal bests
 * for exam pace, and the streak of days the daily set was done. Pure. */
import { emptyMemory, isDue, reviewCard, startOfStudyDay, type CardMemory } from '../../scheduler.ts';
import { SHAPES, type Shape } from './practice.ts';

export type Stage = 'watch' | 'guided' | 'solo' | 'done';

export interface E6BRecord {
  version: 1;
  firstContact?: boolean;
  curriculum?: Record<string, { stage: Stage; solved: string[] }>;
  memories: Record<string, CardMemory>;
  /** Learn stage reached per skill. */
  stages: Partial<Record<Shape, Stage>>;
  /** Fastest correct solo answer per skill, ms. */
  bests: Partial<Record<Shape, number>>;
  daily: { day: string; set: Shape[]; done: number; misses: number } | null;
  streak: { count: number; lastDay: string | null };
  /** The teaching flow: where the learner is in the problem order. */
  flowAt?: number;
  /** The teaching flow's help per skill: clean solves since the last miss. */
  help?: Partial<Record<Shape, { clean: number; missed: boolean }>>;
}

export function emptyRecord(): E6BRecord {
  return { version: 1, memories: {}, stages: {}, bests: {}, daily: null, streak: { count: 0, lastDay: null } };
}

export const skillId = (shape: Shape): string => `e6b:${shape}`;

/** Exam pace per skill, ms: a correct answer inside it counts as fluent. */
export const PACE_MS: Record<Shape, number> = {
  tsd: 45_000, fuel: 45_000, convert: 40_000, tas: 60_000, mach: 50_000, offcourse: 75_000, truealt: 60_000, windhdg: 90_000, windfind: 120_000,
};

export interface Attempt { correct: boolean; helped: boolean; ms: number | null; at: string }

/** Quality on the scheduler's 1–5 scale: fast and unaided 5, unaided 4, after help 3, wrong 2. */
export function quality(shape: Shape, attempt: Attempt): number {
  if (!attempt.correct) return 2;
  if (attempt.helped) return 3;
  return attempt.ms != null && attempt.ms <= PACE_MS[shape] ? 5 : 4;
}

export function recordAttempt(record: E6BRecord, shape: Shape, attempt: Attempt): E6BRecord {
  const id = skillId(shape);
  const current = record.memories[id] ?? emptyMemory(attempt.at);
  const day = startOfStudyDay(Date.parse(attempt.at), 0);
  const today = Object.values(record.memories).filter((m) => m.lastReview && startOfStudyDay(Date.parse(m.lastReview), 0) === day).length;
  const next = reviewCard(current, { quality: quality(shape, attempt), at: attempt.at, responseTimeMs: attempt.ms, complexity: 2, reviewsOnStudyDay: today + 1 });
  let bests = record.bests;
  if (attempt.correct && !attempt.helped && attempt.ms != null && (bests[shape] == null || attempt.ms < bests[shape]!)) bests = { ...bests, [shape]: attempt.ms };
  return { ...record, memories: { ...record.memories, [id]: next }, bests };
}

export type SkillState = 'new' | 'learning' | 'fluent';

/** New until first reviewed; fluent once mastered by the scheduler, or three
 * correct with strong recall and an average inside exam pace. */
export function skillState(record: E6BRecord, shape: Shape): SkillState {
  const memory = record.memories[skillId(shape)];
  if (!memory || memory.totalReviews === 0) return 'new';
  if (memory.status === 'mastered') return 'fluent';
  const paced = memory.avgResponseTimeMs != null && memory.avgResponseTimeMs <= PACE_MS[shape];
  return memory.correctCount >= 3 && memory.retrievalStrength >= 0.75 && paced ? 'fluent' : 'learning';
}

/** The Daily E6-B set: 5–8 problems mixed across skills, due skills first, no
 * skill twice in a row. Before three skills are learned it draws on all nine,
 * learned ones first, so the set is still interleaved. */
export function dailySet(record: E6BRecord, now: string, rand: () => number, size = 6): Shape[] {
  const count = Math.min(8, Math.max(5, size));
  const learned = SHAPES.filter((shape) => skillState(record, shape) !== 'new');
  const pool = learned.length >= 3 ? learned : [...learned, ...SHAPES.filter((shape) => !learned.includes(shape))];
  const memory = (shape: Shape) => record.memories[skillId(shape)];
  const due = (shape: Shape) => memory(shape) != null && isDue(memory(shape), now);
  const ranked = [...pool].sort((a, b) => {
    if (due(a) !== due(b)) return due(a) ? -1 : 1;
    const ma = memory(a);
    const mb = memory(b);
    if (ma && mb) return Date.parse(ma.nextDueAt) - Date.parse(mb.nextDueAt) || ma.retrievalStrength - mb.retrievalStrength;
    if (ma || mb) return ma ? -1 : 1;
    return rand() - 0.5;
  });
  const set: Shape[] = [];
  while (set.length < count) {
    const before = set.length;
    for (const shape of ranked) {
      if (set.length >= count) break;
      if (set[set.length - 1] === shape) continue;
      set.push(shape);
    }
    if (set.length === before) break;
  }
  return set;
}

/** Mark the daily set finished; a clean day (no misses) extends the streak. */
export function finishDaily(record: E6BRecord, day: string, clean: boolean): E6BRecord {
  if (!clean || record.streak.lastDay === day) return record;
  const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const count = record.streak.lastDay === prev ? record.streak.count + 1 : 1;
  return { ...record, streak: { count, lastDay: day } };
}

export type Next = { kind: 'learn'; shape: Shape } | { kind: 'daily'; count: number } | { kind: 'practice'; shape: Shape };

/** What to do next: learn the first new skill in order, else today's set if
 * anything is due, else practise the skill furthest from fluent. */
export function nextAction(record: E6BRecord, now: string, day: string): Next {
  const fresh = SHAPES.find((shape) => skillState(record, shape) === 'new');
  const dueAny = SHAPES.some((shape) => record.memories[skillId(shape)] && isDue(record.memories[skillId(shape)], now));
  const dailyDone = record.daily?.day === day && record.daily.done >= record.daily.set.length;
  if (dueAny && !dailyDone) return { kind: 'daily', count: 6 };
  if (fresh) return { kind: 'learn', shape: fresh };
  const weakest = [...SHAPES].sort((a, b) => (record.memories[skillId(a)]?.retrievalStrength ?? 0) - (record.memories[skillId(b)]?.retrievalStrength ?? 0))[0];
  return { kind: 'practice', shape: weakest };
}

/** Read a stored record, or start fresh when it is missing or from another version. */
export function parseRecord(value: unknown): E6BRecord {
  const v = value as Partial<E6BRecord> | null;
  if (!v || v.version !== 1 || typeof v.memories !== 'object' || !v.streak) return emptyRecord();
  return { ...emptyRecord(), ...v } as E6BRecord;
}
