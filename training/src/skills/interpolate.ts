import { fmt } from './format.ts';
import {
  LB,
  TABLES,
  climbCell,
  climbFuel,
  climbTable,
  ffAt,
  ffInterp,
  ffTable,
  ffWindow,
  generateSkill,
  isaDevForClimb,
  miss,
  pack,
  pick,
  span,
  step,
  tons,
  windowOf,
} from './lib.ts';
import type { Drill, Rung } from './types.ts';

function corners(flLo: number, flHi: number, wLo: number, wHi: number): boolean {
  return [ffAt(flLo, wLo), ffAt(flLo, wHi), ffAt(flHi, wLo), ffAt(flHi, wHi)].every((value) => value != null);
}

function signed(dev: number): string {
  return dev === 0 ? 'ISA' : `ISA${dev > 0 ? '+' : '−'}${Math.abs(dev)}`;
}

function build(rand: () => number, seed: number, rung: Rung): Drill | null {
  if (rung === 1 || rung === 3) {
    const fl = pick(rand, [290, 310, 330, 350]);
    const lower = pick(rand, [66000, 68000, 70000, 72000, 74000]);
    const upper = lower + 2000;
    const weightKg = lower + 1000;
    if (ffAt(fl, lower) == null || ffAt(fl, upper) == null) return null;
    if (ffAt(fl + 10, lower) == null || ffAt(fl + 10, upper) == null) return null;
    const answer = ffInterp(fl, weightKg);
    const lowerFf = ffAt(fl, lower)!;
    const upperFf = ffAt(fl, upper)!;
    const { fls, weights } = ffWindow(fl, lower, upper, fl, 2, 1);
    const line = span('column', `${tons(lower)} t`, `${tons(upper)} t`, `${tons(weightKg)} t`, lowerFf, upperFf, 0.5);
    const stem = rung === 1
      ? `You are cruise-planning a B727-200 at FL${fl}, M 0.80, ISA, at ${fmt(weightKg)} kg. What fuel flow do you interpolate?`
      : `You are in a cruise zone at FL${fl}, M 0.80, ISA. The estimated mid-zone weight is ${fmt(weightKg)} kg. What fuel flow do you use for the zone?`;
    return pack(seed, {
      skill: 'interpolate',
      rung,
      stem,
      figure: ffTable(fls, weights, [[fl, lower], [fl, upper]], [line]),
      unit: 'kg/h',
      tolerance: 0.5,
      decimals: 0,
      answer,
      method: `${fmt(weightKg)} kg is halfway from ${tons(lower)} to ${tons(upper)} t, so the fuel flow is halfway from ${fmt(lowerFf)} to ${fmt(upperFf)}: ${fmt(answer)} kg/h.`,
      thumb: 'Halfway between columns, take the mean of the two cells.',
      given: { fl, weightKg },
      steps: [
        step('lower', 'Read the lower cell', `FL${fl} · ${tons(lower)} t`, lowerFf, 'kg/h'),
        step('upper', 'Read the upper cell', `FL${fl} · ${tons(upper)} t`, upperFf, 'kg/h'),
        step('fraction', 'Fraction of the way', `(${tons(weightKg)} − ${tons(lower)}) ÷ (${tons(upper)} − ${tons(lower)})`, 0.5, '', 2, 0.01),
        step('part', 'Difference × fraction', `(upper − lower) × fraction`, (upperFf - lowerFf) * 0.5, 'kg/h', 0, 1),
        step('add', 'Add to the lower cell', 'lower + part', answer, 'kg/h'),
      ],
      diagnoses: [
        miss('lower-column', 'interpolate', 'no interpolation', `You copied the ${tons(lower)} t column without interpolating.`, lowerFf),
        miss('upper-column', 'interpolate', 'no interpolation', `You read the ${tons(upper)} t column without interpolating.`, upperFf),
        miss('wrong-row', 'table-cell', 'wrong row', `You interpolated on the FL${fl + 10} row.`, ffInterp(fl + 10, weightKg)),
        ...(rung === 1 ? [miss('kilograms-as-pounds', 'units', 'kilograms as pounds', 'You converted the kilograms to pounds.', answer * LB)] : []),
      ],
    });
  }
  if (rung === 2) {
    const flLo = pick(rand, [290, 310, 330, 350]);
    const flHi = flLo + 10;
    const fl = flLo + 5;
    const lower = pick(rand, [66000, 68000, 70000, 72000]);
    const upper = lower + 2000;
    const weightKg = lower + 1000;
    if (!corners(flLo, flHi, lower, upper)) return null;
    if (!corners(flHi, flLo + 20, lower, upper)) return null;
    const answer = ffInterp(fl, weightKg);
    const atLo = ffInterp(flLo, weightKg);
    const atHi = ffInterp(flHi, weightKg);
    const { fls, weights } = ffWindow(flLo, lower, upper, flHi, 1, 1);
    const at = `${tons(weightKg)} t`;
    const spans = [
      span('column', `${tons(lower)} t`, `${tons(upper)} t`, `FL${flLo} · ${at}`, ffAt(flLo, lower)!, ffAt(flLo, upper)!, 0.5),
      span('column', `${tons(lower)} t`, `${tons(upper)} t`, `FL${flHi} · ${at}`, ffAt(flHi, lower)!, ffAt(flHi, upper)!, 0.5),
      span('row', `FL${flLo}`, `FL${flHi}`, `FL${fl}`, atLo, atHi, 0.5),
    ];
    return pack(seed, {
      skill: 'interpolate',
      rung,
      stem: `You are cruise-planning a B727-200 at FL${fl} and ${fmt(weightKg)} kg, M 0.80, ISA. Neither the level nor the weight is tabulated. What fuel flow does double interpolation give?`,
      figure: ffTable(fls, weights, [[flLo, lower], [flLo, upper], [flHi, lower], [flHi, upper]], spans),
      unit: 'kg/h',
      tolerance: 0.5,
      decimals: 0,
      answer,
      method: `Interpolate the weight at FL${flLo} (${fmt(atLo)}) and at FL${flHi} (${fmt(atHi)}), then go halfway between them in level: ${fmt(answer)} kg/h.`,
      thumb: 'Do the weight fraction first, then the same fraction between the levels.',
      given: { fl, weightKg },
      steps: [
        step('low-level', `FL${flLo} at ${at}`, `halfway from ${fmt(ffAt(flLo, lower)!)} to ${fmt(ffAt(flLo, upper)!)}`, atLo, 'kg/h', 0, 1),
        step('high-level', `FL${flHi} at ${at}`, `halfway from ${fmt(ffAt(flHi, lower)!)} to ${fmt(ffAt(flHi, upper)!)}`, atHi, 'kg/h', 0, 1),
        step('fraction', 'Level fraction', `(${fl} − ${flLo}) ÷ (${flHi} − ${flLo})`, 0.5, '', 2, 0.01),
        step('part', 'Difference × fraction', `(FL${flHi} − FL${flLo}) × fraction`, (atHi - atLo) * 0.5, 'kg/h', 0, 1),
        step('add', `Add to FL${flLo}`, `FL${flLo} + part`, answer, 'kg/h'),
      ],
      diagnoses: [
        miss('lower-fl', 'interpolate', 'single interpolation', `You interpolated the weight but stayed on FL${flLo}.`, atLo),
        miss('lower-weight', 'interpolate', 'single interpolation', `You interpolated the level but stayed on ${tons(lower)} t.`, ffInterp(fl, lower)),
        miss('wrong-bracket', 'table-cell', 'wrong row', `You interpolated between FL${flHi} and FL${flLo + 20}.`, (atHi + ffInterp(flLo + 20, weightKg)) / 2),
        miss('kilograms-as-pounds', 'units', 'kilograms as pounds', 'You converted the kilograms to pounds.', answer * LB),
      ],
    });
  }
  const fl = pick(rand, [280, 300, 310, 330]);
  const lower = pick(rand, [70000, 72000, 74000, 76000]);
  const upper = lower + 2000;
  const weightKg = lower + 1000;
  const isaDev = pick(rand, [7, 8, 12, 13]);
  const used = isaDevForClimb(isaDev);
  const wrongIsa = used - 5;
  const lowCell = climbCell(lower, fl, used);
  const highCell = climbCell(upper, fl, used);
  if (lowCell == null || highCell == null) return null;
  let answer = 0;
  let lowerFuel = 0;
  let otherFuel = 0;
  let otherFl = 0;
  try {
    answer = climbFuel(weightKg, fl, isaDev);
    lowerFuel = climbFuel(lower, fl, used);
    otherFuel = climbFuel(weightKg, fl, wrongIsa);
    otherFl = climbFuel(weightKg, fl + 10, used);
  } catch {
    return null;
  }
  const devs = TABLES.climb.isaDev;
  const ws = TABLES.climb.brakeReleaseKg;
  const di = devs.indexOf(used);
  const wi = ws.indexOf(lower);
  const line = span('column', `${tons(lower)} t`, `${tons(upper)} t`, `${tons(weightKg)} t`, lowCell, highCell, 0.5);
  return pack(seed, {
    skill: 'interpolate',
    rung,
    stem: `You are planning the climb of a B727-200, brake release ${fmt(weightKg)} kg, to FL${fl}, ISA${isaDev >= 0 ? '+' : ''}${isaDev}. Climb fuel is interpolated in weight and the ISA deviation is taken to the nearest 5 °C. What climb fuel do you use?`,
    figure: climbTable(fl, windowOf(devs, di, di, 1), windowOf(ws, wi, wi + 1, 1), [[used, lower], [used, upper]], [line]),
    unit: 'kg',
    tolerance: 1,
    decimals: 0,
    answer,
    method: `ISA${isaDev >= 0 ? '+' : ''}${isaDev} enters as ${signed(used)}. ${fmt(weightKg)} kg lies halfway between the weight columns, so the climb fuel is ${fmt(answer)} kg.`,
    thumb: 'Climb to the low thirties is a couple of tonnes, plus or minus the weight.',
    given: { weightKg, fl, isaDev },
    steps: [
      step('row', 'Temperature row', `ISA+${isaDev} to the nearest 5 °C`, used, '°C'),
      step('lower', 'Read the lower cell', `${signed(used)} · ${tons(lower)} t`, lowCell, 'kg'),
      step('upper', 'Read the upper cell', `${signed(used)} · ${tons(upper)} t`, highCell, 'kg'),
      step('part', 'Difference × fraction', '(upper − lower) × 0.5', (highCell - lowCell) * 0.5, 'kg', 0, 1),
      step('add', 'Add to the lower cell', 'lower + part', answer, 'kg', 0, 1),
    ],
    diagnoses: [
      miss('lower-weight', 'interpolate', 'no interpolation', `You used the ${tons(lower)} t column without interpolating.`, lowerFuel),
      miss('wrong-isa', 'isa-dev', 'ISA level', `You read the ${signed(wrongIsa)} row.`, otherFuel),
      miss('wrong-fl', 'table-cell', 'wrong row', `You read the climb to FL${fl + 10}.`, otherFl),
    ],
  });
}

export const interpolateSkill = {
  id: 'interpolate',
  name: 'Interpolation',
  generate(seed: number, rung: Rung): Drill {
    return generateSkill('interpolate', seed, rung, (rand) => build(rand, seed, rung));
  },
};
