import { fmt } from './format.ts';
import {
  generateSkill,
  isaDevForCruise,
  isaC,
  miss,
  pack,
  physicsTas,
  pick,
  seaLevelTas,
  step,
  tableTas,
} from './lib.ts';
import type { Drill, Rung } from './types.ts';

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  const fl = pick(rand, [290, 310, 330, 350, 370]);
  const mach = pick(rand, [0.78, 0.8, 0.82]);
  const raw = pick(rand, [-10, -6, 6, 10, 14]);
  const oatC = isaC(fl) + raw;
  const tas = physicsTas(mach, oatC);
  const isaTas = physicsTas(mach, isaC(fl));
  if (rung === 1) {
    const line = `FL${fl}   M ${mach.toFixed(2)}   OAT ${fmt(oatC, 1)} °C`;
    return pack(seed, {
      skill: 'tas-mach',
      rung,
      stem: `You are cruising a B727-200 at FL${fl} and Mach ${mach.toFixed(2)}. The outside air temperature is ${fmt(oatC, 1)} °C. What is the true airspeed from the local speed of sound?`,
      figure: { title: 'TAS from Mach', lines: [line], highlight: [line] },
      unit: 'kt',
      tolerance: 3,
      decimals: 0,
      answer: tas,
      method: `The speed of sound at ${fmt(oatC, 1)} °C is ${fmt(tas / mach, 1)} kt. Mach ${mach.toFixed(2)} times that speed is ${fmt(tas, 0)} kt.`,
      thumb: `The ISA table plus about 1 kt per °C is ${fmt(tableTas(fl, raw), 0)} kt.`,
      given: { fl, mach, oatC },
      steps: [
        step('kelvin', 'Convert OAT to kelvin', 'OAT + 273.15', oatC + 273.15, 'K', 1, 0.2),
        step('sound', 'Calculate local speed of sound', '38.94 × √(kelvin temperature)', tas / mach, 'kt', 1, 0.6),
        step('tas', 'Multiply Mach by local sound speed', `${mach.toFixed(2)} × local sound speed`, tas, 'kt', 0, 1),
      ],
      diagnoses: [
        miss('isa-temperature', 'isa-dev', 'ISA level', 'You used the ISA temperature and ignored the OAT.', isaTas),
        miss('sea-level', 'tas-mach', 'sea level', 'You used the sea-level speed of sound.', seaLevelTas(mach)),
        miss('mach-times-100', 'tas-mach', 'Mach as knots', 'You treated the Mach number as a speed in tens of knots.', mach * 100),
      ],
    });
  }
  if (rung === 2) {
    const table = tableTas(fl, raw);
    const line = `FL${fl}   M 0.80 table   OAT ${fmt(oatC, 1)} °C`;
    return pack(seed, {
      skill: 'tas-mach',
      rung,
      stem: `You are cruise-planning a B727-200 at FL${fl} and M 0.80. The outside air temperature is ${fmt(oatC, 1)} °C, so the ISA deviation is ${fmt(raw, 1)} °C. What TAS does the cruise table give after the temperature correction?`,
      figure: { title: 'Table 3.1 TAS correction', lines: [line, `ISA TAS ${fmt(tableTas(fl, 0), 0)} kt`], highlight: [line] },
      unit: 'kt',
      tolerance: 0.5,
      decimals: 0,
      answer: table,
      method: `Round the deviation to the nearest 3 °C, then add 1 kt per °C to the ISA TAS. The table TAS is ${fmt(table, 0)} kt.`,
      thumb: 'M 0.80 in the high thirties is about 460 kt, plus 1 kt for each degree above ISA.',
      given: { fl, mach: 0.8, oatC },
      steps: [
        step('round-dev', 'Round ISA deviation for the table', 'Round the supplied deviation to the nearest 3 °C', isaDevForCruise(raw), '°C', 0, 0.5),
        step('isa-tas', 'Read ISA TAS', `FL${fl} · M 0.80`, tableTas(fl, 0), 'kt', 0, 0.5),
        step('correction', 'Apply temperature correction', 'Rounded deviation × 1 kt/°C', table - tableTas(fl, 0), 'kt', 0, 0.5),
        step('tas', 'Add corrected TAS', 'ISA TAS + correction', table, 'kt', 0, 0.5),
      ],
      diagnoses: [
        miss('uncorrected', 'isa-dev', 'ISA level', 'You read the ISA TAS and applied no temperature correction.', tableTas(fl, 0)),
        miss('wrong-fl', 'table-cell', 'wrong row', `You used the ISA TAS for FL${fl + 10}.`, tableTas(fl + 10, raw)),
        miss('unrounded-dev', 'isa-dev', 'unrounded ISA', 'You applied 1 kt per °C to the raw deviation instead of the nearest 3 °C.', tableTas(fl, 0) + raw),
      ],
    });
  }
  if (rung === 3) {
    const timeMin = pick(rand, [20, 24, 30, 36]);
    const answer = (tas * timeMin) / 60;
    const line = `FL${fl}   M ${mach.toFixed(2)}   OAT ${fmt(oatC, 1)} °C   ${fmt(timeMin, 0)} min`;
    return pack(seed, {
      skill: 'tas-mach',
      rung,
      stem: `A B727-200 cruise zone at FL${fl} and Mach ${mach.toFixed(2)} lasts ${fmt(timeMin, 0)} minutes. The OAT is ${fmt(oatC, 1)} °C. What air distance does the zone cover?`,
      figure: { title: 'Zone air distance', lines: [line], highlight: [line] },
      unit: 'nm',
      tolerance: 1,
      decimals: 0,
      answer,
      method: `TAS is ${fmt(tas, 0)} kt at this temperature. Air distance is TAS × ${fmt(timeMin, 0)} / 60 = ${fmt(answer, 0)} nm.`,
      thumb: 'About 8 nm a minute at M 0.80 in the cruise levels.',
      given: { fl, mach, oatC, timeMin },
      steps: [
        step('kelvin', 'Convert OAT to kelvin', 'OAT + 273.15', oatC + 273.15, 'K', 1, 0.2),
        step('sound', 'Calculate local speed of sound', '38.94 × √(kelvin temperature)', tas / mach, 'kt', 1, 0.6),
        step('tas', 'Multiply Mach by local sound speed', `${mach.toFixed(2)} × local sound speed`, tas, 'kt', 0, 1),
        step('hours', 'Convert minutes to hours', 'Minutes ÷ 60', timeMin / 60, 'h', 4, 0.0001),
        step('distance', 'Multiply TAS by time', 'TAS × hours', answer, 'nm', 0, 1),
      ],
      diagnoses: [
        miss('isa-temperature', 'isa-dev', 'ISA level', 'You used the ISA TAS for the air distance.', (isaTas * timeMin) / 60),
        miss('minutes-as-hours', 'zone-time', 'minutes as hours', 'You multiplied TAS by the minutes and forgot to divide by 60.', tas * timeMin),
        miss('answered-tas', 'tas-mach', 'TAS not distance', 'You stopped at the TAS and did not convert it to a distance.', tas),
      ],
    });
  }
  const distNm = pick(rand, [180, 240, 300, 360]);
  const gsKt = pick(rand, [420, 450, 480, 510]);
  const answer = tas * distNm / gsKt;
  const line = `FL${fl}   M ${mach.toFixed(2)}   OAT ${fmt(oatC, 1)} °C   GS ${gsKt} kt   ${distNm} nm`;
  return pack(seed, {
    skill: 'tas-mach',
    rung,
    stem: `You are planning a B727-200 cruise leg of ${distNm} nm at FL${fl}, Mach ${mach.toFixed(2)}, groundspeed ${gsKt} kt. The OAT is ${fmt(oatC, 1)} °C. What air distance does the leg cover?`,
    figure: { title: 'Cruise air distance', lines: [line], highlight: [line] },
    unit: 'nm',
    tolerance: 1,
    decimals: 0,
    answer,
    method: `TAS is ${fmt(tas, 0)} kt. Zone time is ${distNm} / ${gsKt} hours, so the air distance is TAS × that time: ${fmt(answer, 0)} nm.`,
    thumb: 'Air distance is ground distance scaled by TAS / groundspeed.',
    given: { fl, mach, oatC, distNm, gsKt },
    steps: [
      step('kelvin', 'Convert OAT to kelvin', 'OAT + 273.15', oatC + 273.15, 'K', 1, 0.2),
      step('sound', 'Calculate local speed of sound', '38.94 × √(kelvin temperature)', tas / mach, 'kt', 1, 0.6),
      step('tas', 'Multiply Mach by local sound speed', `${mach.toFixed(2)} × local sound speed`, tas, 'kt', 0, 1),
      step('hours', 'Calculate leg time', 'Ground distance ÷ groundspeed', distNm / gsKt, 'h', 4, 0.0001),
      step('distance', 'Scale ground distance by TAS/GS', 'Ground distance × TAS ÷ groundspeed', answer, 'nm', 0, 1),
    ],
    diagnoses: [
      miss('groundspeed-as-tas', 'groundspeed', 'TAS and groundspeed', 'You treated the ground distance as the air distance.', distNm),
      miss('isa-temperature', 'isa-dev', 'ISA level', 'You used the ISA TAS when you scaled the distance.', isaTas * distNm / gsKt),
      miss('minutes-as-hours', 'zone-time', 'minutes as hours', 'You multiplied TAS by the zone time in minutes.', tas * (distNm / gsKt) * 60),
    ],
  });
}

export const tasMach = {
  id: 'tas-mach',
  name: 'TAS from Mach',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('tas-mach', seed, rung, (rand) => build(rand, seed, rung));
  },
};
