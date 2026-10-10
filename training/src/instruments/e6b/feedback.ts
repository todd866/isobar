/** Feedback a learner can act on: an honest check against the scale's reading
 * precision, the name of the error when the wrong answer is a known slip, and
 * the estimate the learner made before touching the computer. Pure. */
import type { Result } from './demos.ts';
import type { Problem, Verdict } from './practice.ts';
import { hmm } from './slide.ts';

/** Minutes as h:mm.m (tenths of a minute): the exact answer the scale approximates. */
export function hmmTenths(minutes: number): string {
  const tenths = Math.round(minutes * 10);
  const h = Math.floor(tenths / 600);
  const m = (tenths - h * 600) / 10;
  return `${h}:${m.toFixed(1).padStart(4, '0')}`;
}

/** A value as the learner would write it in the problem's unit. */
export function formatValue(result: Result, value: number): string {
  if (result.unit === 'min') return hmm(value);
  return result.format(value);
}

/** The exact answer, one digit finer than a reading. */
export function formatExact(result: Result): string {
  const v = result.exact;
  if (result.unit === 'min') return hmmTenths(v);
  if (result.unit === '°T') return `${(((v % 360) + 360) % 360).toFixed(1).padStart(5, '0')}°`;
  if (result.unit === '°') return `${v.toFixed(2)}°`;
  const digits = Math.abs(v) >= 1000 ? 0 : 1;
  return `${v.toLocaleString('en-AU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${result.unit}`;
}

function formatTolerance(result: Result): string {
  const t = result.tolerance;
  if (result.unit === 'min') return `${Math.max(1, Math.round(t))} min`;
  if (result.unit === '°' || result.unit === '°T') return `${t < 1 ? t.toFixed(1) : Math.round(t)}°`;
  return `${t >= 10 ? Math.round(t).toLocaleString('en-AU') : t.toFixed(t < 1 ? 2 : 1)} ${result.unit}`;
}

/** "Your reading 2:31 · exact 2:30.0 · within the scale's reading precision (± 2 min)". */
export function checkText(problem: Problem, verdict: Verdict): string {
  if (verdict.value == null) return `Type your reading${problem.time ? ' in minutes or h:mm' : ` in ${problem.unit}`}.`;
  const key = problem.key;
  const within = verdict.ok ? 'within' : 'outside';
  return `Your reading ${formatValue(key, verdict.value)} · exact ${formatExact(key)} · ${within} the scale's reading precision (± ${formatTolerance(key)})`;
}

export interface Diagnosis { id: string; text: string }

const close = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/** Name the error behind a wrong reading, when it is a known slip. */
export function diagnose(problem: Problem, value: number | null): Diagnosis | null {
  if (value == null) return null;
  const { exact, tolerance, unit } = problem.key;
  if (Math.abs(value - exact) <= tolerance) return null;
  const slack = (v: number) => Math.max(tolerance * 1.5, Math.abs(v) * 0.012);
  if (problem.time && close(value * 60, exact, slack(exact))) {
    return { id: 'hours', text: `That is hours as a decimal. Answer in minutes or h:mm: ${value} h is ${hmm(value * 60)}.` };
  }
  if (unit !== '°T' && value > 0 && exact > 0) {
    const k = Math.round(Math.log10(value / exact));
    if (k !== 0 && close(value / 10 ** k, exact, slack(exact))) {
      return { id: 'decimal', text: `Right figures, wrong decimal place: out by ×${10 ** Math.abs(k)}. The scale gives digits; your estimate places the decimal point.` };
    }
  }
  for (const slip of problem.slips) {
    const gap = unit === '°T' ? Math.abs((((value - slip.value) % 360) + 540) % 360 - 180) : Math.abs(value - slip.value);
    if (gap <= slack(slip.value)) return { id: slip.id, text: slip.text };
  }
  return null;
}

export type EstimateGrade = 'close' | 'ballpark' | 'off';

/** How good a mental estimate was: within 30 %, within a factor of 2, or off. */
export function gradeEstimate(estimate: number, exact: number): EstimateGrade {
  if (!(estimate > 0) || !(exact > 0)) return 'off';
  const r = Math.abs(Math.log10(estimate / exact));
  return r <= Math.log10(1.3) ? 'close' : r <= Math.log10(2) ? 'ballpark' : 'off';
}

/** A reading about ten times (or a tenth of) the estimate: the slide-rule failure
 * mode, caught before the answer is checked. */
export function decimalAlarm(estimate: number, reading: number): boolean {
  if (!(estimate > 0) || !(reading > 0)) return false;
  return Math.abs(Math.log10(reading / estimate)) >= Math.log10(5);
}

export function estimateText(problem: Problem, estimate: number, reading: number | null): string {
  const key = problem.key;
  const grade = gradeEstimate(estimate, key.exact);
  const words = { close: 'close', ballpark: 'in the ballpark', off: 'a long way out' }[grade];
  const alarm = reading != null && decimalAlarm(estimate, reading) ? ' Your reading is about ten times away from it: check the decimal place.' : '';
  return `Estimate ${formatValue(key, estimate)}: ${words}.${alarm}`;
}
