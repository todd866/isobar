import { fmt } from './format.ts';
import {
  TABLES,
  airDistance,
  generateSkill,
  miss,
  namAt,
  pack,
  pick,
  reference,
  roundTo,
  step,
  weightForNam,
} from './lib.ts';
import type { Drill, Rung } from './types.ts';

const TITLE = 'Table 3.4 integrated range, M 0.80 ISA';

function referenceWeight(fl: number, targetR: number): { lowKg: number; highKg: number; fraction: number; weightKg: number } {
  const weights = TABLES.cruise.integratedRange.weightsKg;
  const targetNam = namAt(fl, 50000) - targetR;
  for (let i = 0; i < weights.length - 1; i++) {
    const lowKg = weights[i]!;
    const highKg = weights[i + 1]!;
    const lowNam = namAt(fl, lowKg);
    const highNam = namAt(fl, highKg);
    if (targetNam <= lowNam + 1e-6 && targetNam >= highNam - 1e-6) {
      const fraction = (targetNam - lowNam) / (highNam - lowNam);
      return { lowKg, highKg, fraction, weightKg: lowKg + fraction * (highKg - lowKg) };
    }
  }
  throw new Error(`reference target outside FL${fl}`);
}

function rBand(fl: number, aroundKg: number): string[] {
  const weights = TABLES.cruise.integratedRange.weightsKg;
  let i = 0;
  while (i < weights.length - 1 && weights[i + 1]! < aroundKg) i++;
  const from = Math.max(0, i - 1);
  const to = Math.min(weights.length - 1, i + 1);
  const lines = [`FL${fl}   t      R`];
  for (let k = from; k <= to; k++) {
    lines.push(`       ${fmt(weights[k]! / 1000, 0).padStart(2)}   ${fmt(reference(fl, weights[k]!), 0).padStart(6)}`);
  }
  return lines;
}

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  const levels = [290, 310, 330, 350, 370];
  if (rung === 1) {
    const fl = pick(rand, levels);
    const other = levels[levels.indexOf(fl) + (fl === 370 ? -1 : 1)]!;
    const endKg = pick(rand, [62000, 66000, 70000, 74000]);
    const startKg = endKg + pick(rand, [6000, 8000, 10000]);
    const answer = airDistance(fl, startKg, endKg);
    const startR = reference(fl, startKg);
    const endR = reference(fl, endKg);
    const line = `FL${fl}   R ${fmt(startKg)} kg = ${fmt(reference(fl, startKg), 0)}   R ${fmt(endKg)} kg = ${fmt(reference(fl, endKg), 0)}`;
    return pack(seed, {
      skill: 'integrated-range',
      rung,
      stem: `You are cruise-planning a B727-200 at FL${fl}, M 0.80, ISA. The integrated-range table gives a reference number R at each weight. The zone starts at ${fmt(startKg)} kg and ends at ${fmt(endKg)} kg. What air distance does the zone cover?`,
      figure: { title: TITLE, lines: [line, 'R is nam still available down to 50 000 kg'], highlight: [line] },
      unit: 'nm',
      tolerance: 0.5,
      decimals: 0,
      answer,
      method: `Read R at ${fmt(startKg)} kg and at ${fmt(endKg)} kg on the FL${fl} column. Air distance is ${fmt(reference(fl, startKg), 0)} − ${fmt(reference(fl, endKg), 0)} = ${fmt(answer, 0)} nm. The zero of the table never flies.`,
      thumb: 'Only the difference of the two reference numbers is a distance.',
      given: { fl, startKg, endKg },
      steps: [
        step('start-r', 'Read R at the start weight', `FL${fl} · ${fmt(startKg)} kg`, startR, 'R', 0),
        step('end-r', 'Read R at the end weight', `FL${fl} · ${fmt(endKg)} kg`, endR, 'R', 0),
        step('answer', 'Subtract end R from start R', 'Start R − end R', answer, 'nm', 0, 0.5),
      ],
      diagnoses: [
        miss('wrong-row', 'table-cell', 'wrong row', `You read the end weight one tonne light.`, airDistance(fl, startKg, endKg - 1000)),
        miss('wrong-column', 'table-cell', 'wrong column', `You read both weights at FL${other}.`, airDistance(other, startKg, endKg)),
        miss('reversed', 'integrated-range', 'forward and back', 'You subtracted R start from R end.', -answer),
        miss('cell-as-distance', 'integrated-range', 'R as distance', 'You copied the reference number at the start weight and called it the distance.', reference(fl, startKg)),
      ],
    });
  }
  if (rung === 2) {
    const fl = pick(rand, levels);
    const index = levels.indexOf(fl);
    const other = levels[index === 0 ? 1 : index - 1]!;
    const startKg = pick(rand, [74000, 76000, 78000, 80000]);
    const endRow = startKg - pick(rand, [4000, 6000]);
    const airNm = (namAt(fl, endRow - 1000) + namAt(fl, endRow)) / 2 - namAt(fl, startKg);
    const endKg = weightForNam(fl, namAt(fl, startKg) + airNm);
    const answer = startKg - endKg;
    const startR = reference(fl, startKg);
    const targetR = startR - airNm;
    const line = `FL${fl}   start ${fmt(startKg)} kg   R ${fmt(reference(fl, startKg), 0)}   air ${fmt(airNm, 0)} nm`;
    return pack(seed, {
      skill: 'integrated-range',
      rung,
      stem: `You are planning a B727-200 cruise forward at FL${fl}, M 0.80, ISA. You start at ${fmt(startKg)} kg and the air distance is ${fmt(airNm, 0)} nm. Using the integrated-range reference numbers, what fuel does the sector burn?`,
      figure: { title: TITLE, lines: [line, ...rBand(fl, endKg)], highlight: [line] },
      unit: 'kg',
      tolerance: 5,
      decimals: 0,
      answer,
      method: `R at the start is ${fmt(reference(fl, startKg), 0)}. Subtract ${fmt(airNm, 0)} nm and read the weight at that R, ${fmt(endKg, 0)} kg. Fuel is ${fmt(startKg)} − ${fmt(endKg, 0)} = ${fmt(answer, 0)} kg.`,
      thumb: 'Fuel is the difference of the two weights, not the difference of the reference numbers.',
      given: { fl, startKg, airNm },
      steps: [
        step('start-r', 'Read the start reference', `FL${fl} · ${fmt(startKg)} kg`, startR, 'R', 0),
        step('target-r', 'Subtract the air distance', 'Start reference − air distance', targetR, 'R', 0),
        ...inverseSteps(fl, targetR, 'end'),
        step('answer', 'Subtract end weight from start weight', 'Start weight − end weight', answer, 'kg', 0, 5),
      ],
      diagnoses: [
        miss('backward', 'integrated-range', 'forward and back', 'You added the air distance to R, which is the backward plan.', startKg - weightForNam(fl, namAt(fl, startKg) - airNm)),
        miss('wrong-column', 'table-cell', 'wrong column', `You worked the forward plan at FL${other}.`, startKg - weightForNam(other, namAt(other, startKg) + airNm)),
        miss('nearest-row', 'interpolate', 'row offset', 'You snapped the end weight to the nearest 1 000 kg row.', startKg - roundTo(endKg, 1000)),
        miss('answered-weight', 'integrated-range', 'weight not fuel', 'You answered the end weight instead of the fuel.', endKg),
      ],
    });
  }
  if (rung === 3) {
    const fl = 335;
    const startKg = pick(rand, [76000, 78000, 80000]);
    const endKg = startKg - pick(rand, [6000, 8000]);
    const answer = airDistance(fl, startKg, endKg);
    const start330 = reference(330, startKg);
    const start350 = reference(350, startKg);
    const end330 = reference(330, endKg);
    const end350 = reference(350, endKg);
    const startR = start330 + 0.25 * (start350 - start330);
    const endR = end330 + 0.25 * (end350 - end330);
    const head = `t    FL330   FL350`;
    const row = (kg: number) => `${fmt(kg / 1000, 0).padStart(2)}   ${fmt(reference(330, kg), 0).padStart(6)}   ${fmt(reference(350, kg), 0).padStart(6)}`;
    const marked = row(startKg);
    return pack(seed, {
      skill: 'integrated-range',
      rung,
      stem: `A B727-200 cruise zone at FL${fl} runs from ${fmt(startKg)} kg to ${fmt(endKg)} kg, M 0.80, ISA. The integrated-range columns jump from FL330 to FL350. What air distance do you read, with the column offset included?`,
      figure: { title: TITLE, lines: [head, marked, row(endKg)], highlight: [marked] },
      unit: 'nm',
      tolerance: 1,
      decimals: 0,
      answer,
      method: `FL${fl} is a quarter of the way from FL330 to FL350. Interpolate R at each weight between those columns, then subtract: R start − R end = ${fmt(answer, 0)} nm.`,
      thumb: 'A column offset is the same fraction you would use in any other table.',
      given: { fl, startKg, endKg },
      steps: [
        step('quarter', 'Find the FL335 fraction', 'FL335 is one quarter from FL330 to FL350', 0.25, '', 2, 0.005),
        step('start-r330', 'Read start R at FL330', `${fmt(startKg)} kg`, start330, 'R', 0),
        step('start-r350', 'Read start R at FL350', `${fmt(startKg)} kg`, start350, 'R', 0),
        step('start-r', 'Interpolate start R at FL335', 'FL330 R + fraction × column difference', startR, 'R', 0),
        step('end-r330', 'Read end R at FL330', `${fmt(endKg)} kg`, end330, 'R', 0),
        step('end-r350', 'Read end R at FL350', `${fmt(endKg)} kg`, end350, 'R', 0),
        step('end-r', 'Interpolate end R at FL335', 'FL330 R + fraction × column difference', endR, 'R', 0),
        step('answer', 'Subtract end R from start R', 'Start R − end R', answer, 'nm', 0, 1),
      ],
      diagnoses: [
        miss('nearest-column', 'interpolate', 'column offset', 'You used the nearer column, FL330, and skipped the offset.', airDistance(330, startKg, endKg)),
        miss('other-column', 'interpolate', 'column offset', 'You used FL350 and skipped the offset.', airDistance(350, startKg, endKg)),
        miss('reversed', 'integrated-range', 'forward and back', 'You subtracted the reference numbers the wrong way around.', -answer),
      ],
    });
  }
  const fl = pick(rand, [310, 330, 350]);
  const other = fl === 310 ? 330 : 310;
  const endKg = pick(rand, [64000, 68000, 70000]);
  const startRow = endKg + pick(rand, [5000, 7000]);
  const airNm = namAt(fl, endKg) - (namAt(fl, startRow) + namAt(fl, startRow - 1000)) / 2;
  const startKg = weightForNam(fl, namAt(fl, endKg) - airNm);
  const answer = startKg - endKg;
  const endR = reference(fl, endKg);
  const targetStartR = endR + airNm;
  const line = `FL${fl}   end ${fmt(endKg)} kg   R ${fmt(reference(fl, endKg), 0)}   air ${fmt(airNm, 0)} nm`;
  return pack(seed, {
    skill: 'integrated-range',
    rung,
    stem: `You are planning a B727-200 cruise backward at FL${fl}, M 0.80, ISA. The zone ends at ${fmt(endKg)} kg and the air distance is ${fmt(airNm, 0)} nm. Using the integrated-range reference numbers, what fuel does the sector burn?`,
    figure: { title: TITLE, lines: [line, ...rBand(fl, startKg)], highlight: [line] },
    unit: 'kg',
    tolerance: 5,
    decimals: 0,
    answer,
    method: `R at the end is ${fmt(reference(fl, endKg), 0)}. Add ${fmt(airNm, 0)} nm and read ${fmt(startKg, 0)} kg. Fuel is ${fmt(startKg, 0)} − ${fmt(endKg)} = ${fmt(answer, 0)} kg.`,
    thumb: 'Backward adds distance to R. Forward subtracts it. Fuel is still start weight minus end weight.',
    given: { fl, endKg, airNm },
    steps: [
      step('end-r', 'Read the end reference', `FL${fl} · ${fmt(endKg)} kg`, endR, 'R', 0),
      step('start-r', 'Add the air distance for the backward plan', 'End reference + air distance', targetStartR, 'R', 0),
      ...inverseSteps(fl, targetStartR, 'start'),
      step('answer', 'Subtract end weight from start weight', 'Start weight − end weight', answer, 'kg', 0, 5),
    ],
    diagnoses: [
      miss('forward', 'integrated-range', 'forward and back', 'You subtracted the air distance from R, which is the forward plan.', weightForNam(fl, namAt(fl, endKg) + airNm) - endKg),
      miss('wrong-column', 'table-cell', 'wrong column', `You worked the backward plan at FL${other}.`, weightForNam(other, namAt(other, endKg) - airNm) - endKg),
      miss('answered-weight', 'integrated-range', 'weight not fuel', 'You answered the start weight instead of the fuel.', startKg),
    ],
  });
}

export const integratedRange = {
  id: 'integrated-range',
  name: 'Integrated range',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('integrated-range', seed, rung, (rand) => build(rand, seed, rung));
  },
};

function inverseSteps(fl: number, targetR: number, side: 'start' | 'end') {
  const bracket = referenceWeight(fl, targetR);
  return [
    step(`${side}-low-r`, `Read the lower ${side} weight reference`, 'Lower bracketing table row', reference(fl, bracket.lowKg), 'R', 0),
    step(`${side}-high-r`, `Read the higher ${side} weight reference`, 'Higher bracketing table row', reference(fl, bracket.highKg), 'R', 0),
    step(`${side}-fraction`, `Interpolate the ${side} weight fraction`, 'Target R between the two bracketing references', bracket.fraction, '', 3, 0.005),
    step(`${side}-weight`, `Interpolate the ${side} weight`, 'Lower weight + fraction × weight interval', bracket.weightKg, 'kg', 0, 5),
  ];
}
