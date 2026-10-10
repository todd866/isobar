import { fmt } from './format.ts';
import {
  RSWT_LEVELS,
  climbMetLevel,
  descentMetLevel,
  forecastGrid,
  generateSkill,
  levelWind,
  metLevelFor,
  miss,
  pack,
  pick,
  step,
  triangle,
} from './lib.ts';
import type { FigureTable } from '../figure.ts';
import type { Drill, Rung } from './types.ts';

function winds(rand: () => number): Record<number, { dir: number; kt: number }> {
  const out: Record<number, { dir: number; kt: number }> = {};
  let speed = 20;
  for (const level of RSWT_LEVELS) {
    out[level] = { dir: 270, kt: speed };
    speed += 15;
  }
  void rand;
  return out;
}

function givenWinds(samples: Record<number, { dir: number; kt: number }>): Record<string, number> {
  const given: Record<string, number> = {};
  for (const level of RSWT_LEVELS) {
    given[`d${level}`] = samples[level]!.dir;
    given[`k${level}`] = samples[level]!.kt;
  }
  return given;
}

function component(trackDeg: number, wind: { dir: number; kt: number }): number {
  return triangle(trackDeg, wind.dir, wind.kt).tail;
}

function windFigure(grid: ReturnType<typeof forecastGrid>, selected: number) {
  const rows = RSWT_LEVELS.map((level) => {
    const wind = grid.columns[0]!.wind[level]!;
    return { label: `FL${level}`, cells: [wind.dirT, wind.kt] };
  });
  const row = RSWT_LEVELS.indexOf(selected);
  const table: FigureTable = {
    label: 'RSWT',
    title: 'Forecast winds',
    unit: '',
    corner: 'FL',
    group: 'Wind',
    columns: ['From °T', 'Speed kt'],
    rows,
    decimals: 0,
    columnDecimals: [0, 0],
    used: [[row, 0], [row, 1]],
  };
  const lines = rows.map((item) => `${item.label}  ${fmt(item.cells[0]!, 0)}  ${fmt(item.cells[1]!, 0)}`);
  return { title: 'Forecast winds', lines, highlight: [lines[row]!], table };
}

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  const cruiseFl = pick(rand, [330, 350, 370, 390]);
  const samples = winds(rand);
  const grid = forecastGrid(samples);
  const climb = climbMetLevel(grid, cruiseFl);
  const descent = descentMetLevel(grid, cruiseFl);
  const cruise = metLevelFor(grid, cruiseFl);
  if (rung === 1) {
    const fraction = (2 / 3) * cruiseFl;
    return pack(seed, {
      skill: 'met-level',
      rung,
      stem: `You are planning the climb of a B727-200 to FL${cruiseFl}. The forecast winds are tabulated at the standard levels. Which forecast level do you use for the climb wind?`,
      figure: windFigure(grid, climb),
      unit: 'FL',
      tolerance: 0,
      decimals: 0,
      answer: climb,
      method: `Climb wind is taken at two-thirds of the height. Two-thirds of FL${cruiseFl} is FL${fmt((2 / 3) * cruiseFl, 0)}, and the nearest forecast level is FL${climb}.`,
      thumb: 'Climb at two-thirds of the height. Below FL185, use FL185.',
      given: { cruiseFl, sampleFraction: 2 / 3 },
      steps: [
        step('fraction', 'Find two-thirds height', `⅔ × FL${cruiseFl}`, fraction, 'FL', 0, 0.5),
        step('level', 'Choose the forecast level', 'nearest level, with FL185 as the floor', climb, 'FL', 0, 0),
      ],
      diagnoses: [
        miss('half-height', 'met-level', 'half height', 'You used half the height, which is the descent rule.', descent),
        miss('unsnapped', 'met-level', 'forecast level', 'You used two-thirds of the flight level and did not move to a forecast level.', Math.round((2 / 3) * cruiseFl)),
        miss('cruise-level', 'met-level', 'cruise level', 'You used the forecast level nearest the cruise level.', cruise),
      ],
    });
  }
  if (rung === 2) {
    const fraction = cruiseFl / 2;
    return pack(seed, {
      skill: 'met-level',
      rung,
      stem: `You are planning the descent of a B727-200 from FL${cruiseFl}. You have already picked the climb level. Which forecast level do you use for the descent wind?`,
      figure: windFigure(grid, descent),
      unit: 'FL',
      tolerance: 0,
      decimals: 0,
      answer: descent,
      method: `Descent wind is taken at half the height. Half of FL${cruiseFl} is FL${fmt(cruiseFl / 2, 0)}, and the nearest forecast level is FL${descent}.`,
      thumb: 'Descent at one-half of the height. Below FL185, use FL185.',
      given: { cruiseFl, sampleFraction: 1 / 2 },
      steps: [
        step('fraction', 'Find half height', `½ × FL${cruiseFl}`, fraction, 'FL', 0, 0.5),
        step('level', 'Choose the forecast level', 'nearest level, with FL185 as the floor', descent, 'FL', 0, 0),
      ],
      diagnoses: [
        miss('two-thirds', 'met-level', 'two-thirds height', 'You used two-thirds of the height, which is the climb rule.', climb),
        miss('unsnapped', 'met-level', 'forecast level', 'You used half the flight level and did not move to a forecast level.', Math.round(cruiseFl / 2)),
        miss('cruise-level', 'met-level', 'cruise level', 'You used the forecast level nearest the cruise level.', cruise),
      ],
    });
  }
  const trackDeg = 90;
  const climbWind = levelWind(grid, climb);
  const descentWind = levelWind(grid, descent);
  const cruiseWind = levelWind(grid, cruise);
  const answer = rung === 3 ? component(trackDeg, climbWind) : component(trackDeg, descentWind);
  const other = rung === 3 ? component(trackDeg, descentWind) : component(trackDeg, climbWind);
  const cruiseComp = component(trackDeg, cruiseWind);
  const selectedLevel = rung === 3 ? climb : descent;
  const selectedWind = rung === 3 ? climbWind : descentWind;
  const selectedRaw = grid.columns[0]!.wind[selectedLevel]!;
  const fraction = rung === 3 ? (2 / 3) * cruiseFl : cruiseFl / 2;
  const relative = selectedWind.dir - trackDeg;
  const selectedAngle = ((relative % 360) + 360) % 360;
  const stem = rung === 3
    ? `You are planning the climb of a B727-200 to FL${cruiseFl} on track 090. A headwind is negative. What tailwind component do you use for the climb?`
    : `You are planning the descent of a B727-200 from FL${cruiseFl} on track 090, after a cruise on that track. A headwind is negative. What tailwind component do you use for the descent?`;
  return pack(seed, {
    skill: 'met-level',
    rung,
    stem,
    figure: windFigure(grid, selectedLevel),
    unit: 'kt',
    tolerance: 0.5,
    decimals: 0,
    answer,
    method: rung === 3
      ? `Two-thirds of FL${cruiseFl} selects FL${climb}. The rounded wind there is ${climbWind.dir}/${climbWind.kt}, and on track 090 the tailwind component is ${fmt(answer, 0)} kt.`
      : `Half of FL${cruiseFl} selects FL${descent}. The rounded wind there is ${descentWind.dir}/${descentWind.kt}, and on track 090 the tailwind component is ${fmt(answer, 0)} kt.`,
    thumb: 'Climb wind at two-thirds of the height, descent wind at one-half, then resolve it along the track.',
    given: { cruiseFl, trackDeg, sampleFraction: rung === 3 ? 2 / 3 : 1 / 2, ...givenWinds(samples) },
    steps: [
      step('fraction', rung === 3 ? 'Find two-thirds height' : 'Find half height', rung === 3 ? `⅔ × FL${cruiseFl}` : `½ × FL${cruiseFl}`, fraction, 'FL', 0, 0.5),
      step('level', 'Choose the forecast level', 'nearest level, with FL185 as the floor', selectedLevel, 'FL', 0, 0),
      step('raw-direction', 'Read wind direction', `FL${selectedLevel} · From °T`, selectedRaw.dirT, '°T', 0),
      step('direction', 'Round wind direction', 'nearest 10°T', selectedWind.dir, '°T', 0),
      step('raw-speed', 'Read wind speed', `FL${selectedLevel} · Speed kt`, selectedRaw.kt, 'kt', 0),
      step('speed', 'Round wind speed', 'nearest 5 kt', selectedWind.kt, 'kt', 0),
      step('angle', 'Find the angle from track', 'wind direction − track', selectedAngle, '°', 0, 0.5),
      step('cos', 'Calculate the cosine', 'cos(angle in degrees)', Math.cos(selectedAngle * Math.PI / 180), '', 3, 0.0005),
      step('answer', 'Resolve the tailwind component', '− rounded speed × cosine', answer, 'kt', 0),
    ],
    diagnoses: [
      miss(rung === 3 ? 'half-height' : 'two-thirds', 'met-level', rung === 3 ? 'half height' : 'two-thirds height', rung === 3 ? 'You used the descent level for the climb.' : 'You used the climb level for the descent.', other),
      miss('cruise-level', 'met-level', 'cruise level', 'You resolved the wind at the cruise forecast level.', cruiseComp),
      miss('sign', 'wind-component', 'wind sign', 'You reversed the sign of the tailwind component.', -answer),
    ],
  });
}

export const metLevel = {
  id: 'met-level',
  name: 'Climb and descent wind',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('met-level', seed, rung, (rand) => build(rand, seed, rung));
  },
};
