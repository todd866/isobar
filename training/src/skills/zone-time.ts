import { fmt } from './format.ts';
import { generateSkill, miss, pack, pick, step, triangle } from './lib.ts';
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

function minutes(distNm: number, gsKt: number): number {
  return (distNm / gsKt) * 60;
}

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  if (rung === 1) {
    const distNm = pick(rand, [120, 180, 240, 300]);
    const gsKt = pick(rand, [420, 450, 480]);
    const tasKt = gsKt + pick(rand, [30, 40, -25]);
    const answer = minutes(distNm, gsKt);
    const line = `${distNm} nm   GS ${gsKt} kt   TAS ${tasKt} kt`;
    return pack(seed, {
      skill: 'zone-time',
      rung,
      stem: `A cruise zone in your B727-200 plan is ${distNm} nm long and the groundspeed is ${gsKt} kt. What is the zone time, in minutes?`,
      figure: { title: 'Zone time', lines: [line], highlight: [line] },
      unit: 'min',
      tolerance: 0.1,
      decimals: 1,
      answer,
      method: `Time is distance over groundspeed. ${distNm} / ${gsKt} × 60 = ${fmt(answer, 1)} min.`,
      thumb: 'At about 480 kt, 8 nm takes one minute.',
      given: { distNm, gsKt, tasKt },
      steps: [
        step('gs', 'Use groundspeed', `${distNm} nm at ${gsKt} kt`, gsKt, 'kt', 0, 0.5),
        step('hours', 'Convert distance to hours', `${distNm} ÷ ${gsKt}`, distNm / gsKt, 'h', 3, 0.001),
        step('minutes', 'Convert hours to minutes', 'hours × 60', answer, 'min', 1, 0.1),
      ],
      diagnoses: [
        miss('hours', 'zone-time', 'minutes as hours', 'You answered in hours and did not multiply by 60.', distNm / gsKt),
        miss('times-sixty', 'zone-time', 'minutes as hours', 'You multiplied by 60 twice.', answer * 60),
        miss('tas-not-gs', 'groundspeed', 'TAS not groundspeed', 'You divided the distance by TAS instead of groundspeed.', minutes(distNm, tasKt)),
      ],
    });
  }
  if (rung === 4) {
    const legNm = pick(rand, [280, 340, 400]);
    const climbNm = pick(rand, [40, 55, 70]);
    const tasKt = pick(rand, [450, 470]);
    const tailKt = pick(rand, [30, 40, -35]);
    const gsKt = tasKt + tailKt;
    const dist = legNm - climbNm;
    const answer = minutes(dist, gsKt);
    const line = `leg ${legNm} nm   climb ${climbNm} nm   TAS ${tasKt}   tail ${fmt(tailKt, 0)} kt`;
    return pack(seed, {
      skill: 'zone-time',
      rung,
      stem: `You are planning a B727-200 leg of ${legNm} nm. The climb uses ${climbNm} nm of that leg, and the cruise groundspeed is TAS ${tasKt} kt plus a tailwind component of ${fmt(tailKt, 0)} kt. What is the cruise zone time, in minutes?`,
      figure: { title: 'Cruise zone time', lines: [line], highlight: [line] },
      unit: 'min',
      tolerance: 0.1,
      decimals: 1,
      answer,
      method: `Cruise distance is ${legNm} − ${climbNm} = ${fmt(dist, 0)} nm. Groundspeed is ${fmt(gsKt, 0)} kt, so the zone time is ${fmt(answer, 1)} min.`,
      thumb: 'Take the climb distance out of the leg before you time the cruise.',
      given: { legNm, climbNm, tasKt, tailKt },
      steps: [
        step('cruise-distance', 'Subtract climb distance', `${legNm} − ${climbNm}`, dist, 'nm', 0, 0.5),
        step('gs', 'Add the wind component to TAS', `${tasKt} + (${fmt(tailKt, 0)})`, gsKt, 'kt', 0, 0.5),
        step('hours', 'Convert distance to hours', 'cruise distance ÷ groundspeed', dist / gsKt, 'h', 3, 0.001),
        step('minutes', 'Convert hours to minutes', 'hours × 60', answer, 'min', 1, 0.1),
      ],
      diagnoses: [
        miss('hours', 'zone-time', 'minutes as hours', 'You answered in hours.', dist / gsKt),
        miss('forgot-climb', 'zone-time', 'climb distance', 'You timed the whole leg, climb included.', minutes(legNm, gsKt)),
        miss('sign', 'wind-component', 'wind sign', 'You reversed the tailwind component.', minutes(dist, tasKt - tailKt)),
      ],
    });
  }
  const distNm = pick(rand, [150, 210, 270]);
  const tasKt = pick(rand, [440, 460, 480]);
  const tailKt = rung === 2 ? pick(rand, [25, 40, -30]) : 0;
  const trackDeg = 90;
  const windKt = rung === 3 ? pick(rand, [30, 40, 50]) : Math.abs(tailKt);
  const windFromDeg = rung === 3 ? 140 : tailKt >= 0 ? 270 : 90;
  const gsKt = rung === 2 ? tasKt + tailKt : triangle(trackDeg, windFromDeg, windKt, tasKt).gs;
  const answer = minutes(distNm, gsKt);
  const flipped = rung === 3 ? triangle(trackDeg, (windFromDeg + 180) % 360, windKt, tasKt).gs : tasKt - tailKt;
  const line = rung === 2
    ? `${distNm} nm   TAS ${tasKt} kt   tail ${fmt(tailKt, 0)} kt`
    : `${distNm} nm   TAS ${tasKt} kt   wind ${String(windFromDeg).padStart(3, '0')}/${windKt}   track 090`;
  const stem = rung === 2
    ? `A B727-200 cruise zone is ${distNm} nm. TAS is ${tasKt} kt and the tailwind component is ${fmt(tailKt, 0)} kt. What is the zone time, in minutes?`
    : `A B727-200 cruise zone is ${distNm} nm on track 090 at TAS ${tasKt} kt. The wind is ${String(windFromDeg).padStart(3, '0')}° at ${windKt} kt. What is the zone time, in minutes?`;
  return pack(seed, {
    skill: 'zone-time',
    rung,
    stem,
    figure: { title: 'Zone time', lines: [line], highlight: [line] },
    unit: 'min',
    tolerance: 0.1,
    decimals: 1,
    answer,
    method: `Groundspeed is ${fmt(gsKt, 1)} kt. Zone time is ${distNm} / that speed × 60 = ${fmt(answer, 1)} min.`,
    thumb: 'Find the groundspeed first. Time is distance over that speed.',
    given: rung === 2 ? { distNm, tasKt, tailKt } : { distNm, tasKt, trackDeg, windFromDeg, windKt },
    steps: [
      ...(rung === 3
        ? windTriangleSteps(trackDeg, windFromDeg, windKt, tasKt, gsKt)
        : [step('gs', 'Calculate groundspeed', `${tasKt} + (${fmt(tailKt, 0)})`, gsKt, 'kt', 1, 0.2)]),
      step('hours', 'Convert distance to hours', `${distNm} ÷ GS`, distNm / gsKt, 'h', 3, 0.001),
      step('minutes', 'Convert hours to minutes', 'hours × 60', answer, 'min', 1, 0.1),
    ],
    diagnoses: [
      miss('hours', 'zone-time', 'minutes as hours', 'You answered in hours.', distNm / gsKt),
      rung === 2
        ? miss('ignored-wind', 'wind-component', 'wind ignored', 'You timed the zone on TAS and ignored the wind.', minutes(distNm, tasKt))
        : miss('ignored-cross', 'wind-component', 'crosswind', 'You ignored the crosswind and timed the zone on TAS alone.', minutes(distNm, tasKt)),
      miss('sign', 'wind-component', 'wind sign', 'You reversed the wind before you timed the zone.', minutes(distNm, flipped)),
    ],
  });
}

export const zoneTime = {
  id: 'zone-time',
  name: 'Zone time',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('zone-time', seed, rung, (rand) => build(rand, seed, rung));
  },
};
