/**
 * Fast-lane tools. They read a published chart the caller already loaded.
 * A missing frame stays missing. At most the handler's three rounds call them.
 */

import type { ChartManifest } from '../manifest';
import { frameBlend } from '../interpolate';
import { decodeUint16 } from '../quantise';
import { surfaceWindFromPressure } from '../flow';
import type { PlaceRow } from '../places';
import { REPORT_TOOL } from '../reports/policy';

export const MAX_TOOL_ROUNDS = 4;

export type FieldName = 'mslp' | 'rain' | 'wind' | 'temp';

const FIELD_VAR: Record<FieldName, string> = { mslp: 'mslp', rain: 'rain24', wind: 'wind', temp: 't2m' };
const FIELD_UNITS: Record<FieldName, string> = { mslp: 'hPa', rain: 'mm', wind: 'kt', temp: 'C' };

export interface PublishedChart {
  manifest: ChartManifest;
  /** Dequantised cells for one hour index, or null when that hour was not published. */
  frame(variable: string, index: number): Float32Array | null;
  points: unknown;
  aviation: { airports?: unknown; sigmets?: unknown } | null;
  sky: unknown;
  places: PlaceRow[];
  /** Profile helper. Tests pass a stub; the server uses Open-Meteo. */
  profile(lat: number, lon: number, timeUtc: string): Promise<unknown>;
}

export interface ToolContext {
  archive: boolean;
  /** Requests a handoff; the handler admits it after checking/saving the answer. */
  queueArchive(question: string): Promise<boolean>;
  /** Manage the signed-in user's reports; recipient identity never comes from the model. */
  reportCommand?: (input: unknown, threadId: string) => Promise<unknown>;
  threadId?: string;
}

const TOOL_LIST: { name: string; description: string; properties: Record<string, unknown>; required: string[]; archive?: boolean }[] = [
  {
    name: 'sample_field',
    description: 'Sample one published ECMWF field at a latitude, longitude and UTC time. var is mslp (hPa), rain (mm), wind (kt, from in degrees) or temp (C). Wind directionSource is model 10 m wind or estimated from isobars; explicitly call the latter an estimate in your answer. Missing direction is absent; missing hours come back null.',
    properties: {
      var: { type: 'string', enum: ['mslp', 'rain', 'wind', 'temp'] },
      lat: { type: 'number' },
      lon: { type: 'number' },
      timeUtc: { type: 'string' },
    },
    required: ['var', 'lat', 'lon', 'timeUtc'],
  },
  {
    name: 'sample_region',
    description: 'Sample one published field at 3 to 6 named representative points across a region at one UTC time. Choose points that span the region (for example north, centre and south), and pass their real coordinates. Every returned sample is a map anchor; use these anchors to name the places in your answer. Do not tell the user to pan.',
    properties: {
      var: { type: 'string', enum: ['mslp', 'rain', 'wind', 'temp'] },
      timeUtc: { type: 'string' },
      points: { type: 'array', minItems: 3, maxItems: 6, items: { type: 'object', properties: { name: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' } }, required: ['name', 'lat', 'lon'], additionalProperties: false } },
    },
    required: ['var', 'timeUtc', 'points'],
  },
  {
    name: 'point_profile',
    description: 'Model profile at a point and UTC time: surface and pressure levels from Open-Meteo (non-commercial, CC BY 4.0). Missing values stay null.',
    properties: { lat: { type: 'number' }, lon: { type: 'number' }, timeUtc: { type: 'string' } },
    required: ['lat', 'lon', 'timeUtc'],
  },
  {
    name: 'aerodrome_weather',
    description: 'METAR and TAF for a four-letter ICAO aerodrome from the published aviation file (aviationweather.gov). Missing reports are null.',
    properties: { icao: { type: 'string' } },
    required: ['icao'],
  },
  {
    name: 'run_info',
    description: 'The published forecast run: id, issued time, forecast hours and places.',
    properties: {},
    required: [],
  },
  {
    name: 'find_place',
    description: 'Find a place by name. Returns up to eight matches with name, latitude, longitude and region.',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  {
    name: 'request_archive_analysis',
    description: 'Queue this question for the full archive. One queue per person. Use it only when the published frames cannot answer.',
    properties: { question: { type: 'string' } },
    required: ['question'],
    archive: true,
  },
];

export function toolSpecs(archive: boolean) {
  const weather = TOOL_LIST.filter((tool) => archive || !tool.archive).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { type: 'object' as const, properties: tool.properties, required: tool.required, additionalProperties: false },
  }));
  return weather;
}

/** Signed-in report management is added by the chat handler, never to public tools. */
export function reportToolSpec() {
  return REPORT_TOOL;
}

/** Weather reads the public connector may expose. The archive tool stays off it. */
export const PUBLIC_TOOL_NAMES = ['sample_field', 'point_profile', 'aerodrome_weather', 'run_info', 'find_place'] as const;

export function publicToolSpecs() {
  const names = new Set<string>(PUBLIC_TOOL_NAMES);
  return toolSpecs(false).filter((tool) => names.has(tool.name));
}

function cellIndex(manifest: ChartManifest, lat: number, lon: number): number | null {
  if (lat < manifest.south || lat > manifest.north) return null;
  const column = Math.round((lon - manifest.west) / manifest.step);
  const row = Math.round((manifest.north - lat) / manifest.step);
  if (row < 0 || row >= manifest.ny) return null;
  const x = manifest.wrapsLongitude ? ((column % manifest.nx) + manifest.nx) % manifest.nx : column;
  if (!manifest.wrapsLongitude && (lon < manifest.west || lon > manifest.east || x < 0 || x >= manifest.nx)) return null;
  return row * manifest.nx + x;
}

function atCell(frame: Float32Array | null, index: number): number | null {
  if (!frame) return null;
  const value = frame[index];
  return Number.isFinite(value) ? value : null;
}

/** Bilinear sample of a dequantised published frame. Missing corners stay missing. */
function sampleGrid(frame: Float32Array | null, manifest: ChartManifest, lon: number, lat: number): number | null {
  if (!frame || manifest.nx < 2 || manifest.ny < 2) return null;
  const dlon = manifest.step;
  const dlat = manifest.step;
  if (!(dlon > 0) || !(dlat > 0) || lat < manifest.south || lat > manifest.north) return null;
  let x = (lon - manifest.west) / dlon;
  if (manifest.wrapsLongitude) x = ((x % manifest.nx) + manifest.nx) % manifest.nx;
  else if (x < 0 || x > manifest.nx - 1) return null;
  const y = (manifest.north - lat) / dlat;
  const x0 = manifest.wrapsLongitude ? Math.floor(x) : Math.min(manifest.nx - 2, Math.floor(x));
  const y0 = Math.min(manifest.ny - 2, Math.max(0, Math.floor(y)));
  const tx = x - x0;
  const ty = y - y0;
  const at = (column: number, row: number): number | null => {
    const col = manifest.wrapsLongitude ? ((column % manifest.nx) + manifest.nx) % manifest.nx : column;
    if (col < 0 || col >= manifest.nx || row < 0 || row >= manifest.ny) return null;
    return atCell(frame, row * manifest.nx + col);
  };
  const v00 = at(x0, y0), v10 = at(x0 + 1, y0), v01 = at(x0, y0 + 1), v11 = at(x0 + 1, y0 + 1);
  if (v00 == null || v10 == null || v01 == null || v11 == null) return null;
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

function windDirection(u: number, v: number): number | null {
  if (!(Math.hypot(u, v) > 0)) return null;
  const from = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
  return Math.round(from) % 360;
}

export function sampleField(chart: PublishedChart, name: FieldName, lat: number, lon: number, timeUtc: string): Record<string, unknown> {
  const manifest = chart.manifest;
  const index = cellIndex(manifest, lat, lon);
  const units = FIELD_UNITS[name];
  const base = { var: name, lat, lon, timeUtc, units, value: null as number | null };
  if (index == null) return { ...base, missing: true };
  const runMs = Date.parse(manifest.run);
  const at = Date.parse(timeUtc);
  if (!Number.isFinite(runMs) || !Number.isFinite(at)) return { ...base, missing: true };
  const minute = (at - runMs) / 60_000;
  const firstMinute = manifest.forecastHours[0] * 60;
  const lastMinute = manifest.forecastHours[manifest.forecastHours.length - 1] * 60;
  if (minute < firstMinute || minute > lastMinute) return { ...base, missing: true };
  const blend = frameBlend(manifest.forecastHours, minute);
  if (!blend) return { ...base, missing: true };
  const read = (variable: string, frameIndex: number) => atCell(chart.frame(variable, frameIndex), index);
  const mix = (variable: string): number | null => {
    const left = read(variable, blend.i0);
    const right = read(variable, blend.i1);
    if (left == null || right == null) return null;
    return left + (right - left) * blend.t;
  };
  if (name === 'wind') {
    const scalar = mix('wind');
    // u/v is authoritative even when the legacy scalar wind speed is present.
    const hasModelComponents = manifest.variables.u10 != null && manifest.variables.v10 != null;
    if (hasModelComponents) {
      const u = mix('u10');
      const v = mix('v10');
      const value = scalar ?? (u != null && v != null ? Math.hypot(u, v) * 1.943844 : null);
      if (value == null) return { ...base, units: 'kt', missing: true };
      const from = u != null && v != null ? windDirection(u, v) : null;
      return {
        ...base, units: 'kt', value: Math.round(value * 10) / 10,
        ...(from == null ? {} : { from, directionSource: 'model 10 m wind' }),
        valueSource: scalar == null ? 'model 10 m wind' : 'published wind speed',
      };
    }
    const pressure = (sampleLon: number, sampleLat: number): number | null => {
      const left = sampleGrid(chart.frame('mslp', blend.i0), manifest, sampleLon, sampleLat);
      const right = sampleGrid(chart.frame('mslp', blend.i1), manifest, sampleLon, sampleLat);
      if (left == null || right == null) return null;
      return left + (right - left) * blend.t;
    };
    const estimated = surfaceWindFromPressure(pressure, lon, lat, Math.max(manifest.step, 0.5));
    const from = estimated ? windDirection(estimated.u, estimated.v) : null;
    // The scalar field is the published speed; an isobar estimate supplies
    // direction only and must never invent a replacement speed.
    if (scalar == null) return { ...base, units: 'kt', missing: true };
    return {
      ...base, units: 'kt', value: Math.round(scalar * 10) / 10,
      ...(from == null ? {} : { from, directionSource: 'estimated from isobars' }),
      valueSource: 'published wind speed',
    };
  }
  const value = mix(FIELD_VAR[name]);
  if (value == null) return { ...base, missing: true };
  return { ...base, value: Math.round(value * 10) / 10 };
}

export function findPlace(places: readonly PlaceRow[], name: string): { name: string; lat: number; lon: number; region: string }[] {
  const query = name.trim().toLowerCase();
  if (query.length < 2) return [];
  return places
    .filter((place) => place[0].toLowerCase().includes(query))
    .slice(0, 8)
    .map((place) => ({ name: place[0], lat: place[1], lon: place[2], region: place[4] }));
}

export interface RegionSamplePoint { name: string; lat: number; lon: number }

/** Sample a bounded set of named points, retaining coordinates as recenter anchors. */
export function sampleRegion(chart: PublishedChart, name: FieldName, points: readonly RegionSamplePoint[], timeUtc: string): Record<string, unknown> {
  if (points.length < 3 || points.length > 6) return { error: 'sample_region needs 3 to 6 points' };
  const seen = new Set<string>();
  const samples: Record<string, unknown>[] = [];
  const coordinates = new Set<string>();
  for (const point of points) {
    if (!point || typeof point.name !== 'string' || point.name.trim().length < 2 || point.name.length > 100 || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)
      || point.lat < -90 || point.lat > 90 || point.lon < -180 || point.lon > 180) return { error: 'each point needs a named latitude and longitude within bounds' };
    const key = point.name.trim().toLowerCase();
    const coordinate = `${point.lat},${point.lon}`;
    if (seen.has(key) || coordinates.has(coordinate)) return { error: 'sample_region points must have distinct names and coordinates' };
    seen.add(key); coordinates.add(coordinate);
    samples.push({ name: point.name.trim(), ...sampleField(chart, name, point.lat, point.lon, timeUtc) });
  }
  return { var: name, timeUtc, count: samples.length, samples };
}

function airport(chart: PublishedChart, icao: string): Record<string, unknown> | null {
  const list = chart.aviation && Array.isArray(chart.aviation.airports) ? chart.aviation.airports : [];
  const found = list.find((item) => item && typeof item === 'object' && String((item as { icao?: string }).icao).toUpperCase() === icao.toUpperCase());
  return found && typeof found === 'object' ? found as Record<string, unknown> : null;
}

export async function runTool(name: string, input: unknown, chart: PublishedChart, ctx: ToolContext): Promise<unknown> {
  const row = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (name === 'manage_reports') {
    if (!ctx.reportCommand || !ctx.threadId) return { error: 'Report management requires a signed-in account.' };
    return ctx.reportCommand(input, ctx.threadId);
  }
  if (name === 'sample_field') {
    const field = row.var;
    if (field !== 'mslp' && field !== 'rain' && field !== 'wind' && field !== 'temp') return { error: 'unknown field' };
    if (typeof row.lat !== 'number' || typeof row.lon !== 'number' || typeof row.timeUtc !== 'string') return { error: 'missing argument' };
    return sampleField(chart, field, row.lat, row.lon, row.timeUtc);
  }
  if (name === 'sample_region') {
    const field = row.var;
    if (field !== 'mslp' && field !== 'rain' && field !== 'wind' && field !== 'temp') return { error: 'unknown field' };
    if (typeof row.timeUtc !== 'string' || !Array.isArray(row.points)) return { error: 'missing argument' };
    const points: RegionSamplePoint[] = [];
    for (const value of row.points) {
      if (!value || typeof value !== 'object') return { error: 'each point needs a name, latitude and longitude' };
      const point = value as Record<string, unknown>;
      if (typeof point.name !== 'string' || typeof point.lat !== 'number' || typeof point.lon !== 'number') return { error: 'each point needs a name, latitude and longitude' };
      points.push({ name: point.name, lat: point.lat, lon: point.lon });
    }
    return sampleRegion(chart, field, points, row.timeUtc);
  }
  if (name === 'point_profile') {
    if (typeof row.lat !== 'number' || typeof row.lon !== 'number' || typeof row.timeUtc !== 'string') return { error: 'missing argument' };
    return chart.profile(row.lat, row.lon, row.timeUtc);
  }
  if (name === 'aerodrome_weather') {
    if (typeof row.icao !== 'string' || !/^[A-Za-z]{4}$/.test(row.icao)) return { error: 'missing argument' };
    const found = airport(chart, row.icao);
    if (!found) return { icao: row.icao.toUpperCase(), missing: true };
    return {
      icao: row.icao.toUpperCase(),
      name: found.name ?? null,
      lat: found.lat ?? null,
      lon: found.lon ?? null,
      metar: found.metar ?? null,
      taf: found.taf ?? null,
    };
  }
  if (name === 'run_info') {
    const manifest = chart.manifest;
    return {
      runId: manifest.run,
      timeUtc: manifest.run,
      hours: manifest.forecastHours,
      places: manifest.places.map((place) => ({ name: place.name, lat: place.lat, lon: place.lon, icao: place.icao })),
      generated: manifest.generated,
    };
  }
  if (name === 'find_place') {
    if (typeof row.name !== 'string') return { error: 'missing argument' };
    const matches = findPlace(chart.places, row.name);
    return { matches };
  }
  if (name === 'request_archive_analysis') {
    if (!ctx.archive) return { error: 'archive is not available on this tier' };
    if (typeof row.question !== 'string' || !row.question.trim()) return { error: 'missing argument' };
    const queued = await ctx.queueArchive(row.question.trim().slice(0, 2_000));
    return queued ? { requested: true } : { queued: false, reason: 'one archive question is already in flight' };
  }
  return { error: 'unknown tool' };
}

/** Decode a raw uint16 frame the way the map does. Null bytes are a missing hour. */
export function frameFromBytes(bytes: Uint8Array | null, scale: { scale: number; offset: number; fill?: number }): Float32Array | null {
  if (!bytes) return null;
  try { return decodeUint16(bytes, scale); } catch { return null; }
}
