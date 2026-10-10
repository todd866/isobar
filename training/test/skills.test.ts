/** Part-task drills. The expected answer is recomputed here from `given` and the
 * published tables. It does not call the generator's arithmetic. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { TABLES, RSWT_LEVELS } from '../src/b727/engine.ts';
import { concepts, sources } from '../src/catalog.ts';
import { reduce, openSession } from '../src/session.ts';
import { SKILLS, PREVIEW_DRILLS, diagnose, drillCards, toCard, type Drill } from '../src/skills/index.ts';
import { lintCard, validateCard } from '../src/validate.ts';
import { renderShell, type RenderInput } from '../src/view.ts';

const LB = 2.2;
const R = 287.05287;
const GAMMA = 1.4;
const KT = 0.514444;

function roundTo(x: number, step: number): number {
  return Math.round(x / step + 1e-9) * step;
}

function g(drill: Drill, key: string): number {
  const value = drill.given[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${drill.id} missing ${key}`);
  return value;
}

function interp(axis: number[], row: (number | null)[], x: number): number {
  if (x <= axis[0]!) {
    if (row[0] == null) throw new Error('null');
    return row[0];
  }
  if (x >= axis.at(-1)!) {
    const last = row.at(-1);
    if (last == null) throw new Error('null');
    return last;
  }
  for (let i = 1; i < axis.length; i++) {
    if (x <= axis[i]!) {
      const a = row[i - 1];
      const b = row[i];
      if (a == null || b == null) throw new Error('null');
      const f = (x - axis[i - 1]!) / (axis[i]! - axis[i - 1]!);
      return a + f * (b - a);
    }
  }
  throw new Error('interp');
}

function ff(fl: number, kg: number): number {
  const table = TABLES.cruise.m080;
  const value = table.ff[table.fl.indexOf(fl)]![TABLES.cruise.weightsKg.indexOf(kg)];
  if (value == null) throw new Error(`blank fuel flow FL${fl} ${kg}`);
  return value;
}

function ffAt(fl: number, kg: number): number {
  const fls = TABLES.cruise.m080.fl;
  const exact = fls.indexOf(fl);
  if (exact >= 0) return interp(TABLES.cruise.weightsKg, TABLES.cruise.m080.ff[exact]!, kg);
  let i = 1;
  while (i < fls.length && fl > fls[i]!) i++;
  const lo = interp(TABLES.cruise.weightsKg, TABLES.cruise.m080.ff[i - 1]!, kg);
  const hi = interp(TABLES.cruise.weightsKg, TABLES.cruise.m080.ff[i]!, kg);
  const f = (fl - fls[i - 1]!) / (fls[i]! - fls[i - 1]!);
  return lo + f * (hi - lo);
}

function descentFuel(landingKg: number, fl: number): number {
  const table = TABLES.descent;
  const col = Math.max(table.landingWeightKg[0]!, Math.min(table.landingWeightKg.at(-1)!, roundTo(landingKg, 10000)));
  return table.table[table.landingWeightKg.indexOf(col)]![table.fl.indexOf(fl)]!.f;
}

function climbFuel(weightKg: number, fl: number, isaDev: number): number {
  const table = TABLES.climb;
  const dev = Math.max(table.isaDev[0]!, Math.min(table.isaDev.at(-1)!, roundTo(isaDev, 5)));
  const row = table.table[table.isaDev.indexOf(dev)]![table.fl.indexOf(fl)]!.map((cell) => (cell ? cell.f : null));
  return Math.floor(interp(table.brakeReleaseKg, row, weightKg) + 0.5);
}

function isaC(fl: number): number {
  const hM = fl * 100 * 0.3048;
  const tK = hM < 11000 ? 288.15 - 0.0065 * hM : 216.65;
  return tK - 273.15;
}

function physicsTas(mach: number, oatC: number): number {
  return mach * Math.sqrt(GAMMA * R * (oatC + 273.15)) / KT;
}

function tableTas(fl: number, isaDev: number): number {
  const i = TABLES.cruise.m080.fl.indexOf(fl);
  return TABLES.cruise.m080.tasIsa[i]! + TABLES.cruise.m080.corrections.tasKtPerC * roundTo(isaDev, 3);
}

function seaTas(mach: number): number {
  return mach * Math.sqrt(GAMMA * R * 288.15) / KT;
}

function triangle(track: number, from: number, wind: number, tas = 0): { tail: number; cross: number; gs: number } {
  const rel = ((from - track) * Math.PI) / 180;
  const tail = -wind * Math.cos(rel);
  const cross = wind * Math.sin(rel);
  const gs = tas > 0 ? Math.sqrt(Math.max(0, tas * tas - cross * cross)) + tail : 0;
  return { tail, cross, gs };
}

function nam(fl: number, kg: number): number {
  const ir = TABLES.cruise.integratedRange;
  const exact = ir.fl.indexOf(fl);
  if (exact >= 0) return interp(ir.weightsKg, ir.nam[exact]!, kg);
  let i = 1;
  while (i < ir.fl.length && fl > ir.fl[i]!) i++;
  const lo = interp(ir.weightsKg, ir.nam[i - 1]!, kg);
  const hi = interp(ir.weightsKg, ir.nam[i]!, kg);
  return lo + ((fl - ir.fl[i - 1]!) / (ir.fl[i]! - ir.fl[i - 1]!)) * (hi - lo);
}

function weightForNam(fl: number, target: number): number {
  const ws = TABLES.cruise.integratedRange.weightsKg;
  const curve = ws.map((w) => nam(fl, w));
  for (let i = 0; i < ws.length - 1; i++) {
    const hi = curve[i]!;
    const lo = curve[i + 1]!;
    if (target <= hi + 1e-6 && target >= lo - 1e-6) {
      return ws[i]! + ((hi - target) / (hi - lo)) * (ws[i + 1]! - ws[i]!);
    }
  }
  throw new Error(`nam ${target} off FL${fl}`);
}

function nearest(axis: readonly number[], x: number): number {
  let best = axis[0]!;
  for (const value of axis) {
    const da = Math.abs(value - x);
    const db = Math.abs(best - x);
    if (da < db || (da === db && value > best)) best = value;
  }
  return best;
}

function climbLevel(fl: number): number {
  const height = (2 / 3) * fl;
  return height <= RSWT_LEVELS[0]! ? RSWT_LEVELS[0]! : nearest(RSWT_LEVELS, height);
}

function descentLevel(fl: number): number {
  const height = 0.5 * fl;
  return height <= RSWT_LEVELS[0]! ? RSWT_LEVELS[0]! : nearest(RSWT_LEVELS, height);
}

function cruiseLevel(fl: number): number {
  return fl <= RSWT_LEVELS[0]! ? RSWT_LEVELS[0]! : nearest(RSWT_LEVELS, fl);
}

function roundedWind(dir: number, kt: number): { dir: number; kt: number } {
  let next = roundTo(dir, 10) % 360;
  if (next === 0) next = 360;
  return { dir: next, kt: roundTo(kt, 5) };
}

function indexUnits(weightKg: number, armM: number): number {
  const b = TABLES.balance.indexUnit;
  return (weightKg * (armM - b.referenceArmM)) / b.divisor;
}

function armOf(mac: number): number {
  const b = TABLES.balance.mac;
  return b.lemacM + (mac / 100) * b.macM;
}

function macFrom(weightKg: number, total: number): number {
  const b = TABLES.balance.indexUnit;
  const arm = b.referenceArmM + ((total - b.offset) * b.divisor) / weightKg;
  return ((arm - TABLES.balance.mac.lemacM) / TABLES.balance.mac.macM) * 100;
}

function compArm(id: number): number {
  return TABLES.balance.compartments[String(id) as '1']!.armM;
}

function zone(id: string): number {
  return TABLES.balance.zones[id as 'A']!.armM;
}

const NEXT: Record<number, number> = { 1: 2, 2: 1, 4: 5, 5: 4 };

function totalIndex(weightKg: number, mac: number): number {
  return TABLES.balance.indexUnit.offset + indexUnits(weightKg, armOf(mac));
}

function etp(dist: number, on: number, back: number): number {
  return (dist * back) / (on + back);
}

function etpTwo(a: { d: number; on: number; back: number }, b: { d: number; on: number; back: number }): number {
  const x = ((a.d / a.on + b.d / b.on) * a.on * a.back) / (a.on + a.back);
  if (x >= 0 && x <= a.d) return x;
  const backTo = a.d / a.back;
  const x1 = ((b.d / b.on - backTo) * b.on * b.back) / (b.on + b.back);
  return a.d + x1;
}

function answerOf(drill: Drill): number {
  const skill = drill.skill;
  const rung = drill.rung;
  if (skill === 'table-cell' && rung === 1) return ff(g(drill, 'fl'), g(drill, 'weightKg'));
  if (skill === 'table-cell' && rung === 2) return descentFuel(g(drill, 'landingKg'), g(drill, 'fl'));
  if (skill === 'table-cell' && rung === 3) {
    const emzw = roundTo(g(drill, 'startKg') - g(drill, 'fuelKg') / 2, 1000);
    return ff(g(drill, 'fl'), emzw);
  }
  if (skill === 'table-cell' && rung === 4) {
    const toc = roundTo(g(drill, 'brakeReleaseKg') - g(drill, 'climbFuelKg'), 1000);
    return ff(g(drill, 'fl'), toc);
  }
  if (skill === 'interpolate' && (rung === 1 || rung === 3)) return ffAt(g(drill, 'fl'), g(drill, 'weightKg'));
  if (skill === 'interpolate' && rung === 2) return ffAt(g(drill, 'fl'), g(drill, 'weightKg'));
  if (skill === 'interpolate' && rung === 4) return climbFuel(g(drill, 'weightKg'), g(drill, 'fl'), g(drill, 'isaDev'));
  if (skill === 'isa-dev') {
    const raw = g(drill, 'oatC') - isaC(g(drill, 'fl'));
    if (rung === 1) return raw;
    if (rung === 4) return roundTo(raw, 5);
    return roundTo(raw, 3);
  }
  if (skill === 'tas-mach' && rung === 1) return physicsTas(g(drill, 'mach'), g(drill, 'oatC'));
  if (skill === 'tas-mach' && rung === 2) return tableTas(g(drill, 'fl'), g(drill, 'oatC') - isaC(g(drill, 'fl')));
  if (skill === 'tas-mach' && rung === 3) return physicsTas(g(drill, 'mach'), g(drill, 'oatC')) * g(drill, 'timeMin') / 60;
  if (skill === 'tas-mach' && rung === 4) return physicsTas(g(drill, 'mach'), g(drill, 'oatC')) * g(drill, 'distNm') / g(drill, 'gsKt');
  if (skill === 'wind-component' && (rung === 1 || rung === 3)) return triangle(g(drill, 'trackDeg'), g(drill, 'windFromDeg'), g(drill, 'windKt')).tail;
  if (skill === 'wind-component') {
    const track = ((g(drill, 'trackDeg') + g(drill, 'variationEast')) % 360 + 360) % 360;
    return triangle(track, g(drill, 'windFromDeg'), g(drill, 'windKt')).tail;
  }
  if (skill === 'groundspeed' && rung === 1) {
    const head = g(drill, 'windFromDeg') === g(drill, 'trackDeg');
    return head ? g(drill, 'tasKt') - g(drill, 'windKt') : g(drill, 'tasKt') + g(drill, 'windKt');
  }
  if (skill === 'groundspeed' && rung === 4) {
    const tas = physicsTas(g(drill, 'mach'), g(drill, 'oatC'));
    return triangle(g(drill, 'trackDeg'), g(drill, 'windFromDeg'), g(drill, 'windKt'), tas).gs;
  }
  if (skill === 'groundspeed') return triangle(g(drill, 'trackDeg'), g(drill, 'windFromDeg'), g(drill, 'windKt'), g(drill, 'tasKt')).gs;
  if (skill === 'zone-time' && rung === 1) return g(drill, 'distNm') / g(drill, 'gsKt') * 60;
  if (skill === 'zone-time' && rung === 2) return g(drill, 'distNm') / (g(drill, 'tasKt') + g(drill, 'tailKt')) * 60;
  if (skill === 'zone-time' && rung === 3) {
    const gs = triangle(g(drill, 'trackDeg'), g(drill, 'windFromDeg'), g(drill, 'windKt'), g(drill, 'tasKt')).gs;
    return g(drill, 'distNm') / gs * 60;
  }
  if (skill === 'zone-time' && rung === 4) {
    const dist = g(drill, 'legNm') - g(drill, 'climbNm');
    return dist / (g(drill, 'tasKt') + g(drill, 'tailKt')) * 60;
  }
  if (skill === 'zone-fuel' && rung === 1) return g(drill, 'flowKgH') * g(drill, 'timeMin') / 60;
  if (skill === 'zone-fuel' && rung === 2) {
    const gs = g(drill, 'tasKt') + g(drill, 'tailKt');
    return g(drill, 'flowKgH') * (g(drill, 'distNm') / gs);
  }
  if (skill === 'zone-fuel' && rung === 3) {
    const gs = triangle(g(drill, 'trackDeg'), g(drill, 'windFromDeg'), g(drill, 'windKt'), g(drill, 'tasKt')).gs;
    return g(drill, 'flowKgH') * (g(drill, 'distNm') / gs);
  }
  if (skill === 'zone-fuel' && rung === 4) {
    const dist = g(drill, 'legNm') - g(drill, 'climbNm');
    return g(drill, 'flowKgH') * (dist / g(drill, 'gsKt'));
  }
  if (skill === 'mid-zone-weight' && rung === 1) return g(drill, 'startKg') - g(drill, 'fuelKg') / 2;
  if (skill === 'mid-zone-weight' && rung === 2) return roundTo(g(drill, 'startKg') - g(drill, 'fuelKg') / 2, 1000);
  if (skill === 'mid-zone-weight' && rung === 3) {
    const zone = g(drill, 'flowKgH') * g(drill, 'timeMin') / 60;
    return roundTo(g(drill, 'startKg') - zone / 2, 1000);
  }
  if (skill === 'mid-zone-weight' && rung === 4) {
    const toc = g(drill, 'brakeReleaseKg') - g(drill, 'climbFuelKg');
    return roundTo(toc - g(drill, 'zoneFuelKg') / 2, 1000);
  }
  if (skill === 'met-level' && rung === 1) return climbLevel(g(drill, 'cruiseFl'));
  if (skill === 'met-level' && rung === 2) return descentLevel(g(drill, 'cruiseFl'));
  if (skill === 'met-level') {
    const level = rung === 3 ? climbLevel(g(drill, 'cruiseFl')) : descentLevel(g(drill, 'cruiseFl'));
    const wind = roundedWind(g(drill, `d${level}`), g(drill, `k${level}`));
    return triangle(g(drill, 'trackDeg'), wind.dir, wind.kt).tail;
  }
  if (skill === 'etp' && rung === 1) return etp(g(drill, 'distNm'), g(drill, 'gsOnKt'), g(drill, 'gsBackKt'));
  if (skill === 'etp' && (rung === 2 || rung === 3)) {
    const on = g(drill, 'tasOn') + g(drill, 'tail');
    const back = g(drill, 'tasOn') - g(drill, 'tail');
    return etp(g(drill, 'distNm'), on, back);
  }
  if (skill === 'etp' && rung === 4) {
    return etpTwo(
      { d: g(drill, 'd1'), on: g(drill, 'gsOn1'), back: g(drill, 'gsBack1') },
      { d: g(drill, 'd2'), on: g(drill, 'gsOn2'), back: g(drill, 'gsBack2') },
    );
  }
  if (skill === 'pnr' && rung === 1) return g(drill, 'fuelKg') / (g(drill, 'sgrOut') + g(drill, 'sgrBack'));
  if (skill === 'pnr' && (rung === 2 || rung === 3)) {
    const out = g(drill, 'flowOut') / g(drill, 'gsOn');
    const back = g(drill, 'flowBack') / g(drill, 'gsBack');
    return g(drill, 'fuelKg') / (out + back);
  }
  if (skill === 'pnr' && rung === 4) {
    const spent = (g(drill, 'sgrOut1') + g(drill, 'sgrBack1')) * g(drill, 'd1');
    return g(drill, 'd1') + (g(drill, 'fuelKg') - spent) / (g(drill, 'sgrOut2') + g(drill, 'sgrBack2'));
  }
  if (skill === 'integrated-range' && (rung === 1 || rung === 3)) return nam(g(drill, 'fl'), g(drill, 'endKg')) - nam(g(drill, 'fl'), g(drill, 'startKg'));
  if (skill === 'integrated-range' && rung === 2) {
    const end = weightForNam(g(drill, 'fl'), nam(g(drill, 'fl'), g(drill, 'startKg')) + g(drill, 'airNm'));
    return g(drill, 'startKg') - end;
  }
  if (skill === 'integrated-range' && rung === 4) {
    const start = weightForNam(g(drill, 'fl'), nam(g(drill, 'fl'), g(drill, 'endKg')) - g(drill, 'airNm'));
    return start - g(drill, 'endKg');
  }
  if (skill === 'specific-range' && rung === 1) return g(drill, 'fuelKg') / g(drill, 'distNm');
  if (skill === 'specific-range' && rung === 2) return g(drill, 'fuelKg') / g(drill, 'timeMin');
  if (skill === 'specific-range' && rung === 3) return g(drill, 'flowKgH') / g(drill, 'gsKt');
  if (skill === 'specific-range' && rung === 4) return g(drill, 'distNm') * 10 + 1600;
  if (skill === 'cg-shift' && rung === 1) return indexUnits(g(drill, 'weightKg'), compArm(g(drill, 'compartment')));
  if (skill === 'cg-shift' && rung === 2) {
    const index = totalIndex(g(drill, 'weightKg'), g(drill, 'mac')) + indexUnits(g(drill, 'addKg'), compArm(g(drill, 'compartment')));
    return macFrom(g(drill, 'weightKg') + g(drill, 'addKg'), index);
  }
  if (skill === 'cg-shift' && rung === 3) {
    const delta = indexUnits(g(drill, 'moveKg'), compArm(g(drill, 'to'))) - indexUnits(g(drill, 'moveKg'), compArm(g(drill, 'from')));
    return macFrom(g(drill, 'weightKg'), totalIndex(g(drill, 'weightKg'), g(drill, 'mac')) + delta);
  }
  if (skill === 'cg-shift' && rung === 4) {
    const people = g(drill, 'adults') * TABLES.balance.standardWeights.adult;
    const index = g(drill, 'basicIndex') + indexUnits(people, zone('A')) + indexUnits(g(drill, 'freightKg'), compArm(g(drill, 'compartment')));
    return macFrom(g(drill, 'basicKg') + people + g(drill, 'freightKg'), index);
  }
  throw new Error(`no independent answer for ${skill} rung ${rung}`);
}

function rangeColumn(fl: number, end: boolean): number {
  const levels = [290, 310, 330, 350, 370];
  if (end) return fl === 370 ? 350 : levels[levels.indexOf(fl) + 1]!;
  const index = levels.indexOf(fl);
  return levels[index === 0 ? 1 : index - 1]!;
}

function wrongOf(drill: Drill, id: string): number {
  const right = answerOf(drill);
  const skill = drill.skill;
  const rung = drill.rung;
  if (id === 'kilograms-as-pounds') return right * LB;
  if (skill === 'table-cell' && id === 'wrong-row' && rung === 1) return ff(g(drill, 'fl') + 10, g(drill, 'weightKg'));
  if (skill === 'table-cell' && id === 'wrong-column' && rung === 1) return ff(g(drill, 'fl'), g(drill, 'weightKg') + 2000);
  if (skill === 'table-cell' && id === 'isa-corrected') {
    const per = TABLES.cruise.m080.corrections.ffPercentPer3C;
    return right * (1 + (per / 100) * (roundTo(10, 3) / 3));
  }
  if (skill === 'table-cell' && id === 'wrong-row' && rung === 2) return descentFuel(g(drill, 'landingKg'), g(drill, 'fl') - 10);
  if (skill === 'table-cell' && id === 'wrong-column' && rung === 2) {
    const column = roundTo(g(drill, 'landingKg'), 10000);
    return descentFuel(column === 70000 ? 60000 : 70000, g(drill, 'fl'));
  }
  if (skill === 'table-cell' && id === 'interpolated') return (descentFuel(60000, g(drill, 'fl')) + descentFuel(70000, g(drill, 'fl'))) / 2;
  if (skill === 'table-cell' && id === 'wrong-row' && rung === 3) return ff(g(drill, 'fl') + 10, roundTo(g(drill, 'startKg') - g(drill, 'fuelKg') / 2, 1000));
  if (skill === 'table-cell' && id === 'forgot-half') return ff(g(drill, 'fl'), roundTo(g(drill, 'startKg') - g(drill, 'fuelKg'), 1000));
  if (skill === 'table-cell' && id === 'start-weight') return ff(g(drill, 'fl'), g(drill, 'startKg'));
  if (skill === 'table-cell' && id === 'wrong-row') return ff(g(drill, 'fl') + 10, roundTo(g(drill, 'brakeReleaseKg') - g(drill, 'climbFuelKg'), 1000));
  if (skill === 'table-cell' && id === 'climb-ignored') return ff(g(drill, 'fl'), g(drill, 'brakeReleaseKg'));
  if (skill === 'interpolate' && (id === 'lower-column' || id === 'upper-column')) {
    const weight = g(drill, 'weightKg');
    return ff(g(drill, 'fl'), id === 'lower-column' ? weight - 1000 : weight + 1000);
  }
  if (skill === 'interpolate' && id === 'wrong-row') return ffAt(g(drill, 'fl') + 10, g(drill, 'weightKg'));
  if (skill === 'interpolate' && id === 'lower-fl') return ffAt(g(drill, 'fl') - 5, g(drill, 'weightKg'));
  if (skill === 'interpolate' && id === 'lower-weight' && rung === 2) return ffAt(g(drill, 'fl'), g(drill, 'weightKg') - 1000);
  if (skill === 'interpolate' && id === 'wrong-bracket') return (ffAt(g(drill, 'fl') + 5, g(drill, 'weightKg')) + ffAt(g(drill, 'fl') + 15, g(drill, 'weightKg'))) / 2;
  if (skill === 'interpolate' && id === 'lower-weight') return climbFuel(g(drill, 'weightKg') - 1000, g(drill, 'fl'), roundTo(g(drill, 'isaDev'), 5));
  if (skill === 'interpolate' && id === 'wrong-isa') return climbFuel(g(drill, 'weightKg'), g(drill, 'fl'), roundTo(g(drill, 'isaDev'), 5) - 5);
  if (skill === 'interpolate' && id === 'wrong-fl') return climbFuel(g(drill, 'weightKg'), g(drill, 'fl') + 10, roundTo(g(drill, 'isaDev'), 5));
  if (skill === 'isa-dev') {
    const fl = g(drill, 'fl');
    const oat = g(drill, 'oatC');
    const raw = oat - isaC(fl);
    const step = rung === 1 ? 0 : rung === 4 ? 5 : 3;
    const enter = (value: number) => (step === 0 ? value : roundTo(value, step));
    if (id === 'sign') return enter(-raw);
    if (id === 'wrong-level') return enter(oat - isaC(fl + 20));
    if (id === 'lapse') return enter(oat - (15 - 2 * (fl / 10)));
    if (id === 'sea-level') return oat - 15;
    if (id === 'unrounded') return raw;
    if (id === 'climb-step') return roundTo(raw, 5);
    if (id === 'cruise-step') return roundTo(raw, 3);
  }
  if (skill === 'tas-mach' && id === 'isa-temperature' && rung === 1) return physicsTas(g(drill, 'mach'), isaC(g(drill, 'fl')));
  if (skill === 'tas-mach' && id === 'sea-level') return seaTas(g(drill, 'mach'));
  if (skill === 'tas-mach' && id === 'mach-times-100') return g(drill, 'mach') * 100;
  if (skill === 'tas-mach' && id === 'uncorrected') return tableTas(g(drill, 'fl'), 0);
  if (skill === 'tas-mach' && id === 'wrong-fl') return tableTas(g(drill, 'fl') + 10, g(drill, 'oatC') - isaC(g(drill, 'fl')));
  if (skill === 'tas-mach' && id === 'unrounded-dev') return tableTas(g(drill, 'fl'), 0) + (g(drill, 'oatC') - isaC(g(drill, 'fl')));
  if (skill === 'tas-mach' && id === 'isa-temperature') return physicsTas(g(drill, 'mach'), isaC(g(drill, 'fl'))) * (rung === 3 ? g(drill, 'timeMin') / 60 : g(drill, 'distNm') / g(drill, 'gsKt'));
  if (skill === 'tas-mach' && id === 'minutes-as-hours' && rung === 3) return physicsTas(g(drill, 'mach'), g(drill, 'oatC')) * g(drill, 'timeMin');
  if (skill === 'tas-mach' && id === 'answered-tas') return physicsTas(g(drill, 'mach'), g(drill, 'oatC'));
  if (skill === 'tas-mach' && id === 'groundspeed-as-tas') return g(drill, 'distNm');
  if (skill === 'tas-mach' && id === 'minutes-as-hours') return physicsTas(g(drill, 'mach'), g(drill, 'oatC')) * (g(drill, 'distNm') / g(drill, 'gsKt')) * 60;
  if (skill === 'wind-component' && (rung === 1 || rung === 3)) {
    const used = triangle(g(drill, 'trackDeg'), g(drill, 'windFromDeg'), g(drill, 'windKt'));
    const offset = (g(drill, 'windFromDeg') - g(drill, 'trackDeg') + 360) % 360;
    if (id === 'sign') return -used.tail;
    if (id === 'crosswind') return used.cross;
    if (id === 'full-wind') return offset < 90 ? -g(drill, 'windKt') : g(drill, 'windKt');
  }
  if (skill === 'wind-component') {
    const mag = g(drill, 'trackDeg');
    const track = ((mag + g(drill, 'variationEast')) % 360 + 360) % 360;
    const used = triangle(track, g(drill, 'windFromDeg'), g(drill, 'windKt'));
    if (id === 'sign') return -used.tail;
    if (id === 'crosswind') return used.cross;
    if (id === 'forgot-variation') return triangle(mag, g(drill, 'windFromDeg'), g(drill, 'windKt')).tail;
  }
  if (skill === 'groundspeed' && rung === 1) {
    const head = g(drill, 'windFromDeg') === g(drill, 'trackDeg');
    if (id === 'sign') return head ? g(drill, 'tasKt') + g(drill, 'windKt') : g(drill, 'tasKt') - g(drill, 'windKt');
    if (id === 'tas-only') return g(drill, 'tasKt');
    if (id === 'wind-only') return g(drill, 'windKt');
  }
  if (skill === 'groundspeed' && rung === 4) {
    const tas = physicsTas(g(drill, 'mach'), g(drill, 'oatC'));
    const from = g(drill, 'windFromDeg');
    if (id === 'sign') return triangle(g(drill, 'trackDeg'), (from + 180) % 360, g(drill, 'windKt'), tas).gs;
    if (id === 'isa-tas') return triangle(g(drill, 'trackDeg'), from, g(drill, 'windKt'), physicsTas(g(drill, 'mach'), isaC(g(drill, 'fl')))).gs;
    if (id === 'tas-only') return tas;
  }
  if (skill === 'groundspeed') {
    const used = triangle(g(drill, 'trackDeg'), g(drill, 'windFromDeg'), g(drill, 'windKt'), g(drill, 'tasKt'));
    if (id === 'sign') return triangle(g(drill, 'trackDeg'), (g(drill, 'windFromDeg') + 180) % 360, g(drill, 'windKt'), g(drill, 'tasKt')).gs;
    if (id === 'ignored-cross') return g(drill, 'tasKt') + used.tail;
    if (id === 'full-wind') return g(drill, 'tasKt') + g(drill, 'windKt');
  }
  if (skill === 'zone-time' && id === 'hours' && rung === 1) return g(drill, 'distNm') / g(drill, 'gsKt');
  if (skill === 'zone-time' && id === 'times-sixty') return right * 60;
  if (skill === 'zone-time' && id === 'tas-not-gs') return g(drill, 'distNm') / g(drill, 'tasKt') * 60;
  if (skill === 'zone-time' && id === 'hours' && rung === 2) return g(drill, 'distNm') / (g(drill, 'tasKt') + g(drill, 'tailKt'));
  if (skill === 'zone-time' && id === 'ignored-wind') return g(drill, 'distNm') / g(drill, 'tasKt') * 60;
  if (skill === 'zone-time' && id === 'sign' && rung === 2) return g(drill, 'distNm') / (g(drill, 'tasKt') - g(drill, 'tailKt')) * 60;
  if (skill === 'zone-time' && id === 'hours' && rung === 3) {
    const gs = triangle(g(drill, 'trackDeg'), g(drill, 'windFromDeg'), g(drill, 'windKt'), g(drill, 'tasKt')).gs;
    return g(drill, 'distNm') / gs;
  }
  if (skill === 'zone-time' && id === 'ignored-cross') return g(drill, 'distNm') / g(drill, 'tasKt') * 60;
  if (skill === 'zone-time' && id === 'sign' && rung === 3) {
    const gs = triangle(g(drill, 'trackDeg'), (g(drill, 'windFromDeg') + 180) % 360, g(drill, 'windKt'), g(drill, 'tasKt')).gs;
    return g(drill, 'distNm') / gs * 60;
  }
  if (skill === 'zone-time' && id === 'hours') return (g(drill, 'legNm') - g(drill, 'climbNm')) / (g(drill, 'tasKt') + g(drill, 'tailKt'));
  if (skill === 'zone-time' && id === 'forgot-climb') return g(drill, 'legNm') / (g(drill, 'tasKt') + g(drill, 'tailKt')) * 60;
  if (skill === 'zone-time' && id === 'sign') return (g(drill, 'legNm') - g(drill, 'climbNm')) / (g(drill, 'tasKt') - g(drill, 'tailKt')) * 60;
  if (skill === 'zone-fuel' && id === 'minutes-as-hours' && rung === 1) return g(drill, 'flowKgH') * g(drill, 'timeMin');
  if (skill === 'zone-fuel' && id === 'per-second') return g(drill, 'flowKgH') * g(drill, 'timeMin') / 3600;
  if (skill === 'zone-fuel' && rung === 2) {
    const gs = g(drill, 'tasKt') + g(drill, 'tailKt');
    const time = g(drill, 'distNm') / gs * 60;
    if (id === 'minutes-as-hours') return g(drill, 'flowKgH') * time;
    if (id === 'ignored-wind') return g(drill, 'flowKgH') * (g(drill, 'distNm') / g(drill, 'tasKt'));
  }
  if (skill === 'zone-fuel' && rung === 3) {
    const gs = triangle(g(drill, 'trackDeg'), g(drill, 'windFromDeg'), g(drill, 'windKt'), g(drill, 'tasKt')).gs;
    if (id === 'minutes-as-hours') return g(drill, 'flowKgH') * (g(drill, 'distNm') / gs * 60);
    if (id === 'tas-not-gs') return g(drill, 'flowKgH') * (g(drill, 'distNm') / g(drill, 'tasKt'));
  }
  if (skill === 'zone-fuel' && rung === 4) {
    const dist = g(drill, 'legNm') - g(drill, 'climbNm');
    const time = dist / g(drill, 'gsKt') * 60;
    if (id === 'minutes-as-hours') return g(drill, 'flowKgH') * time;
    if (id === 'forgot-climb') return g(drill, 'flowKgH') * (g(drill, 'legNm') / g(drill, 'gsKt'));
  }
  if (skill === 'mid-zone-weight' && id === 'forgot-half' && rung === 1) return g(drill, 'startKg') - g(drill, 'fuelKg');
  if (skill === 'mid-zone-weight' && id === 'quarter') return g(drill, 'startKg') - g(drill, 'fuelKg') / 4;
  if (skill === 'mid-zone-weight' && id === 'forgot-half' && rung === 2) return roundTo(g(drill, 'startKg') - g(drill, 'fuelKg'), 1000);
  if (skill === 'mid-zone-weight' && id === 'unrounded' && rung === 2) return g(drill, 'startKg') - g(drill, 'fuelKg') / 2;
  if (skill === 'mid-zone-weight' && id === 'round-2000') return roundTo(g(drill, 'startKg') - g(drill, 'fuelKg') / 2, 2000);
  if (skill === 'mid-zone-weight' && rung === 3) {
    const zone = g(drill, 'flowKgH') * g(drill, 'timeMin') / 60;
    if (id === 'forgot-half') return roundTo(g(drill, 'startKg') - zone, 1000);
    if (id === 'minutes-as-hours') return roundTo(g(drill, 'startKg') - (g(drill, 'flowKgH') * g(drill, 'timeMin')) / 2, 1000);
    if (id === 'unrounded') return g(drill, 'startKg') - zone / 2;
  }
  if (skill === 'mid-zone-weight' && rung === 4) {
    const toc = g(drill, 'brakeReleaseKg') - g(drill, 'climbFuelKg');
    if (id === 'forgot-half') return roundTo(toc - g(drill, 'zoneFuelKg'), 1000);
    if (id === 'forgot-climb') return roundTo(g(drill, 'brakeReleaseKg') - g(drill, 'zoneFuelKg') / 2, 1000);
    if (id === 'unrounded') return toc - g(drill, 'zoneFuelKg') / 2;
  }
  if (skill === 'met-level' && rung === 1 && id === 'half-height') return descentLevel(g(drill, 'cruiseFl'));
  if (skill === 'met-level' && rung === 1 && id === 'unsnapped') return Math.round((2 / 3) * g(drill, 'cruiseFl'));
  if (skill === 'met-level' && rung === 1 && id === 'cruise-level') return cruiseLevel(g(drill, 'cruiseFl'));
  if (skill === 'met-level' && rung === 2 && id === 'two-thirds') return climbLevel(g(drill, 'cruiseFl'));
  if (skill === 'met-level' && rung === 2 && id === 'unsnapped') return Math.round(g(drill, 'cruiseFl') / 2);
  if (skill === 'met-level' && rung === 2 && id === 'cruise-level') return cruiseLevel(g(drill, 'cruiseFl'));
  if (skill === 'met-level' && (rung === 3 || rung === 4)) {
    const other = rung === 3 ? descentLevel(g(drill, 'cruiseFl')) : climbLevel(g(drill, 'cruiseFl'));
    const cruise = cruiseLevel(g(drill, 'cruiseFl'));
    const at = (level: number) => {
      const wind = roundedWind(g(drill, `d${level}`), g(drill, `k${level}`));
      return triangle(g(drill, 'trackDeg'), wind.dir, wind.kt).tail;
    };
    if (id === 'half-height' || id === 'two-thirds') return at(other);
    if (id === 'cruise-level') return at(cruise);
    if (id === 'sign') return -right;
  }
  if (skill === 'etp' && id === 'reversed' && rung === 1) return etp(g(drill, 'distNm'), g(drill, 'gsBackKt'), g(drill, 'gsOnKt'));
  if (skill === 'etp' && id === 'midpoint' && rung === 1) return g(drill, 'distNm') / 2;
  if (skill === 'etp' && id === 'minutes' && rung === 1) return (right / g(drill, 'gsOnKt')) * 60;
  if (skill === 'etp' && (rung === 2 || rung === 3)) {
    const on = g(drill, 'tasOn') + g(drill, 'tail');
    const back = g(drill, 'tasOn') - g(drill, 'tail');
    if (id === 'reversed') return etp(g(drill, 'distNm'), back, on);
    if (id === 'ignored-wind') return g(drill, 'distNm') / 2;
    if (id === 'minutes') return (right / on) * 60;
  }
  if (skill === 'etp' && rung === 4) {
    const a = { d: g(drill, 'd1'), on: g(drill, 'gsOn1'), back: g(drill, 'gsBack1') };
    const b = { d: g(drill, 'd2'), on: g(drill, 'gsOn2'), back: g(drill, 'gsBack2') };
    if (id === 'first-zone') return etp(a.d, a.on, a.back);
    if (id === 'reversed') return etpTwo({ d: a.d, on: a.back, back: a.on }, { d: b.d, on: b.back, back: b.on });
    if (id === 'midpoint') return (a.d + b.d) / 2;
  }
  if (skill === 'pnr' && rung === 1) {
    if (id === 'outbound-only') return g(drill, 'fuelKg') / g(drill, 'sgrOut');
    if (id === 'return-only') return g(drill, 'fuelKg') / g(drill, 'sgrBack');
  }
  if (skill === 'pnr' && (rung === 2 || rung === 3)) {
    const out = g(drill, 'flowOut') / g(drill, 'gsOn');
    if (id === 'outbound-only') return g(drill, 'fuelKg') / out;
    if (id === 'flow-as-sgr') return g(drill, 'fuelKg') / (g(drill, 'flowOut') + g(drill, 'flowBack'));
    if (id === 'sign') return g(drill, 'fuelKg') / (g(drill, 'flowOut') / g(drill, 'gsBack') + g(drill, 'flowBack') / g(drill, 'gsOn'));
  }
  if (skill === 'pnr' && rung === 4) {
    const extra = g(drill, 'fuelKg') - (g(drill, 'sgrOut1') + g(drill, 'sgrBack1')) * g(drill, 'd1');
    if (id === 'zone-end') return g(drill, 'd1');
    if (id === 'same-sgr') return g(drill, 'd1') + extra / (g(drill, 'sgrOut1') + g(drill, 'sgrBack1'));
    if (id === 'outbound-only') return g(drill, 'd1') + extra / g(drill, 'sgrOut2');
  }
  if (skill === 'integrated-range' && rung === 1) {
    const fl = g(drill, 'fl');
    if (id === 'wrong-row') return nam(fl, g(drill, 'endKg') - 1000) - nam(fl, g(drill, 'startKg'));
    if (id === 'wrong-column') return nam(rangeColumn(fl, true), g(drill, 'endKg')) - nam(rangeColumn(fl, true), g(drill, 'startKg'));
    if (id === 'reversed') return -right;
    if (id === 'cell-as-distance') return nam(fl, 50000) - nam(fl, g(drill, 'startKg'));
  }
  if (skill === 'integrated-range' && rung === 2) {
    const fl = g(drill, 'fl');
    const other = rangeColumn(fl, false);
    const end = weightForNam(fl, nam(fl, g(drill, 'startKg')) + g(drill, 'airNm'));
    if (id === 'backward') return g(drill, 'startKg') - weightForNam(fl, nam(fl, g(drill, 'startKg')) - g(drill, 'airNm'));
    if (id === 'wrong-column') return g(drill, 'startKg') - weightForNam(other, nam(other, g(drill, 'startKg')) + g(drill, 'airNm'));
    if (id === 'nearest-row') return g(drill, 'startKg') - roundTo(end, 1000);
    if (id === 'answered-weight') return end;
  }
  if (skill === 'integrated-range' && rung === 3) {
    if (id === 'nearest-column') return nam(330, g(drill, 'endKg')) - nam(330, g(drill, 'startKg'));
    if (id === 'other-column') return nam(350, g(drill, 'endKg')) - nam(350, g(drill, 'startKg'));
    if (id === 'reversed') return -right;
  }
  if (skill === 'integrated-range' && rung === 4) {
    const fl = g(drill, 'fl');
    const other = fl === 310 ? 330 : 310;
    const start = weightForNam(fl, nam(fl, g(drill, 'endKg')) - g(drill, 'airNm'));
    if (id === 'forward') return weightForNam(fl, nam(fl, g(drill, 'endKg')) + g(drill, 'airNm')) - g(drill, 'endKg');
    if (id === 'wrong-column') return weightForNam(other, nam(other, g(drill, 'endKg')) - g(drill, 'airNm')) - g(drill, 'endKg');
    if (id === 'answered-weight') return start;
  }
  if (skill === 'specific-range' && id === 'kg-per-min' && rung === 1) return g(drill, 'fuelKg') / g(drill, 'timeMin');
  if (skill === 'specific-range' && id === 'inverted') return g(drill, 'distNm') / g(drill, 'fuelKg');
  if (skill === 'specific-range' && id === 'kg-per-nm') return g(drill, 'fuelKg') / g(drill, 'distNm');
  if (skill === 'specific-range' && id === 'per-hour') return g(drill, 'fuelKg') / (g(drill, 'timeMin') / 60);
  if (skill === 'specific-range' && id === 'kg-per-min') return g(drill, 'flowKgH') / 60;
  if (skill === 'specific-range' && id === 'thumb-ten') return 10;
  if (skill === 'specific-range' && id === 'flow-as-answer') return g(drill, 'flowKgH');
  if (skill === 'specific-range' && id === 'no-climb') return g(drill, 'distNm') * 10;
  if (skill === 'specific-range' && id === 'double-climb') return g(drill, 'distNm') * 10 + 3200;
  if (skill === 'cg-shift' && rung === 1) {
    const arm = compArm(g(drill, 'compartment'));
    if (id === 'with-offset') return right + 100;
    if (id === 'forgot-divisor') return g(drill, 'weightKg') * (arm - TABLES.balance.indexUnit.referenceArmM);
    if (id === 'wrong-arm') return indexUnits(g(drill, 'weightKg'), compArm(NEXT[g(drill, 'compartment')]!));
  }
  if (skill === 'cg-shift' && rung === 2) {
    const index = totalIndex(g(drill, 'weightKg'), g(drill, 'mac')) + indexUnits(g(drill, 'addKg'), compArm(g(drill, 'compartment')));
    const wrong = totalIndex(g(drill, 'weightKg'), g(drill, 'mac')) + indexUnits(g(drill, 'addKg'), compArm(NEXT[g(drill, 'compartment')]!));
    if (id === 'old-weight') return macFrom(g(drill, 'weightKg'), index);
    if (id === 'wrong-arm') return macFrom(g(drill, 'weightKg') + g(drill, 'addKg'), wrong);
    if (id === 'index-not-mac') return index;
  }
  if (skill === 'cg-shift' && rung === 3) {
    const delta = indexUnits(g(drill, 'moveKg'), compArm(1)) - indexUnits(g(drill, 'moveKg'), compArm(5));
    const index = totalIndex(g(drill, 'weightKg'), g(drill, 'mac')) + delta;
    if (id === 'reversed') return macFrom(g(drill, 'weightKg'), totalIndex(g(drill, 'weightKg'), g(drill, 'mac')) - delta);
    if (id === 'index-not-mac') return index;
    if (id === 'wrong-arm') return macFrom(g(drill, 'weightKg'), totalIndex(g(drill, 'weightKg'), g(drill, 'mac')) + indexUnits(g(drill, 'moveKg'), compArm(2)) - indexUnits(g(drill, 'moveKg'), compArm(5)));
  }
  if (skill === 'cg-shift' && rung === 4) {
    const people = g(drill, 'adults') * TABLES.balance.standardWeights.adult;
    const index = g(drill, 'basicIndex') + indexUnits(people, zone('A')) + indexUnits(g(drill, 'freightKg'), compArm(g(drill, 'compartment')));
    if (id === 'wrong-zone') return macFrom(g(drill, 'basicKg') + people + g(drill, 'freightKg'), g(drill, 'basicIndex') + indexUnits(people, zone('B')) + indexUnits(g(drill, 'freightKg'), compArm(g(drill, 'compartment'))));
    if (id === 'wrong-arm') return macFrom(g(drill, 'basicKg') + people + g(drill, 'freightKg'), g(drill, 'basicIndex') + indexUnits(people, zone('A')) + indexUnits(g(drill, 'freightKg'), compArm(NEXT[g(drill, 'compartment')]!)));
    if (id === 'index-not-mac') return index;
  }
  throw new Error(`${drill.skill} rung ${drill.rung} has no crafted value for ${id}`);
}

const EXPECTED: Record<string, Record<number, string[]>> = {
  'table-cell': { 1: ['wrong-row', 'wrong-column', 'isa-corrected', 'kilograms-as-pounds'], 2: ['wrong-row', 'wrong-column', 'interpolated'], 3: ['wrong-row', 'forgot-half', 'start-weight'], 4: ['wrong-row', 'climb-ignored', 'kilograms-as-pounds'] },
  interpolate: { 1: ['lower-column', 'upper-column', 'wrong-row', 'kilograms-as-pounds'], 2: ['lower-fl', 'lower-weight', 'wrong-bracket', 'kilograms-as-pounds'], 3: ['lower-column', 'upper-column', 'wrong-row'], 4: ['lower-weight', 'wrong-isa', 'wrong-fl'] },
  'isa-dev': { 1: ['sign', 'wrong-level', 'lapse', 'sea-level'], 2: ['sign', 'wrong-level', 'lapse', 'unrounded', 'climb-step'], 3: ['sign', 'wrong-level', 'lapse', 'unrounded', 'climb-step'], 4: ['sign', 'wrong-level', 'lapse', 'unrounded', 'cruise-step'] },
  'tas-mach': { 1: ['isa-temperature', 'sea-level', 'mach-times-100'], 2: ['uncorrected', 'wrong-fl', 'unrounded-dev'], 3: ['isa-temperature', 'minutes-as-hours', 'answered-tas'], 4: ['groundspeed-as-tas', 'isa-temperature', 'minutes-as-hours'] },
  'wind-component': { 1: ['sign', 'crosswind', 'full-wind'], 2: ['sign', 'crosswind', 'forgot-variation'], 3: ['sign', 'crosswind', 'full-wind'], 4: ['sign', 'crosswind', 'forgot-variation'] },
  groundspeed: { 1: ['sign', 'tas-only', 'wind-only'], 2: ['sign', 'ignored-cross', 'full-wind'], 3: ['sign', 'ignored-cross', 'full-wind'], 4: ['sign', 'isa-tas', 'tas-only'] },
  'zone-time': { 1: ['hours', 'times-sixty', 'tas-not-gs'], 2: ['hours', 'ignored-wind', 'sign'], 3: ['hours', 'ignored-cross', 'sign'], 4: ['hours', 'forgot-climb', 'sign'] },
  'zone-fuel': { 1: ['minutes-as-hours', 'per-second', 'kilograms-as-pounds'], 2: ['minutes-as-hours', 'ignored-wind', 'kilograms-as-pounds'], 3: ['minutes-as-hours', 'tas-not-gs', 'kilograms-as-pounds'], 4: ['minutes-as-hours', 'forgot-climb', 'kilograms-as-pounds'] },
  'mid-zone-weight': { 1: ['forgot-half', 'quarter', 'kilograms-as-pounds'], 2: ['forgot-half', 'unrounded', 'round-2000'], 3: ['forgot-half', 'minutes-as-hours', 'unrounded'], 4: ['forgot-half', 'forgot-climb', 'unrounded'] },
  'met-level': { 1: ['half-height', 'unsnapped', 'cruise-level'], 2: ['two-thirds', 'unsnapped', 'cruise-level'], 3: ['half-height', 'cruise-level', 'sign'], 4: ['two-thirds', 'cruise-level', 'sign'] },
  etp: { 1: ['reversed', 'midpoint', 'minutes'], 2: ['reversed', 'ignored-wind', 'minutes'], 3: ['reversed', 'ignored-wind', 'minutes'], 4: ['first-zone', 'reversed', 'midpoint'] },
  pnr: { 1: ['outbound-only', 'return-only', 'kilograms-as-pounds'], 2: ['outbound-only', 'flow-as-sgr', 'kilograms-as-pounds'], 3: ['outbound-only', 'flow-as-sgr', 'sign'], 4: ['zone-end', 'same-sgr', 'outbound-only'] },
  'integrated-range': { 1: ['wrong-row', 'wrong-column', 'reversed', 'cell-as-distance'], 2: ['backward', 'wrong-column', 'nearest-row', 'answered-weight'], 3: ['nearest-column', 'other-column', 'reversed'], 4: ['forward', 'wrong-column', 'answered-weight'] },
  'specific-range': { 1: ['kg-per-min', 'inverted', 'kilograms-as-pounds'], 2: ['kg-per-nm', 'per-hour', 'kilograms-as-pounds'], 3: ['kg-per-min', 'thumb-ten', 'flow-as-answer'], 4: ['no-climb', 'double-climb', 'kilograms-as-pounds'] },
  'cg-shift': { 1: ['with-offset', 'forgot-divisor', 'wrong-arm'], 2: ['old-weight', 'wrong-arm', 'index-not-mac'], 3: ['reversed', 'index-not-mac', 'wrong-arm'], 4: ['wrong-zone', 'wrong-arm', 'index-not-mac'] },
};

test('published integrated-range cells differ by the air distance', () => {
  const ir = TABLES.cruise.integratedRange;
  const row = ir.nam[ir.fl.indexOf(330)]!;
  const at = (kg: number) => row[ir.weightsKg.indexOf(kg)]!;
  assert.equal(at(80000), 495);
  assert.equal(at(70000), 1458);
  assert.equal(at(70000) - at(80000), 963);
});

for (const skill of SKILLS) {
  test(`${skill.name} recomputes and each diagnosis fires`, () => {
    assert.equal(skill.id in EXPECTED, true, skill.id);
    for (const seed of [1, 2, 3]) {
      for (const rung of [1, 2, 3, 4] as const) {
        const drill = skill.generate(seed, rung);
        const expected = answerOf(drill);
        assert.ok(
          Math.abs(drill.answer - expected) <= Math.max(drill.tolerance, 1e-6),
          `${drill.id} answer ${drill.answer} vs ${expected} given ${JSON.stringify(drill.given)}`,
        );
        const wanted = EXPECTED[skill.id]![rung]!;
        let checked = 0;
        for (const id of wanted) {
          const wrong = wrongOf(drill, id);
          if (!Number.isFinite(wrong) || Math.abs(wrong - drill.answer) <= drill.tolerance) continue;
          const hit = diagnose({ value: drill.answer, tolerance: drill.tolerance, diagnoses: drill.diagnoses }, wrong);
          assert.equal(hit?.id, id, `${drill.id} ${id}: crafted ${wrong}, answer ${drill.answer}, diagnosed ${hit?.id ?? 'none'} ${JSON.stringify(drill.given)}`);
          checked += 1;
        }
        assert.ok(checked >= 2, `${drill.id} only diagnosed ${checked} misses`);
        const card = toCard(drill);
        assert.deepEqual(validateCard(card, concepts, sources), [], drill.id);
        assert.deepEqual(lintCard(card), [], drill.id);
      }
    }
  });
}

test('the drill bank is stable and the preview cards exist', () => {
  const cards = drillCards();
  assert.equal(cards.length, SKILLS.length * 4);
  assert.equal(new Set(cards.map((card) => card.id)).size, cards.length);
  for (const id of PREVIEW_DRILLS) assert.ok(cards.some((card) => card.id === id), id);
  for (const card of cards) {
    assert.equal(card.kind, 'numeric');
    assert.ok(card.numeric);
    assert.deepEqual(validateCard(card, concepts, sources), [], card.id);
    assert.deepEqual(lintCard(card), [], card.id);
  }
});

test('a numeric card submits on the answer and shows its tolerance', () => {
  const drill = SKILLS[0]!.generate(1, 1);
  const card = toCard(drill);
  const session = openSession([card.id], 'all', 1_000);
  const answered = reduce(session, { type: 'answer', text: String(drill.answer) }, card);
  assert.equal(answered.session.phase, 'revealed');
  assert.equal(answered.session.selected, String(drill.answer));
  const shell = (phase: 'ask' | 'revealed', selected: string | null): string => renderShell({
    page: 'review',
    mode: 'performance',
    card,
    phase,
    selected,
    done: 0,
    due: 1,
    profileDue: 0,
    retentionPct: 0,
    streak: 0,
    snapshot: null,
    sources,
    cards: [card],
    overlay: 'none',
    flagDraft: '',
    flagged: false,
    shortcuts: [],
  } satisfies RenderInput);
  const ask = shell('ask', '');
  assert.ok(ask.includes('data-numeric'), 'input');
  assert.ok(ask.includes(drill.unit), 'unit');
  assert.ok(ask.includes('data-numeric-submit'), 'submit');
  const revealed = shell('revealed', String(drill.answer));
  assert.ok(revealed.includes('±'), 'tolerance');
  assert.ok(revealed.includes(drill.unit), 'unit on reveal');
  assert.ok(revealed.includes(drill.method.slice(0, 24)), 'worked method');
  assert.ok(revealed.includes(drill.thumb.slice(0, 16)), 'rule of thumb');
});
