import { fmt } from './format.ts';
import {
  generateSkill,
  isaC,
  isaDevForClimb,
  isaDevForCruise,
  lapseC,
  miss,
  pack,
  pick,
  step,
} from './lib.ts';
import type { Drill, Rung } from './types.ts';

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  const fl = pick(rand, rung === 4 ? [310, 330, 350, 370] : [250, 290, 310, 330, 350, 370]);
  const raw = pick(rand, [-12, -8, -4, 4, 8, 11, 14, 17]);
  const oatC = isaC(fl) + raw;
  const step = rung === 4 ? 5 : rung === 1 ? 0 : 3;
  const answer = step === 0 ? raw : step === 5 ? isaDevForClimb(raw) : isaDevForCruise(raw);
  const line = `FL${fl}   OAT ${fmt(oatC, 1)} °C`;
  const where = rung === 4 ? 'for the climb' : rung === 1 ? '' : 'for cruise fuel flow';
  const stem = rung === 3
    ? `You are in the cruise zone of a B727-200 at FL${fl}. The zone forecast gives an outside air temperature of ${fmt(oatC, 1)} °C. What ISA deviation do you enter for the cruise fuel flow?`
    : rung === 4
      ? `You are planning the climb of a B727-200 to FL${fl}. The forecast outside air temperature at the climb level is ${fmt(oatC, 1)} °C. What ISA deviation do you enter for the climb table?`
      : `You are flight-planning a B727-200 at FL${fl}. The outside air temperature is ${fmt(oatC, 1)} °C. What is the ISA deviation${where ? ` ${where}` : ''}?`;
  const method = step === 0
    ? `ISA at FL${fl} is ${fmt(isaC(fl), 1)} °C. Deviation is OAT minus ISA: ${fmt(oatC, 1)} − (${fmt(isaC(fl), 1)}) = ${fmt(answer, 1)} °C.`
    : `OAT minus ISA is ${fmt(raw, 1)} °C. The ${step === 5 ? 'climb' : 'cruise'} table wants the nearest ${step} °C, so you enter ${fmt(answer, 0)} °C.`;
  const steps = step === 0
    ? [
      stepValue('isa', 'Calculate local ISA temperature', `max(15 − 0.19812 × FL, −56.5) °C`, isaC(fl), '°C', 1, 0.2),
      stepValue('deviation', 'Subtract ISA from OAT', `${fmt(oatC, 1)} − ISA`, raw, '°C', 1, 0.2),
    ]
    : [
      stepValue('isa', 'Calculate local ISA temperature', `max(15 − 0.19812 × FL, −56.5) °C`, isaC(fl), '°C', 1, 0.2),
      stepValue('deviation', 'Subtract ISA from OAT', `${fmt(oatC, 1)} − ISA`, raw, '°C', 1, 0.2),
      stepValue('table-round', `Round to nearest ${step} °C`, 'Use the deviation from the previous step', answer, '°C', 0, 0.01),
    ];
  return pack(seed, {
    skill: 'isa-dev',
    rung,
    stem,
    figure: { title: 'ISA deviation', lines: [line], highlight: [line] },
    unit: '°C',
    tolerance: step === 0 ? 0.2 : 0.01,
    decimals: step === 0 ? 1 : 0,
    answer,
    method,
    thumb: 'About 2 °C per 1 000 ft from 15 °C, and −56.5 °C in the stratosphere.',
    given: { fl, oatC, roundingStep: step },
    steps,
    diagnoses: [
      miss('sign', 'isa-dev', 'sign of ISA', 'You subtracted OAT from ISA instead of ISA from OAT.', step === 0 ? -raw : step === 5 ? isaDevForClimb(-raw) : isaDevForCruise(-raw)),
      miss('wrong-level', 'isa-dev', 'ISA level', `You used the ISA temperature for FL${fl + 20}.`, (() => {
        const other = oatC - isaC(fl + 20);
        return step === 0 ? other : step === 5 ? isaDevForClimb(other) : isaDevForCruise(other);
      })()),
      miss('lapse', 'isa-dev', 'lapse rate', 'You used 2 °C per 1 000 ft all the way up, including above the tropopause.', (() => {
        const other = oatC - lapseC(fl);
        return step === 0 ? other : step === 5 ? isaDevForClimb(other) : isaDevForCruise(other);
      })()),
      ...(rung === 1 ? [miss('sea-level', 'isa-dev', 'sea level', 'You subtracted 15 °C as if you were at sea level.', oatC - 15)] : []),
      ...(step !== 0 ? [miss('unrounded', 'isa-dev', 'unrounded ISA', 'You entered the raw deviation and skipped the table rounding.', raw)] : []),
      ...(rung === 2 || rung === 3 ? [miss('climb-step', 'isa-dev', 'ISA level', 'You rounded to 5 °C, which is the climb rule, not the cruise rule.', isaDevForClimb(raw))] : []),
      ...(rung === 4 ? [miss('cruise-step', 'isa-dev', 'ISA level', 'You rounded to 3 °C, which is the cruise fuel-flow rule, not the climb rule.', isaDevForCruise(raw))] : []),
    ],
  });
}

function stepValue(id: string, label: string, detail: string, value: number, unit: string, decimals: number, tolerance: number) {
  return step(id, label, detail, value, unit, decimals, tolerance);
}

export const isaDev = {
  id: 'isa-dev',
  name: 'ISA deviation',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('isa-dev', seed, rung, (rand) => build(rand, seed, rung));
  },
};
