/** Teaching at the point of action: what each guided step asks the learner to
 * set, whether the instrument now satisfies it, and the words and value tags
 * shown on the instrument. Pure: no DOM, so the tests can drive it.
 *
 * A step's goals are what changed from the step before it: a new disc angle
 * is a disc goal, a new hairline position a hairline goal, a new plate
 * azimuth, slide position or pencil dot a wind-side goal. A step that changes
 * nothing is a reading step and is satisfied as soon as it is shown.
 */
import type { Step } from './demos.ts';
import { E6B, scale, type Face } from './face.ts';
import { hmm, norm, ringMinutes, turn, valueAt } from './slide.ts';
import { HIGH_SPEED_SLIDE, U, readDot, signed180, type WindState } from './wind.ts';

export interface Pose { theta: number; cursor: number; wind: WindState }

export type Goal =
  | { kind: 'disc'; theta: number; tol: number }
  | { kind: 'cursor'; angle: number; tol: number }
  | { kind: 'plate'; plate: number; tol: number }
  | { kind: 'slide'; gs: number; tol: number }
  | { kind: 'dot'; dot: [number, number]; tol: number };

/** Alignment tolerances. A main-scale graduation spans 1.5–2.6° of arc, so the
 * disc and hairline must sit within about a third of one; the wind side within
 * the 2-kt arc spacing and 1° of azimuth graduation. */
export const TOL = { disc: 0.6, loose: 18, cursor: 0.6, plate: 1.2, slide: 1.5, dot: 2.5 * U };

const moved = (a: number, b: number, eps = 0.01): boolean => Math.abs(turn(a - b)) > eps;

/** The goals of step `index`: what the learner has to change on the instrument. */
export function stepGoals(steps: Step[], index: number): Goal[] {
  const step = steps[index];
  const prev = index > 0 ? steps[index - 1] : null;
  const goals: Goal[] = [];
  if (step.wind) {
    const was = prev?.wind ?? null;
    if (!was || Math.abs(signed180(step.wind.plate - was.plate)) > 0.05) goals.push({ kind: 'plate', plate: step.wind.plate, tol: TOL.plate });
    if (was && Math.abs(step.wind.gs - was.gs) > 0.5) goals.push({ kind: 'slide', gs: step.wind.gs, tol: step.wind.slide==='high'?5:TOL.slide });
    const dot = step.wind.dot;
    if (dot && (!was?.dot || Math.hypot(dot[0] - was.dot[0], dot[1] - was.dot[1]) > 1)) goals.push({ kind: 'dot', dot, tol: step.wind.slide==='high'?2.5*HIGH_SPEED_SLIDE.unitsPerKt:TOL.dot });
    return goals;
  }
  if (step.cursor != null && (!prev || prev.cursor == null || moved(step.cursor, prev.cursor))) {
    goals.push({ kind: 'cursor', angle: norm(step.cursor), tol: TOL.cursor });
  }
  if (!prev || moved(step.theta, prev.theta) || prev.loose) {
    goals.push({ kind: 'disc', theta: norm(step.theta), tol: step.loose ? TOL.loose : TOL.disc });
  }
  return goals;
}

/** How far the instrument is from a goal, in the goal's units (signed where it has a direction). */
export function goalError(goal: Goal, pose: Pose): number {
  switch (goal.kind) {
    case 'disc': return turn(pose.theta - goal.theta);
    case 'cursor': return turn(pose.cursor - goal.angle);
    case 'plate': return signed180(pose.wind.plate - goal.plate);
    case 'slide': return pose.wind.gs - goal.gs;
    case 'dot': {
      const dot = pose.wind.dot;
      return dot ? Math.hypot(dot[0] - goal.dot[0], dot[1] - goal.dot[1]) : Infinity;
    }
  }
}

export function goalMet(goal: Goal, pose: Pose): boolean {
  return Math.abs(goalError(goal, pose)) <= goal.tol;
}

/** A step is satisfied when every goal is met; a reading step (no goals) at once. */
export function stepMet(goals: Goal[], pose: Pose): boolean {
  return goals.every((goal) => goalMet(goal, pose));
}

/** Fading. Guided round 0 is a completion problem: the instrument performs every
 * step before the last one that needs setting, and the learner makes that last
 * move and the reading. Round 1 leaves every step to the learner. Returns, per
 * step, whether the instrument does it. */
export function autoSteps(steps: Step[], round: number): boolean[] {
  if (round > 0) return steps.map(() => false);
  let last = -1;
  steps.forEach((_, i) => { if (stepGoals(steps, i).length) last = i; });
  return steps.map((_, i) => i < last);
}

/** The action a step asks for, in plain words. */
export function actionFor(goals: Goal[]): string {
  const kinds = new Set(goals.map((goal) => goal.kind));
  if (kinds.has('cursor') && kinds.has('disc')) return 'Put the hairline on it, then turn the blue disc';
  if (kinds.has('disc')) return 'Turn the blue disc';
  if (kinds.has('cursor')) return 'Move the red hairline';
  if (kinds.has('plate') && kinds.has('slide')) return 'Turn the plate and slide the grid';
  if (kinds.has('plate')) return 'Turn the clear plate';
  if (kinds.has('slide')) return 'Slide the grid';
  if (kinds.has('dot')) return 'Mark the pencil dot';
  return 'Read it';
}

/** The manual's words with the scales named by colour: no "middle". */
export function plain(text: string): string {
  return text
    .replace(/\bmiddle scale\b/g, 'inner (blue) scale')
    .replace(/\bouter scale\b/g, 'outer (black) scale')
    .replace(/\bthe middle\b/g, 'the inner (blue) scale');
}

const reading = (value: number): string =>
  value.toLocaleString('en-AU', { minimumFractionDigits: value < 30 ? 2 : 1, maximumFractionDigits: value < 30 ? 2 : 1 });

const bearing = (v: number): string => `${String(Math.round(((v % 360) + 360) % 360) || 360).padStart(3, '0')}°`;

/** Values under the hairline, as shown on the tags beside it. */
export function tags(pose: Pose): { outer: string; inner: string; time: string } {
  const outer = valueAt(pose.cursor);
  const inner = valueAt(pose.cursor - pose.theta);
  // Round before choosing the ring's decade, so 59.9999 reads 1:00, not 10:00.
  return { outer: reading(outer), inner: reading(inner), time: hmm(ringMinutes(Math.round(inner * 1000) / 1000)) };
}

/** The one-line readout, colour-matched to the scales it names. */
export function readoutLine(pose: Pose, side: 'computer' | 'wind'): string {
  if (side === 'wind') {
    const dot = readDot(pose.wind);
    const dotText = dot ? `Dot: TAS ${Math.round(dot.tas)} kt, ${Math.abs(dot.wca).toFixed(1)}° ${dot.wca >= 0 ? 'right' : 'left'}` : 'Dot: none';
    return `Index ${bearing(pose.wind.plate)} · Ground speed ${Math.round(pose.wind.gs)} kt · ${dotText}`;
  }
  const t = tags(pose);
  return `Outer (black) ${t.outer} · Inner (blue) ${t.inner} · Time ${t.time}`;
}

export type Mode = 'learn' | 'practice' | 'free';

/** Which reading aids are on. The hairline is never removed: on screen it is the
 * pencil and finger a pilot uses on the real computer (owner, 7 Oct). Exam mode
 * removes the readout, the value tags and the coach marks, and starts the clock. */
export function aids(mode: Mode, exam: boolean): { hairline: true; tags: boolean; readout: boolean; coach: boolean; timer: boolean } {
  const examOn = mode === 'practice' && exam;
  return { hairline: true, tags: !examOn, readout: !examOn, coach: mode === 'learn' && !examOn, timer: mode === 'practice' };
}

/** The graduation angles the hairline snaps to: the outer scale (fixed) and the
 * inner scale (turned by θ), so it settles on either scale's marks. */
export function graduationAngles(face: Face = E6B): { outer: number[]; inner: number[] } {
  const ticks = (id: string) => scale(face, id).ticks.map((tick) => norm(tick.angle)).sort((a, b) => a - b);
  return { outer: ticks('outer'), inner: ticks('middle') };
}

const SNAP = 0.3;

/** Snap a hairline angle to the nearest graduation within 0.3°, or leave it. */
export function snapCursor(angle: number, theta: number, grads = graduationAngles()): number {
  let best = angle;
  let gap = SNAP;
  const consider = (a: number) => {
    const d = Math.abs(turn(a - angle));
    if (d < gap) { gap = d; best = norm(a); }
  };
  for (const a of grads.outer) consider(a);
  for (const a of grads.inner) consider(a + theta);
  return best;
}

/** The next outer-scale graduation from `angle` in direction `dir` (keyboard steps). */
export function nextGraduation(angle: number, dir: 1 | -1, grads = graduationAngles()): number {
  const list = grads.outer;
  const a = norm(angle);
  if (dir > 0) return list.find((g) => g > a + 1e-6) ?? list[0];
  for (let i = list.length - 1; i >= 0; i--) if (list[i] < a - 1e-6) return list[i];
  return list[list.length - 1];
}
