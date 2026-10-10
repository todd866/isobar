import { toCard } from './card.ts';
import { cgShift } from './moment.ts';
import { etp } from './etp.ts';
import { specificRange } from './estimate.ts';
import { groundspeed } from './groundspeed.ts';
import { interpolateSkill } from './interpolate.ts';
import { isaDev } from './isa.ts';
import { metLevel } from './met-level.ts';
import { midZoneWeight } from './mid-zone.ts';
import { pnr } from './pnr.ts';
import { integratedRange } from './range.ts';
import { tableCell } from './table-cell.ts';
import { tasMach } from './tas.ts';
import { hash } from './lib.ts';
import type { Drill, Rung } from './types.ts';
import { windComponent } from './wind.ts';
import { zoneFuel } from './zone-fuel.ts';
import { zoneTime } from './zone-time.ts';
import type { Card } from '../model.ts';

export interface Skill {
  id: string;
  name: string;
  generate(seed: number, rung: Rung): Drill;
}

export const SKILLS: Skill[] = [
  tableCell,
  interpolateSkill,
  isaDev,
  tasMach,
  windComponent,
  groundspeed,
  zoneTime,
  zoneFuel,
  midZoneWeight,
  metLevel,
  etp,
  pnr,
  integratedRange,
  specificRange,
  cgShift,
];

const RUNGS: Rung[] = [1, 2, 3, 4];

export function drillCards(): Card[] {
  const cards: Card[] = [];
  for (const skill of SKILLS) {
    for (const rung of RUNGS) {
      const seed = hash(skill.id);
      const drill = skill.generate(seed, rung);
      drill.id = `drill.${skill.id}.r${rung}`;
      cards.push(toCard(drill, { seed }));
    }
  }
  return cards;
}

/** Six drills of different skills, for a headless look at the shell. */
export const PREVIEW_DRILLS = [
  'drill.table-cell.r1',
  'drill.interpolate.r2',
  'drill.isa-dev.r1',
  'drill.tas-mach.r1',
  'drill.wind-component.r2',
  'drill.integrated-range.r2',
];

export { diagnose } from './diagnose.ts';
export { parseEntry, fmt, formatTolerance } from './format.ts';
export { toCard };
export type { Drill, Rung } from './types.ts';
