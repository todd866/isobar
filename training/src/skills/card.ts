import type { Card, DrillRef } from '../model.ts';
import type { Drill } from './types.ts';

export function toCard(drill: Drill, ref?: Partial<DrillRef> & { seed: number }): Card {
  const complexity = (drill.rung >= 3 ? 3 : drill.rung) as 1 | 2 | 3;
  return {
    id: drill.id,
    conceptIds: ['fp.later'],
    subject: 'plan',
    kind: 'numeric',
    planStep: null,
    stem: drill.stem,
    options: [],
    correctId: '',
    explanation: `${drill.method} Rule of thumb: ${drill.thumb}`,
    citations: [{ sourceId: 'casa-727', section: drill.figure.title }],
    complexity,
    topics: [drill.skill],
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
    drill: { skill: drill.skill, rung: drill.rung, support: 0, ...ref, seed: ref?.seed ?? 0 },
  };
}
