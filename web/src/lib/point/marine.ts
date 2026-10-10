/**
 * Open-Meteo Marine (CC BY 4.0) for the point column: surface current, sea-surface
 * temperature, significant wave height and swell. Fetched on tap and cached like
 * the atmospheric profile. Over land the API returns nulls; those stay null.
 */
import { roundedCoordinate } from './openmeteo';

export const MARINE_HOURLY = [
  'sea_surface_temperature', 'ocean_current_velocity', 'ocean_current_direction',
  'wave_height', 'swell_wave_height', 'swell_wave_period', 'swell_wave_direction',
] as const;

const SESSION_PREFIX = 'isobar.point.marine.v1:';
const MAX_MEMORY_ENTRIES = 32;
const CACHE_TTL_MS = 3_600_000;
const MAX_GAP = 3 * 3_600_000;
const KT_PER_KMH = 1 / 1.852;

export interface MarineSample {
  /** Surface current speed, knots. Direction is where the water flows to. */
  currentSpeedKt: number | null;
  currentToDeg: number | null;
  sstC: number | null;
  waveHeightM: number | null;
  swellHeightM: number | null;
  swellPeriodS: number | null;
  /** Direction the swell comes from, degrees. */
  swellFromDeg: number | null;
}

export interface MarineSeries {
  time: number[];
  samples: MarineSample[];
}

export interface MarineLoadOptions {
  mapTimeMs: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

const memoryCache = new Map<string, { series: MarineSeries; fetchedAt: number }>();
const inFlight = new Map<string, symbol>();

export function marineCacheKey(latitude: number, longitude: number, mapTimeMs: number): string {
  const day = new Date(mapTimeMs).toISOString().slice(0, 10);
  return `${SESSION_PREFIX}${roundedCoordinate(latitude).toFixed(1)},${roundedCoordinate(longitude).toFixed(1)}:${day}`;
}

export function marineUrl(latitude: number, longitude: number, mapTimeMs?: number): string {
  const day = new Date(mapTimeMs ?? Date.now()).toISOString().slice(0, 10);
  const end = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    latitude: roundedCoordinate(latitude).toFixed(1),
    longitude: roundedCoordinate(longitude).toFixed(1),
    hourly: MARINE_HOURLY.join(','),
    timezone: 'GMT',
    start_date: day,
    end_date: end,
  });
  return `https://marine-api.open-meteo.com/v1/marine?${params.toString()}`;
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

function emptySample(): MarineSample {
  return { currentSpeedKt: null, currentToDeg: null, sstC: null, waveHeightM: null, swellHeightM: null, swellPeriodS: null, swellFromDeg: null };
}

/** Parse an Open-Meteo Marine response. Null fields stay null; a numeric zero is a reading. */
export function parseMarine(response: unknown): MarineSeries {
  if (!response || typeof response !== 'object') throw new Error('Invalid marine response');
  const hourly = (response as { hourly?: unknown }).hourly;
  if (!hourly || typeof hourly !== 'object') throw new Error('Marine response has no hourly data');
  const record = hourly as Record<string, unknown>;
  const rawTimes = Array.isArray(record.time) ? record.time : [];
  const times = rawTimes.map(stringTime);
  if (!times.length || times.some((time) => time == null)) throw new Error('Marine response has invalid times');
  const valid = times as number[];
  if (valid.some((time, i) => i > 0 && time <= valid[i - 1])) throw new Error('Marine times are not increasing');
  const samples = valid.map((_, i) => {
    const speed = numberAt(record.ocean_current_velocity, i);
    return {
      currentSpeedKt: speed == null ? null : speed * KT_PER_KMH,
      currentToDeg: numberAt(record.ocean_current_direction, i),
      sstC: numberAt(record.sea_surface_temperature, i),
      waveHeightM: numberAt(record.wave_height, i),
      swellHeightM: numberAt(record.swell_wave_height, i),
      swellPeriodS: numberAt(record.swell_wave_period, i),
      swellFromDeg: numberAt(record.swell_wave_direction, i),
    };
  });
  return { time: valid, samples };
}

function lerp(a: number | null, b: number | null, f: number): number | null {
  if (a == null || b == null) return null;
  return a + (b - a) * f;
}

function currentLerp(a: MarineSample, b: MarineSample, f: number): Pick<MarineSample, 'currentSpeedKt' | 'currentToDeg'> {
  if (a.currentSpeedKt == null || b.currentSpeedKt == null || a.currentToDeg == null || b.currentToDeg == null) {
    return { currentSpeedKt: null, currentToDeg: null };
  }
  const rad = Math.PI / 180;
  const u = a.currentSpeedKt * Math.sin(a.currentToDeg * rad) * (1 - f) + b.currentSpeedKt * Math.sin(b.currentToDeg * rad) * f;
  const v = a.currentSpeedKt * Math.cos(a.currentToDeg * rad) * (1 - f) + b.currentSpeedKt * Math.cos(b.currentToDeg * rad) * f;
  const speed = Math.hypot(u, v);
  const to = speed < 0.02 ? (f < 0.5 ? a.currentToDeg : b.currentToDeg) : (Math.atan2(u, v) / rad + 360) % 360;
  return { currentSpeedKt: speed, currentToDeg: to };
}

function mix(a: MarineSample, b: MarineSample, f: number): MarineSample {
  return {
    ...currentLerp(a, b, f),
    sstC: lerp(a.sstC, b.sstC, f),
    waveHeightM: lerp(a.waveHeightM, b.waveHeightM, f),
    swellHeightM: lerp(a.swellHeightM, b.swellHeightM, f),
    swellPeriodS: lerp(a.swellPeriodS, b.swellPeriodS, f),
    swellFromDeg: lerp(a.swellFromDeg, b.swellFromDeg, f),
  };
}

/** Same ≤3 h sample policy as the atmospheric profile. A miss is an empty sample, not zeros. */
export function marineAt(series: MarineSeries | null, timeMs: number): MarineSample | null {
  if (!series || !series.time.length || !Number.isFinite(timeMs)) return null;
  const times = series.time;
  let after = times.findIndex((t) => t >= timeMs);
  const at = (index: number) => series.samples[index] ?? emptySample();
  if (after === 0 || (after > 0 && times[after] === timeMs)) return times[after] - timeMs > MAX_GAP ? null : at(after);
  if (after < 0) {
    const last = times.length - 1;
    return timeMs - times[last] > MAX_GAP ? null : at(last);
  }
  const before = after - 1;
  const t0 = times[before];
  const t1 = times[after];
  if (t1 - t0 <= MAX_GAP) return mix(at(before), at(after), (timeMs - t0) / (t1 - t0));
  const nearest = timeMs - t0 <= t1 - timeMs ? before : after;
  return Math.abs(times[nearest] - timeMs) > MAX_GAP ? null : at(nearest);
}

function storage(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

function remember(key: string, series: MarineSeries, fetchedAt: number) {
  memoryCache.delete(key);
  memoryCache.set(key, { series, fetchedAt });
  while (memoryCache.size > MAX_MEMORY_ENTRIES) memoryCache.delete(memoryCache.keys().next().value as string);
}

function readCache(key: string): MarineSeries | null {
  const found = memoryCache.get(key);
  if (found && Date.now() - found.fetchedAt < CACHE_TTL_MS) return found.series;
  memoryCache.delete(key);
  let saved: string | null = null;
  try { saved = storage()?.getItem(key) ?? null; } catch { return null; }
  if (!saved) return null;
  try {
    const envelope = JSON.parse(saved) as { response?: unknown; fetchedAt?: number };
    if (!envelope.response || typeof envelope.fetchedAt !== 'number' || Date.now() - envelope.fetchedAt >= CACHE_TTL_MS) return null;
    const series = parseMarine(envelope.response);
    remember(key, series, envelope.fetchedAt);
    return series;
  } catch { return null; }
}

function writeCache(key: string, series: MarineSeries, raw: unknown, fetchedAt: number) {
  remember(key, series, fetchedAt);
  try {
    const store = storage();
    if (!store) return;
    store.setItem(key, JSON.stringify({ response: raw, fetchedAt }));
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) { const stored = store.key(i); if (stored?.startsWith(SESSION_PREFIX)) keys.push(stored); }
    while (keys.length > MAX_MEMORY_ENTRIES) store.removeItem(keys.shift()!);
  } catch { /* private mode or quota: memory remains useful */ }
}

export async function loadMarine(latitude: number, longitude: number, options: MarineLoadOptions): Promise<MarineSeries> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error('Invalid point coordinates');
  const key = marineCacheKey(latitude, longitude, options.mapTimeMs);
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const cached = readCache(key);
  if (cached) return cached;
  const requestId = Symbol(key);
  inFlight.set(key, requestId);
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(marineUrl(latitude, longitude, options.mapTimeMs), { signal: options.signal });
    if (!response.ok) throw new Error(`Marine request failed (${response.status})`);
    const raw = await response.json();
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const series = parseMarine(raw);
    if (inFlight.get(key) === requestId) writeCache(key, series, raw, Date.now());
    return series;
  } finally {
    if (inFlight.get(key) === requestId) inFlight.delete(key);
  }
}

export function clearMarineCache(): void {
  memoryCache.clear();
  const store = storage();
  if (!store) return;
  try { for (let i = store.length - 1; i >= 0; i--) { const key = store.key(i); if (key?.startsWith(SESSION_PREFIX)) store.removeItem(key); } } catch { /* storage may be unavailable */ }
}
