import type { DaySummary, NowReading, SkyIcon } from '../points';
import { profileAt, type Profile, type ProfileSeries } from '../sky/physics';
import { addLocalDays, localDayKey, localMidnight, weekdayShort } from '../time-label';
import { sunProtectionLabel, uvAtHour, uvFigure, type UvFigure } from './uv';

export const OPEN_METEO_MODEL = 'ecmwf_ifs025';
export const PRESSURE_LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200] as const;
const SESSION_PREFIX = 'isobar.point.openmeteo.v1:';
/** v2 includes the UV index. Older session entries are left unread and cleared. */
const PLACE_PREFIX = 'isobar.place.forecast.v2:';
const PLACE_CACHE = 'isobar.place.forecast.';
const MAX_MEMORY_ENTRIES = 32;
const CACHE_TTL_MS = 3_600_000;

export interface PointSurface {
  temperature2mC: number | null;
  dewPoint2mC: number | null;
  windSpeed10mKt: number | null;
  windDirection10m: number | null;
  cloudCoverPct: number | null;
  precipitationMm: number | null;
  surfacePressureHpa: number | null;
}

/** Open-Meteo's own identity for one point. `cycle` is false when the API named no model run. */
export interface PointProvenance {
  source: string;
  model: string;
  /** Cycle time, or the fetch time when `cycle` is false ("latest at fetch time"). */
  run: string;
  cycle: boolean;
}

export interface PointModel {
  latitude: number;
  longitude: number;
  elevationM: number | null;
  provenance: PointProvenance;
  series: ProfileSeries;
  surface: PointSurface[];
}

export interface PlaceDay {
  key: string;
  hi: number | null;
  lo: number | null;
  rain: number | null;
  windKt: number | null;
  windFrom: number | null;
  icon: SkyIcon | null;
  /** Daily maximum UV index. Null when Open-Meteo omitted it. */
  uvMax: number | null;
}

/** Seven local days plus hourly surface, cached per place and Open-Meteo run. */
export interface PlaceForecast {
  latitude: number;
  longitude: number;
  zone: string;
  provenance: PointProvenance;
  times: number[];
  surface: PointSurface[];
  /** Hourly UV index, aligned with `times`. Null hours stay null. */
  uv: (number | null)[];
  days: PlaceDay[];
}

export interface OpenMeteoLoadOptions {
  /** Time used by the map/player; included in the cache key. */
  mapTimeMs: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

interface OpenMeteoHourly {
  time?: unknown;
  [key: string]: unknown;
}

const memoryCache = new Map<string, { model: PointModel; fetchedAt: number }>();
const placeCache = new Map<string, { forecast: PlaceForecast; fetchedAt: number }>();
const inFlight = new Map<string, symbol>();

export function roundedCoordinate(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Cache namespace is the Open-Meteo model, never the map's run. */
export function pointCacheKey(latitude: number, longitude: number, mapTimeMs: number, model = OPEN_METEO_MODEL): string {
  const day = new Date(mapTimeMs).toISOString().slice(0, 10);
  return `${SESSION_PREFIX}${roundedCoordinate(latitude).toFixed(1)},${roundedCoordinate(longitude).toFixed(1)}:${model}:${day}`;
}

function numberAt(values: unknown, index: number): number | null {
  if (!Array.isArray(values)) return null;
  const value = values[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(time) ? time : null;
}

function levelVariable(level: number, name: string): string {
  return `${name}_${level}hPa`;
}

/** Build the exact Open-Meteo request used by the point section. */
export function openMeteoUrl(latitude: number, longitude: number, _model = OPEN_METEO_MODEL, mapTimeMs?: number): string {
  const hourly = [
    ...PRESSURE_LEVELS.flatMap((level) => ['temperature', 'relative_humidity', 'cloud_cover', 'wind_speed', 'wind_direction', 'geopotential_height'].map((name) => levelVariable(level, name))),
    'temperature_2m', 'dew_point_2m', 'wind_speed_10m', 'wind_direction_10m', 'cloud_cover', 'precipitation', 'surface_pressure',
  ].join(',');
  const day = new Date(mapTimeMs ?? Date.now()).toISOString().slice(0, 10);
  const end = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    latitude: roundedCoordinate(latitude).toFixed(1),
    longitude: roundedCoordinate(longitude).toFixed(1),
    models: OPEN_METEO_MODEL,
    hourly,
    wind_speed_unit: 'kn',
    timezone: 'GMT',
    start_date: day,
    end_date: end,
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
}

function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(time) ? utcStamp(time) : null;
}

function modelId(root: Record<string, unknown>): string | null {
  if (typeof root.model === 'string' && root.model) return root.model;
  const models = root.models;
  if (typeof models === 'string' && models) return models;
  if (Array.isArray(models) && typeof models[0] === 'string') return models[0];
  if (models && typeof models === 'object') {
    const keys = Object.keys(models as object);
    if (keys.length === 1) return keys[0];
  }
  return null;
}

function cycleFrom(value: unknown): string | null {
  const direct = isoTime(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return isoTime(record.initialization_time) ?? isoTime(record.model_run) ?? isoTime(record.init_time) ?? isoTime(record.run) ?? isoTime(record.time);
}

/**
 * The forecast payload names a cycle when Open-Meteo sends one (`models` metadata,
 * `model_run`, or `initialization_time`). Otherwise the profile is the latest run
 * available at `fetchedAtMs`, and the label says so.
 */
export function openMeteoProvenance(root: Record<string, unknown>, fetchedAtMs: number): PointProvenance {
  const model = modelId(root) ?? OPEN_METEO_MODEL;
  const fromModels = root.models && typeof root.models === 'object' && !Array.isArray(root.models)
    ? Object.values(root.models as Record<string, unknown>).map(cycleFrom).find((value): value is string => !!value) ?? null
    : null;
  const cycle = fromModels ?? cycleFrom(root.model_run) ?? cycleFrom(root.initialization_time) ?? cycleFrom(root.init_time);
  if (cycle) return { source: 'Open-Meteo', model, run: cycle, cycle: true };
  const fetched = utcStamp(Number.isFinite(fetchedAtMs) ? fetchedAtMs : Date.now());
  return { source: 'Open-Meteo', model, run: fetched, cycle: false };
}

/** Parse a recorded or live Open-Meteo response into the shared sky profile shape. */
export function parseOpenMeteo(response: unknown, latitude?: number, longitude?: number, fetchedAtMs = Date.now()): PointModel {
  if (!response || typeof response !== 'object') throw new Error('Invalid Open-Meteo response');
  const root = response as Record<string, unknown>;
  const rawHourly = root.hourly;
  if (!rawHourly || typeof rawHourly !== 'object') throw new Error('Open-Meteo response has no hourly data');
  const hourly = rawHourly as OpenMeteoHourly;
  const rawTimes = Array.isArray(hourly.time) ? hourly.time : [];
  const times = rawTimes.map(stringTime);
  const validIndexes = times.reduce<number[]>((out, time, index) => { if (time != null) out.push(index); return out; }, []);
  if (!validIndexes.length || validIndexes.length !== rawTimes.length) throw new Error('Open-Meteo response has invalid times');
  const validTimes = validIndexes.map((index) => times[index] as number);
  if (validTimes.some((time, i) => i > 0 && time <= validTimes[i - 1])) throw new Error('Open-Meteo times are not increasing');
  const value = (name: string, index: number) => numberAt(hourly[name], index);
  const levels = PRESSURE_LEVELS.map((hPa) => ({
    hPa,
    z: validIndexes.map((i) => value(levelVariable(hPa, 'geopotential_height'), i)),
    t: validIndexes.map((i) => value(levelVariable(hPa, 'temperature'), i)),
    rh: validIndexes.map((i) => value(levelVariable(hPa, 'relative_humidity'), i)),
    ws: validIndexes.map((i) => value(levelVariable(hPa, 'wind_speed'), i)),
    wd: validIndexes.map((i) => value(levelVariable(hPa, 'wind_direction'), i)),
    cc: validIndexes.map((i) => value(levelVariable(hPa, 'cloud_cover'), i)),
    w: validIndexes.map(() => null),
  }));
  const surface: PointSurface[] = validIndexes.map((i) => ({
    temperature2mC: value('temperature_2m', i), dewPoint2mC: value('dew_point_2m', i),
    windSpeed10mKt: value('wind_speed_10m', i), windDirection10m: value('wind_direction_10m', i),
    cloudCoverPct: value('cloud_cover', i), precipitationMm: value('precipitation', i), surfacePressureHpa: value('surface_pressure', i),
  }));
  const lat = typeof latitude === 'number' ? latitude : typeof root.latitude === 'number' ? root.latitude : NaN;
  const lon = typeof longitude === 'number' ? longitude : typeof root.longitude === 'number' ? root.longitude : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error('Invalid point coordinates');
  const elevationM = typeof root.elevation === 'number' && Number.isFinite(root.elevation) ? root.elevation : null;
  const provenance = openMeteoProvenance(root, fetchedAtMs);
  return {
    latitude: lat, longitude: lon, elevationM, surface, provenance,
    series: {
      icao: 'POINT', run: provenance.run, source: provenance.source, model: provenance.model, runKnown: provenance.cycle,
      lat, lon, elevationFt: elevationM == null ? Number.NaN : elevationM * 3.28084, coastKm: null, time: validTimes, levels,
    },
  };
}

function storage(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

function readMemory(key: string): PointModel | null {
  const hit = memoryCache.get(key);
  if (!hit || Date.now() - hit.fetchedAt >= CACHE_TTL_MS) return null;
  return hit.model;
}

export function peekPointModel(latitude: number, longitude: number, mapTimeMs: number): PointModel | null {
  return readMemory(pointCacheKey(latitude, longitude, mapTimeMs));
}

function readCache(key: string): PointModel | null {
  const found = memoryCache.get(key);
  if (found && Date.now() - found.fetchedAt < CACHE_TTL_MS) return found.model;
  memoryCache.delete(key);
  let saved: string | null = null;
  try { saved = storage()?.getItem(key) ?? null; } catch { return null; }
  if (!saved) return null;
  try {
    const envelope = JSON.parse(saved) as { response?: unknown; latitude?: number; longitude?: number; fetchedAt?: number };
    if (!envelope.response || typeof envelope.fetchedAt !== 'number' || !Number.isFinite(envelope.fetchedAt)) return null;
    if (Date.now() - envelope.fetchedAt >= CACHE_TTL_MS) return null;
    // Re-read the response. A stored map run is not this profile's cycle.
    const parsed = parseOpenMeteo(envelope.response, envelope.latitude, envelope.longitude, envelope.fetchedAt);
    remember(key, parsed, envelope.fetchedAt);
    return parsed;
  } catch { return null; }
}

function remember(key: string, model: PointModel, fetchedAt: number) {
  memoryCache.delete(key);
  memoryCache.set(key, { model, fetchedAt });
  while (memoryCache.size > MAX_MEMORY_ENTRIES) memoryCache.delete(memoryCache.keys().next().value as string);
}

function writeCache(key: string, value: PointModel, raw: unknown, fetchedAt: number): void {
  remember(key, value, fetchedAt);
  try {
    const store = storage();
    if (store) {
      store.setItem(key, JSON.stringify({ response: raw, latitude: value.latitude, longitude: value.longitude, fetchedAt }));
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) { const storedKey = store.key(i); if (storedKey?.startsWith(SESSION_PREFIX)) keys.push(storedKey); }
      while (keys.length > MAX_MEMORY_ENTRIES) store.removeItem(keys.shift()!);
    }
  } catch { /* private mode/quota: memory remains useful */ }
}

/** Load a point profile with memory + sessionStorage caching and stale-write protection. */
export async function loadPointProfile(latitude: number, longitude: number, options: OpenMeteoLoadOptions): Promise<PointModel> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error('Invalid point coordinates');
  const key = pointCacheKey(latitude, longitude, options.mapTimeMs, OPEN_METEO_MODEL);
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const cached = readCache(key);
  if (cached) return cached;
  const requestId = Symbol(key);
  inFlight.set(key, requestId);
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(openMeteoUrl(latitude, longitude, OPEN_METEO_MODEL, options.mapTimeMs), { signal: options.signal });
    if (!response.ok) throw new Error(`Open-Meteo request failed (${response.status})`);
    const raw = await response.json() as Record<string, unknown>;
    const headerRun = typeof response.headers?.get === 'function' ? response.headers.get('x-open-meteo-model-run') ?? response.headers.get('x-model-run') : null;
    if (headerRun && raw && typeof raw === 'object' && !raw.model_run && !raw.initialization_time) raw.model_run = headerRun;
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const fetchedAt = Date.now();
    const parsed = parseOpenMeteo(raw, roundedCoordinate(latitude), roundedCoordinate(longitude), fetchedAt);
    if (inFlight.get(key) === requestId) writeCache(key, parsed, raw, fetchedAt);
    return parsed;
  } finally {
    if (inFlight.get(key) === requestId) inFlight.delete(key);
  }
}

export function pointProfileAt(model: PointModel | null, timeMs: number): Profile | null {
  return model ? profileAt(model.series, timeMs) : null;
}

function surfaceLerp(a: PointSurface, b: PointSurface, f: number): PointSurface {
  const lerp = (x: number | null, y: number | null) => x == null || y == null ? null : x + (y - x) * f;
  let windSpeed10mKt: number | null = null;
  let windDirection10m: number | null = null;
  if (a.windSpeed10mKt != null && b.windSpeed10mKt != null && a.windDirection10m != null && b.windDirection10m != null) {
    const r = Math.PI / 180;
    const u = -(a.windSpeed10mKt * Math.sin(a.windDirection10m * r) * (1 - f) + b.windSpeed10mKt * Math.sin(b.windDirection10m * r) * f);
    const v = -(a.windSpeed10mKt * Math.cos(a.windDirection10m * r) * (1 - f) + b.windSpeed10mKt * Math.cos(b.windDirection10m * r) * f);
    windSpeed10mKt = Math.hypot(u, v);
    windDirection10m = windSpeed10mKt < 0.05 ? (f < 0.5 ? a.windDirection10m : b.windDirection10m) : (Math.atan2(-u, -v) / r + 360) % 360;
  }
  return { temperature2mC: lerp(a.temperature2mC, b.temperature2mC), dewPoint2mC: lerp(a.dewPoint2mC, b.dewPoint2mC), windSpeed10mKt, windDirection10m, cloudCoverPct: lerp(a.cloudCoverPct, b.cloudCoverPct), precipitationMm: lerp(a.precipitationMm, b.precipitationMm), surfacePressureHpa: lerp(a.surfacePressureHpa, b.surfacePressureHpa) };
}

/** Surface values at a map time, using the same <=3 h sample policy as profileAt. */
export function pointSurfaceAt(model: PointModel | null, timeMs: number): PointSurface | null {
  if (!model) return null;
  // Share the physics helper's sample selection, including nearest fallback
  // and the three-hour ceiling. No levels need calculating for this lookup.
  const sampled = profileAt({ ...model.series, levels: [] }, timeMs);
  if (!sampled) return null;
  const [t0, t1] = sampled.samples;
  const a = model.surface[model.series.time.indexOf(t0)];
  if (!a) return null;
  if (t1 == null) return a;
  const b = model.surface[model.series.time.indexOf(t1)];
  return b ? surfaceLerp(a, b, (timeMs - t0) / (t1 - t0)) : null;
}

export function clearPointCache(): void {
  memoryCache.clear();
  placeCache.clear();
  const store = storage();
  if (!store) return;
  try {
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (key?.startsWith(SESSION_PREFIX) || key?.startsWith(PLACE_CACHE)) store.removeItem(key);
    }
  } catch { /* storage may be unavailable */ }
}

const PLACE_HOURLY = ['temperature_2m', 'dew_point_2m', 'wind_speed_10m', 'wind_direction_10m', 'cloud_cover', 'precipitation', 'surface_pressure', 'uv_index'];
const PLACE_DAILY = ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'wind_speed_10m_max', 'wind_direction_10m_dominant', 'weather_code', 'uv_index_max'];

/** Daily high/low, rain and wind, plus hourly surface, for any place. Not the sounding request. */
export function placeForecastUrl(latitude: number, longitude: number): string {
  const params = new URLSearchParams({
    latitude: roundedCoordinate(latitude).toFixed(1),
    longitude: roundedCoordinate(longitude).toFixed(1),
    models: OPEN_METEO_MODEL,
    hourly: PLACE_HOURLY.join(','),
    daily: PLACE_DAILY.join(','),
    wind_speed_unit: 'kn',
    timezone: 'auto',
    forecast_days: '7',
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

function zoneOf(value: unknown): string {
  if (value === 'GMT' || value === 'UTC') return 'UTC';
  if (typeof value !== 'string' || !value.includes('/')) return 'UTC';
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}

function offsetMillis(root: Record<string, unknown>): number {
  const offset = root.utc_offset_seconds;
  return typeof offset === 'number' && Number.isFinite(offset) ? offset * 1000 : 0;
}

/** Open-Meteo local stamps have no zone; `utc_offset_seconds` shifts them to UTC. */
function offsetTime(value: unknown, offsetMs: number): number | null {
  if (typeof value !== 'string' || !value) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(value)) return stringTime(value);
  const asUtc = Date.parse(`${value}Z`);
  return Number.isFinite(asUtc) ? asUtc - offsetMs : null;
}

function skyFromCode(code: number | null, rain: number | null): SkyIcon | null {
  if (code != null) {
    if (code >= 51 && code <= 57) return 'drizzle';
    if (code >= 61) return 'rain';
    if (code <= 1) return 'sun';
    if (code === 2) return 'partly';
    return 'cloud';
  }
  if (rain == null) return null;
  if (rain >= 1) return 'rain';
  if (rain >= 0.2) return 'drizzle';
  return 'sun';
}

function midnightOfDate(key: string, zone: string): number {
  const [year, month, day] = key.split('-').map(Number);
  let probe = Date.UTC(year, month - 1, day, 12, 0, 0);
  for (let step = 0; step < 3; step += 1) {
    if (localDayKey(probe, zone) === key) return localMidnight(probe, zone);
    probe += localDayKey(probe, zone) < key ? 86_400_000 : -86_400_000;
  }
  return localMidnight(probe, zone);
}

/** Parse a place forecast. Missing hours and days stay missing. */
export function parsePlaceForecast(response: unknown, fetchedAtMs = Date.now()): PlaceForecast {
  if (!response || typeof response !== 'object') throw new Error('Invalid Open-Meteo response');
  const root = response as Record<string, unknown>;
  const hourly = root.hourly;
  const daily = root.daily;
  if (!hourly || typeof hourly !== 'object' || !daily || typeof daily !== 'object') throw new Error('Open-Meteo response has no place forecast');
  const hours = hourly as Record<string, unknown>;
  const daysIn = daily as Record<string, unknown>;
  const offsetMs = offsetMillis(root);
  const rawTimes = Array.isArray(hours.time) ? hours.time : [];
  const times = rawTimes.map((value) => offsetTime(value, offsetMs));
  if (!times.length || times.some((time) => time == null)) throw new Error('Open-Meteo response has invalid times');
  const validTimes = times as number[];
  if (validTimes.some((time, index) => index > 0 && time <= validTimes[index - 1])) throw new Error('Open-Meteo times are not increasing');
  const at = (name: string, index: number) => numberAt(hours[name], index);
  const surface: PointSurface[] = validTimes.map((_, index) => ({
    temperature2mC: at('temperature_2m', index),
    dewPoint2mC: at('dew_point_2m', index),
    windSpeed10mKt: at('wind_speed_10m', index),
    windDirection10m: at('wind_direction_10m', index),
    cloudCoverPct: at('cloud_cover', index),
    precipitationMm: at('precipitation', index),
    surfacePressureHpa: at('surface_pressure', index),
  }));
  const uv = validTimes.map((_, index) => at('uv_index', index));
  const dayKeys = Array.isArray(daysIn.time) ? daysIn.time : [];
  const hi = Array.isArray(daysIn.temperature_2m_max) ? daysIn.temperature_2m_max : [];
  const lo = Array.isArray(daysIn.temperature_2m_min) ? daysIn.temperature_2m_min : [];
  const rain = Array.isArray(daysIn.precipitation_sum) ? daysIn.precipitation_sum : [];
  const wind = Array.isArray(daysIn.wind_speed_10m_max) ? daysIn.wind_speed_10m_max : [];
  const from = Array.isArray(daysIn.wind_direction_10m_dominant) ? daysIn.wind_direction_10m_dominant : [];
  const code = Array.isArray(daysIn.weather_code) ? daysIn.weather_code : [];
  const uvMax = Array.isArray(daysIn.uv_index_max) ? daysIn.uv_index_max : [];
  const num = (values: unknown[], index: number) => {
    const value = values[index];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const days: PlaceDay[] = [];
  dayKeys.forEach((key, index) => {
    if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
    const rainMm = num(rain, index);
    days.push({
      key,
      hi: num(hi, index),
      lo: num(lo, index),
      rain: rainMm,
      windKt: num(wind, index),
      windFrom: num(from, index),
      icon: skyFromCode(num(code, index), rainMm),
      uvMax: num(uvMax, index),
    });
  });
  if (!days.length) throw new Error('Open-Meteo response has no days');
  const lat = typeof root.latitude === 'number' ? root.latitude : NaN;
  const lon = typeof root.longitude === 'number' ? root.longitude : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error('Invalid point coordinates');
  return { latitude: lat, longitude: lon, zone: zoneOf(root.timezone), provenance: openMeteoProvenance(root, fetchedAtMs), times: validTimes, surface, uv, days };
}

function placeCacheKey(latitude: number, longitude: number): string {
  return `${PLACE_PREFIX}${roundedCoordinate(latitude).toFixed(1)},${roundedCoordinate(longitude).toFixed(1)}:${OPEN_METEO_MODEL}`;
}

function readPlaceCache(key: string): PlaceForecast | null {
  const found = placeCache.get(key);
  if (found && Date.now() - found.fetchedAt < CACHE_TTL_MS) return found.forecast;
  placeCache.delete(key);
  let saved: string | null = null;
  try { saved = storage()?.getItem(key) ?? null; } catch { return null; }
  if (!saved) return null;
  try {
    const envelope = JSON.parse(saved) as { response?: unknown; fetchedAt?: number };
    if (!envelope.response || typeof envelope.fetchedAt !== 'number' || Date.now() - envelope.fetchedAt >= CACHE_TTL_MS) return null;
    const parsed = parsePlaceForecast(envelope.response, envelope.fetchedAt);
    placeCache.set(key, { forecast: parsed, fetchedAt: envelope.fetchedAt });
    return parsed;
  } catch { return null; }
}

function writePlaceCache(key: string, forecast: PlaceForecast, raw: unknown, fetchedAt: number): void {
  placeCache.delete(key);
  placeCache.set(key, { forecast, fetchedAt });
  while (placeCache.size > MAX_MEMORY_ENTRIES) placeCache.delete(placeCache.keys().next().value as string);
  try {
    const store = storage();
    if (!store) return;
    store.setItem(key, JSON.stringify({ response: raw, fetchedAt }));
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const storedKey = store.key(i);
      if (storedKey?.startsWith(PLACE_PREFIX)) keys.push(storedKey);
    }
    while (keys.length > MAX_MEMORY_ENTRIES) store.removeItem(keys.shift()!);
  } catch { /* private mode or quota: memory remains useful */ }
}

/** Load a place forecast. The cache key is the place and model; the stored run is Open-Meteo's. */
export async function loadPlaceForecast(latitude: number, longitude: number, options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<PlaceForecast> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error('Invalid point coordinates');
  const key = placeCacheKey(latitude, longitude);
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const cached = readPlaceCache(key);
  if (cached) return cached;
  const requestId = Symbol(key);
  inFlight.set(key, requestId);
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(placeForecastUrl(latitude, longitude), { signal: options.signal });
    if (!response.ok) throw new Error(`Open-Meteo request failed (${response.status})`);
    const raw = await response.json() as Record<string, unknown>;
    const headerRun = typeof response.headers?.get === 'function' ? response.headers.get('x-open-meteo-model-run') ?? response.headers.get('x-model-run') : null;
    if (headerRun && raw && typeof raw === 'object' && !raw.model_run && !raw.initialization_time) raw.model_run = headerRun;
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const fetchedAt = Date.now();
    const parsed = parsePlaceForecast(raw, fetchedAt);
    if (inFlight.get(key) === requestId) writePlaceCache(key, parsed, raw, fetchedAt);
    return parsed;
  } finally {
    if (inFlight.get(key) === requestId) inFlight.delete(key);
  }
}

function forecastModel(forecast: PlaceForecast): PointModel {
  return {
    latitude: forecast.latitude, longitude: forecast.longitude, elevationM: null, provenance: forecast.provenance, surface: forecast.surface,
    series: {
      icao: 'POINT', run: forecast.provenance.run, source: forecast.provenance.source, model: forecast.provenance.model, runKnown: forecast.provenance.cycle,
      lat: forecast.latitude, lon: forecast.longitude, elevationFt: Number.NaN, coastKm: null, time: forecast.times, levels: [],
    },
  };
}

export function forecastReading(forecast: PlaceForecast, timeMs: number): { reading: NowReading; valid: string | null } {
  const surface = pointSurfaceAt(forecastModel(forecast), timeMs);
  return {
    reading: {
      tempC: surface?.temperature2mC ?? null,
      windKt: surface?.windSpeed10mKt ?? null,
      windFrom: surface?.windDirection10m == null ? null : Math.round(surface.windDirection10m) % 360,
    },
    valid: surface ? new Date(timeMs).toISOString().replace(/\.000Z$/, 'Z') : null,
  };
}

function uvHours(forecast: PlaceForecast): { time: number; uv: number | null }[] {
  return forecast.times.map((time, index) => ({ time, uv: forecast.uv[index] ?? null }));
}

export interface UvNow extends UvFigure {
  protection: string | null;
}

/** UV for the hour containing `timeMs`, with that local day's protection window. */
export function forecastUv(forecast: PlaceForecast, timeMs: number): UvNow | null {
  const figure = uvFigure(uvAtHour(forecast.times, forecast.uv, timeMs));
  if (!figure) return null;
  const dayStart = localMidnight(timeMs, forecast.zone);
  const dayEnd = addLocalDays(dayStart, 1, forecast.zone);
  return { ...figure, protection: sunProtectionLabel(uvHours(forecast), dayStart, dayEnd, forecast.zone) };
}

export function forecastDaySummaries(forecast: PlaceForecast): DaySummary[] {
  const hours = uvHours(forecast);
  return forecast.days.map((day) => {
    const dayStart = midnightOfDate(day.key, forecast.zone);
    const dayEnd = addLocalDays(dayStart, 1, forecast.zone);
    const figure = uvFigure(day.uvMax);
    return {
      key: day.key,
      weekday: weekdayShort(dayStart + 12 * 3_600_000, forecast.zone),
      dayStart,
      dayEnd,
      hi: day.hi == null ? null : Math.round(day.hi),
      lo: day.lo == null ? null : Math.round(day.lo),
      rain: day.rain,
      icon: day.icon,
      windKt: day.windKt,
      windFrom: day.windFrom,
      uv: figure?.index ?? null,
      protection: figure ? sunProtectionLabel(hours, dayStart, dayEnd, forecast.zone) : null,
    };
  });
}

/** Copy UV onto collector days that share a local date. Other fields stay. */
export function overlayUv(days: DaySummary[], forecast: PlaceForecast): DaySummary[] {
  const byKey = new Map(forecastDaySummaries(forecast).map((day) => [day.key, day]));
  return days.map((day) => {
    const uv = byKey.get(day.key);
    if (!uv) return day;
    return { ...day, uv: uv.uv ?? null, protection: uv.protection ?? null };
  });
}
