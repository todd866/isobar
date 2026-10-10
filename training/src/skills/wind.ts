import { fmt } from './format.ts';
import { generateSkill, miss, pack, pick, step, triangle, trueTrack } from './lib.ts';
import type { Drill, Rung } from './types.ts';

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  const windKt = pick(rand, [20, 30, 40, 50, 60]);
  if (rung === 1 || rung === 3) {
    const trackDeg = pick(rand, [40, 70, 90, 110, 250, 280]);
    const offset = pick(rand, [20, 30, 60]);
    const windFromDeg = (trackDeg + offset) % 360;
    const { tail, cross } = triangle(trackDeg, windFromDeg, windKt);
    const line = `track ${String(trackDeg).padStart(3, '0')}°T   wind ${String(windFromDeg).padStart(3, '0')}/${String(windKt).padStart(2, '0')}`;
    const stem = rung === 1
      ? `You are cruising a B727-200 on track ${String(trackDeg).padStart(3, '0')}° true. The wind is ${String(windFromDeg).padStart(3, '0')}° true at ${windKt} kt. A headwind is negative. What is the tailwind component, in knots?`
      : `You are in a cruise zone of a B727-200 on track ${String(trackDeg).padStart(3, '0')}° true. The zone wind is ${String(windFromDeg).padStart(3, '0')}° true at ${windKt} kt. A headwind is negative. What tailwind component do you use for the zone?`;
    return pack(seed, {
      skill: 'wind-component',
      rung,
      stem,
      figure: { title: 'Wind component', lines: [line], highlight: [line] },
      unit: 'kt',
      tolerance: 0.5,
      decimals: 1,
      answer: tail,
      method: `The wind is ${offset}° off the track. The along-track component is −${windKt} × cos ${offset}° = ${fmt(tail, 1)} kt, tail positive.`,
      thumb: 'At 30° off, use about seven-eighths of the wind; at 60°, about half.',
      given: { trackDeg, windFromDeg, windKt },
      steps: [
        step('angle', 'Find signed wind angle', `wind from ${windFromDeg}° − track ${trackDeg}°`, offset, '°', 0, 0.5),
        step('sin', 'Calculate the sine of the angle', 'sin of the signed wind angle', Math.sin(offset * Math.PI / 180), '', 3, 0.005),
        step('cross', 'Resolve the crosswind', 'Wind speed × sine', cross, 'kt', 1, 0.5),
        step('cos', 'Calculate the cosine of the angle', 'cosine of the signed wind angle', Math.cos(offset * Math.PI / 180), '', 3, 0.005),
        step('tail', 'Resolve the along-track component', '−wind speed × cosine', tail, 'kt', 1, 0.5),
      ],
      diagnoses: [
        miss('sign', 'wind-component', 'wind sign', 'You reversed the sign of the tailwind component.', -tail),
        miss('crosswind', 'wind-component', 'crosswind', 'You reported the crosswind component instead of the tailwind.', cross),
        miss('full-wind', 'wind-component', 'full wind', 'You applied the whole wind speed as a tailwind or a headwind.', offset < 90 ? -windKt : windKt),
      ],
    });
  }
  const trackM = pick(rand, [50, 80, 100, 140, 260]);
  const variationEast = pick(rand, [8, 12, -6, -11]);
  const trackDeg = trueTrack(trackM, variationEast);
  const offset = pick(rand, [25, 35]);
  const windFromDeg = (trackDeg + offset) % 360;
  const used = triangle(trackDeg, windFromDeg, windKt);
  const forgot = triangle(trackM, windFromDeg, windKt);
  const line = `track ${String(trackM).padStart(3, '0')}°M   variation ${fmt(variationEast, 0)}°E   wind ${String(windFromDeg).padStart(3, '0')}/${windKt}`;
  const stem = rung === 2
    ? `You are planning a B727-200 on magnetic track ${String(trackM).padStart(3, '0')}°. Variation is ${fmt(variationEast, 0)}° east and the wind is ${String(windFromDeg).padStart(3, '0')}° true at ${windKt} kt. A headwind is negative. What is the tailwind component?`
    : `The cruise leg of your B727-200 plan is magnetic track ${String(trackM).padStart(3, '0')}°, variation ${fmt(variationEast, 0)}° east, wind ${String(windFromDeg).padStart(3, '0')}° true at ${windKt} kt. A headwind is negative. What tailwind component belongs on that leg?`;
  return pack(seed, {
    skill: 'wind-component',
    rung,
    stem,
    figure: { title: 'Wind component', lines: [line], highlight: [line] },
    unit: 'kt',
    tolerance: 0.5,
    decimals: 1,
    answer: used.tail,
    method: `True track is ${String(Math.round(trackDeg)).padStart(3, '0')}°. The along-track component of the ${windKt} kt wind is ${fmt(used.tail, 1)} kt, tail positive.`,
    thumb: 'Convert the track to true before you resolve the wind.',
    given: { trackDeg: trackM, windFromDeg, windKt, variationEast },
    steps: [
      step('true-track', 'Convert magnetic track to true', `${trackM}°M + ${variationEast}°`, trackDeg, '°T', 0, 0.5),
      step('angle', 'Find signed wind angle', `wind from ${windFromDeg}° − true track`, offset, '°', 0, 0.5),
      step('sin', 'Calculate the sine of the angle', 'sin of the signed wind angle', Math.sin(offset * Math.PI / 180), '', 3, 0.005),
      step('cross', 'Resolve the crosswind', 'Wind speed × sine', used.cross, 'kt', 1, 0.5),
      step('cos', 'Calculate the cosine of the angle', 'cosine of the signed wind angle', Math.cos(offset * Math.PI / 180), '', 3, 0.005),
      step('tail', 'Resolve the along-track component', '−wind speed × cosine', used.tail, 'kt', 1, 0.5),
    ],
    diagnoses: [
      miss('sign', 'wind-component', 'wind sign', 'You reversed the sign of the tailwind component.', -used.tail),
      miss('crosswind', 'wind-component', 'crosswind', 'You reported the crosswind component.', used.cross),
      miss('forgot-variation', 'wind-component', 'variation', 'You resolved the wind against the magnetic track.', forgot.tail),
    ],
  });
}

export const windComponent = {
  id: 'wind-component',
  name: 'Wind component',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('wind-component', seed, rung, (rand) => build(rand, seed, rung));
  },
};
