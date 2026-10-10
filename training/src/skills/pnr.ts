import { fmt } from './format.ts';
import { LB, generateSkill, miss, pack, pick, pnrDistanceNm, step } from './lib.ts';
import type { Drill, Rung } from './types.ts';

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  if (rung === 1) {
    const sgrOut = pick(rand, [9, 10, 11]);
    const sgrBack = pick(rand, [12, 13, 14]);
    const distNm = 800;
    const fuelKg = pick(rand, [4000, 5000, 6000]);
    const answer = pnrDistanceNm(fuelKg, [{ distNm, sgrOutKgPerNm: sgrOut, sgrBackKgPerNm: sgrBack }]).distNm;
    const perNm = sgrOut + sgrBack;
    const line = `${fmt(fuelKg)} kg   out ${sgrOut} kg/nm   back ${sgrBack} kg/nm`;
    return pack(seed, {
      skill: 'pnr',
      rung,
      stem: `You have ${fmt(fuelKg)} kg available for an out-and-back in a B727-200. The specific ground range is ${sgrOut} kg/nm outbound and ${sgrBack} kg/nm back, and the route is longer than the point of no return. How far from departure is the point of no return?`,
      figure: { title: 'Point of no return', lines: [line], highlight: [line] },
      unit: 'nm',
      tolerance: 0.5,
      decimals: 1,
      answer,
      method: `Add the outbound and return specific ranges, then divide the fuel by that sum. ${fmt(fuelKg)} / (${sgrOut} + ${sgrBack}) = ${fmt(answer, 1)} nm.`,
      thumb: 'You pay for every mile twice, once out and once back.',
      given: { fuelKg, sgrOut, sgrBack, distNm },
      steps: [
        step('sum-sgr', 'Add outbound and return burn', `${sgrOut} + ${sgrBack}`, perNm, 'kg/nm', 1),
        step('answer', 'Divide available fuel by the round-trip burn', 'Available fuel ÷ round-trip burn', answer, 'nm', 1, 0.5),
      ],
      diagnoses: [
        miss('outbound-only', 'pnr', 'return fuel', 'You divided by the outbound specific range only.', fuelKg / sgrOut),
        miss('return-only', 'pnr', 'return fuel', 'You divided by the return specific range only.', fuelKg / sgrBack),
        miss('kilograms-as-pounds', 'units', 'kilograms as pounds', 'You converted the fuel to pounds first.', (fuelKg * LB) / (sgrOut + sgrBack)),
      ],
    });
  }
  if (rung === 4) {
    const d1 = pick(rand, [80, 100, 120]);
    const sgrOut1 = 10;
    const sgrBack1 = 12;
    const sgrOut2 = 11;
    const sgrBack2 = 14;
    const zoneFuel = (sgrOut1 + sgrBack1) * d1;
    const extra = pick(rand, [1500, 2000, 2500]);
    const fuelKg = zoneFuel + extra;
    const d2 = 400;
    const answer = pnrDistanceNm(fuelKg, [
      { distNm: d1, sgrOutKgPerNm: sgrOut1, sgrBackKgPerNm: sgrBack1 },
      { distNm: d2, sgrOutKgPerNm: sgrOut2, sgrBackKgPerNm: sgrBack2 },
    ]).distNm;
    const perNm1 = sgrOut1 + sgrBack1;
    const remaining = fuelKg - zoneFuel;
    const perNm2 = sgrOut2 + sgrBack2;
    const extraDistance = remaining / perNm2;
    const line = `zone 1 ${d1} nm at ${sgrOut1}+${sgrBack1} kg/nm   zone 2 ${sgrOut2}+${sgrBack2} kg/nm   fuel ${fmt(fuelKg)} kg`;
    return pack(seed, {
      skill: 'pnr',
      rung,
      stem: `A B727-200 has ${fmt(fuelKg, 0)} kg for an out-and-back over two zones. Zone 1 is ${d1} nm at ${sgrOut1} kg/nm out and ${sgrBack1} kg/nm back. Zone 2 continues at ${sgrOut2} kg/nm out and ${sgrBack2} kg/nm back. How far from departure is the point of no return?`,
      figure: { title: 'Point of no return', lines: [line], highlight: [line] },
      unit: 'nm',
      tolerance: 0.5,
      decimals: 1,
      answer,
      method: `Zone 1 uses ${fmt(zoneFuel, 0)} kg out and back, leaving ${fmt(extra, 0)} kg. That buys ${fmt(extra / (sgrOut2 + sgrBack2), 1)} nm into zone 2, so the point is ${fmt(answer, 1)} nm out.`,
      thumb: 'Spend the out-and-back fuel zone by zone. The point is where the fuel runs out.',
      given: { fuelKg, d1, sgrOut1, sgrBack1, sgrOut2, sgrBack2 },
      steps: [
        step('zone1-rate', 'Add zone 1 outbound and return burn', `${sgrOut1} + ${sgrBack1}`, perNm1, 'kg/nm', 1),
        step('zone1-fuel', 'Spend the fuel through zone 1', 'Zone 1 burn rate × zone 1 distance', zoneFuel, 'kg', 0),
        step('remaining', 'Find fuel left for zone 2', 'Available fuel − zone 1 fuel', remaining, 'kg', 0),
        step('zone2-rate', 'Add zone 2 outbound and return burn', `${sgrOut2} + ${sgrBack2}`, perNm2, 'kg/nm', 1),
        step('zone2-distance', 'Convert remaining fuel to distance', 'Remaining fuel ÷ zone 2 burn rate', extraDistance, 'nm', 1),
        step('answer', 'Add the first zone', 'Zone 1 distance + zone 2 distance', answer, 'nm', 1, 0.5),
      ],
      diagnoses: [
        miss('zone-end', 'pnr', 'one zone', 'You stopped at the end of the first zone.', d1),
        miss('same-sgr', 'pnr', 'specific range', 'You kept the first zone specific ranges into the second zone.', d1 + extra / (sgrOut1 + sgrBack1)),
        miss('outbound-only', 'pnr', 'return fuel', 'You divided the remaining fuel by the outbound specific range only.', d1 + extra / sgrOut2),
      ],
    });
  }
  const flowOut = pick(rand, [4200, 4600]);
  const flowBack = flowOut + 400;
  const gsOn = pick(rand, [430, 470, 500]);
  const gsBack = rung === 3 ? gsOn - 80 : gsOn - 40;
  const sgrOut = flowOut / gsOn;
  const sgrBack = flowBack / gsBack;
  const distNm = 900;
  const fuelKg = pick(rand, [4500, 5500]);
  const answer = fuelKg / (sgrOut + sgrBack);
  const sgrSum = sgrOut + sgrBack;
  const line = `${fmt(fuelKg)} kg   out ${fmt(flowOut)} kg/h at ${gsOn} kt   back ${fmt(flowBack)} kg/h at ${gsBack} kt`;
  const stem = rung === 2
    ? `You have ${fmt(fuelKg)} kg for an out-and-back in a B727-200. Outbound the fuel flow is ${fmt(flowOut)} kg/h at ${gsOn} kt, and back it is ${fmt(flowBack)} kg/h at ${gsBack} kt. How far from departure is the point of no return?`
    : `One cruise zone has a headwind home. You have ${fmt(fuelKg)} kg for the out-and-back. Outbound is ${fmt(flowOut)} kg/h at ${gsOn} kt, and the return is ${fmt(flowBack)} kg/h at ${gsBack} kt. How far from departure is the point of no return?`;
  return pack(seed, {
    skill: 'pnr',
    rung,
    stem,
    figure: { title: 'Point of no return', lines: [line], highlight: [line] },
    unit: 'nm',
    tolerance: 0.5,
    decimals: 1,
    answer,
    method: `Specific range is fuel flow divided by groundspeed: ${fmt(sgrOut, 2)} kg/nm out and ${fmt(sgrBack, 2)} kg/nm back. ${fmt(fuelKg)} / the sum is ${fmt(answer, 1)} nm.`,
    thumb: 'Kilograms per hour divided by knots is kilograms per nautical mile.',
    given: { fuelKg, flowOut, gsOn, flowBack, gsBack, distNm },
    steps: [
      step('sgr-out', 'Convert outbound flow to specific range', 'Outbound flow ÷ outbound groundspeed', sgrOut, 'kg/nm', 2, 0.01),
      step('sgr-back', 'Convert return flow to specific range', 'Return flow ÷ return groundspeed', sgrBack, 'kg/nm', 2, 0.01),
      step('sum-sgr', 'Add outbound and return burn', 'Outbound specific range + return specific range', sgrSum, 'kg/nm', 2, 0.01),
      step('answer', 'Divide available fuel by the round-trip burn', 'Available fuel ÷ round-trip burn', answer, 'nm', 1, 0.5),
    ],
    diagnoses: [
      miss('outbound-only', 'pnr', 'return fuel', 'You divided by the outbound specific range only.', fuelKg / sgrOut),
      miss('flow-as-sgr', 'specific-range', 'kg/h as kg/nm', 'You treated the fuel flows as kilograms per nautical mile.', fuelKg / (flowOut + flowBack)),
      miss(rung === 2 ? 'kilograms-as-pounds' : 'sign', rung === 2 ? 'units' : 'wind-component', rung === 2 ? 'kilograms as pounds' : 'wind sign', rung === 2 ? 'You converted the fuel to pounds first.' : 'You swapped the outbound and return groundspeeds.', rung === 2 ? (fuelKg * LB) / (sgrOut + sgrBack) : fuelKg / (flowOut / gsBack + flowBack / gsOn)),
    ],
  });
}

export const pnr = {
  id: 'pnr',
  name: 'Point of no return',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('pnr', seed, rung, (rand) => build(rand, seed, rung));
  },
};
