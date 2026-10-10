import { fmt } from './format.ts';
import {
  TABLES,
  armOfMac,
  compartmentArm,
  generateSkill,
  indexUnits,
  macFromIndex,
  miss,
  pack,
  pick,
  step,
  zoneArm,
} from './lib.ts';
import type { FigureTable, WorkStep } from '../figure.ts';
import type { Drill, Rung } from './types.ts';

const NEXT: Record<number, number> = { 1: 2, 2: 1, 4: 5, 5: 4 };

function totalIndex(weightKg: number, mac: number): number {
  return TABLES.balance.indexUnit.offset + indexUnits(weightKg, armOfMac(mac));
}

type LoadRow = { label: string; weight: number; arm: number; moment: number };

function loadingFigure(rows: LoadRow[], highlights: string[], computed: { row: number; column: number; step: string }[], columns = ['kg', 'm', 'kg·m'], usedRows = rows.map((_, i) => i)) {
  const table: FigureTable = {
    label: 'Loading',
    title: 'Moments',
    unit: '',
    corner: 'Item',
    group: 'Load data',
    columns,
    rows: rows.map((row) => ({ label: row.label, cells: [row.weight, row.arm, row.moment] })),
    decimals: 0,
    columnDecimals: [0, 5, 0],
    computed,
    used: usedRows.flatMap((r) => [0, 1, 2].map((c) => [r, c] as [number, number])),
  };
  const lines = table.rows.map((row) => `${row.label}  ${fmt(row.cells[0]!, 0)}  ${fmt(row.cells[1]!, 3)}  ${fmt(row.cells[2]!, 0)}`);
  return { title: 'Loading moments', lines, highlight: highlights.length ? highlights : lines, table };
}

function cgSteps(rows: LoadRow[], totalWeight: number, totalMoment: number, totalArm: number, answer: number, percent = true, preSteps: WorkStep[] = []): WorkStep[] {
  const moments = rows.map((row, i) => step(`moment-${i}`, `Moment for ${row.label}`, `${row.label}: weight × arm`, row.moment, 'kg·m', 0));
  return [
    ...preSteps,
    ...moments,
    step('total-weight', 'Add the weights', 'sum the item weights', totalWeight, 'kg', 0),
    step('total-moment', 'Add the moments', 'sum the item moments', totalMoment, 'kg·m', 0, 2),
    step('mean-arm', 'Find the loaded arm', 'total moment ÷ total weight', totalArm, 'm', 5, 0.00005),
    step('answer', percent ? 'Convert the arm to percent MAC' : 'Divide the offset moment by 500', percent ? '(loaded arm − 20.75) ÷ 4.595 × 100' : 'offset moment ÷ 500', answer, percent ? '% MAC' : 'IU', percent ? 1 : 1),
  ];
}

function computedMomentRows(rows: LoadRow[], momentStep = (i: number) => `moment-${i}`): { row: number; column: number; step: string }[] {
  return rows.flatMap((_, i) => [{ row: i, column: 2, step: momentStep(i) }]);
}

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  if (rung === 1) {
    const compartment = pick(rand, [1, 2, 4, 5]);
    const weightKg = pick(rand, [400, 800, 1200, 1600]);
    const armM = compartmentArm(compartment);
    const answer = indexUnits(weightKg, armM);
    const offsetArm = armM - TABLES.balance.indexUnit.referenceArmM;
    const offsetMoment = weightKg * offsetArm;
    const rows = [{ label: `Hold ${compartment}`, weight: weightKg, arm: offsetArm, moment: offsetMoment }, { label: 'Total', weight: weightKg, arm: offsetArm, moment: offsetMoment }];
    const wrongArm = compartmentArm(NEXT[compartment]!);
    const line = `compartment ${compartment}   ${fmt(weightKg)} kg   arm ${fmt(armM, 1)} m`;
    return pack(seed, {
      skill: 'cg-shift',
      rung,
      stem: `You are loading a B727-200. Compartment ${compartment} takes ${fmt(weightKg)} kg at an arm of ${fmt(armM, 1)} m aft of the datum. The index datum sits at 25 percent MAC. What is the index of that load?`,
      figure: loadingFigure(rows, [], [{ row: 0, column: 1, step: 'offset-arm' }, { row: 0, column: 2, step: 'offset-moment' }, { row: 1, column: 1, step: 'offset-arm' }, { row: 1, column: 2, step: 'offset-moment' }], ['kg', 'Offset m', 'Offset kg·m']),
      unit: 'IU',
      tolerance: 0.05,
      decimals: 1,
      answer,
      method: `${fmt(weightKg)} × (${fmt(armM, 2)} − 21.90) / 500 = ${fmt(answer, 1)} IU. The 100-unit offset belongs to the aeroplane, not to one load.`,
      thumb: 'A tonne about a metre off the datum is about 2 index units.',
      given: { compartment, weightKg, armM, referenceArmM: TABLES.balance.indexUnit.referenceArmM, divisor: TABLES.balance.indexUnit.divisor },
      steps: [
        step('offset-arm', 'Find the arm from the datum', `${fmt(armM, 1)} − 21.89875`, offsetArm, 'm', 5, 0.000005),
        step('offset-moment', 'Multiply weight by offset arm', `${fmt(weightKg, 0)} × offset arm`, offsetMoment, 'kg·m', 0),
        step('answer', 'Convert offset moment to index units', 'offset moment ÷ 500', answer, 'IU', 1),
      ],
      diagnoses: [
        miss('with-offset', 'cg-shift', 'index offset', 'You added the 100-unit basic offset to a single load.', answer + 100),
        miss('forgot-divisor', 'cg-shift', 'moment', 'You stopped at weight times the arm offset and did not divide by 500.', weightKg * (armM - TABLES.balance.indexUnit.referenceArmM)),
        miss('wrong-arm', 'cg-shift', 'wrong arm', `You used compartment ${NEXT[compartment]} instead of compartment ${compartment}.`, indexUnits(weightKg, wrongArm)),
      ],
    });
  }
  if (rung === 2) {
    const weightKg = pick(rand, [62000, 66000, 70000]);
    const mac = pick(rand, [22, 26, 30]);
    const compartment = pick(rand, [1, 5]);
    const addKg = pick(rand, [3000, 4000, 5000]);
    const armM = compartmentArm(compartment);
    const next = totalIndex(weightKg, mac) + indexUnits(addKg, armM);
    const answer = macFromIndex(weightKg + addKg, next);
    const oldWay = macFromIndex(weightKg, next);
    const wrong = macFromIndex(weightKg + addKg, totalIndex(weightKg, mac) + indexUnits(addKg, compartmentArm(NEXT[compartment]!)));
    const baseArm = armOfMac(mac);
    const addMoment = addKg * armM;
    const baseMoment = weightKg * baseArm;
    const totalWeight = weightKg + addKg;
    const totalMoment = baseMoment + addMoment;
    const totalArm = totalMoment / totalWeight;
    const rows = [{ label: 'Aircraft', weight: weightKg, arm: baseArm, moment: baseMoment }, { label: `Hold ${compartment}`, weight: addKg, arm: armM, moment: addMoment }, { label: 'Total', weight: totalWeight, arm: totalArm, moment: totalMoment }];
    const line = `${fmt(weightKg)} kg at ${fmt(mac, 0)}% MAC   + ${fmt(addKg)} kg in compartment ${compartment}`;
    return pack(seed, {
      skill: 'cg-shift',
      rung,
      stem: `A B727-200 weighs ${fmt(weightKg)} kg at ${fmt(mac, 0)} percent MAC. You add ${fmt(addKg)} kg in compartment ${compartment}. What is the new centre of gravity, in percent MAC?`,
      figure: loadingFigure(rows, [], [...computedMomentRows(rows.slice(0, 2)), { row: 0, column: 1, step: 'base-arm' }, { row: 2, column: 0, step: 'total-weight' }, { row: 2, column: 1, step: 'mean-arm' }, { row: 2, column: 2, step: 'total-moment' }]),
      unit: '% MAC',
      tolerance: 0.05,
      decimals: 1,
      answer,
      method: `Add the load's index to the aeroplane's index, add the weight, and convert back to percent MAC. The new centre of gravity is ${fmt(answer, 1)}% MAC.`,
      thumb: 'Freight in the forward hold pulls an aft centre of gravity forward.',
      given: { weightKg, mac, addKg, compartment, baseArm, armM },
      steps: cgSteps(rows.slice(0, 2), totalWeight, totalMoment, totalArm, answer, true, [step('base-arm', 'Convert starting % MAC to arm', `${fmt(mac, 0)} ÷ 100 × 4.595 + 20.75`, baseArm, 'm', 5, 0.000005)]),
      diagnoses: [
        miss('old-weight', 'cg-shift', 'moment', 'You changed the moment but divided by the old weight.', oldWay),
        miss('wrong-arm', 'cg-shift', 'wrong arm', `You used compartment ${NEXT[compartment]}.`, wrong),
        miss('index-not-mac', 'cg-shift', 'index not MAC', 'You answered the new index instead of percent MAC.', next),
      ],
    });
  }
  if (rung === 3) {
    const weightKg = pick(rand, [64000, 68000, 72000]);
    const mac = pick(rand, [24, 28, 32]);
    const moveKg = pick(rand, [1500, 2000, 2500]);
    const from = 5;
    const to = 1;
    const delta = indexUnits(moveKg, compartmentArm(to)) - indexUnits(moveKg, compartmentArm(from));
    const index = totalIndex(weightKg, mac) + delta;
    const answer = macFromIndex(weightKg, index);
    const reversed = macFromIndex(weightKg, totalIndex(weightKg, mac) - delta);
    const baseArm = armOfMac(mac);
    const fromArm = compartmentArm(from);
    const toArm = compartmentArm(to);
    const rows = [{ label: 'Aircraft', weight: weightKg, arm: baseArm, moment: weightKg * baseArm }, { label: `Unload ${from}`, weight: -moveKg, arm: fromArm, moment: -moveKg * fromArm }, { label: `Load ${to}`, weight: moveKg, arm: toArm, moment: moveKg * toArm }];
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
    const totalMoment = rows.reduce((sum, row) => sum + row.moment, 0);
    const totalArm = totalMoment / totalWeight;
    rows.push({ label: 'Total', weight: totalWeight, arm: totalArm, moment: totalMoment });
    const line = `${fmt(weightKg)} kg at ${fmt(mac, 0)}% MAC   move ${fmt(moveKg)} kg from 5 to 1`;
    return pack(seed, {
      skill: 'cg-shift',
      rung,
      stem: `A B727-200 weighs ${fmt(weightKg)} kg at ${fmt(mac, 0)} percent MAC. You move ${fmt(moveKg)} kg of freight from compartment 5 to compartment 1. What is the new centre of gravity, in percent MAC?`,
      figure: loadingFigure(rows, [], [...computedMomentRows(rows.slice(0, 3)), { row: 0, column: 1, step: 'base-arm' }, { row: 3, column: 0, step: 'total-weight' }, { row: 3, column: 1, step: 'mean-arm' }, { row: 3, column: 2, step: 'total-moment' }]),
      unit: '% MAC',
      tolerance: 0.05,
      decimals: 1,
      answer,
      method: `The weight does not change. The index changes by the load times the change of arm, divided by 500. The new centre of gravity is ${fmt(answer, 1)}% MAC.`,
      thumb: 'Moving weight forward moves the centre of gravity forward, by load × distance / total weight.',
      given: { weightKg, mac, moveKg, from, to, baseArm, fromArm, toArm },
      steps: cgSteps(rows.slice(0, 3), totalWeight, totalMoment, totalArm, answer, true, [step('base-arm', 'Convert starting % MAC to arm', `${fmt(mac, 0)} ÷ 100 × 4.595 + 20.75`, baseArm, 'm', 5, 0.000005)]),
      diagnoses: [
        miss('reversed', 'cg-shift', 'sign of the shift', 'You moved the freight aft instead of forward.', reversed),
        miss('index-not-mac', 'cg-shift', 'index not MAC', 'You answered the new index instead of percent MAC.', index),
        miss('wrong-arm', 'cg-shift', 'wrong arm', 'You moved the freight into compartment 2 instead of compartment 1.', macFromIndex(weightKg, totalIndex(weightKg, mac) + indexUnits(moveKg, compartmentArm(2)) - indexUnits(moveKg, compartmentArm(from)))),
      ],
    });
  }
  const basicKg = TABLES.balance.standardWeights ? 46400 : 46400;
  const basicIndex = 125.5;
  const adults = pick(rand, [12, 18, 24]);
  const freightKg = pick(rand, [600, 1000, 1400]);
  const compartment = pick(rand, [1, 4]);
  const people = adults * TABLES.balance.standardWeights.adult;
  const index = basicIndex + indexUnits(people, zoneArm('A')) + indexUnits(freightKg, compartmentArm(compartment));
  const weight = basicKg + people + freightKg;
  const answer = macFromIndex(weight, index);
  const basicArm = TABLES.balance.indexUnit.referenceArmM + ((basicIndex - TABLES.balance.indexUnit.offset) * TABLES.balance.indexUnit.divisor) / basicKg;
  const peopleArm = zoneArm('A');
  const freightArm = compartmentArm(compartment);
  const rows = [{ label: 'Basic', weight: basicKg, arm: basicArm, moment: basicKg * basicArm }, { label: 'Adults A', weight: people, arm: peopleArm, moment: people * peopleArm }, { label: `Hold ${compartment}`, weight: freightKg, arm: freightArm, moment: freightKg * freightArm }];
  const totalMoment = rows.reduce((sum, row) => sum + row.moment, 0);
  const totalArm = totalMoment / weight;
  rows.push({ label: 'Total', weight, arm: totalArm, moment: totalMoment });
  const wrongZone = macFromIndex(weight, basicIndex + indexUnits(people, zoneArm('B')) + indexUnits(freightKg, compartmentArm(compartment)));
  const wrongArm = macFromIndex(weight, basicIndex + indexUnits(people, zoneArm('A')) + indexUnits(freightKg, compartmentArm(NEXT[compartment]!)));
  const line = `basic ${fmt(basicKg)} kg   zone A ${adults} adults   compartment ${compartment} ${fmt(freightKg)} kg`;
  return pack(seed, {
    skill: 'cg-shift',
    rung,
    stem: `You are building the zero-fuel weight of a B727-200. Basic weight is ${fmt(basicKg)} kg at index ${fmt(basicIndex, 1)}. Zone A has ${adults} adults and compartment ${compartment} has ${fmt(freightKg)} kg. What is the zero-fuel centre of gravity, in percent MAC?`,
    figure: loadingFigure(rows, [], [...computedMomentRows(rows.slice(0, 3)), { row: 0, column: 1, step: 'basic-arm' }, { row: 1, column: 0, step: 'people-weight' }, { row: 3, column: 0, step: 'total-weight' }, { row: 3, column: 1, step: 'mean-arm' }, { row: 3, column: 2, step: 'total-moment' }]),
    unit: '% MAC',
    tolerance: 0.05,
    decimals: 1,
    answer,
    method: `Add each load's index to the basic index, add the weights, and convert to percent MAC. Zero-fuel CG is ${fmt(answer, 1)}% MAC.`,
    thumb: 'Passengers forward of the wing move a tail-heavy 727 forward.',
    given: { basicKg, basicIndex, adults, freightKg, compartment, people, basicArm, peopleArm, freightArm },
    steps: cgSteps(rows.slice(0, 3), weight, totalMoment, totalArm, answer, true, [
      step('basic-arm', 'Convert basic index to arm', `21.89875 + (${basicIndex} − 100) × 500 ÷ ${basicKg}`, basicArm, 'm', 5, 0.000005),
      step('people-weight', 'Find the adults weight', `${adults} × ${TABLES.balance.standardWeights.adult} kg`, people, 'kg', 0),
    ]),
    diagnoses: [
      miss('wrong-zone', 'cg-shift', 'wrong arm', 'You put the passengers in zone B.', wrongZone),
      miss('wrong-arm', 'cg-shift', 'wrong arm', `You loaded compartment ${NEXT[compartment]}.`, wrongArm),
      miss('index-not-mac', 'cg-shift', 'index not MAC', 'You answered the zero-fuel index instead of percent MAC.', index),
    ],
  });
}

export const cgShift = {
  id: 'cg-shift',
  name: 'Moment and centre of gravity',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('cg-shift', seed, rung, (rand) => build(rand, seed, rung));
  },
};
