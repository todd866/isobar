/** Adaptive follow-ups for numeric drills: md3's retest → prerequisite →
 * transfer loop inside one session.
 *
 * A wrong (or very slow) answer does not reveal the answer. The same problem
 * comes straight back one rung down, with supports: the used cells marked, the
 * interpolation drawn, a worksheet checked step by step, and the slip named.
 * Solving it brings a fresh problem at the original rung, with lighter
 * support; each success fades the support until a bare item closes the loop. */

import type { Card, DrillRef } from './model.ts';
import type { WorkStep } from './figure.ts';
import { diagnose } from './skills/diagnose.ts';
import { fmt, parseEntry } from './skills/format.ts';
import { SKILLS } from './skills/index.ts';
import { hash } from './skills/lib.ts';
import type { Rung } from './skills/types.ts';

export type Outcome = 'correct' | 'slow' | 'wrong';

/** Slower than this, a right answer is not yet fluent. */
export const SLOW_MS: Record<Rung, number> = { 1: 60_000, 2: 90_000, 3: 150_000, 4: 240_000 };

/** Follow-ups one miss may chain before the scheduler takes over. */
export const MAX_FOLLOW_UPS = 6;

export interface SkillState {
  /** Support the next item of this skill is served with. */
  support: 0 | 1 | 2;
  retests: number;
  transfers: number;
  /** Loops closed with a bare item. */
  closed: number;
  lastSlip: string | null;
  lastAt: string | null;
}

export type SkillBook = Record<string, SkillState>;

export function emptySkill(): SkillState {
  return { support: 0, retests: 0, transfers: 0, closed: 0, lastSlip: null, lastAt: null };
}

export interface Judgement {
  outcome: Outcome;
  entered: number | null;
  /** One line naming the slip, never the answer. */
  slip: string;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

export function judge(card: Card, text: string, elapsedMs: number): Judgement {
  const spec = card.numeric;
  const entered = parseEntry(text);
  if (!spec || entered == null) return { outcome: 'wrong', entered, slip: 'No number entered. Work it in steps.' };
  const ok = Math.abs(entered - spec.value) <= spec.tolerance;
  const rung = card.drill?.rung ?? 1;
  if (ok && elapsedMs > SLOW_MS[rung]) return { outcome: 'slow', entered, slip: `Right, but it took ${duration(elapsedMs)}. Once more in steps.` };
  if (ok) return { outcome: 'correct', entered, slip: '' };
  const found = diagnose(spec, entered);
  return { outcome: 'wrong', entered, slip: found ? found.detail : `${fmt(entered, spec.decimals)} ${spec.unit} is not one of the usual slips. Work it in steps.` };
}

export function originOf(card: Card): string {
  return card.drill?.origin ?? card.id;
}

function chain(card: Card): number {
  const match = /~(\d+)$/.exec(card.id);
  return match ? Number(match[1]) : 0;
}

/** A worksheet for every numeric card: the drill's own, or one answer line. */
export function worksheet(card: Card): WorkStep[] {
  const spec = card.numeric;
  if (!spec) return [];
  if (spec.steps?.length) return spec.steps;
  return [{ id: 'answer', label: 'Answer', detail: spec.thumb, value: spec.value, tolerance: spec.tolerance, unit: spec.unit, decimals: spec.decimals }];
}

/** The body cell holding the entered number, so a retest can show the slip in the table. */
function slipCell(card: Card, entered: number | null): [number, number] | undefined {
  const table = card.figure?.table;
  if (!table || entered == null) return undefined;
  for (let r = 0; r < table.rows.length; r++) {
    const cells = table.rows[r]!.cells;
    for (let c = 0; c < cells.length; c++) {
      const value = cells[c];
      if (value != null && Math.abs(value - entered) < 0.5 && !table.used.some(([ur, uc]) => ur === r && uc === c)) return [r, c];
    }
  }
  return undefined;
}

/** The same problem, one rung down, fully supported. Null when the chain is spent. */
export function retestCard(card: Card, judgement: Judgement): Card | null {
  if (card.kind !== 'numeric' || !card.drill) return null;
  const n = chain(card) + 1;
  if (n > MAX_FOLLOW_UPS) return null;
  const origin = originOf(card);
  const rung = Math.max(1, card.drill.rung - 1) as Rung;
  const slip = slipCell(card, judgement.entered);
  const ref: DrillRef = { ...card.drill, rung, support: 2, origin, stage: 'retest', slip: judgement.slip };
  return {
    ...card,
    id: `${origin}~${n}`,
    drill: ref,
    ...(card.figure ? { figure: { ...card.figure, ...(slip && card.figure.table ? { table: { ...card.figure.table, slip } } : {}) } } : {}),
  };
}

/** A fresh problem of the same skill at the original rung, with new numbers. */
export function transferCard(card: Card, support: 0 | 1 | 2): Card | null {
  if (!card.drill) return null;
  const n = chain(card) + 1;
  if (n > MAX_FOLLOW_UPS) return null;
  const skill = SKILLS.find((item) => item.id === card.drill!.skill);
  if (!skill) return null;
  const origin = originOf(card);
  const rung = (Number(/\.r(\d)/.exec(origin)?.[1]) || card.drill.rung) as Rung;
  const before = card.numeric?.value;
  // Some discrete skills (e.g. descent forecast level) have the same answer
  // for several different inputs. Prefer a new answer, then a genuinely new stem.
  let alternate: Card | null = null;
  for (let k = 0; k < 12; k++) {
    const seed = hash(`${origin}|transfer|${n}|${k}`);
    const drill = skill.generate(seed, rung);
    if (drill.stem === card.stem) continue;
    const stem = drill.stem;
    const transfer: Card = {
      ...card,
      id: `${origin}~${n}`,
      stem,
      explanation: `${drill.method} Rule of thumb: ${drill.thumb}`,
      citations: [{ sourceId: 'casa-727', section: drill.figure.title }],
      figure: drill.figure,
      numeric: {
        value: drill.answer,
        tolerance: drill.tolerance,
        unit: drill.unit,
        decimals: drill.decimals,
        method: drill.method,
        thumb: drill.thumb,
        diagnoses: drill.diagnoses,
        given: drill.given,
        ...(drill.steps ? { steps: drill.steps } : {}),
      },
      drill: { skill: drill.skill, rung, seed, support, origin, stage: 'transfer' },
    };
    if (before == null || Math.abs(drill.answer - before) > (card.numeric?.tolerance ?? 0)) return transfer;
    alternate ??= transfer;
  }
  return alternate;
}

/** The support of the next transfer once this card is graded, or null when the loop is closed. */
export function nextSupport(card: Card, solved: boolean): 0 | 1 | 2 | null {
  const stage = card.drill?.stage;
  if (!card.drill || card.kind !== 'numeric') return null;
  if (!solved) return 2;
  if (stage === 'retest') return 1;
  if (stage === 'transfer') return card.drill.support > 0 ? (card.drill.support - 1) as 0 | 1 : null;
  return null;
}

export function noteMiss(book: SkillBook, card: Card, judgement: Judgement, at: string): SkillBook {
  const skill = card.drill?.skill;
  if (!skill) return book;
  const now = book[skill] ?? emptySkill();
  return { ...book, [skill]: { ...now, support: 2, retests: now.retests + 1, lastSlip: judgement.slip, lastAt: at } };
}

export function noteGrade(book: SkillBook, card: Card, solved: boolean, at: string): SkillBook {
  const skill = card.drill?.skill;
  if (!skill || !card.drill?.stage) return book;
  const now = book[skill] ?? emptySkill();
  const next = nextSupport(card, solved);
  const transfers = card.drill.stage === 'transfer' && solved ? now.transfers + 1 : now.transfers;
  const closed = next == null ? now.closed + 1 : now.closed;
  return { ...book, [skill]: { ...now, support: next ?? 0, transfers, closed, lastAt: at } };
}
