import { fmt } from './format.ts';
import { generateSkill, LB, miss, pack, pick, step, triangle } from './lib.ts';
import type { Drill, Rung } from './types.ts';

function windTriangleSteps(trackDeg: number, windFromDeg: number, windKt: number, tasKt: number, gsKt: number) {
  const angle = windFromDeg - trackDeg;
  const radians = angle * Math.PI / 180;
  const cross = windKt * Math.sin(radians);
  const tail = -windKt * Math.cos(radians);
  const air = Math.sqrt(Math.max(0, tasKt * tasKt - cross * cross));
  return [
    step('angle', 'Find signed wind angle', `wind from ${windFromDeg}° − track ${trackDeg}°`, angle, '°', 0, 0.5),
    step('sin', 'Calculate sine of the angle', 'sin of the wind angle', Math.sin(radians), '', 3, 0.005),
    step('cross', 'Resolve the crosswind', 'wind speed × sine', cross, 'kt', 1, 0.5),
    step('cos', 'Calculate cosine of the angle', 'cos of the wind angle', Math.cos(radians), '', 3, 0.005),
    step('tail', 'Resolve the along-track wind', '−wind speed × cosine', tail, 'kt', 1, 0.5),
    step('air', 'Allow for the crosswind', '√(TAS² − crosswind²)', air, 'kt', 1, 0.5),
    step('gs', 'Add the along-track wind', 'air speed component + tailwind', gsKt, 'kt', 1, 0.5),
  ];
}

function fuel(flowKgH: number, timeMin: number): number {
  return (flowKgH * timeMin) / 60;
}

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  const flowKgH = pick(rand, [3800, 4200, 4500, 4800]);
  if (rung === 1) {
    const timeMin = pick(rand, [18, 24, 30, 42]);
    const answer = fuel(flowKgH, timeMin);
    const line = `${fmt(flowKgH)} kg/h   ${fmt(timeMin, 0)} min`;
    return pack(seed, {
      skill: 'zone-fuel',
      rung,
      stem: `A B727-200 cruise zone burns at ${fmt(flowKgH)} kg/h and the zone time is ${fmt(timeMin, 0)} minutes. What is the zone fuel?`,
      figure: { title: 'Zone fuel', lines: [line], highlight: [line] },
      unit: 'kg',
      tolerance: 1,
      decimals: 0,
      answer,
      method: `Fuel is flow × time in hours. ${fmt(flowKgH)} × ${fmt(timeMin, 0)} / 60 = ${fmt(answer, 0)} kg.`,
      thumb: 'About 70 to 80 kg a minute in the cruise.',
      given: { flowKgH, timeMin },
      steps: [
        step('hours', 'Convert minutes to hours', `${timeMin} ÷ 60`, timeMin / 60, 'h', 5, 0.00005),
        step('fuel', 'Multiply flow by time', `${fmt(flowKgH)} × hours`, answer, 'kg', 0, 1),
      ],
      diagnoses: [
        miss('minutes-as-hours', 'zone-time', 'minutes as hours', 'You multiplied the flow by the minutes as if they were hours.', flowKgH * timeMin),
        miss('per-second', 'zone-fuel', 'minutes as hours', 'You divided by 3 600, as if the flow were kilograms per second.', flowKgH * timeMin / 3600),
        miss('kilograms-as-pounds', 'units', 'kilograms as pounds', 'You multiplied the kilograms by 2.2.', answer * LB),
      ],
    });
  }
  if (rung === 4) {
    const legNm = pick(rand, [300, 360, 420]);
    const climbNm = pick(rand, [50, 70]);
    const gsKt = pick(rand, [440, 480, 510]);
    const dist = legNm - climbNm;
    const timeMin = (dist / gsKt) * 60;
    const answer = fuel(flowKgH, timeMin);
    const line = `leg ${legNm} nm   climb ${climbNm} nm   GS ${gsKt} kt   ${fmt(flowKgH)} kg/h`;
    return pack(seed, {
      skill: 'zone-fuel',
      rung,
      stem: `You are planning a B727-200 leg of ${legNm} nm. The climb uses ${climbNm} nm, the cruise groundspeed is ${gsKt} kt and the cruise fuel flow is ${fmt(flowKgH)} kg/h. What is the cruise zone fuel?`,
      figure: { title: 'Cruise zone fuel', lines: [line], highlight: [line] },
      unit: 'kg',
      tolerance: 1,
      decimals: 0,
      answer,
      method: `Cruise distance is ${fmt(dist, 0)} nm, so the zone time is ${fmt(timeMin, 1)} min. Fuel is ${fmt(flowKgH)} × that time / 60 = ${fmt(answer, 0)} kg.`,
      thumb: 'About 10 kg per ground nautical mile in the cruise, after the climb is taken out.',
      given: { flowKgH, legNm, climbNm, gsKt },
      steps: [
        step('cruise-distance', 'Subtract climb distance', `${legNm} − ${climbNm}`, dist, 'nm', 0, 0.5),
        step('hours', 'Convert distance to hours', `cruise distance ÷ ${gsKt}`, dist / gsKt, 'h', 5, 0.00005),
        step('minutes', 'Convert hours to minutes', 'hours × 60', timeMin, 'min', 3, 0.003),
        step('fuel', 'Multiply flow by time', `${fmt(flowKgH)} × minutes ÷ 60`, answer, 'kg', 0, 1),
      ],
      diagnoses: [
        miss('minutes-as-hours', 'zone-time', 'minutes as hours', 'You multiplied the flow by the zone time in minutes.', flowKgH * timeMin),
        miss('forgot-climb', 'zone-fuel', 'climb distance', 'You burned cruise fuel for the whole leg, climb included.', fuel(flowKgH, (legNm / gsKt) * 60)),
        miss('kilograms-as-pounds', 'units', 'kilograms as pounds', 'You multiplied the kilograms by 2.2.', answer * LB),
      ],
    });
  }
  const distNm = pick(rand, [160, 220, 280]);
  const tasKt = pick(rand, [450, 470]);
  const tailKt = pick(rand, [20, 40, -30]);
  const trackDeg = 90;
  const windKt = Math.abs(tailKt) + (rung === 3 ? 15 : 0);
  const windFromDeg = rung === 3 ? 140 : tailKt >= 0 ? 270 : 90;
  const gsKt = rung === 2 ? tasKt + tailKt : triangle(trackDeg, windFromDeg, windKt, tasKt).gs;
  const timeMin = (distNm / gsKt) * 60;
  const answer = fuel(flowKgH, timeMin);
  const tasTime = (distNm / tasKt) * 60;
  const line = rung === 2
    ? `${distNm} nm   TAS ${tasKt} kt   tail ${fmt(tailKt, 0)} kt   ${fmt(flowKgH)} kg/h`
    : `${distNm} nm   TAS ${tasKt} kt   wind ${String(windFromDeg).padStart(3, '0')}/${windKt}   ${fmt(flowKgH)} kg/h`;
  const stem = rung === 2
    ? `A B727-200 cruise zone is ${distNm} nm at TAS ${tasKt} kt with a tailwind component of ${fmt(tailKt, 0)} kt. Fuel flow is ${fmt(flowKgH)} kg/h. What is the zone fuel?`
    : `A B727-200 cruise zone is ${distNm} nm on track 090 at TAS ${tasKt} kt. The wind is ${String(windFromDeg).padStart(3, '0')}° at ${windKt} kt and the fuel flow is ${fmt(flowKgH)} kg/h. What is the zone fuel?`;
  return pack(seed, {
    skill: 'zone-fuel',
    rung,
    stem,
    figure: { title: 'Zone fuel', lines: [line], highlight: [line] },
    unit: 'kg',
    tolerance: 1,
    decimals: 0,
    answer,
    method: `Groundspeed is ${fmt(gsKt, 1)} kt, so the zone takes ${fmt(timeMin, 1)} min. Fuel is ${fmt(flowKgH)} × that time / 60 = ${fmt(answer, 0)} kg.`,
    thumb: 'Flow in kg/h times hours, not times minutes.',
    given: rung === 2 ? { flowKgH, distNm, tasKt, tailKt } : { flowKgH, distNm, tasKt, trackDeg, windFromDeg, windKt },
    steps: [
      ...(rung === 3
        ? windTriangleSteps(trackDeg, windFromDeg, windKt, tasKt, gsKt)
        : [step('gs', 'Calculate groundspeed', `${tasKt} + (${fmt(tailKt, 0)})`, gsKt, 'kt', 1, 0.2)]),
      step('hours', 'Convert distance to hours', `${distNm} ÷ GS`, distNm / gsKt, 'h', 5, 0.00005),
      step('minutes', 'Convert hours to minutes', 'hours × 60', timeMin, 'min', 3, 0.003),
      step('fuel', 'Multiply flow by time', `${fmt(flowKgH)} × minutes ÷ 60`, answer, 'kg', 0, 1),
    ],
    diagnoses: [
      miss('minutes-as-hours', 'zone-time', 'minutes as hours', 'You multiplied the flow by the minutes.', flowKgH * timeMin),
      miss(rung === 2 ? 'ignored-wind' : 'tas-not-gs', rung === 2 ? 'wind-component' : 'groundspeed', rung === 2 ? 'wind ignored' : 'TAS not groundspeed', 'You burned the fuel against TAS instead of groundspeed.', fuel(flowKgH, tasTime)),
      miss('kilograms-as-pounds', 'units', 'kilograms as pounds', 'You multiplied the kilograms by 2.2.', answer * LB),
    ],
  });
}

export const zoneFuel = {
  id: 'zone-fuel',
  name: 'Zone fuel',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('zone-fuel', seed, rung, (rand) => build(rand, seed, rung));
  },
};
