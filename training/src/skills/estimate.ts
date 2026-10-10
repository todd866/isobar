import { fmt } from './format.ts';
import { LB, generateSkill, miss, pack, pick, step } from './lib.ts';
import type { Drill, Rung } from './types.ts';

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  if (rung === 1) {
    const distNm = pick(rand, [180, 240, 320, 400]);
    const perNm = pick(rand, [8.4, 9.2, 11.5, 12.4]);
    const fuelKg = perNm * distNm;
    const timeMin = pick(rand, [24, 30, 40]);
    const answer = fuelKg / distNm;
    const line = `${fmt(fuelKg, 0)} kg   ${distNm} nm   ${timeMin} min`;
    return pack(seed, {
      skill: 'specific-range',
      rung,
      stem: `A B727-200 cruise zone burns ${fmt(fuelKg, 0)} kg over ${distNm} nm and takes ${timeMin} minutes. What is the specific range, in kilograms per nautical mile?`,
      figure: { title: 'Specific range', lines: [line], highlight: [line] },
      unit: 'kg/nm',
      tolerance: 0.05,
      decimals: 1,
      answer,
      method: `Kilograms per nautical mile is fuel divided by distance: ${fmt(fuelKg, 0)} / ${distNm} = ${fmt(answer, 1)} kg/nm.`,
      thumb: 'The cruise cross-check is about 10 kg per ground nautical mile.',
      given: { fuelKg, distNm, timeMin },
      steps: [
        step('distance', 'Choose the distance flown', 'kg/nm uses nautical miles as the divisor', distNm, 'nm', 0, 0.5),
        step('specific-range', 'Divide fuel by distance', `${fmt(fuelKg)} kg ÷ distance`, answer, 'kg/nm', 1, 0.05),
      ],
      diagnoses: [
        miss('kg-per-min', 'specific-range', 'kg/min', 'You divided the fuel by the minutes.', fuelKg / timeMin),
        miss('inverted', 'specific-range', 'specific range', 'You divided the distance by the fuel.', distNm / fuelKg),
        miss('kilograms-as-pounds', 'units', 'kilograms as pounds', 'You multiplied by 2.2.', answer * LB),
      ],
    });
  }
  if (rung === 2) {
    const timeMin = pick(rand, [20, 25, 35, 45]);
    const perMin = pick(rand, [62, 74, 88, 96]);
    const fuelKg = perMin * timeMin;
    const distNm = pick(rand, [160, 220, 300]);
    const answer = fuelKg / timeMin;
    const line = `${fmt(fuelKg, 0)} kg   ${timeMin} min   ${distNm} nm`;
    return pack(seed, {
      skill: 'specific-range',
      rung,
      stem: `A B727-200 cruise zone burns ${fmt(fuelKg, 0)} kg in ${timeMin} minutes and covers ${distNm} nm. What is the burn, in kilograms per minute?`,
      figure: { title: 'Specific range', lines: [line], highlight: [line] },
      unit: 'kg/min',
      tolerance: 0.05,
      decimals: 1,
      answer,
      method: `Kilograms per minute is fuel divided by time: ${fmt(fuelKg, 0)} / ${timeMin} = ${fmt(answer, 1)} kg/min.`,
      thumb: 'The cruise cross-check is about 80 kg per minute.',
      given: { fuelKg, timeMin, distNm },
      steps: [
        step('minutes', 'Choose the elapsed time', 'kg/min uses minutes as the divisor', timeMin, 'min', 0, 0.5),
        step('kg-per-min', 'Divide fuel by minutes', `${fmt(fuelKg)} kg ÷ elapsed minutes`, answer, 'kg/min', 1, 0.05),
      ],
      diagnoses: [
        miss('kg-per-nm', 'specific-range', 'kg/nm', 'You divided the fuel by the distance.', fuelKg / distNm),
        miss('per-hour', 'zone-fuel', 'minutes as hours', 'You turned the minutes into hours and reported the fuel flow.', fuelKg / (timeMin / 60)),
        miss('kilograms-as-pounds', 'units', 'kilograms as pounds', 'You multiplied by 2.2.', answer * LB),
      ],
    });
  }
  if (rung === 3) {
    const flowKgH = pick(rand, [3900, 4300, 4700, 5100]);
    const gsKt = pick(rand, [420, 460, 500]);
    const answer = flowKgH / gsKt;
    const line = `${fmt(flowKgH)} kg/h   GS ${gsKt} kt`;
    return pack(seed, {
      skill: 'specific-range',
      rung,
      stem: `A B727-200 cruise zone flows at ${fmt(flowKgH)} kg/h and the groundspeed is ${gsKt} kt. What specific range, in kilograms per nautical mile, does that zone imply?`,
      figure: { title: 'Specific range', lines: [line], highlight: [line] },
      unit: 'kg/nm',
      tolerance: 0.05,
      decimals: 2,
      answer,
      method: `Kilograms per hour divided by knots is kilograms per nautical mile: ${fmt(flowKgH)} / ${gsKt} = ${fmt(answer, 2)} kg/nm.`,
      thumb: 'About 10 kg/nm. Anything near double that is a units error.',
      given: { flowKgH, gsKt },
      steps: [
        step('hour-distance', 'Find the distance flown in one hour', `${gsKt} kt × 1 hour`, gsKt, 'nm', 0, 0.5),
        step('kg-per-nm', 'Divide one-hour fuel by distance', `${fmt(flowKgH)} kg ÷ one-hour distance`, answer, 'kg/nm', 2, 0.05),
      ],
      diagnoses: [
        miss('kg-per-min', 'specific-range', 'kg/min', 'You divided the fuel flow by 60 and stopped there.', flowKgH / 60),
        miss('thumb-ten', 'specific-range', 'rule of thumb', 'You answered the 10 kg/nm cross-check instead of this zone.', 10),
        miss('flow-as-answer', 'zone-fuel', 'kg/h as kg/nm', 'You answered the fuel flow and did not divide by the groundspeed.', flowKgH),
      ],
    });
  }
  const distNm = pick(rand, [240, 360, 480, 640]);
  const answer = distNm * 10 + 1600;
  const line = `${distNm} ground nm`;
  return pack(seed, {
    skill: 'specific-range',
    rung,
    stem: `You want a rule-of-thumb cross-check on a B727-200 trip of ${distNm} ground nautical miles, climb included. What trip fuel does the estimate give?`,
    figure: { title: 'Rule of thumb', lines: [line, '10 kg per ground nm, plus 1 600 kg for the climb'], highlight: [line] },
    unit: 'kg',
    tolerance: 0.5,
    decimals: 0,
    answer,
    method: `Trip fuel is about ${distNm} × 10 + 1 600 = ${fmt(answer, 0)} kg. It checks the plan. It is not the plan.`,
    thumb: '10 kg/nm plus 1 600 kg. A miss of more than about 15 percent needs another look.',
    given: { distNm },
    steps: [
      step('cruise-fuel', 'Estimate cruise fuel', `${distNm} × 10`, distNm * 10, 'kg', 0, 0.5),
      step('trip-fuel', 'Add climb allowance', 'cruise fuel + 1 600', answer, 'kg', 0, 0.5),
    ],
    diagnoses: [
      miss('no-climb', 'specific-range', 'climb allowance', 'You used 10 kg/nm and left off the 1 600 kg climb allowance.', distNm * 10),
      miss('double-climb', 'specific-range', 'climb allowance', 'You added the climb allowance twice.', distNm * 10 + 3200),
      miss('kilograms-as-pounds', 'units', 'kilograms as pounds', 'You multiplied the estimate by 2.2.', answer * LB),
    ],
  });
}

export const specificRange = {
  id: 'specific-range',
  name: 'Kilograms per mile and per minute',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('specific-range', seed, rung, (rand) => build(rand, seed, rung));
  },
};
