/** A part-task drill. One number, drawn from the B727 model, with the
 * worked method, a rule-of-thumb cross-check, and the wrong answers that
 * point back at a sub-skill. */

import type { FigureDiagram, FigureTable, WorkStep } from '../figure.ts';

export type Rung = 1 | 2 | 3 | 4;

export interface Diagnosis {
  id: string;
  /** Sub-skill the miss implies. */
  skill: string;
  /** Short label shown on the card. */
  note: string;
  /** One line naming the slip, shown on the follow-up. */
  detail: string;
  value: number;
}

export interface Drill {
  id: string;
  skill: string;
  rung: Rung;
  stem: string;
  /** `lines` is the plain-text form of the exhibit; `table`, when present, is what the card draws. */
  figure: { title: string; lines: string[]; highlight: string[]; table?: FigureTable; diagram?: FigureDiagram };
  unit: string;
  tolerance: number;
  decimals: number;
  answer: number;
  method: string;
  thumb: string;
  diagnoses: Diagnosis[];
  /** Worksheet for the supported follow-up. The last step's value is the answer. */
  steps?: WorkStep[];
  /** Inputs an independent check reads. Not shown as the answer. */
  given: Record<string, number>;
}
