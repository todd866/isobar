import { fmt } from './format.ts';
import { generateSkill, isaC, miss, pack, physicsTas, pick, step, triangle } from './lib.ts';
import type { Drill, Rung } from './types.ts';

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  if (rung === 1) {
    const tasKt = pick(rand, [440, 460, 480]);
    const windKt = pick(rand, [20, 30, 40, 50]);
    const trackDeg = 90;
    const head = pick(rand, [true, false]);
    const windFromDeg = head ? trackDeg : (trackDeg + 180) % 360;
    const answer = head ? tasKt - windKt : tasKt + windKt;
    const line = `TAS ${tasKt} kt   wind ${head ? String(trackDeg).padStart(3, '0') : '270'}/${windKt}   track 090`;
    return pack(seed, {
      skill: 'groundspeed',
      rung,
      stem: `You are cruising a B727-200 at ${tasKt} kt true on track 090. The wind is ${head ? '090' : '270'}° true at ${windKt} kt, straight ${head ? 'ahead' : 'behind'}. What is the groundspeed?`,
      figure: { title: 'Groundspeed', lines: [line], highlight: [line] },
      unit: 'kt',
      tolerance: 0.5,
      decimals: 0,
      answer,
      method: head
        ? `A headwind subtracts. Groundspeed is ${tasKt} − ${windKt} = ${fmt(answer, 0)} kt.`
        : `A tailwind adds. Groundspeed is ${tasKt} + ${windKt} = ${fmt(answer, 0)} kt.`,
      thumb: 'Straight down the track, groundspeed is TAS plus or minus the wind.',
      given: { tasKt, trackDeg, windFromDeg, windKt },
      steps: [
        step('angle', 'Find signed wind angle', `wind from ${windFromDeg}° − track ${trackDeg}°`, head ? 0 : 180, '°', 0, 0.5),
        step('sin', 'Calculate the sine of the angle', 'sin of the wind angle', 0, '', 3, 0.005),
        step('cross', 'Resolve the crosswind', 'Wind speed × sine', 0, 'kt', 1, 0.5),
        step('cos', 'Calculate the cosine of the angle', 'cosine of the wind angle', head ? 1 : -1, '', 3, 0.005),
        step('tail', 'Resolve the along-track wind', '−wind speed × cosine', usedTail(windKt, head), 'kt', 1, 0.5),
        step('gs', 'Add the along-track wind to TAS', 'TAS + tailwind', answer, 'kt', 0, 0.5),
      ],
      diagnoses: [
        miss('sign', 'wind-component', 'wind sign', 'You applied the wind with the wrong sign.', head ? tasKt + windKt : tasKt - windKt),
        miss('tas-only', 'groundspeed', 'wind ignored', 'You answered the TAS and left the wind off.', tasKt),
        miss('wind-only', 'wind-component', 'wind as speed', 'You answered the wind speed instead of the groundspeed.', windKt),
      ],
    });
  }
  if (rung === 4) {
    const fl = pick(rand, [310, 330, 350]);
    const mach = 0.8;
    const raw = pick(rand, [-8, 8, 12]);
    const oatC = isaC(fl) + raw;
    const tasKt = physicsTas(mach, oatC);
    const trackDeg = pick(rand, [70, 90, 120]);
    const windFromDeg = (trackDeg + 40) % 360;
    const windKt = pick(rand, [30, 40, 55]);
    const used = triangle(trackDeg, windFromDeg, windKt, tasKt);
    const flipped = triangle(trackDeg, (windFromDeg + 180) % 360, windKt, tasKt);
    const isaGs = triangle(trackDeg, windFromDeg, windKt, physicsTas(mach, isaC(fl))).gs;
    const line = `FL${fl}   M 0.80   OAT ${fmt(oatC, 1)} °C   track ${trackDeg}   wind ${String(windFromDeg).padStart(3, '0')}/${windKt}`;
    return pack(seed, {
      skill: 'groundspeed',
      rung,
      stem: `You are planning a B727-200 cruise at FL${fl}, M 0.80, OAT ${fmt(oatC, 1)} °C, on track ${String(trackDeg).padStart(3, '0')}° true. The wind is ${String(windFromDeg).padStart(3, '0')}° true at ${windKt} kt. What groundspeed do you use for the leg?`,
      figure: { title: 'Cruise groundspeed', lines: [line], highlight: [line] },
      unit: 'kt',
      tolerance: 1,
      decimals: 0,
      answer: used.gs,
      method: `TAS is ${fmt(tasKt, 0)} kt. Resolving the ${windKt} kt wind gives a groundspeed of ${fmt(used.gs, 0)} kt.`,
      thumb: 'Take the along-track part of the wind off the TAS, then allow for the crosswind.',
      given: { fl, mach, oatC, trackDeg, windFromDeg, windKt },
      steps: [
        step('kelvin', 'Convert OAT to kelvin', 'OAT + 273.15', oatC + 273.15, 'K', 1, 0.2),
        step('sound', 'Calculate local speed of sound', '38.94 × √(kelvin temperature)', tasKt / mach, 'kt', 1, 0.6),
        step('tas', 'Calculate TAS', `${mach.toFixed(2)} × local sound speed`, tasKt, 'kt', 0, 1),
        step('angle', 'Find signed wind angle', `wind from ${windFromDeg}° − track ${trackDeg}°`, 40, '°', 0, 0.5),
        step('sin', 'Calculate the sine of the angle', 'sin of the wind angle', Math.sin(40 * Math.PI / 180), '', 3, 0.005),
        step('cross', 'Resolve the crosswind', 'Wind speed × sine', used.cross, 'kt', 1, 0.5),
        step('cos', 'Calculate the cosine of the angle', 'cosine of the wind angle', Math.cos(40 * Math.PI / 180), '', 3, 0.005),
        step('tail', 'Resolve the along-track wind', '−wind speed × cosine', used.tail, 'kt', 1, 0.5),
        step('air', 'Allow for the crosswind', '√(TAS² − crosswind²)', Math.sqrt(tasKt * tasKt - used.cross * used.cross), 'kt', 1, 0.5),
        step('gs', 'Add the along-track wind', 'air speed component + tailwind', used.gs, 'kt', 0, 1),
      ],
      diagnoses: [
        miss('sign', 'wind-component', 'wind sign', 'You reversed the wind direction before the triangle.', flipped.gs),
        miss('isa-tas', 'isa-dev', 'ISA level', 'You used the ISA TAS in the wind triangle.', isaGs),
        miss('tas-only', 'groundspeed', 'wind ignored', 'You answered the TAS and left the wind off.', tasKt),
      ],
    });
  }
  const tasKt = pick(rand, [430, 450, 470, 490]);
  const trackDeg = pick(rand, [60, 90, 140, 260]);
  const offset = rung === 2 ? 50 : 40;
  const windFromDeg = (trackDeg + offset) % 360;
  const windKt = pick(rand, [25, 35, 45, 60]);
  const used = triangle(trackDeg, windFromDeg, windKt, tasKt);
  const flipped = triangle(trackDeg, (windFromDeg + 180) % 360, windKt, tasKt);
  const noCross = tasKt + used.tail;
  const line = `TAS ${tasKt} kt   track ${String(trackDeg).padStart(3, '0')}   wind ${String(windFromDeg).padStart(3, '0')}/${windKt}`;
  const stem = rung === 2
    ? `A B727-200 is cruising at ${tasKt} kt true on track ${String(trackDeg).padStart(3, '0')}°. The wind is ${String(windFromDeg).padStart(3, '0')}° at ${windKt} kt, so it has a crosswind. What is the groundspeed?`
    : `You are in a cruise zone at ${tasKt} kt true, track ${String(trackDeg).padStart(3, '0')}°, wind ${String(windFromDeg).padStart(3, '0')}° at ${windKt} kt. What groundspeed do you use for the zone?`;
  return pack(seed, {
    skill: 'groundspeed',
    rung,
    stem,
    figure: { title: 'Groundspeed', lines: [line], highlight: [line] },
    unit: 'kt',
    tolerance: 0.5,
    decimals: 1,
    answer: used.gs,
    method: `The along-track component is ${fmt(used.tail, 1)} kt and the crosswind is ${fmt(used.cross, 1)} kt. Groundspeed is ${fmt(used.gs, 1)} kt.`,
    thumb: 'A pure crosswind trims a little off the TAS; it does not add in full.',
    given: { tasKt, trackDeg, windFromDeg, windKt },
    steps: [
      step('angle', 'Find signed wind angle', `wind from ${windFromDeg}° − track ${trackDeg}°`, offset, '°', 0, 0.5),
      step('sin', 'Calculate the sine of the angle', 'sin of the wind angle', Math.sin(offset * Math.PI / 180), '', 3, 0.005),
      step('cross', 'Resolve the crosswind', 'Wind speed × sine', used.cross, 'kt', 1, 0.5),
      step('cos', 'Calculate the cosine of the angle', 'cosine of the wind angle', Math.cos(offset * Math.PI / 180), '', 3, 0.005),
      step('tail', 'Resolve the along-track wind', '−wind speed × cosine', used.tail, 'kt', 1, 0.5),
      step('air', 'Allow for the crosswind', '√(TAS² − crosswind²)', Math.sqrt(tasKt * tasKt - used.cross * used.cross), 'kt', 1, 0.5),
      step('gs', 'Add the along-track wind', 'air speed component + tailwind', used.gs, 'kt', 1, 0.5),
    ],
    diagnoses: [
      miss('sign', 'wind-component', 'wind sign', 'You reversed the wind direction.', flipped.gs),
      miss('ignored-cross', 'wind-component', 'crosswind', 'You added the tailwind component and ignored the crosswind in the triangle.', noCross),
      miss('full-wind', 'wind-component', 'full wind', 'You added the whole wind speed to the TAS.', tasKt + windKt),
    ],
  });
}

export const groundspeed = {
  id: 'groundspeed',
  name: 'Groundspeed',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('groundspeed', seed, rung, (rand) => build(rand, seed, rung));
  },
};

function usedTail(windKt: number, head: boolean): number {
  return head ? -windKt : windKt;
}
