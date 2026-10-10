import { fmt } from './format.ts';
import {
  LB,
  TABLES,
  cruiseCells,
  descentFuel,
  descentTable,
  ffAt,
  ffTable,
  ffWindow,
  generateSkill,
  isaFlow,
  miss,
  pack,
  pick,
  step,
  tons,
  weightEntry,
  windowOf,
} from './lib.ts';
import type { Drill, Rung } from './types.ts';

function cell(fl: number, weightKg: number): number {
  const value = ffAt(fl, weightKg);
  if (value == null) throw new Error('blank cell');
  return value;
}

/** Five levels by three or more weights around one cell. */
function around(fl: number, weightKg: number) {
  const { fls, weights } = ffWindow(fl, weightKg, weightKg, fl, 2, 2);
  return ffTable(fls, weights, [[fl, weightKg]]);
}

function readCell(fl: number, weightKg: number, unit = 'kg/h') {
  return step('cell', 'Read the cell', `FL${fl} row · ${tons(weightKg)} t column`, cell(fl, weightKg), unit);
}

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  if (rung === 1) {
    const chosen = pick(rand, cruiseCells());
    const { fl, weightKg } = chosen;
    const answer = chosen.ff;
    return pack(seed, {
      skill: 'table-cell',
      rung,
      stem: `You are cruise-planning a B727-200 at M 0.80, ISA. What fuel flow do you read at FL${fl} and ${fmt(weightKg)} kg?`,
      figure: around(fl, weightKg),
      unit: 'kg/h',
      tolerance: 0.5,
      decimals: 0,
      answer,
      method: `The row is FL${fl} and the column is ${tons(weightKg)} t. That cell is ${fmt(answer)} kg/h, already at ISA.`,
      thumb: 'A heavy 727 cruises at roughly 4 000 to 5 000 kg/h.',
      given: { fl, weightKg },
      steps: [readCell(fl, weightKg)],
      diagnoses: [
        miss('wrong-row', 'table-cell', 'wrong row', `You read the FL${fl + 10} row.`, cell(fl + 10, weightKg)),
        miss('wrong-column', 'table-cell', 'wrong column', `You read the ${tons(weightKg + 2000)} t column.`, cell(fl, weightKg + 2000)),
        miss('isa-corrected', 'isa-dev', 'ISA level', 'You corrected for temperature; the table is already ISA.', isaFlow(answer, 10)),
        miss('kilograms-as-pounds', 'units', 'kilograms as pounds', 'You converted the kilograms to pounds.', answer * LB),
      ],
    });
  }
  if (rung === 2) {
    const fl = pick(rand, [250, 290, 310, 330, 350, 370]);
    const landingKg = pick(rand, [62000, 64000, 66000, 68000]);
    const answer = descentFuel(landingKg, fl);
    const column = landingKg >= 65000 ? 70000 : 60000;
    const other = column === 70000 ? 60000 : 70000;
    const levels = TABLES.descent.fl;
    const at = levels.indexOf(fl);
    return pack(seed, {
      skill: 'table-cell',
      rung,
      stem: `You are planning the descent of a B727-200, landing at ${fmt(landingKg)} kg from FL${fl}. The descent table is entered at the nearest 10 000 kg with no interpolation. What descent fuel do you read?`,
      figure: descentTable(windowOf(levels, at, at, 2), [[fl, column]]),
      unit: 'kg',
      tolerance: 0.5,
      decimals: 0,
      answer,
      method: `${fmt(landingKg)} kg rounds to the ${tons(column)} t column. At FL${fl} that cell is ${fmt(answer)} kg. Do not interpolate.`,
      thumb: 'Descent from the high thirties is roughly 700 to 800 kg.',
      given: { fl, landingKg },
      steps: [
        step('column', 'Round the landing weight', `${fmt(landingKg)} kg to the nearest 10 t`, column / 1000, 't'),
        step('cell', 'Read the cell', `FL${fl} row · ${tons(column)} t column`, answer, 'kg'),
      ],
      diagnoses: [
        miss('wrong-row', 'table-cell', 'wrong row', `You read the FL${fl - 10} row.`, descentFuel(landingKg, fl - 10)),
        miss('wrong-column', 'table-cell', 'wrong column', `You read the ${tons(other)} t column.`, descentFuel(other, fl)),
        miss('interpolated', 'interpolate', 'no interpolation', 'You averaged the two columns; this table does not interpolate.', (descentFuel(60000, fl) + descentFuel(70000, fl)) / 2),
      ],
    });
  }
  if (rung === 3) {
    const startKg = pick(rand, [72000, 76000, 80000]);
    const fuelKg = pick(rand, [4000, 8000]);
    const fl = pick(rand, [290, 310, 330, 350]);
    const emzw = weightEntry(startKg - fuelKg / 2);
    const burned = weightEntry(startKg - fuelKg);
    if ([emzw, burned, startKg].some((weight) => ffAt(fl, weight) == null || ffAt(fl + 10, weight) == null)) return null;
    const answer = cell(fl, emzw);
    const { fls, weights } = ffWindow(fl, burned, startKg, fl, 2, 0);
    return pack(seed, {
      skill: 'table-cell',
      rung,
      stem: `You are planning one cruise zone in a B727-200 at FL${fl}, M 0.80, ISA. The zone starts at ${fmt(startKg)} kg and burns ${fmt(fuelKg)} kg. What cruise fuel flow do you read at the mid-zone weight?`,
      figure: ffTable(fls, weights, [[fl, emzw]]),
      unit: 'kg/h',
      tolerance: 0.5,
      decimals: 0,
      answer,
      method: `Mid-zone weight is ${fmt(startKg)} − ${fmt(fuelKg)} / 2 = ${fmt(emzw)} kg. The FL${fl} cell there is ${fmt(answer)} kg/h.`,
      thumb: 'Enter the zone halfway through the burn, on a 1 000 kg boundary.',
      given: { fl, startKg, fuelKg },
      steps: [
        step('weight', 'Mid-zone weight', `${fmt(startKg)} − ${fmt(fuelKg)} ÷ 2`, emzw, 'kg'),
        readCell(fl, emzw),
      ],
      diagnoses: [
        miss('wrong-row', 'table-cell', 'wrong row', `You read the FL${fl + 10} row.`, cell(fl + 10, emzw)),
        miss('forgot-half', 'mid-zone-weight', 'forgot the half', 'You took off the whole zone fuel, not half.', cell(fl, burned)),
        miss('start-weight', 'mid-zone-weight', 'start weight', 'You read the start-of-zone weight.', cell(fl, startKg)),
      ],
    });
  }
  const brakeReleaseKg = pick(rand, [78000, 80000, 82000]);
  const climbFuelKg = pick(rand, [2000, 4000]);
  const fl = pick(rand, [290, 310, 330]);
  const toc = weightEntry(brakeReleaseKg - climbFuelKg);
  if (ffAt(fl, toc) == null || ffAt(fl, brakeReleaseKg) == null || ffAt(fl + 10, toc) == null) return null;
  const answer = cell(fl, toc);
  const { fls, weights } = ffWindow(fl, toc, brakeReleaseKg, fl, 2, 1);
  return pack(seed, {
    skill: 'table-cell',
    rung,
    stem: `You are planning a B727-200 at M 0.80, ISA. Brake release is ${fmt(brakeReleaseKg)} kg, the climb to FL${fl} burns ${fmt(climbFuelKg)} kg, and the first cruise zone is entered at the top of climb. What cruise fuel flow do you read?`,
    figure: ffTable(fls, weights, [[fl, toc]]),
    unit: 'kg/h',
    tolerance: 0.5,
    decimals: 0,
    answer,
    method: `Top of climb is ${fmt(brakeReleaseKg)} − ${fmt(climbFuelKg)} = ${fmt(toc)} kg. The FL${fl} cell is ${fmt(answer)} kg/h.`,
    thumb: 'Take the climb fuel off before you open the cruise table.',
    given: { fl, brakeReleaseKg, climbFuelKg },
    steps: [
      step('weight', 'Top-of-climb weight', `${fmt(brakeReleaseKg)} − ${fmt(climbFuelKg)}`, toc, 'kg'),
      readCell(fl, toc),
    ],
    diagnoses: [
      miss('wrong-row', 'table-cell', 'wrong row', `You read the FL${fl + 10} row.`, cell(fl + 10, toc)),
      miss('climb-ignored', 'table-cell', 'climb fuel', 'You read the table at brake-release weight.', cell(fl, brakeReleaseKg)),
      miss('kilograms-as-pounds', 'units', 'kilograms as pounds', 'You converted the kilograms to pounds.', answer * LB),
    ],
  });
}

export const tableCell = {
  id: 'table-cell',
  name: 'Table cell',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('table-cell', seed, rung, (rand) => build(rand, seed, rung));
  },
};
