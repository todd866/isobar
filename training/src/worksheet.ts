/** Worksheet sub-steps for a supported follow-up, checked as the learner types. */

import type { WorkStep } from './figure.ts';
import { fmt, parseEntry } from './skills/format.ts';

export type StepMark = 'empty' | 'pending' | 'ok' | 'bad';

function digits(text: string): number {
  return text.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '').length;
}

/** `ok` once the entry is inside tolerance; `bad` once it has as many digits as
 * the expected value (or the learner pressed Enter) and is still out; `pending`
 * while it could still become right. */
export function markStep(step: WorkStep, text: string, committed = false): StepMark {
  if (!text.trim()) return 'empty';
  const value = parseEntry(text);
  if (value == null) return committed ? 'bad' : 'pending';
  if (Math.abs(value - step.value) <= step.tolerance + 1e-9) return 'ok';
  if (committed) return 'bad';
  return digits(text) >= digits(fmt(step.value, step.decimals)) ? 'bad' : 'pending';
}

export function marks(steps: WorkStep[], drafts: Record<string, string>, committed: ReadonlySet<string> = new Set()): StepMark[] {
  return steps.map((step) => markStep(step, drafts[step.id] ?? '', committed.has(step.id)));
}

/** The first step not yet right, or -1 when the worksheet is solved. */
export function activeStep(steps: WorkStep[], drafts: Record<string, string>): number {
  return marks(steps, drafts).findIndex((mark) => mark !== 'ok');
}

export function solved(steps: WorkStep[], drafts: Record<string, string>): boolean {
  return steps.length > 0 && activeStep(steps, drafts) === -1;
}
