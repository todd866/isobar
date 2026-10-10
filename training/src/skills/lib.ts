/** Shared draws and table reads for the part-task generators.
 * The tests recompute from `given` and do not call this file. */

import {
  RSWT_LEVELS,
  TABLES,
  climbMetLevel,
  descentMetLevel,
  etpDistanceNm,
  etpMultiZone,
  interpolate,
  isaDevForClimb,
  isaDevForCruise,
  landingWeightColumn,
  metLevelFor,
  pnrDistanceNm,
  roundFuel,
  roundTo,
  roundWind,
  weightEntry,
  type MetGrid,
} from '../b727/engine.ts';
import { fmt } from './format.ts';
import type { Diagnosis, Drill, Rung } from './types.ts';
import type { FigureTable, Span, WorkStep } from '../figure.ts';
import { diagramFor } from './diagrams.ts';

export const LB = 2.2;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

export function miss(id: string, skill: string, note: string, detail: string, value: number): Diagnosis {
  return { id, skill, note, detail, value };
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function separable(answer: number, tolerance: number, diagnoses: Diagnosis[]): boolean {
  for (let i = 0; i < diagnoses.length; i++) {
    for (let j = i + 1; j < diagnoses.length; j++) {
      const a = diagnoses[i]!.value;
      const b = diagnoses[j]!.value;
      const scale = Math.max(1, Math.abs(a), Math.abs(b));
      if (Math.abs(a - b) <= Math.max(tolerance, scale * 1e-6, 1e-4)) return false;
    }
  }
  return true;
}

export function pack(seed: number, drill: Omit<Drill, 'id' | 'diagnoses'> & { diagnoses: Diagnosis[] }): Drill | null {
  const banned = /\b(snapshot|run|product|bucket)\b/i;
  const diagnoses: Diagnosis[] = [];
  for (const item of drill.diagnoses) {
    if (!Number.isFinite(item.value)) continue;
    if (Math.abs(item.value - drill.answer) <= drill.tolerance) continue;
    if (diagnoses.some((have) => have.id === item.id)) continue;
    diagnoses.push(item);
  }
  if (!Number.isFinite(drill.answer) || diagnoses.length < 2) return null;
  if (!separable(drill.answer, drill.tolerance, diagnoses)) return null;
  const stem = drill.stem.trim();
  if (!stem.endsWith('?') || words(stem) < 8) return null;
  if ([stem, drill.method, drill.thumb].some((text) => text.includes('…') || text.includes('...') || banned.test(text))) return null;
  if (!drill.figure.lines.length || !drill.figure.highlight.length) return null;
  for (const needle of drill.figure.highlight) {
    if (!drill.figure.lines.some((line) => line.includes(needle))) return null;
  }
  const diagram = diagramFor(drill);
  return { ...drill, figure: { ...drill.figure, ...(diagram ? { diagram } : {}) }, stem, diagnoses, id: `${drill.skill}.r${drill.rung}.${seed}` };
}

export function generateSkill(
  id: string,
  seed: number,
  rung: Rung,
  build: (rand: () => number) => Drill | null,
): Drill {
  for (let k = 0; k < 60; k++) {
    const rand = mulberry32((Math.imul(seed + 1, 0x9e3779b1) + k * 9973 + rung * 131) >>> 0);
    try {
      const drill = build(rand);
      if (drill) return drill;
    } catch {
      // This draw fell off a table. Try another.
    }
  }
  throw new Error(`${id} rung ${rung} seed ${seed} produced no separable drill`);
}

// --- cruise fuel flow -------------------------------------------------------

interface Cell { fl: number; weightKg: number; ff: number }

let interior: Cell[] | null = null;

export function cruiseCells(): Cell[] {
  if (interior) return interior;
  const fls = TABLES.cruise.m080.fl;
  const ws = TABLES.cruise.weightsKg;
  const grid = TABLES.cruise.m080.ff;
  const out: Cell[] = [];
  for (let i = 1; i < fls.length - 1; i++) {
    for (let j = 1; j < ws.length - 1; j++) {
      const ff = grid[i]?.[j];
      if (ff == null) continue;
      const neighbours = [grid[i + 1]?.[j], grid[i - 1]?.[j], grid[i]?.[j + 1], grid[i]?.[j - 1]];
      if (neighbours.every((value) => value != null)) out.push({ fl: fls[i]!, weightKg: ws[j]!, ff });
    }
  }
  interior = out;
  return out;
}

export function ffAt(fl: number, weightKg: number): number | null {
  const fls = TABLES.cruise.m080.fl;
  const ws = TABLES.cruise.weightsKg;
  const fi = fls.indexOf(fl);
  const wi = ws.indexOf(weightKg);
  if (fi < 0 || wi < 0) return null;
  return TABLES.cruise.m080.ff[fi]?.[wi] ?? null;
}

export function ffInterp(fl: number, weightKg: number): number {
  const fls = TABLES.cruise.m080.fl;
  const ws = TABLES.cruise.weightsKg;
  const exact = fls.indexOf(fl);
  if (exact >= 0) {
    const value = interpolate(ws, TABLES.cruise.m080.ff[exact]!, weightKg);
    if (value == null) throw new Error(`no fuel flow at FL${fl}`);
    return value;
  }
  let i = 1;
  while (i < fls.length && fl > fls[i]!) i++;
  if (i <= 0 || i >= fls.length) throw new Error(`FL${fl} outside the cruise table`);
  const lo = interpolate(ws, TABLES.cruise.m080.ff[i - 1]!, weightKg);
  const hi = interpolate(ws, TABLES.cruise.m080.ff[i]!, weightKg);
  if (lo == null || hi == null) throw new Error(`no fuel flow near FL${fl}`);
  const f = (fl - fls[i - 1]!) / (fls[i]! - fls[i - 1]!);
  return lo + f * (hi - lo);
}

export function isaFlow(ff: number, dev: number): number {
  const step = isaDevForCruise(dev);
  const per = TABLES.cruise.m080.corrections.ffPercentPer3C;
  return ff * (1 + (per / 100) * (step / 3));
}

/** Up to `pad` neighbours either side of the index range [lo, hi] of `axis`. */
export function windowOf<T>(axis: readonly T[], lo: number, hi: number, pad: number): T[] {
  return axis.slice(Math.max(0, lo - pad), Math.min(axis.length, hi + pad + 1));
}

function tons(kg: number): string {
  return fmt(kg / 1000, 0);
}

/** Plain-text rows for validation and screen readers; `highlight` names the used rows. */
function tableLines(table: FigureTable): { lines: string[]; highlight: string[] } {
  const lines = table.rows.map((row) => `${row.label}  ${row.cells.map((cell) => (cell == null ? '—' : fmt(cell, table.decimals))).join('  ')}`);
  const rows = [...new Set(table.used.map(([row]) => row))];
  return { lines: [`${table.corner}  ${table.columns.join('  ')}  (${table.group})`, ...lines], highlight: rows.map((row) => lines[row]!) };
}

export interface TableFigure { title: string; lines: string[]; highlight: string[]; table: FigureTable }

function figureOf(table: FigureTable): TableFigure {
  return { title: `${table.label} ${table.title}, ${table.unit}`, ...tableLines(table), table };
}

/** Table 3.1, M 0.80 fuel flow: levels down the side, gross weight across. */
export function ffTable(fls: number[], weights: number[], used: [number, number][], spans?: Span[]): TableFigure {
  const rows = fls
    .map((fl) => ({ label: `FL${fl}`, cells: weights.map((w) => ffAt(fl, w)) }))
    .filter((row) => row.cells.some((cell) => cell != null));
  const labels = rows.map((row) => row.label);
  const cells: [number, number][] = used.map(([fl, w]) => [labels.indexOf(`FL${fl}`), weights.indexOf(w)]);
  if (cells.some(([r, c]) => r < 0 || c < 0 || rows[r]!.cells[c] == null)) throw new Error('used cell outside the table');
  return figureOf({
    label: 'Table 3.1',
    title: 'M 0.80 fuel flow',
    unit: 'kg/h',
    corner: 'FL',
    group: 'Gross weight (t)',
    columns: weights.map(tons),
    rows,
    decimals: 0,
    used: cells,
    ...(spans ? { spans } : {}),
  });
}

/** The fuel-flow window around one level and a weight bracket. */
export function ffWindow(fl: number, wLo: number, wHi: number, flHi = fl, rowPad = 2, colPad = 1): { fls: number[]; weights: number[] } {
  const fls = TABLES.cruise.m080.fl;
  const ws = TABLES.cruise.weightsKg;
  return {
    fls: windowOf(fls, fls.indexOf(fl), fls.indexOf(flHi), rowPad),
    weights: windowOf(ws, ws.indexOf(wLo), ws.indexOf(wHi), colPad),
  };
}

export function span(axis: Span['axis'], from: string, to: string, at: string, low: number, high: number, fraction: number): Span {
  return { axis, from, to, at, low, high, fraction, result: low + fraction * (high - low) };
}

export function step(id: string, label: string, detail: string, value: number, unit: string, decimals = 0, tolerance?: number): WorkStep {
  return { id, label, detail, value, unit, decimals, tolerance: tolerance ?? (decimals === 0 ? 0.5 : 0.5 * 10 ** -decimals) };
}

export { tons };

// --- descent and climb ------------------------------------------------------

export function descentFuel(landingKg: number, fl: number): number {
  const t = TABLES.descent;
  const col = Math.max(t.landingWeightKg[0]!, Math.min(t.landingWeightKg.at(-1)!, landingWeightColumn(landingKg)));
  const wi = t.landingWeightKg.indexOf(col);
  const fi = t.fl.indexOf(fl);
  return t.table[wi]![fi]!.f;
}

export function climbFuel(weightKg: number, fl: number, isaDev: number): number {
  const t = TABLES.climb;
  const dev = Math.max(t.isaDev[0]!, Math.min(t.isaDev.at(-1)!, isaDevForClimb(isaDev)));
  const di = t.isaDev.indexOf(dev);
  const fi = t.fl.indexOf(fl);
  const row = t.table[di]![fi]!.map((cell) => (cell ? cell.f : null));
  const value = interpolate(t.brakeReleaseKg, row, weightKg);
  if (value == null) throw new Error(`no climb fuel at ${weightKg} kg FL${fl}`);
  return roundFuel(value);
}

/** Table 4.1, descent fuel: levels down the side, landing weight across. */
export function descentTable(fls: number[], used: [number, number][]): TableFigure {
  const t = TABLES.descent;
  const weights = t.landingWeightKg;
  const rows = fls.map((fl) => ({ label: `FL${fl}`, cells: weights.map((w) => descentFuel(w, fl)) }));
  const labels = rows.map((row) => row.label);
  return figureOf({
    label: 'Table 4.1',
    title: 'Descent fuel',
    unit: 'kg',
    corner: 'FL',
    group: 'Landing weight (t)',
    columns: weights.map(tons),
    rows,
    decimals: 0,
    used: used.map(([fl, w]) => [labels.indexOf(`FL${fl}`), weights.indexOf(w)]),
  });
}

/** The raw climb-fuel cell, before interpolation. */
export function climbCell(weightKg: number, fl: number, isaUsed: number): number | null {
  const t = TABLES.climb;
  const di = t.isaDev.indexOf(isaUsed);
  const fi = t.fl.indexOf(fl);
  const wi = t.brakeReleaseKg.indexOf(weightKg);
  if (di < 0 || fi < 0 || wi < 0) return null;
  return t.table[di]?.[fi]?.[wi]?.f ?? null;
}

function signed(dev: number): string {
  return dev === 0 ? 'ISA' : `ISA${dev > 0 ? '+' : '−'}${Math.abs(dev)}`;
}

/** Table 2.1, climb fuel to one level: ISA deviation down the side, brake-release weight across. */
export function climbTable(fl: number, devs: number[], weights: number[], used: [number, number][], spans?: Span[]): TableFigure {
  const rows = devs.map((dev) => ({ label: signed(dev), cells: weights.map((w) => climbCell(w, fl, dev)) }));
  const labels = rows.map((row) => row.label);
  return figureOf({
    label: 'Table 2.1',
    title: `Climb to FL${fl}, fuel`,
    unit: 'kg',
    corner: 'Temp',
    group: 'Brake-release weight (t)',
    columns: weights.map(tons),
    rows,
    decimals: 0,
    used: used.map(([dev, w]) => [labels.indexOf(signed(dev)), weights.indexOf(w)]),
    ...(spans ? { spans } : {}),
  });
}

// --- atmosphere -------------------------------------------------------------

export function isaC(fl: number): number {
  const hM = fl * 100 * 0.3048;
  const tK = hM < 11000 ? 288.15 - 0.0065 * hM : 216.65;
  return tK - 273.15;
}

export function lapseC(fl: number): number {
  return 15 - 2 * (fl / 10);
}

export function physicsTas(mach: number, oatC: number): number {
  const a = Math.sqrt(1.4 * 287.05287 * (oatC + 273.15));
  return (mach * a) / 0.514444;
}

export function tableTas(fl: number, isaDev: number): number {
  const i = TABLES.cruise.m080.fl.indexOf(fl);
  if (i < 0) throw new Error(`no M 0.80 TAS at FL${fl}`);
  return TABLES.cruise.m080.tasIsa[i]! + TABLES.cruise.m080.corrections.tasKtPerC * isaDevForCruise(isaDev);
}

export function seaLevelTas(mach: number): number {
  const a = Math.sqrt(1.4 * 287.05287 * 288.15);
  return (mach * a) / 0.514444;
}

// --- wind -------------------------------------------------------------------

export function triangle(trackDeg: number, windFromDeg: number, windKt: number, tasKt = 0): { tail: number; cross: number; gs: number } {
  const rel = ((windFromDeg - trackDeg) * Math.PI) / 180;
  const tail = -windKt * Math.cos(rel);
  const cross = windKt * Math.sin(rel);
  const gs = tasKt > 0 ? Math.sqrt(Math.max(0, tasKt * tasKt - cross * cross)) + tail : 0;
  return { tail, cross, gs };
}

export function trueTrack(magDeg: number, variationEast: number): number {
  return ((magDeg + variationEast) % 360 + 360) % 360;
}

// --- integrated range -------------------------------------------------------

export function namAt(fl: number, weightKg: number): number {
  const ir = TABLES.cruise.integratedRange;
  const exactFl = ir.fl.indexOf(fl);
  if (exactFl >= 0) {
    const value = interpolate(ir.weightsKg, ir.nam[exactFl]!, weightKg);
    if (value == null) throw new Error('nam');
    return value;
  }
  let i = 1;
  while (i < ir.fl.length && fl > ir.fl[i]!) i++;
  const lo = interpolate(ir.weightsKg, ir.nam[i - 1]!, weightKg);
  const hi = interpolate(ir.weightsKg, ir.nam[i]!, weightKg);
  if (lo == null || hi == null) throw new Error('nam');
  const f = (fl - ir.fl[i - 1]!) / (ir.fl[i]! - ir.fl[i - 1]!);
  return lo + f * (hi - lo);
}

/** Reference number: nam still to go down to 50 t. Heavier weight, larger R. */
export function reference(fl: number, weightKg: number): number {
  return namAt(fl, 50000) - namAt(fl, weightKg);
}

export function airDistance(fl: number, startKg: number, endKg: number): number {
  return reference(fl, startKg) - reference(fl, endKg);
}

export function weightForNam(fl: number, target: number): number {
  const ws = TABLES.cruise.integratedRange.weightsKg;
  const curve = ws.map((w) => namAt(fl, w));
  for (let i = 0; i < ws.length - 1; i++) {
    const hi = curve[i]!;
    const lo = curve[i + 1]!;
    if (target <= hi + 1e-6 && target >= lo - 1e-6) {
      const f = (hi - target) / (hi - lo);
      return ws[i]! + f * (ws[i + 1]! - ws[i]!);
    }
  }
  throw new Error(`nam ${target} is off the FL${fl} range curve`);
}

// --- balance ----------------------------------------------------------------

export function indexUnits(weightKg: number, armM: number): number {
  const b = TABLES.balance.indexUnit;
  return (weightKg * (armM - b.referenceArmM)) / b.divisor;
}

export function armOfMac(mac: number): number {
  const b = TABLES.balance.mac;
  return b.lemacM + (mac / 100) * b.macM;
}

export function macOfArm(armM: number): number {
  const b = TABLES.balance.mac;
  return ((armM - b.lemacM) / b.macM) * 100;
}

export function macFromIndex(weightKg: number, totalIndex: number): number {
  const b = TABLES.balance.indexUnit;
  const arm = b.referenceArmM + ((totalIndex - b.offset) * b.divisor) / weightKg;
  return macOfArm(arm);
}

export function compartmentArm(id: number): number {
  const comp = TABLES.balance.compartments[String(id) as '1'];
  if (!comp) throw new Error(`compartment ${id}`);
  return comp.armM;
}

export function zoneArm(id: string): number {
  const zone = TABLES.balance.zones[id as 'A'];
  if (!zone) throw new Error(`zone ${id}`);
  return zone.armM;
}

// --- met levels -------------------------------------------------------------

export function forecastGrid(winds: Record<number, { dir: number; kt: number }>): MetGrid {
  const wind: Record<number, { dirT: number; kt: number }> = {};
  const isaDev: Record<number, number> = {};
  for (const level of RSWT_LEVELS) {
    const sample = winds[level];
    if (!sample) throw new Error(`no wind at FL${level}`);
    wind[level] = { dirT: sample.dir, kt: sample.kt };
    isaDev[level] = 0;
  }
  return { levels: [...RSWT_LEVELS], columns: [{ name: 'A', wind, isaDev }] };
}

export function levelWind(grid: MetGrid, level: number): { dir: number; kt: number } {
  const raw = grid.columns[0]!.wind[level];
  if (!raw) throw new Error(`no wind at FL${level}`);
  return roundWind(raw.dirT, raw.kt);
}

export { RSWT_LEVELS, climbMetLevel, descentMetLevel, metLevelFor, roundTo, weightEntry, isaDevForClimb, isaDevForCruise, etpDistanceNm, etpMultiZone, pnrDistanceNm, TABLES };
