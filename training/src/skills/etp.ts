import { fmt } from './format.ts';
import { etpDistanceNm, etpMultiZone, generateSkill, miss, pack, pick, step } from './lib.ts';
import type { Drill, Rung } from './types.ts';

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  if (rung === 1) {
    const distNm = pick(rand, [400, 600, 800, 1000]);
    const gsOnKt = pick(rand, [420, 460, 500]);
    const gsBackKt = pick(rand, [360, 400, 440]);
    const answer = etpDistanceNm(distNm, gsOnKt, gsBackKt);
    const sumGs = gsOnKt + gsBackKt;
    const numerator = distNm * gsBackKt;
    const line = `${distNm} nm   onward ${gsOnKt} kt   back ${gsBackKt} kt`;
    return pack(seed, {
      skill: 'etp',
      rung,
      stem: `You are planning a B727-200 between two aerodromes ${distNm} nm apart. From the equi-time point the groundspeed onward is ${gsOnKt} kt and the groundspeed back is ${gsBackKt} kt. How far from departure is the equi-time point?`,
      figure: { title: 'Equi-time point', lines: [line], highlight: [line] },
      unit: 'nm',
      tolerance: 0.5,
      decimals: 1,
      answer,
      method: `Distance from departure is total × GS back / (GS on + GS back): ${distNm} × ${gsBackKt} / ${gsOnKt + gsBackKt} = ${fmt(answer, 1)} nm.`,
      thumb: 'Equal groundspeeds put the point halfway. A faster onward leg pulls it back toward departure.',
      given: { distNm, gsOnKt, gsBackKt },
      steps: [
        step('sum-gs', 'Add the groundspeeds', `${gsOnKt} + ${gsBackKt}`, sumGs, 'kt'),
        step('numerator', 'Form the distance numerator', `${distNm} × ${gsBackKt}`, numerator, 'nm·kt', 0, 0.5),
        step('answer', 'Divide for the ETP', 'Distance numerator ÷ groundspeed sum', answer, 'nm', 1, 0.5),
      ],
      diagnoses: [
        miss('reversed', 'etp', 'onward and back', 'You put the onward groundspeed in the numerator.', etpDistanceNm(distNm, gsBackKt, gsOnKt)),
        miss('midpoint', 'etp', 'wind ignored', 'You put the point halfway and ignored the wind.', distNm / 2),
        miss('minutes', 'zone-time', 'minutes as hours', 'You answered the time to the point, in minutes, instead of the distance.', (answer / gsOnKt) * 60),
      ],
    });
  }
  if (rung === 4) {
    const d1 = pick(rand, [200, 250, 300]);
    const d2 = pick(rand, [200, 280, 320]);
    const gsOn1 = pick(rand, [430, 470]);
    const gsBack1 = gsOn1 - 60;
    const gsOn2 = gsOn1 + 20;
    const gsBack2 = gsBack1 - 20;
    const route = etpMultiZone([
      { distNm: d1, gsOnKt: gsOn1, gsBackKt: gsBack1 },
      { distNm: d2, gsOnKt: gsOn2, gsBackKt: gsBack2 },
    ]);
    const answer = route.distNm;
    const onZone2 = d2 / gsOn2;
    const onZone1 = d1 / gsOn1 + onZone2;
    const backZone1 = d1 / gsBack1;
    const xZone1 = ((d1 / gsOn1 + onZone2) * gsOn1 * gsBack1) / (gsOn1 + gsBack1);
    const xZone2 = ((d2 / gsOn2 - backZone1) * gsOn2 * gsBack2) / (gsOn2 + gsBack2);
    const routeSteps = route.zone === 0
      ? [
        step('on-zone-2', 'Time to continue through zone 2', 'Zone 2 distance ÷ onward groundspeed', onZone2, 'h', 5, 0.00001),
        step('on-total', 'Time to continue from zone 1 start', 'Zone 1 time + zone 2 time', onZone1, 'h', 5, 0.00001),
        step('back-zone-1', 'Time to return through zone 1', 'Zone 1 distance ÷ return groundspeed', backZone1, 'h', 5, 0.00001),
        step('zone-distance', 'Distance into zone 1 at equal time', `on × ${gsOn1} × ${gsBack1} ÷ (${gsOn1} + ${gsBack1})`, xZone1, 'nm', 1),
        step('answer', 'Add the route distance before the point', 'Zone 1 distance + distance into zone 1', answer, 'nm', 1, 0.5),
      ]
      : [
        step('on-zone-2', 'Time to continue through zone 2', 'Zone 2 distance ÷ onward groundspeed', onZone2, 'h', 5, 0.00001),
        step('back-zone-1', 'Time to return through zone 1', 'Zone 1 distance ÷ return groundspeed', backZone1, 'h', 5, 0.00001),
        step('time-gap', 'Continue time less return time', 'Zone 2 time − zone 1 return time', onZone2 - backZone1, 'h', 5, 0.00001),
        step('zone-distance', 'Distance into zone 2 at equal time', `gap × ${gsOn2} × ${gsBack2} ÷ (${gsOn2} + ${gsBack2})`, xZone2, 'nm', 1),
        step('answer', 'Add zone 1 before the point', 'Zone 1 distance + distance into zone 2', answer, 'nm', 1, 0.5),
      ];
    const line = `zone 1 ${d1} nm ${gsOn1}/${gsBack1}   zone 2 ${d2} nm ${gsOn2}/${gsBack2}`;
    return pack(seed, {
      skill: 'etp',
      rung,
      stem: `A B727-200 route has two cruise zones. Zone 1 is ${d1} nm with groundspeed ${gsOn1} kt onward and ${gsBack1} kt back. Zone 2 is ${d2} nm with ${gsOn2} kt onward and ${gsBack2} kt back. How far from departure is the equi-time point?`,
      figure: { title: 'Equi-time point', lines: [line], highlight: [line] },
      unit: 'nm',
      tolerance: 0.5,
      decimals: 1,
      answer,
      method: `Set the time to continue equal to the time to return, using each zone's own groundspeeds. The point is ${fmt(answer, 1)} nm from departure.`,
      thumb: 'If the winds were the same in both zones, one equi-time formula would do.',
      given: { d1, gsOn1, gsBack1, d2, gsOn2, gsBack2 },
      steps: routeSteps,
      diagnoses: [
        miss('first-zone', 'etp', 'one zone', 'You solved the equi-time point on the first zone alone.', etpDistanceNm(d1, gsOn1, gsBack1)),
        miss('reversed', 'etp', 'onward and back', 'You swapped onward and back groundspeeds in both zones.', etpMultiZone([
          { distNm: d1, gsOnKt: gsBack1, gsBackKt: gsOn1 },
          { distNm: d2, gsOnKt: gsBack2, gsBackKt: gsOn2 },
        ]).distNm),
        miss('midpoint', 'etp', 'wind ignored', 'You put the point halfway along the whole route.', (d1 + d2) / 2),
      ],
    });
  }
  const distNm = pick(rand, [500, 700, 900]);
  const tasOn = pick(rand, [450, 470]);
  const tasBack = tasOn;
  const tail = pick(rand, [30, 40, 50]);
  const gsOnKt = tasOn + tail;
  const gsBackKt = tasBack - tail;
  const answer = etpDistanceNm(distNm, gsOnKt, gsBackKt);
  const ignored = etpDistanceNm(distNm, tasOn, tasBack);
  const sumGs = gsOnKt + gsBackKt;
  const numerator = distNm * gsBackKt;
  const line = `${distNm} nm   TAS ${tasOn} kt   tailwind out ${tail} kt`;
  const stem = rung === 2
    ? `Two aerodromes are ${distNm} nm apart. A B727-200 cruises at ${tasOn} kt true both ways, with a ${tail} kt tailwind on the way out and the same wind as a headwind on the way back. How far from departure is the equi-time point?`
    : `A single cruise zone of ${distNm} nm joins two aerodromes. The B727-200 cruises at ${tasOn} kt, and the zone wind is a ${tail} kt tailwind outbound. How far from departure is the equi-time point?`;
  return pack(seed, {
    skill: 'etp',
    rung,
    stem,
    figure: { title: 'Equi-time point', lines: [line], highlight: [line] },
    unit: 'nm',
    tolerance: 0.5,
    decimals: 1,
    answer,
    method: `Onward groundspeed is ${fmt(gsOnKt, 0)} kt and the return is ${fmt(gsBackKt, 0)} kt. The point is ${distNm} × ${fmt(gsBackKt, 0)} / ${fmt(gsOnKt + gsBackKt, 0)} = ${fmt(answer, 1)} nm from departure.`,
    thumb: 'A tailwind on the way out moves the equi-time point back toward departure.',
    given: { distNm, tasOn, tail },
    steps: [
      step('gs-out', 'Add the tailwind outbound', `${tasOn} + ${tail}`, gsOnKt, 'kt'),
      step('gs-back', 'Subtract it on the return', `${tasOn} − ${tail}`, gsBackKt, 'kt'),
      step('sum-gs', 'Add the two groundspeeds', `${gsOnKt} + ${gsBackKt}`, sumGs, 'kt'),
      step('numerator', 'Form the distance numerator', `${distNm} × ${gsBackKt}`, numerator, 'nm·kt', 0, 0.5),
      step('answer', 'Divide for the ETP', 'Distance numerator ÷ groundspeed sum', answer, 'nm', 1, 0.5),
    ],
    diagnoses: [
      miss('reversed', 'etp', 'onward and back', 'You swapped the onward and return groundspeeds.', etpDistanceNm(distNm, gsBackKt, gsOnKt)),
      miss('ignored-wind', 'wind-component', 'wind ignored', 'You used TAS both ways and ignored the wind.', ignored),
      miss('minutes', 'zone-time', 'minutes as hours', 'You answered the time to the point, in minutes, instead of the distance.', (answer / gsOnKt) * 60),
    ],
  });
}

export const etp = {
  id: 'etp',
  name: 'Equi-time point',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('etp', seed, rung, (rand) => build(rand, seed, rung));
  },
};
