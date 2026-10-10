/** Isobar B727 flight-planning engine.
 *
 * Reads the generated handbook tables in `data/` the way the CASA ATPL(A)
 * Examination Information Book (v2.9, CC BY 4.0) tells a candidate to read
 * the handbook: gross weight to the nearest 1,000 kg then linear
 * interpolation, ISA deviation to the nearest 3 °C for cruise fuel flow and
 * 5 °C for climb and holding, landing weight to the nearest 10,000 kg with no
 * interpolation, climb time and distance unrounded, climb fuel to the nearest
 * kg with 0.5 up, wind to the nearest 10° and 5 kt, met data from the forecast
 * level closest to 2/3 of a climb and 1/2 of a descent, FL185 data below
 * FL185, and ETP, PNR and PSD by the book's definitions.
 *
 * Units: kg, FL, kt, nm, min, kg/h, degrees. Winds are given true unless a
 * magnetic variation is supplied with the track.
 */

import climbData from './data/climb.json' with { type: 'json' };
import cruiseData from './data/cruise.json' with { type: 'json' };
import descentData from './data/descent.json' with { type: 'json' };
import holdingData from './data/holding.json' with { type: 'json' };
import capabilityData from './data/altitude-capability.json' with { type: 'json' };
import abnormalData from './data/abnormal.json' with { type: 'json' };
import takeoffData from './data/takeoff.json' with { type: 'json' };
import landingData from './data/landing.json' with { type: 'json' };
import balanceData from './data/balance.json' with { type: 'json' };
import fuelPolicy from './data/fuel-policy.json' with { type: 'json' };
import limitations from './data/limitations.json' with { type: 'json' };

export const TABLES = {
  climb: climbData,
  cruise: cruiseData,
  descent: descentData,
  holding: holdingData,
  capability: capabilityData,
  abnormal: abnormalData,
  takeoff: takeoffData,
  landing: landingData,
  balance: balanceData,
  fuelPolicy,
  limitations,
};

// ---------------------------------------------------------------------------
// Rounding rules (CASA information book 4.2.9.5 and 4.2.9.6)

/** Round half up to a multiple of `step`. */
export function roundTo(x: number, step: number): number {
  return Math.round(x / step + 1e-9) * step;
}

/** Fuel flow tables are entered with gross weight to the nearest 1,000 kg:
 * 72,500 to 73,499 enters as 73,000. */
export function weightEntry(kg: number): number {
  return roundTo(kg, 1000);
}

/** Cruise fuel flow: ISA deviation to the nearest multiple of 3 °C (ISA+10 → +9, ISA+14 → +15). */
export function isaDevForCruise(dev: number): number {
  return roundTo(dev, 3);
}

/** Climb, holding and altitude capability: ISA deviation to the nearest 5 °C (ISA+8 → +10, ISA+7 → +5). */
export function isaDevForClimb(dev: number): number {
  return roundTo(dev, 5);
}

/** Descent: landing weight column to the nearest 10,000 kg, 64,999 → 60,000 and 65,000 → 70,000. */
export function landingWeightColumn(kg: number): number {
  return roundTo(kg, 10000);
}

/** Climb fuel to the nearest kg, 0.5 rounds up. */
export function roundFuel(kg: number): number {
  return Math.floor(kg + 0.5);
}

/** Forecast wind to the nearest 10° and 5 kt. */
export function roundWind(dirDeg: number, kt: number): { dir: number; kt: number } {
  let dir = roundTo(dirDeg, 10) % 360;
  if (dir === 0) dir = 360;
  return { dir, kt: roundTo(kt, 5) };
}

/** Linear interpolation of a row indexed by `axis` at `x`, clamped at the ends. */
export function interpolate(axis: number[], row: (number | null)[], x: number): number | null {
  if (x <= axis[0]) return row[0];
  if (x >= axis[axis.length - 1]) return row[row.length - 1];
  for (let i = 1; i < axis.length; i++) {
    if (x <= axis[i]) {
      const a = row[i - 1];
      const b = row[i];
      if (a === null || b === null) return null;
      const f = (x - axis[i - 1]) / (axis[i] - axis[i - 1]);
      return a + f * (b - a);
    }
  }
  return null;
}

function indexOfExact(axis: number[], x: number, what: string): number {
  const i = axis.indexOf(x);
  if (i < 0) throw new Error(`${what} ${x} is not a table entry (${axis.join(', ')})`);
  return i;
}

/** Nearest table axis value (half rounds to the higher entry). */
export function nearestEntry(axis: number[], x: number): number {
  let best = axis[0];
  for (const v of axis) if (Math.abs(v - x) < Math.abs(best - x) || (Math.abs(v - x) === Math.abs(best - x) && v > best)) best = v;
  return best;
}

// ---------------------------------------------------------------------------
// Climb (Table 2.1)

export interface ClimbResult {
  timeMin: number;
  fuelKg: number;
  distNam: number;
  tasKt: number;
  isaDevUsed: number;
}

/** Climb from brake release. Interpolates linearly between weight columns and
 * ISA rows; time and distance keep their fractions, fuel is rounded to the kg. */
export function climbLookup(brakeReleaseKg: number, fl: number, isaDev: number): ClimbResult | null {
  const t = TABLES.climb;
  const fi = indexOfExact(t.fl, fl, 'climb FL');
  const dev = isaDevForClimb(isaDev);
  const di = indexOfExact(t.isaDev, Math.max(t.isaDev[0], Math.min(t.isaDev[t.isaDev.length - 1], dev)), 'climb ISA deviation');
  const row = t.table[di][fi];
  const pick = (k: 't' | 'f' | 'd') => interpolate(t.brakeReleaseKg, row.map((c) => (c ? c[k] : null)), brakeReleaseKg);
  const time = pick('t');
  const fuel = pick('f');
  const dist = pick('d');
  if (time === null || fuel === null || dist === null) return null;
  return { timeMin: time, fuelKg: roundFuel(fuel), distNam: dist, tasKt: (dist / time) * 60, isaDevUsed: dev };
}

// ---------------------------------------------------------------------------
// Cruise (Section 3)

export type Technique = 'M0.80' | 'LRC' | '280KIAS';

export interface CruiseResult {
  fuelFlowKgPerHour: number;
  tasKt: number;
  mach: number | null;
  weightEntered: number;
  isaDevUsed: number;
}

function cruiseTable(technique: Technique) {
  const c = TABLES.cruise;
  if (technique === 'M0.80') return { fl: c.m080.fl, ff: c.m080.ff, tas: c.m080.fl.map((_, i) => c.weightsKg.map(() => c.m080.tasIsa[i])), mach: null, corr: c.m080.corrections };
  if (technique === 'LRC') return { fl: c.lrc.fl, ff: c.lrc.ff, tas: c.lrc.tas, mach: c.lrc.mach, corr: c.lrc.corrections };
  return { fl: c.kias280.fl, ff: c.kias280.ff, tas: c.kias280.tas, mach: c.kias280.mach, corr: c.kias280.corrections };
}

/** Cruise fuel flow and TAS at an estimated mid-zone weight. The weight enters
 * to the nearest 1,000 kg and is interpolated between the 2,000 kg columns;
 * ISA deviation is rounded to 3 °C and applied as a percentage per 3 °C. */
export function cruiseLookup(technique: Technique, fl: number, emzwKg: number, isaDev: number): CruiseResult | null {
  const t = cruiseTable(technique);
  const fi = indexOfExact(t.fl, fl, `${technique} FL`);
  const w = weightEntry(emzwKg);
  const ff = interpolate(TABLES.cruise.weightsKg, t.ff[fi], w);
  const tas = interpolate(TABLES.cruise.weightsKg, t.tas[fi], w);
  if (ff === null || tas === null) return null;
  const dev = isaDevForCruise(isaDev);
  const mach = t.mach ? interpolate(TABLES.cruise.weightsKg, t.mach[fi], w) : 0.8;
  return {
    fuelFlowKgPerHour: ff * (1 + (t.corr.ffPercentPer3C / 100) * (dev / 3)),
    tasKt: tas + t.corr.tasKtPerC * dev,
    mach,
    weightEntered: w,
    isaDevUsed: dev,
  };
}

/** Thrust-limited weight at a level (Table 2.5), ISA deviation to the nearest 5 °C. */
export function altitudeCapabilityKg(technique: 'M0.80' | 'LRC', fl: number, isaDev: number): number | null {
  const t = TABLES.capability;
  const fi = indexOfExact(t.fl, fl, 'capability FL');
  const dev = Math.max(t.isaDev[0], Math.min(t.isaDev[t.isaDev.length - 1], isaDevForClimb(isaDev)));
  const di = indexOfExact(t.isaDev, dev, 'capability ISA deviation');
  return (technique === 'M0.80' ? t.m080 : t.lrc)[di][fi];
}

/** IFR cruising levels above FL290 (AIP ENR 1.7): eastbound (000–179 M) odd
 * thousands FL290, 330, 370, 410; westbound (180–359 M) FL310, 350, 390.
 * Below FL290: eastbound odd, westbound even. */
export function ifrLevels(trackMagnetic: number, minFl = 250, maxFl = 390): number[] {
  const east = ((trackMagnetic % 360) + 360) % 360 < 180;
  const out: number[] = [];
  for (let fl = minFl; fl <= maxFl; fl += 10) {
    if (fl < 290) {
      if ((east && fl % 20 === 10) || (!east && fl % 20 === 0)) out.push(fl);
    } else if (east ? [290, 330, 370, 410].includes(fl) : [310, 350, 390].includes(fl)) out.push(fl);
  }
  return out;
}

/** Highest appropriate level: the highest IFR level whose thrust-limited
 * weight is not below the start-of-cruise weight. */
export function highestLevel(technique: 'M0.80' | 'LRC', trackMagnetic: number, startCruiseKg: number, isaDevByFl: (fl: number) => number, maxFl = 390): number | null {
  const levels = ifrLevels(trackMagnetic, 250, maxFl).filter((fl) => TABLES.capability.fl.includes(fl));
  let best: number | null = null;
  for (const fl of levels) {
    const cap = altitudeCapabilityKg(technique, fl, isaDevByFl(fl));
    if (cap !== null && cap >= startCruiseKg) best = fl;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Descent (Table 4.1) and holding (Table 4.2)

export interface DescentResult {
  timeMin: number;
  fuelKg: number;
  distNam: number;
  tasKt: number;
  landingWeightColumn: number;
}

/** Descent to 1,500 ft overhead. Landing weight column to the nearest 10,000 kg, no interpolation. */
export function descentLookup(landingKg: number, fromFl: number, toFl = 0): DescentResult {
  const t = TABLES.descent;
  const col = Math.max(t.landingWeightKg[0], Math.min(t.landingWeightKg[t.landingWeightKg.length - 1], landingWeightColumn(landingKg)));
  const wi = indexOfExact(t.landingWeightKg, col, 'descent landing weight');
  const fi = indexOfExact(t.fl, fromFl, 'descent FL');
  const top = t.table[wi][fi];
  let time = top.t;
  let fuel = top.f;
  let dist = top.d;
  if (toFl > 0) {
    const li = indexOfExact(t.fl, toFl, 'descent lower FL');
    const low = t.table[wi][li];
    time -= low.t;
    fuel -= low.f;
    dist -= low.d;
  }
  return { timeMin: time, fuelKg: fuel, distNam: dist, tasKt: (dist / time) * 60, landingWeightColumn: col };
}

export interface HoldingResult {
  fuelFlowKgPerHour: number;
  tasKt: number;
  isaDevUsed: number;
}

/** Holding fuel flow at an estimated mid-hold weight (nearest 1,000 kg,
 * interpolated) and ISA deviation to the nearest 5 °C, 1% per 5 °C. FL15 is 1,500 ft. */
export function holdingLookup(emzwKg: number, fl: number, isaDev: number, oneInop = false): HoldingResult | null {
  const h = TABLES.holding;
  const table = oneInop ? h.oneInop.table : h.table;
  const levels = oneInop ? h.oneInop.fl : h.fl;
  const fi = indexOfExact(levels, fl, 'holding FL');
  const w = weightEntry(emzwKg);
  const ff = interpolate(h.weightsKg, table[fi].map((c) => (c ? c.ff : null)), w);
  const tas = interpolate(h.weightsKg, table[fi].map((c) => (c ? c.tas : null)), w);
  if (ff === null || tas === null) return null;
  const dev = isaDevForClimb(isaDev);
  return { fuelFlowKgPerHour: ff * (1 + (h.corrections.ffPercentPer5C / 100) * (dev / 5)), tasKt: tas, isaDevUsed: dev };
}

/** Fuel for a hold of `minutes` at 1,500 ft at a weight, ISA. */
export function holdingFuelKg(weightKg: number, minutes: number, isaDev = 0, fl = 15): number {
  const h = holdingLookup(weightKg, fl, isaDev);
  if (!h) throw new Error(`no holding data at ${weightKg} kg`);
  return (h.fuelFlowKgPerHour * minutes) / 60;
}

// ---------------------------------------------------------------------------
// Abnormal (Section 5)

/** One-engine-inoperative ceiling, FL, gross weight to the nearest 1,000 kg,
 * ISA deviation to the nearest 5 °C, interpolated between the 10 °C columns and
 * rounded down to the 1,000 ft. */
export function oneInopCeilingFl(weightKg: number, isaDev: number): number | null {
  const c = TABLES.abnormal.oneInop.ceiling;
  const dev = Math.max(c.isaDev[0], Math.min(c.isaDev[c.isaDev.length - 1], isaDevForClimb(isaDev)));
  const w = weightEntry(weightKg);
  const byIsa = c.isaDev.map((_, i) => interpolate(TABLES.abnormal.weightsKg, c.fl[i], w));
  const v = interpolate(c.isaDev, byIsa, dev);
  return v === null ? null : Math.floor(v / 10) * 10;
}

export function oneInopCruiseLookup(fl: number, emzwKg: number, isaDev: number): CruiseResult | null {
  const t = TABLES.abnormal.oneInop.lrc;
  const fi = indexOfExact(t.fl, fl, '1-INOP FL');
  const w = weightEntry(emzwKg);
  const ff = interpolate(TABLES.abnormal.weightsKg, t.ff[fi], w);
  const tas = interpolate(TABLES.abnormal.weightsKg, t.tas[fi], w);
  const mach = interpolate(TABLES.abnormal.weightsKg, t.mach[fi], w);
  if (ff === null || tas === null) return null;
  const dev = isaDevForCruise(isaDev);
  const corr = TABLES.cruise.lrc.corrections;
  return { fuelFlowKgPerHour: ff * (1 + (corr.ffPercentPer3C / 100) * (dev / 3)), tasKt: tas + corr.tasKtPerC * dev, mach, weightEntered: w, isaDevUsed: dev };
}

export function depressurisedCruiseLookup(fl: number, emzwKg: number, isaDev: number): CruiseResult | null {
  const t = TABLES.abnormal.depressurised.lrc;
  const fi = indexOfExact(t.fl, fl, 'depressurised FL');
  const w = weightEntry(emzwKg);
  const ff = interpolate(TABLES.abnormal.weightsKg, t.ff[fi], w);
  const tas = interpolate(TABLES.abnormal.weightsKg, t.tas[fi], w);
  const mach = interpolate(TABLES.abnormal.weightsKg, t.mach[fi], w);
  if (ff === null || tas === null) return null;
  const dev = isaDevForCruise(isaDev);
  const corr = TABLES.cruise.lrc.corrections;
  return { fuelFlowKgPerHour: ff * (1 + (corr.ffPercentPer3C / 100) * (dev / 3)), tasKt: tas + corr.tasKtPerC * dev, mach, weightEntered: w, isaDevUsed: dev };
}

// ---------------------------------------------------------------------------
// Meteorology: RSWT-style grid and the 2/3, 1/2 and FL185 rules

export interface MetColumn {
  name: string;
  /** keyed by forecast level (FL as number, e.g. 185, 235, 300, 340, 385, 445) */
  wind: Record<number, { dirT: number; kt: number }>;
  isaDev: Record<number, number>;
}

export interface MetGrid {
  levels: number[];
  columns: MetColumn[];
}

export const RSWT_LEVELS = [185, 235, 300, 340, 385, 445];

/** Forecast level to use for a cruise at `fl`: the closest level, FL185 below FL185. */
export function metLevelFor(grid: MetGrid, fl: number): number {
  const base = Math.min(...grid.levels);
  if (fl <= base) return base;
  return nearestEntry(grid.levels, fl);
}

/** Forecast level for a climb: 2/3 of the way from `fromFl` to `toFl`. */
export function climbMetLevel(grid: MetGrid, toFl: number, fromFl = 0): number {
  return metLevelFor(grid, fromFl + (2 / 3) * (toFl - fromFl));
}

/** Forecast level for a descent: half way from `fromFl` to `toFl`. */
export function descentMetLevel(grid: MetGrid, fromFl: number, toFl = 0): number {
  return metLevelFor(grid, fromFl + 0.5 * (toFl - fromFl));
}

export interface MetSample {
  level: number;
  windDirT: number;
  windKt: number;
  isaDev: number;
}

/** Wind (rounded to 10° and 5 kt) and ISA deviation from a column at a forecast level. */
export function sampleMet(column: MetColumn, level: number): MetSample {
  const w = column.wind[level];
  if (!w) throw new Error(`${column.name} has no wind at FL${level}`);
  const r = roundWind(w.dirT, w.kt);
  return { level, windDirT: r.dir, windKt: r.kt, isaDev: column.isaDev[level] };
}

// ---------------------------------------------------------------------------
// Triangle of velocities

export interface GroundSpeed {
  gsKt: number;
  /** positive tailwind, negative headwind */
  componentKt: number;
  driftDeg: number;
  headingDeg: number;
}

/** Exact triangle of velocities. Track and wind in the same reference (both
 * true, or both magnetic after variation is applied). */
export function groundSpeed(tasKt: number, trackDeg: number, windFromDeg: number, windKt: number): GroundSpeed {
  const rel = ((windFromDeg - trackDeg) * Math.PI) / 180;
  const along = -windKt * Math.cos(rel);
  const cross = windKt * Math.sin(rel);
  const gs = Math.sqrt(Math.max(0, tasKt * tasKt - cross * cross)) + along;
  const drift = (Math.asin(Math.max(-1, Math.min(1, cross / tasKt))) * 180) / Math.PI;
  // cross < 0 is wind from the left; the aircraft drifts right and heads left of track
  return { gsKt: gs, componentKt: along, driftDeg: -drift, headingDeg: (((trackDeg + drift) % 360) + 360) % 360 };
}

/** True direction from magnetic and variation (east positive). */
export function trueFromMagnetic(magDeg: number, variationEast: number): number {
  return (((magDeg + variationEast) % 360) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Geodesy for routes

export interface LatLon {
  lat: number;
  lon: number;
}

const DEG = Math.PI / 180;

export function greatCircleNm(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * DEG, φ2 = b.lat * DEG, dλ = (b.lon - a.lon) * DEG;
  const d = Math.acos(Math.max(-1, Math.min(1, Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(dλ))));
  return (d * 180) / Math.PI * 60;
}

export function initialTrackTrue(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * DEG, φ2 = b.lat * DEG, dλ = (b.lon - a.lon) * DEG;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/** Point a fraction `f` of the way along the great circle from a to b. */
export function alongTrack(a: LatLon, b: LatLon, f: number): LatLon {
  const d = (greatCircleNm(a, b) / 60) * DEG;
  if (d === 0) return a;
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const φ1 = a.lat * DEG, λ1 = a.lon * DEG, φ2 = b.lat * DEG, λ2 = b.lon * DEG;
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return { lat: Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG, lon: Math.atan2(y, x) / DEG };
}

// ---------------------------------------------------------------------------
// Zone log

export interface Leg {
  /** waypoint at the end of the leg */
  to: string;
  distNm: number;
  /** magnetic track */
  trackM: number;
  /** east positive */
  variation: number;
  /** index into grid.columns for this leg */
  metColumn: number;
}

export interface PlanInput {
  from: string;
  to: string;
  legs: Leg[];
  cruiseFl: number;
  technique: Technique;
  brakeReleaseKg: number;
  grid: MetGrid;
  /** Descend to this FL at destination; 0 for landing. */
  descentToFl?: number;
}

export interface ZoneRow {
  segment: string;
  fl: number | string;
  isaDev: number;
  mach: number | null;
  tasKt: number;
  trackM: number;
  wind: string;
  headingM: number;
  gsKt: number;
  distNm: number;
  etiMin: number;
  airDistNam: number;
  fuelFlowKgPerHour: number | null;
  zoneFuelKg: number;
  startZoneKg: number;
  emzwKg: number | null;
  endZoneKg: number;
  metLevel: number;
}

export interface Plan {
  rows: ZoneRow[];
  totalDistNm: number;
  totalTimeMin: number;
  burnKg: number;
  landingKg: number;
  tocKg: number;
  todKg: number;
}

/** Plan a flight: climb, one cruise zone per leg (met column may change at a
 * waypoint), descent. Climb and descent ground distances are taken out of the
 * first and last legs. Zone fuel: EMZW = SZW − zone fuel / 2, rounded to
 * 1,000 kg, iterated until the entered weight is stable. */
export function planFlight(input: PlanInput): Plan {
  const { legs, grid, cruiseFl, technique } = input;
  const total = legs.reduce((s, l) => s + l.distNm, 0);
  const rows: ZoneRow[] = [];
  let w = input.brakeReleaseKg;

  // climb
  const first = legs[0];
  const cLevel = climbMetLevel(grid, cruiseFl);
  const cMet = sampleMet(grid.columns[first.metColumn], cLevel);
  const climb = climbLookup(w, cruiseFl, cMet.isaDev);
  if (!climb) throw new Error(`cannot climb to FL${cruiseFl} at ${w} kg`);
  const cGs = groundSpeed(climb.tasKt, trueFromMagnetic(first.trackM, first.variation), cMet.windDirT, cMet.windKt);
  const climbGround = (cGs.gsKt * climb.timeMin) / 60;
  rows.push({
    segment: `${input.from} → TOC`, fl: `climb ${cruiseFl}`, isaDev: climb.isaDevUsed, mach: null, tasKt: climb.tasKt, trackM: first.trackM,
    wind: windText(cMet, first.variation), headingM: ((cGs.headingDeg - first.variation) % 360 + 360) % 360, gsKt: cGs.gsKt,
    distNm: climbGround, etiMin: climb.timeMin, airDistNam: climb.distNam, fuelFlowKgPerHour: null, zoneFuelKg: climb.fuelKg,
    startZoneKg: w, emzwKg: null, endZoneKg: w - climb.fuelKg, metLevel: cLevel,
  });
  w -= climb.fuelKg;
  const tocKg = w;

  // descent: estimate landing weight by the rule of thumb then refine once
  const last = legs[legs.length - 1];
  const dLevel = descentMetLevel(grid, cruiseFl, input.descentToFl ?? 0);
  const dMet = sampleMet(grid.columns[last.metColumn], dLevel);
  let lwEstimate = w - (total * 10 - climb.fuelKg) ;
  let descentRow: ZoneRow | null = null;
  let descentGround = 0;
  let cruiseRows: ZoneRow[] = [];
  for (let pass = 0; pass < 3; pass++) {
    const des = descentLookup(lwEstimate, cruiseFl, input.descentToFl ?? 0);
    const dGs = groundSpeed(des.tasKt, trueFromMagnetic(last.trackM, last.variation), dMet.windDirT, dMet.windKt);
    descentGround = (dGs.gsKt * des.timeMin) / 60;
    // cruise zones
    cruiseRows = [];
    let wz = tocKg;
    let remainingClimb = climbGround;
    let remainingDescent = descentGround;
    let firstCruise = true;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      let d = leg.distNm;
      if (remainingClimb > 0) { const take = Math.min(remainingClimb, d); d -= take; remainingClimb -= take; }
      if (i === legs.length - 1) d -= remainingDescent;
      else if (i === legs.length - 2 && legs[legs.length - 1].distNm < remainingDescent) {
        // descent longer than the last leg: take the balance out of this leg
        const over = remainingDescent - legs[legs.length - 1].distNm;
        d -= over;
        remainingDescent -= over;
      }
      if (d <= 0) continue;
      const level = metLevelFor(grid, cruiseFl);
      const met = sampleMet(grid.columns[leg.metColumn], level);
      let emzw = weightEntry(wz - (d * 10) / 2);
      let row: ZoneRow | null = null;
      for (let it = 0; it < 6; it++) {
        const cr = cruiseLookup(technique, cruiseFl, emzw, met.isaDev);
        if (!cr) throw new Error(`no ${technique} data at FL${cruiseFl} for ${emzw} kg`);
        const gs = groundSpeed(cr.tasKt, trueFromMagnetic(leg.trackM, leg.variation), met.windDirT, met.windKt);
        const eti = (d / gs.gsKt) * 60;
        const fuel = (cr.fuelFlowKgPerHour * eti) / 60;
        const check = weightEntry(wz - fuel / 2);
        row = {
          segment: firstCruise ? `TOC → ${leg.to}` : `${legs[i - 1].to} → ${leg.to}`, fl: cruiseFl, isaDev: cr.isaDevUsed, mach: cr.mach, tasKt: cr.tasKt,
          trackM: leg.trackM, wind: windText(met, leg.variation), headingM: ((gs.headingDeg - leg.variation) % 360 + 360) % 360, gsKt: gs.gsKt,
          distNm: d, etiMin: eti, airDistNam: (cr.tasKt * eti) / 60, fuelFlowKgPerHour: cr.fuelFlowKgPerHour, zoneFuelKg: fuel,
          startZoneKg: wz, emzwKg: emzw, endZoneKg: wz - fuel, metLevel: level,
        };
        if (check === emzw) break;
        emzw = check;
      }
      if (i === legs.length - 1 && remainingDescent > 0) row!.segment = `${firstCruise ? 'TOC' : legs[i - 1].to} → TOD`;
      firstCruise = false;
      cruiseRows.push(row!);
      wz -= row!.zoneFuelKg;
    }
    const todKg = wz;
    descentRow = {
      segment: `TOD → ${input.to}`, fl: `descent ${cruiseFl}`, isaDev: dMet.isaDev, mach: null, tasKt: des.tasKt, trackM: last.trackM,
      wind: windText(dMet, last.variation), headingM: ((dGs.headingDeg - last.variation) % 360 + 360) % 360, gsKt: dGs.gsKt,
      distNm: descentGround, etiMin: des.timeMin, airDistNam: des.distNam, fuelFlowKgPerHour: null, zoneFuelKg: des.fuelKg,
      startZoneKg: todKg, emzwKg: null, endZoneKg: todKg - des.fuelKg, metLevel: dLevel,
    };
    const lw = todKg - des.fuelKg;
    if (landingWeightColumn(lw) === des.landingWeightColumn) break;
    lwEstimate = lw;
  }
  rows.push(...cruiseRows, descentRow!);
  const burn = rows.reduce((s, r) => s + r.zoneFuelKg, 0);
  return {
    rows,
    totalDistNm: total,
    totalTimeMin: rows.reduce((s, r) => s + r.etiMin, 0),
    burnKg: burn,
    landingKg: input.brakeReleaseKg - burn,
    tocKg,
    todKg: descentRow!.startZoneKg,
  };
}

function windText(met: MetSample, variation: number): string {
  const mag = (((met.windDirT - variation) % 360) + 360) % 360;
  return `${String(Math.round(mag) === 0 ? 360 : Math.round(mag)).padStart(3, '0')}M/${met.windKt}`;
}

// ---------------------------------------------------------------------------
// Fuel plan (Isobar company policy, Part 121 style)

export interface FuelPlanInput {
  tripKg: number;
  landingKg: number;
  /** alternate burn from missed approach to 1,500 ft at the alternate, excluding the approach allowance; 0 when no alternate */
  alternateBurnKg?: number;
  holdingMin?: number;
  /** final reserve by table (default) or the fixed 1,600 kg before-flight figure */
  fixedFinalReserve?: boolean;
  additionalKg?: number;
  discretionaryKg?: number;
  taxiKg?: number;
  isaDevAtDestination?: number;
}

export interface FuelPlan {
  tripKg: number;
  contingencyKg: number;
  alternateKg: number;
  holdingKg: number;
  finalReserveKg: number;
  additionalKg: number;
  discretionaryKg: number;
  taxiKg: number;
  takeoffFuelKg: number;
  rampFuelKg: number;
  landingKgAtDestination: number;
  /** weight at the end of the alternate leg (or at destination when there is none) */
  reserveWeightKg: number;
  lines: { name: string; kg: number; basis: string }[];
}

export function fuelPlan(input: FuelPlanInput): FuelPlan {
  const policy = TABLES.fuelPolicy;
  const taxi = input.taxiKg ?? policy.taxiKg;
  const trip = input.tripKg;
  const dev = input.isaDevAtDestination ?? 0;
  const fiveMinHold = holdingFuelKg(input.landingKg, 5, dev);
  const contingency = Math.max(0.05 * trip, fiveMinHold);
  const alternate = input.alternateBurnKg ? input.alternateBurnKg + policy.approachAndLandingKg : holdingFuelKg(input.landingKg, 15, dev);
  const reserveWeight = input.alternateBurnKg ? input.landingKg - input.alternateBurnKg - policy.approachAndLandingKg : input.landingKg;
  const holding = input.holdingMin ? holdingFuelKg(input.landingKg, input.holdingMin, dev) : 0;
  const finalReserve = input.fixedFinalReserve ? 1600 : holdingFuelKg(reserveWeight, 30, 0);
  const additional = input.additionalKg ?? 0;
  const discretionary = input.discretionaryKg ?? 0;
  const takeoff = trip + contingency + alternate + holding + finalReserve + additional + discretionary;
  const basis = (id: string) => policy.components.find((c) => c.id === id)?.basis ?? 'company';
  return {
    tripKg: trip,
    contingencyKg: contingency,
    alternateKg: alternate,
    holdingKg: holding,
    finalReserveKg: finalReserve,
    additionalKg: additional,
    discretionaryKg: discretionary,
    taxiKg: taxi,
    takeoffFuelKg: takeoff,
    rampFuelKg: takeoff + taxi,
    landingKgAtDestination: input.landingKg,
    reserveWeightKg: reserveWeight,
    lines: [
      { name: 'Trip', kg: trip, basis: basis('trip') },
      { name: input.alternateBurnKg ? 'Alternate' : 'No alternate: 15 min holding', kg: alternate, basis: basis('alternate') },
      { name: 'Contingency 5% (min 5 min holding)', kg: contingency, basis: basis('contingency') },
      { name: input.holdingMin ? `Weather holding ${input.holdingMin} min` : 'Weather holding', kg: holding, basis: basis('holding') },
      { name: 'Final reserve 30 min', kg: finalReserve, basis: basis('final') },
      { name: 'Additional', kg: additional, basis: basis('additional') },
      { name: 'Discretionary', kg: discretionary, basis: basis('discretionary') },
      { name: 'Take-off fuel', kg: takeoff, basis: 'sum' },
      { name: 'Taxi', kg: taxi, basis: basis('taxi') },
      { name: 'Ramp fuel', kg: takeoff + taxi, basis: 'sum' },
    ],
  };
}

// ---------------------------------------------------------------------------
// ETP, PNR, PSD (CASA information book 4.2.9.9, 4.2.13.3)

/** Equi-time point between two aerodromes `distNm` apart, with the ground
 * speeds that apply from the ETP onwards (on) and back. Descent is ignored
 * for the position. Returns the distance from the departure end. */
export function etpDistanceNm(distNm: number, gsOnKt: number, gsBackKt: number): number {
  return (distNm * gsBackKt) / (gsOnKt + gsBackKt);
}

/** ETP over several zones. Each zone has its on and back ground speeds; the
 * ETP is where time to continue equals time to return. */
export function etpMultiZone(zones: { distNm: number; gsOnKt: number; gsBackKt: number }[]): { distNm: number; zone: number } {
  const total = zones.reduce((s, z) => s + z.distNm, 0);
  // time to go on from the start of zone i to the end, and time back from the end of zone i to the start
  let onFrom = zones.map((z) => z.distNm / z.gsOnKt);
  for (let i = zones.length - 2; i >= 0; i--) onFrom[i] += onFrom[i + 1];
  let backTo = 0;
  let covered = 0;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    // within zone i at x from its start: on = (z.d - x)/gsOn + onFrom[i+1]; back = backTo + x/gsBack
    const onRest = i + 1 < zones.length ? onFrom[i + 1] : 0;
    const x = ((z.distNm / z.gsOnKt + onRest - backTo) * z.gsOnKt * z.gsBackKt) / (z.gsOnKt + z.gsBackKt);
    if (x >= 0 && x <= z.distNm + 1e-9) return { distNm: covered + x, zone: i };
    backTo += z.distNm / z.gsBackKt;
    covered += z.distNm;
  }
  return { distNm: total, zone: zones.length - 1 };
}

/** Point of no return along a route. `fuelAvailableKg` is the fuel for the
 * out-and-back portion (FOB less reserves, holding and the fuel to descend
 * and land back). Each zone has the specific ground range out and back in
 * kg per ground nm (fuel flow ÷ ground speed). */
export function pnrDistanceNm(fuelAvailableKg: number, zones: { distNm: number; sgrOutKgPerNm: number; sgrBackKgPerNm: number }[]): { distNm: number; zone: number; limited: boolean } {
  let fuel = fuelAvailableKg;
  let covered = 0;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    const perNm = z.sgrOutKgPerNm + z.sgrBackKgPerNm;
    const zoneFuel = perNm * z.distNm;
    if (fuel <= zoneFuel) return { distNm: covered + fuel / perNm, zone: i, limited: true };
    fuel -= zoneFuel;
    covered += z.distNm;
  }
  return { distNm: covered, zone: zones.length - 1, limited: false };
}

export interface PsdInput {
  from: LatLon;
  to: LatLon;
  alternate: LatLon;
  /** fuel for flight to the PSD plus flight from the PSD to the alternate (FOB less reserves and the landing allowance) */
  fuelAvailableKg: number;
  /** out-bound along-track performance */
  outbound: { tasKt: number; fuelFlowKgPerHour: number };
  /** performance from the PSD to the alternate (normal, 1-INOP or depressurised) */
  diversion: { tasKt: number; fuelFlowKgPerHour: number };
  windFromT: number;
  windKt: number;
}

/** Point of safe diversion to an off-track alternate: the latest point along
 * the great circle from `from` to `to` from which the alternate can be reached
 * with the fuel available. Descent is ignored for the position. */
export function psd(input: PsdInput): { distNm: number; fraction: number; position: LatLon; diversionNm: number; diversionTrackT: number } | null {
  const total = greatCircleNm(input.from, input.to);
  const fuelAt = (f: number) => {
    const p = alongTrack(input.from, input.to, f);
    const out = f * total;
    const outGs = groundSpeed(input.outbound.tasKt, initialTrackTrue(input.from, input.to), input.windFromT, input.windKt).gsKt;
    const div = greatCircleNm(p, input.alternate);
    const divTrack = initialTrackTrue(p, input.alternate);
    const divGs = groundSpeed(input.diversion.tasKt, divTrack, input.windFromT, input.windKt).gsKt;
    return (out / outGs) * input.outbound.fuelFlowKgPerHour + (div / divGs) * input.diversion.fuelFlowKgPerHour;
  };
  if (fuelAt(1) <= input.fuelAvailableKg) {
    const p = input.to;
    return { distNm: total, fraction: 1, position: p, diversionNm: greatCircleNm(p, input.alternate), diversionTrackT: initialTrackTrue(p, input.alternate) };
  }
  if (fuelAt(0) > input.fuelAvailableKg) return null;
  let lo = 0, hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi);
    if (fuelAt(mid) <= input.fuelAvailableKg) lo = mid; else hi = mid;
  }
  const p = alongTrack(input.from, input.to, lo);
  return { distNm: lo * total, fraction: lo, position: p, diversionNm: greatCircleNm(p, input.alternate), diversionTrackT: initialTrackTrue(p, input.alternate) };
}

// ---------------------------------------------------------------------------
// Weight and balance

export interface LoadInput {
  basicWeightKg: number;
  basicIndex: number;
  /** passengers by zone: adults, adolescents, children, infants */
  zones: Record<string, { adult?: number; adolescent?: number; child?: number; infant?: number }>;
  /** freight by compartment number */
  freightKg: Record<number, number>;
  extraCrew?: number;
  fuelKg: number;
  taxiKg?: number;
  tripBurnKg?: number;
}

export interface LoadSheet {
  payloadKg: number;
  zeroFuelKg: number;
  zeroFuelIndex: number;
  zeroFuelMac: number;
  rampKg: number;
  brakeReleaseKg: number;
  brakeReleaseIndex: number;
  brakeReleaseMac: number;
  landingKg: number | null;
  landingMac: number | null;
  items: { name: string; kg: number; iu: number }[];
  violations: string[];
  stabTrim: { flaps5: number; flaps15: number; flaps25: number };
}

function indexOf(kg: number, armM: number): number {
  const b = TABLES.balance.indexUnit;
  return (kg * (armM - b.referenceArmM)) / b.divisor;
}

export function macFromIndex(kg: number, totalIndex: number): number {
  const b = TABLES.balance;
  const arm = b.indexUnit.referenceArmM + ((totalIndex - b.indexUnit.offset) * b.indexUnit.divisor) / kg;
  return ((arm - b.mac.lemacM) / b.mac.macM) * 100;
}

export function fuelIndexFor(kg: number): number {
  const t = TABLES.balance.fuelIndex;
  const v = interpolate(t.map((x) => x.kg), t.map((x) => x.iu), kg);
  return v ?? 0;
}

export function cgLimitsAt(kg: number): { forwardMac: number; aftMac: number } {
  const t = TABLES.balance.envelope.table;
  const axis = t.map((x) => x.kg);
  return { forwardMac: interpolate(axis, t.map((x) => x.forwardMac), kg) ?? 0, aftMac: interpolate(axis, t.map((x) => x.aftMac), kg) ?? 0 };
}

export function loadSheet(input: LoadInput): LoadSheet {
  const b = TABLES.balance;
  const sw = b.standardWeights;
  const items: { name: string; kg: number; iu: number }[] = [];
  const violations: string[] = [];
  items.push({ name: 'Basic weight', kg: input.basicWeightKg, iu: input.basicIndex });
  let payload = 0;
  for (const [zone, p] of Object.entries(input.zones)) {
    const z = b.zones[zone as keyof typeof b.zones];
    if (!z) throw new Error(`unknown zone ${zone}`);
    const seats = (p.adult ?? 0) + (p.adolescent ?? 0) + (p.child ?? 0);
    if (seats > z.seats) violations.push(`Zone ${zone}: ${seats} seats used, ${z.seats} available`);
    const kg = (p.adult ?? 0) * sw.adult + (p.adolescent ?? 0) * sw.adolescent + (p.child ?? 0) * sw.child + (p.infant ?? 0) * sw.infant;
    items.push({ name: `Zone ${zone} (rows ${z.rows})`, kg, iu: indexOf(kg, z.armM) });
    payload += kg;
  }
  for (const [c, kg] of Object.entries(input.freightKg)) {
    const comp = b.compartments[c as unknown as keyof typeof b.compartments];
    if (!comp) throw new Error(`unknown compartment ${c}`);
    if (kg > comp.maxKg) violations.push(`Compartment ${c}: ${kg} kg exceeds ${comp.maxKg} kg`);
    items.push({ name: `Compartment ${c} (${comp.hold})`, kg, iu: indexOf(kg, comp.armM) });
    payload += kg;
  }
  if (input.extraCrew) {
    const kg = input.extraCrew * b.extraCrewKg;
    items.push({ name: 'Extra crew', kg, iu: indexOf(kg, b.crewSeatArmM) });
    payload += kg;
  }
  const zfw = input.basicWeightKg + payload;
  const zfwIndex = items.reduce((s, i) => s + i.iu, 0);
  const zfwMac = macFromIndex(zfw, zfwIndex);
  const taxi = input.taxiKg ?? TABLES.fuelPolicy.taxiKg;
  const ramp = zfw + input.fuelKg;
  const brw = ramp - taxi;
  const brwIndex = zfwIndex + fuelIndexFor(input.fuelKg - taxi);
  const brwMac = macFromIndex(brw, brwIndex);
  const lim = TABLES.limitations.weights;
  if (zfw > lim.maxZeroFuelKg) violations.push(`ZFW ${zfw} kg exceeds MZFW ${lim.maxZeroFuelKg} kg`);
  if (ramp > lim.maxTaxiKg) violations.push(`Ramp weight ${ramp} kg exceeds max taxi weight ${lim.maxTaxiKg} kg`);
  if (brw > lim.maxTakeoffKg) violations.push(`BRW ${brw} kg exceeds MTOW ${lim.maxTakeoffKg} kg`);
  const check = (name: string, kg: number, mac: number) => {
    const l = cgLimitsAt(kg);
    if (mac < l.forwardMac - 1e-9) violations.push(`${name} CG ${mac.toFixed(1)}% MAC is forward of the ${l.forwardMac.toFixed(1)}% limit`);
    if (mac > l.aftMac + 1e-9) violations.push(`${name} CG ${mac.toFixed(1)}% MAC is aft of the ${l.aftMac.toFixed(1)}% limit`);
  };
  check('ZFW', zfw, zfwMac);
  check('BRW', brw, brwMac);
  let landingKg: number | null = null;
  let landingMac: number | null = null;
  if (input.tripBurnKg !== undefined) {
    landingKg = brw - input.tripBurnKg;
    const fuelLeft = input.fuelKg - taxi - input.tripBurnKg;
    landingMac = macFromIndex(landingKg, zfwIndex + fuelIndexFor(fuelLeft));
    if (landingKg > lim.maxLandingKg) violations.push(`LW ${landingKg} kg exceeds MLW ${lim.maxLandingKg} kg`);
    check('LW', landingKg, landingMac);
  }
  const trimRow = (mac: number) => {
    const t = b.stabTrim;
    const axis = t.map((x) => x.mac);
    return {
      flaps5: interpolate(axis, t.map((x) => x.flaps5), mac) ?? 0,
      flaps15: interpolate(axis, t.map((x) => x.flaps15), mac) ?? 0,
      flaps25: interpolate(axis, t.map((x) => x.flaps25), mac) ?? 0,
    };
  };
  return {
    payloadKg: payload, zeroFuelKg: zfw, zeroFuelIndex: zfwIndex, zeroFuelMac: zfwMac,
    rampKg: ramp, brakeReleaseKg: brw, brakeReleaseIndex: brwIndex, brakeReleaseMac: brwMac,
    landingKg, landingMac, items, violations, stabTrim: trimRow(brwMac),
  };
}

// ---------------------------------------------------------------------------
// Take-off and landing limits (Section 6)

export interface TakeoffInput {
  flap: 5 | 15 | 25;
  toraM: number;
  slopePercent: number;
  /** along-runway component, headwind positive, knots */
  windKt: number;
  elevationFt: number;
  qnhHpa: number;
  oatC: number;
  engineAntiIce?: boolean;
  wingAntiIce?: boolean;
}

export interface TakeoffLimit {
  pressureAltFt: number;
  correctedLengthM: number;
  fieldLimitKg: number;
  climbLimitKg: number;
  structuralKg: number;
  performanceLimitKg: number;
  limitedBy: 'field' | 'climb' | 'structural';
  speeds: { v1: number; vr: number; v2: number } | null;
}

function interp2(axisA: number[], axisB: number[], grid: number[][], a: number, b: number): number {
  const rows = grid.map((row) => interpolate(axisB, row, b) ?? 0);
  return interpolate(axisA, rows, a) ?? 0;
}

/** Field and climb limits that fall off the top of the tables are reported as
 * this value: "above the table", never a real weight. */
export const TABLE_CEILING_KG = 90000;

/** Exam convention: 30 ft per hPa from the 1013 hPa standard. */
export function pressureAltitude(elevationFt: number, qnhHpa: number): number {
  return elevationFt + (1013 - qnhHpa) * 30;
}

export function takeoffLimit(input: TakeoffInput): TakeoffLimit {
  const t = TABLES.takeoff;
  const fi = indexOfExact(t.flaps as unknown as number[], input.flap, 'take-off flap');
  const pa = pressureAltitude(input.elevationFt, input.qnhHpa);
  const c = t.corrections;
  const wind = input.windKt >= 0 ? input.windKt * c.headwindMPerKt : -input.windKt * c.tailwindMPerKt;
  const corrected = (input.toraM - c.lineUpM) * (1 + c.slopePerPercent * input.slopePercent) + wind;
  // field: interpolate PA, OAT, length
  const byPa = t.pressureAltFt.map((_, pi) => interp2(t.oatC, t.fieldLengthM, t.fieldLimit.weightKg[fi][pi], input.oatC, corrected));
  const field = Math.min(TABLE_CEILING_KG, interpolate(t.pressureAltFt, byPa, pa) ?? 0);
  let climb = Math.min(TABLE_CEILING_KG, interp2(t.pressureAltFt, t.oatC, t.climbLimit.weightKg[fi], pa, input.oatC));
  if (input.windKt < 0) climb -= -input.windKt * t.climbLimit.tailwindKgPerKt;
  if (input.wingAntiIce) climb -= t.climbLimit.engineAndWingAntiIceKg;
  else if (input.engineAntiIce) climb -= t.climbLimit.engineAntiIceKg;
  let structural = TABLES.limitations.weights.maxTakeoffKg;
  if (pa > 2000) structural -= ((pa - 2000) / 1000) * t.weightLapseAbove2000FtKgPer1000Ft;
  const perf = Math.min(field, climb, structural);
  const limitedBy = perf === field ? 'field' : perf === climb ? 'climb' : 'structural';
  const lim = TABLES.limitations;
  const vs = lim.vSpeeds;
  const axis = vs.map((v) => v.kg);
  const key = String(input.flap) as '5' | '15' | '25';
  const speeds = perf >= axis[0] ? {
    v1: Math.round(interpolate(axis, vs.map((v) => v.takeoff[key].v1), perf) ?? 0),
    vr: Math.round(interpolate(axis, vs.map((v) => v.takeoff[key].vr), perf) ?? 0),
    v2: Math.round(interpolate(axis, vs.map((v) => v.takeoff[key].v2), perf) ?? 0),
  } : null;
  return { pressureAltFt: pa, correctedLengthM: corrected, fieldLimitKg: field, climbLimitKg: climb, structuralKg: structural, performanceLimitKg: perf, limitedBy, speeds };
}

export interface LandingInput {
  flap: 30 | 40;
  ldaM: number;
  slopePercent: number;
  windKt: number;
  elevationFt: number;
  qnhHpa: number;
  oatC: number;
  wet: boolean;
}

export interface LandingLimit {
  pressureAltFt: number;
  correctedLengthM: number;
  fieldLimitKg: number;
  approachClimbLimitKg: number;
  structuralKg: number;
  performanceLimitKg: number;
  limitedBy: 'field' | 'climb' | 'structural';
  vrefKt: number | null;
}

export function landingLimit(input: LandingInput): LandingLimit {
  const t = TABLES.landing;
  const fi = indexOfExact(t.flaps as unknown as number[], input.flap, 'landing flap');
  const si = input.wet ? 1 : 0;
  const pa = pressureAltitude(input.elevationFt, input.qnhHpa);
  const c = t.corrections;
  const wind = input.windKt >= 0 ? input.windKt * c.headwindMPerKt : -input.windKt * c.tailwindMPerKt;
  const corrected = input.ldaM * (1 + c.slopePerPercent * -input.slopePercent) + wind;
  const field = Math.min(TABLE_CEILING_KG, interp2(t.pressureAltFt, t.fieldLengthM, t.fieldLimit.weightKg[fi][si], pa, corrected));
  const climb = Math.min(TABLE_CEILING_KG, interp2(t.pressureAltFt, t.oatC, t.approachClimb.weightKg[fi], pa, input.oatC));
  const structural = input.flap === 40 ? TABLES.limitations.weights.maxLandingFlaps40Kg : TABLES.limitations.weights.maxLandingKg;
  const perf = Math.min(field, climb, structural);
  const limitedBy = perf === field ? 'field' : perf === climb ? 'climb' : 'structural';
  const vs = TABLES.limitations.vSpeeds;
  const key = String(input.flap) as '30' | '40';
  const vref = interpolate(vs.map((v) => v.kg), vs.map((v) => v.vref[key]), perf);
  return { pressureAltFt: pa, correctedLengthM: corrected, fieldLimitKg: field, approachClimbLimitKg: climb, structuralKg: structural, performanceLimitKg: perf, limitedBy, vrefKt: vref === null ? null : Math.round(vref) };
}

// ---------------------------------------------------------------------------
// Rule-of-thumb cross-check

export function ruleOfThumb(plan: Plan): { kgPerGroundNm: number; kgPerMin: number; thumbTripKg: number; differencePercent: number } {
  const r = TABLES.limitations.ruleOfThumb;
  const thumb = plan.totalDistNm * r.cruiseKgPerGroundNm + r.climbExtraKg;
  return {
    kgPerGroundNm: plan.burnKg / plan.totalDistNm,
    kgPerMin: plan.burnKg / plan.totalTimeMin,
    thumbTripKg: thumb,
    differencePercent: ((plan.burnKg - thumb) / thumb) * 100,
  };
}
