/**
 * Display units. Stored weather stays in hPa, °C, knots, metres and millimetres.
 * Everything a person reads is converted here. Missing stays missing.
 */

import { ICAO_REGION, regionAt, type RegionRow } from './units-regions';

export type UnitMode = 'aus' | 'us' | 'local';

export interface UnitSpec {
  mode: UnitMode;
  pressure: 'hPa' | 'inHg';
  temp: 'C' | 'F';
  wind: 'kt';
  height: 'ft' | 'm';
  visibility: 'km' | 'sm';
  rain: 'mm' | 'in';
  flightLevel: 'ft' | 'metric';
  /** Geopotential feet at which flight-level labels begin. */
  transitionFt: number;
}

export interface DisplayUnits extends UnitSpec {
  id: string;
  label: 'AUS' | 'US' | 'LOCAL';
  uncertain: boolean;
  transitionUncertain: boolean;
}

/** International foot. */
export const METRES_PER_FOOT = 0.3048;
export const FEET_PER_METRE = 1 / METRES_PER_FOOT;
export const METRES_PER_STATUTE_MILE = 1609.344;
export const MM_PER_INCH = 25.4;
/** inHg = hPa × this factor, then rounded to 2 decimal places. */
export const INHG_PER_HPA = 0.02953;

export const AUS_UNITS: DisplayUnits = {
  mode: 'aus', id: 'aus', label: 'AUS',
  pressure: 'hPa', temp: 'C', wind: 'kt', height: 'ft', visibility: 'km', rain: 'mm',
  flightLevel: 'ft', transitionFt: 10000,
  uncertain: false, transitionUncertain: false,
};

export const US_UNITS: DisplayUnits = {
  mode: 'us', id: 'us', label: 'US',
  pressure: 'inHg', temp: 'F', wind: 'kt', height: 'ft', visibility: 'sm', rain: 'in',
  flightLevel: 'ft', transitionFt: 18000,
  uncertain: false, transitionUncertain: false,
};

export function hPaToInHg(hPa: number): number {
  return Math.round(hPa * INHG_PER_HPA * 100) / 100;
}

export function cToF(celsius: number): number {
  return celsius * 9 / 5 + 32;
}

export function metresToFeet(metres: number): number {
  return metres * FEET_PER_METRE;
}

export function feetToMetres(feet: number): number {
  return feet * METRES_PER_FOOT;
}

export function metresToStatuteMiles(metres: number): number {
  return metres / METRES_PER_STATUTE_MILE;
}

export function mmToInches(mm: number): number {
  return mm / MM_PER_INCH;
}

/** ISA pressure altitude in metres. Same expression the foot flight level uses. */
export function pressureAltitudeMetres(hPa: number): number {
  if (!(hPa > 0)) return Number.NaN;
  return hPa >= 226.32
    ? 44330.77 * (1 - (hPa / 1013.25) ** 0.190263)
    : 11000 - 6341.62 * Math.log(hPa / 226.32);
}

/**
 * Metric flight level. Round to the nearest 10 m, then encode tens of metres
 * as S plus four digits: 9,200 m → S0920. Feet is that rounded level.
 */
export function metricFlightLevel(metres: number): { metres: number; code: string; feet: number } | null {
  if (!Number.isFinite(metres)) return null;
  const rounded = Math.round(metres / 10) * 10;
  const code = `S${String(Math.round(rounded / 10)).padStart(4, '0')}`;
  return { metres: rounded, code, feet: Math.round(rounded * FEET_PER_METRE) };
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/**
 * Isobar text is the number only: `1013` or `29.92`. The unit is one legend
 * chip, not a suffix on every line.
 */
export function formatIsobar(hPa: number, units: UnitSpec): string {
  if (!Number.isFinite(hPa)) return '';
  if (units.pressure === 'inHg') return hPaToInHg(hPa).toFixed(2);
  return String(Math.round(hPa));
}

/** One pressure reading. inHg names its unit; hPa stays the bare number. */
export function formatPressureHpa(hPa: number | null | undefined, units: UnitSpec): string | null {
  if (!finite(hPa)) return null;
  const value = formatIsobar(hPa, units);
  return units.pressure === 'inHg' ? `${value} inHg` : value;
}

/** Header style is `20°` / `68°F`. Signed with a unit letter is `+19°C`. */
export function formatTempC(
  celsius: number | null | undefined,
  units: UnitSpec,
  opts?: { signed?: boolean; unit?: boolean },
): string | null {
  if (!finite(celsius)) return null;
  const value = units.temp === 'F' ? cToF(celsius) : celsius;
  const n = Math.round(value);
  const body = opts?.signed && n > 0 ? `+${n}` : String(n);
  const mark = units.temp === 'F' || opts?.unit ? (units.temp === 'F' ? '°F' : '°C') : '°';
  return `${body}${mark}`;
}

/** Dry under 0.2 mm stays blank, in either rain unit. */
export function formatRainMm(mm: number | null | undefined, units: UnitSpec): string | null {
  if (!finite(mm) || mm < 0.2) return null;
  if (units.rain === 'in') {
    const inches = mmToInches(mm);
    return inches >= 1 ? inches.toFixed(1) : inches.toFixed(2);
  }
  return mm >= 10 ? String(Math.round(mm)) : mm.toFixed(1);
}

/** Legend stops always print, including a dry amount. */
export function formatRainAmount(mm: number, units: UnitSpec): string {
  if (!Number.isFinite(mm)) return '';
  if (units.rain === 'in') {
    const inches = mmToInches(mm);
    return inches >= 10 ? String(Math.round(inches)) : inches >= 1 ? inches.toFixed(1) : inches.toFixed(2);
  }
  return mm >= 10 ? String(Math.round(mm)) : String(mm);
}

export function formatVisibilityMetres(metres: number | null | undefined, units: UnitSpec): string | null {
  if (!finite(metres)) return null;
  if (units.visibility === 'sm') {
    if (metres >= 9999) return `${(9999 / METRES_PER_STATUTE_MILE).toFixed(1)}+ SM`;
    const sm = metres / METRES_PER_STATUTE_MILE;
    return sm >= 10 ? `${Math.round(sm)} SM` : `${sm.toFixed(1)} SM`;
  }
  if (metres >= 9999) return '10+ km';
  return metres >= 5000 ? `${metres / 1000} km` : `${metres.toLocaleString('en-AU')} m`;
}

export function formatCeilingFeet(feet: number, units: UnitSpec): string {
  if (units.height === 'm') return `${Math.round(feetToMetres(feet)).toLocaleString('en-AU')} m`;
  return `${Math.round(feet).toLocaleString('en-AU')}`;
}

export function unitsTooltip(units: UnitSpec): string {
  const temp = units.temp === 'F' ? '°F' : '°C';
  const height = units.height === 'm' ? 'm' : 'ft';
  const vis = units.visibility === 'sm' ? 'SM' : 'km';
  const rain = units.rain === 'in' ? 'in' : 'mm';
  const fl = units.flightLevel === 'metric' ? 'SFL' : 'FL';
  return `${units.pressure} · ${temp} · kt · ${height} · ${vis} · ${rain} · ${fl}`;
}

export function unitsContextPhrase(units: UnitSpec): string {
  const temp = units.temp === 'F' ? '°F' : '°C';
  const height = units.height === 'm' ? 'm' : 'ft';
  const fl = units.flightLevel === 'metric' ? 'metric FL' : `FL above ${units.transitionFt} ft`;
  const vis = units.visibility === 'sm' ? 'SM' : 'km';
  const rain = units.rain === 'in' ? 'in' : 'mm';
  return `Units: ${units.pressure}, ${temp}, kt, ${height}, ${fl}, ${vis}, ${rain}`;
}

/** One system-prompt paragraph. Tool numbers stay stored; the reply converts. */
export function unitsSystemLine(units: UnitSpec): string {
  const pressure = units.pressure === 'inHg' ? 'inHg to 2 decimal places' : 'hPa';
  const temp = units.temp === 'F' ? '°F' : '°C';
  const height = units.height === 'm' ? 'metres' : 'feet';
  const fl = units.flightLevel === 'metric'
    ? 'metric flight levels (S followed by tens of metres, for example S0920) above the transition'
    : `flight levels above ${units.transitionFt} ft`;
  const vis = units.visibility === 'sm' ? 'statute miles' : 'kilometres';
  const rain = units.rain === 'in' ? 'inches' : 'millimetres';
  return `Answer in the active units: pressure ${pressure}, temperature ${temp}, wind knots, altitude ${height}, ${fl}, visibility ${vis}, rain ${rain}. Tool results are stored as hPa, °C, knots, metres and millimetres; convert when you answer. A converted figure is derived, not invented. Missing stays missing.`;
}

function fromRegion(row: RegionRow, mode: UnitMode, label: DisplayUnits['label']): DisplayUnits {
  return {
    mode, id: row.id, label,
    pressure: row.pressure, temp: row.temp, wind: 'kt', height: row.height,
    visibility: row.visibility, rain: row.rain, flightLevel: row.flightLevel,
    transitionFt: row.transitionFt, uncertain: row.uncertain, transitionUncertain: row.transitionUncertain,
  };
}

/** AUS and US ignore the point. LOCAL uses the region, or ICAO defaults when the point is missing. */
export function resolveUnits(mode: UnitMode, lat: number | null, lon: number | null): DisplayUnits {
  if (mode === 'us') return { ...US_UNITS };
  if (mode === 'aus') return { ...AUS_UNITS };
  if (lat == null || lon == null) return fromRegion(ICAO_REGION, 'local', 'LOCAL');
  return fromRegion(regionAt(lat, lon), 'local', 'LOCAL');
}

export interface DwellState {
  regionId: string;
  pendingId: string | null;
  pendingAt: number | null;
}

/**
 * A region change commits only after it has been the pending region for
 * `dwellMs`. Returning to the shown region clears the pending change.
 */
export function dwellRegion(state: DwellState, regionId: string, now: number, dwellMs = 1000): DwellState {
  if (regionId === state.regionId) return { regionId: state.regionId, pendingId: null, pendingAt: null };
  if (state.pendingId === regionId && state.pendingAt != null && now - state.pendingAt >= dwellMs) {
    return { regionId, pendingId: null, pendingAt: null };
  }
  if (state.pendingId === regionId && state.pendingAt != null) return state;
  return { regionId: state.regionId, pendingId: regionId, pendingAt: now };
}

const MODES = new Set(['aus', 'us', 'local']);

/** Drop a unit block that is not one of the three modes and the known unit letters. */
export function parseUnitSpec(value: unknown): UnitSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.mode !== 'string' || !MODES.has(row.mode)) return null;
  if (row.pressure !== 'hPa' && row.pressure !== 'inHg') return null;
  if (row.temp !== 'C' && row.temp !== 'F') return null;
  if (row.wind != null && row.wind !== 'kt') return null;
  if (row.height !== 'ft' && row.height !== 'm') return null;
  if (row.visibility !== 'km' && row.visibility !== 'sm') return null;
  if (row.rain !== 'mm' && row.rain !== 'in') return null;
  if (row.flightLevel !== 'ft' && row.flightLevel !== 'metric') return null;
  if (typeof row.transitionFt !== 'number' || !Number.isFinite(row.transitionFt) || row.transitionFt <= 0 || row.transitionFt > 100000) return null;
  return {
    mode: row.mode as UnitMode,
    pressure: row.pressure,
    temp: row.temp,
    wind: 'kt',
    height: row.height,
    visibility: row.visibility,
    rain: row.rain,
    flightLevel: row.flightLevel,
    transitionFt: row.transitionFt,
  };
}

export function unitKey(units: UnitSpec): string {
  return [units.mode, units.pressure, units.temp, units.height, units.visibility, units.rain, units.flightLevel, units.transitionFt].join(':');
}
