/**
 * Web chart manifest.
 * Schema 1 is the historical 0–96 h ladder: 33 frames, every 3 h.
 * Schema 2 lists `forecast_hours` explicitly. Gaps may be uneven (3 h, then 6 h).
 * A missing hour is not invented and is not stretched from its neighbour.
 */

import type { FrameEncoding } from './frame-codec';

export const SCHEMA1_HOURS: readonly number[] = Object.freeze(
  Array.from({ length: 33 }, (_, index) => index * 3),
);

export interface VariableSpec {
  /** Legacy: every frame packed time-major in one file. */
  file: string | null;
  /** One file per forecast hour; null is a missing hour. Preferred over `file`. */
  frames: (string | null)[] | null;
  /** How each frame file is stored; `raw` when absent. */
  encoding: FrameEncoding;
  units: string;
  scale: number;
  offset: number;
  fill: number;
}

export interface PlaceSpec {
  id: string;
  name: string;
  zone: string;
  lat: number;
  lon: number;
  icao: string;
}

export interface ChartManifest {
  schema: 1 | 2;
  contract: 'isobar-web';
  run: string;
  generated: string;
  forecastHours: number[];
  /** Null when the ladder is not a single step. Schema 1 is always 3. */
  uniformStepHours: number | null;
  nx: number;
  ny: number;
  west: number;
  east: number;
  north: number;
  south: number;
  step: number;
  /** A global longitude ladder repeats at the dateline without a duplicate column. */
  wrapsLongitude: boolean;
  dtype: 'uint16';
  variables: Record<string, VariableSpec>;
  places: PlaceSpec[];
  aviation: string;
  /** Point series at the places, or null for an older export. */
  points: string | null;
  attribution: { source: string; licence: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameHours(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((hour, index) => hour === b[index]);
}

function readHours(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('forecast_hours is missing');
  const hours = value.map((hour) => {
    if (typeof hour !== 'number' || !Number.isFinite(hour)) throw new Error('forecast hour is not a number');
    return hour;
  });
  for (let i = 1; i < hours.length; i += 1) {
    if (!(hours[i] > hours[i - 1])) throw new Error('forecast_hours must increase');
  }
  return hours;
}

function uniformStep(hours: readonly number[]): number | null {
  if (hours.length < 2) return null;
  const step = hours[1] - hours[0];
  for (let i = 2; i < hours.length; i += 1) {
    if (hours[i] - hours[i - 1] !== step) return null;
  }
  return step;
}

function readFrames(value: unknown, name: string, count: number): (string | null)[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length !== count) throw new Error(`variable ${name} frames do not match forecast_hours`);
  return value.map((item) => {
    if (item === null) return null;
    if (typeof item !== 'string' || item.includes('..') || item.startsWith('/')) throw new Error(`variable ${name} frame path is invalid`);
    return item;
  });
}

function readVariable(value: unknown, name: string, count: number): VariableSpec {
  if (!isRecord(value)) throw new Error(`variable ${name} is missing`);
  const file = value.file ?? null;
  const frames = readFrames(value.frames, name, count);
  const units = value.units;
  const scale = value.scale;
  const offset = value.offset;
  const fill = value.fill ?? 65535;
  const encoding = value.encoding ?? 'raw';
  if (encoding !== 'raw' && encoding !== 'shuffle-gzip') throw new Error(`variable ${name} encoding is unknown`);
  if (typeof units !== 'string' || (file !== null && typeof file !== 'string') || (file === null && frames === null)) {
    throw new Error(`variable ${name} is incomplete`);
  }
  if (typeof scale !== 'number' || typeof offset !== 'number' || typeof fill !== 'number') {
    throw new Error(`variable ${name} scale is incomplete`);
  }
  return { file, frames, encoding, units, scale, offset, fill };
}

export function readManifest(json: unknown): ChartManifest {
  if (!isRecord(json)) throw new Error('manifest is not an object');
  if (json.contract !== 'isobar-web') throw new Error('manifest contract is not isobar-web');
  const schema = json.schema;
  if (schema !== 1 && schema !== 2) throw new Error('manifest schema is not 1 or 2');

  let forecastHours: number[];
  if (schema === 1) {
    forecastHours = json.forecast_hours == null ? [...SCHEMA1_HOURS] : readHours(json.forecast_hours);
    if (!sameHours(forecastHours, SCHEMA1_HOURS)) {
      throw new Error('schema 1 is 33 frames at 3 h, from 0 h through 96 h');
    }
    if (json.uniform_step_hours != null && json.uniform_step_hours !== 3) {
      throw new Error('schema 1 step is 3 h');
    }
  } else {
    forecastHours = readHours(json.forecast_hours);
    const step = uniformStep(forecastHours);
    if (json.uniform_step_hours != null && json.uniform_step_hours !== step) {
      throw new Error('uniform_step_hours does not match forecast_hours');
    }
  }

  const grid = json.grid;
  if (!isRecord(grid)) throw new Error('grid is missing');
  const nx = grid.nx;
  const ny = grid.ny;
  const west = grid.west;
  const east = grid.east;
  const north = grid.north;
  const south = grid.south;
  const step = grid.step;
  if (typeof nx !== 'number' || typeof ny !== 'number' || nx < 2 || ny < 2) throw new Error('grid size is invalid');
  if (typeof west !== 'number' || typeof east !== 'number' || typeof north !== 'number' || typeof south !== 'number') {
    throw new Error('grid bounds are invalid');
  }
  if (!(east > west) || !(north > south)) throw new Error('grid bounds are inverted');
  if (grid.dtype !== 'uint16') throw new Error('grid dtype is not uint16');
  const wrapsLongitude = grid.wraps_longitude === true;
  if (wrapsLongitude && (west !== -180 || east !== 179.5 || north !== 90 || south !== -90 || step !== 0.5 || nx !== 720 || ny !== 361)) {
    throw new Error('global grid geometry is not the supported 0.5 degree ladder');
  }
  if (wrapsLongitude) {
    const globalHours = [...Array.from({ length: 49 }, (_, i) => i * 3), 150, 156, 162, 168];
    if (schema !== 2 || forecastHours.length !== globalHours.length || forecastHours.some((hour, i) => hour !== globalHours[i]))
      throw new Error('global forecast must contain all 53 schema 2 leads');
  }

  const variablesIn = json.variables;
  if (!isRecord(variablesIn)) throw new Error('variables are missing');
  const variables: Record<string, VariableSpec> = {};
  for (const name of Object.keys(variablesIn)) variables[name] = readVariable(variablesIn[name], name, forecastHours.length);
  for (const name of ['mslp', 'rain24', 't2m', 'wind']) {
    if (!variables[name]) throw new Error(`variable ${name} is missing`);
  }

  const placesIn = json.places;
  if (!Array.isArray(placesIn)) throw new Error('places are missing');
  const places: PlaceSpec[] = placesIn.map((place) => {
    if (!isRecord(place)) throw new Error('place is invalid');
    const { id, name, zone, lat, lon, icao } = place;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof zone !== 'string' || typeof icao !== 'string') {
      throw new Error('place is incomplete');
    }
    if (typeof lat !== 'number' || typeof lon !== 'number') throw new Error('place coordinates are invalid');
    return { id, name, zone, lat, lon, icao };
  });

  const attributionIn = json.attribution;
  if (!Array.isArray(attributionIn)) throw new Error('attribution is missing');
  const attribution = attributionIn.map((item) => {
    if (!isRecord(item) || typeof item.source !== 'string' || typeof item.licence !== 'string') {
      throw new Error('attribution entry is invalid');
    }
    return { source: item.source, licence: item.licence };
  });

  return {
    schema,
    contract: 'isobar-web',
    run: typeof json.run === 'string' ? json.run : '',
    generated: typeof json.generated === 'string' ? json.generated : '',
    forecastHours,
    uniformStepHours: schema === 1 ? 3 : uniformStep(forecastHours),
    nx,
    ny,
    west,
    east,
    north,
    south,
    step: typeof step === 'number' ? step : (east - west) / (nx - 1),
    wrapsLongitude,
    dtype: 'uint16',
    variables,
    places,
    aviation: typeof json.aviation === 'string' ? json.aviation : 'aviation.json',
    points: typeof json.points === 'string' && !json.points.includes('..') ? json.points : null,
    attribution,
  };
}

/** Byte length of one variable packed time-major, north-to-south, west-to-east. */
export function packedBytes(manifest: ChartManifest): number {
  return manifest.forecastHours.length * manifest.nx * manifest.ny * 2;
}
