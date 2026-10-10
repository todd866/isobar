import { fmt } from './format.ts';
import { LB, generateSkill, miss, pack, pick, roundTo, step, weightEntry } from './lib.ts';
import type { Drill, Rung } from './types.ts';

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  if (rung === 1) {
    const startKg = pick(rand, [70000, 74000, 78000, 82000]);
    const fuelKg = pick(rand, [2400, 3600, 4800, 6000]);
    const answer = startKg - fuelKg / 2;
    const line = `start ${fmt(startKg)} kg   zone fuel ${fmt(fuelKg)} kg`;
    return pack(seed, {
      skill: 'mid-zone-weight',
      rung,
      stem: `A B727-200 cruise zone starts at ${fmt(startKg)} kg and the zone fuel is ${fmt(fuelKg)} kg. What is the mid-zone weight, before you round it for the table?`,
      figure: { title: 'Mid-zone weight', lines: [line], highlight: [line] },
      unit: 'kg',
      tolerance: 1,
      decimals: 0,
      answer,
      method: `The table is entered halfway through the burn. ${fmt(startKg)} − ${fmt(fuelKg)} / 2 = ${fmt(answer, 0)} kg.`,
      thumb: 'Half the zone fuel, not the whole burn, comes off the start weight.',
      given: { startKg, fuelKg },
      steps: [
        step('half-fuel', 'Take half the zone fuel', `${fmt(fuelKg)} ÷ 2`, fuelKg / 2, 'kg', 0, 0.5),
        step('mid-weight', 'Subtract half the burn', `${fmt(startKg)} − half fuel`, answer, 'kg', 0, 1),
      ],
      diagnoses: [
        miss('forgot-half', 'mid-zone-weight', 'forgot the half', 'You subtracted the whole zone fuel.', startKg - fuelKg),
        miss('quarter', 'mid-zone-weight', 'forgot the half', 'You subtracted a quarter of the zone fuel.', startKg - fuelKg / 4),
        miss('kilograms-as-pounds', 'units', 'kilograms as pounds', 'You multiplied the kilograms by 2.2.', answer * LB),
      ],
    });
  }
  if (rung === 2) {
    const startKg = pick(rand, [74800, 76300, 78700]);
    const fuelKg = pick(rand, [3500, 4700, 5900]);
    const raw = startKg - fuelKg / 2;
    const answer = weightEntry(raw);
    const line = `start ${fmt(startKg)} kg   zone fuel ${fmt(fuelKg)} kg`;
    return pack(seed, {
      skill: 'mid-zone-weight',
      rung,
      stem: `A B727-200 cruise zone starts at ${fmt(startKg)} kg and burns ${fmt(fuelKg)} kg. The cruise table is entered at the mid-zone weight to the nearest 1 000 kg. What weight do you enter?`,
      figure: { title: 'Mid-zone weight', lines: [line], highlight: [line] },
      unit: 'kg',
      tolerance: 0.5,
      decimals: 0,
      answer,
      method: `Halfway through the burn is ${fmt(raw, 0)} kg, which rounds to ${fmt(answer, 0)} kg.`,
      thumb: 'Nearest 1 000 kg, with a half rounding up.',
      given: { startKg, fuelKg },
      steps: [
        step('half-fuel', 'Take half the zone fuel', `${fmt(fuelKg)} ÷ 2`, fuelKg / 2, 'kg', 0, 0.5),
        step('raw-weight', 'Subtract half the burn', `${fmt(startKg)} − half fuel`, raw, 'kg', 0, 1),
        step('table-weight', 'Round for the table', 'nearest 1 000 kg', answer, 'kg', 0, 0.5),
      ],
      diagnoses: [
        miss('forgot-half', 'mid-zone-weight', 'forgot the half', 'You subtracted the whole zone fuel, then rounded.', weightEntry(startKg - fuelKg)),
        miss('unrounded', 'mid-zone-weight', 'unrounded weight', 'You entered the exact halfway weight and did not round.', raw),
        miss('round-2000', 'table-cell', 'wrong column', 'You rounded to the 2 000 kg column instead of the nearest 1 000 kg.', roundTo(raw, 2000)),
      ],
    });
  }
  if (rung === 3) {
    const startKg = pick(rand, [76000, 80000]);
    const flowKgH = pick(rand, [4000, 4400, 4800]);
    const timeMin = pick(rand, [24, 30, 36]);
    const zone = (flowKgH * timeMin) / 60;
    const raw = startKg - zone / 2;
    const answer = weightEntry(raw);
    const line = `start ${fmt(startKg)} kg   ${fmt(flowKgH)} kg/h   ${timeMin} min`;
    return pack(seed, {
      skill: 'mid-zone-weight',
      rung,
      stem: `A B727-200 cruise zone starts at ${fmt(startKg)} kg. Fuel flow is ${fmt(flowKgH)} kg/h and the zone time is ${timeMin} minutes. What mid-zone weight do you enter, to the nearest 1 000 kg?`,
      figure: { title: 'Mid-zone weight', lines: [line], highlight: [line] },
      unit: 'kg',
      tolerance: 0.5,
      decimals: 0,
      answer,
      method: `Zone fuel is ${fmt(flowKgH)} × ${timeMin} / 60 = ${fmt(zone, 0)} kg. Halfway is ${fmt(raw, 0)} kg, entered as ${fmt(answer, 0)} kg.`,
      thumb: 'Fuel first, then half of it off the start weight.',
      given: { startKg, flowKgH, timeMin },
      steps: [
        step('hours', 'Convert zone minutes to hours', `${timeMin} ÷ 60`, timeMin / 60, 'h', 3, 0.001),
        step('zone-fuel', 'Calculate zone fuel', `${fmt(flowKgH)} × hours`, zone, 'kg', 0, 1),
        step('half-fuel', 'Take half the zone fuel', 'zone fuel ÷ 2', zone / 2, 'kg', 0, 1),
        step('raw-weight', 'Subtract half the burn', `${fmt(startKg)} − half fuel`, raw, 'kg', 0, 1),
        step('table-weight', 'Round for the table', 'nearest 1 000 kg', answer, 'kg', 0, 0.5),
      ],
      diagnoses: [
        miss('forgot-half', 'mid-zone-weight', 'forgot the half', 'You subtracted the whole zone fuel.', weightEntry(startKg - zone)),
        miss('minutes-as-hours', 'zone-time', 'minutes as hours', 'You treated the minutes as hours when you worked the fuel.', weightEntry(startKg - (flowKgH * timeMin) / 2)),
        miss('unrounded', 'mid-zone-weight', 'unrounded weight', 'You did not round to the nearest 1 000 kg.', raw),
      ],
    });
  }
  const brakeReleaseKg = pick(rand, [78000, 82000]);
  const climbFuelKg = pick(rand, [2200, 2800, 3400]);
  const zoneFuelKg = pick(rand, [2600, 3400, 4200]);
  const toc = brakeReleaseKg - climbFuelKg;
  const raw = toc - zoneFuelKg / 2;
  const answer = weightEntry(raw);
  const line = `brake release ${fmt(brakeReleaseKg)} kg   climb ${fmt(climbFuelKg)} kg   zone fuel ${fmt(zoneFuelKg)} kg`;
  return pack(seed, {
    skill: 'mid-zone-weight',
    rung,
    stem: `You are planning a B727-200. Brake release is ${fmt(brakeReleaseKg)} kg, the climb burns ${fmt(climbFuelKg)} kg, and the first cruise zone burns ${fmt(zoneFuelKg)} kg. What mid-zone weight do you enter for that cruise zone, to the nearest 1 000 kg?`,
    figure: { title: 'Mid-zone weight', lines: [line], highlight: [line] },
    unit: 'kg',
    tolerance: 0.5,
    decimals: 0,
    answer,
    method: `Top of climb is ${fmt(toc, 0)} kg. Halfway through the cruise burn is ${fmt(raw, 0)} kg, entered as ${fmt(answer, 0)} kg.`,
    thumb: 'Climb fuel comes off before the cruise zone is halved.',
    given: { brakeReleaseKg, climbFuelKg, zoneFuelKg },
    steps: [
      step('top-climb', 'Subtract climb fuel', `${fmt(brakeReleaseKg)} − ${fmt(climbFuelKg)}`, toc, 'kg', 0, 1),
      step('half-fuel', 'Take half the zone fuel', `${fmt(zoneFuelKg)} ÷ 2`, zoneFuelKg / 2, 'kg', 0, 0.5),
      step('raw-weight', 'Subtract half the burn', 'top-of-climb weight − half fuel', raw, 'kg', 0, 1),
      step('table-weight', 'Round for the table', 'nearest 1 000 kg', answer, 'kg', 0, 0.5),
    ],
    diagnoses: [
      miss('forgot-half', 'mid-zone-weight', 'forgot the half', 'You subtracted the whole cruise burn from the top of climb.', weightEntry(toc - zoneFuelKg)),
      miss('forgot-climb', 'mid-zone-weight', 'climb fuel', 'You halved the cruise burn from brake release and forgot the climb.', weightEntry(brakeReleaseKg - zoneFuelKg / 2)),
      miss('unrounded', 'mid-zone-weight', 'unrounded weight', 'You did not round to the nearest 1 000 kg.', raw),
    ],
  });
}

export const midZoneWeight = {
  id: 'mid-zone-weight',
  name: 'Mid-zone weight',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('mid-zone-weight', seed, rung, (rand) => build(rand, seed, rung));
  },
};
