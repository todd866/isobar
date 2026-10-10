/** Compact coastal forecast data for the Kite and Surf lenses. */

export interface CoastalHour {
  time: number;
  windKt: number | null;
  gustKt: number | null;
  windFrom: number | null;
  daylight: boolean | null;
  waveHeightM: number | null;
  swellHeightM: number | null;
  swellPeriodS: number | null;
  swellFrom: number | null;
  secondaryHeightM: number | null;
  secondaryPeriodS: number | null;
  secondaryFrom: number | null;
  seaTempC: number | null;
}

export interface CoastalForecast { hours: CoastalHour[]; zone: string; }

export interface CoastalLoadOptions {
  nowMs: number;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

const PREFIX = 'isobar.coastal.forecast.v1:';
const MAX_ENTRIES = 32;
const TTL_MS = 3_600_000;
const memory = new Map<string, { forecast: CoastalForecast; fetchedAt: number }>();
interface Pending { controller: AbortController; promise: Promise<CoastalForecast>; subscribers: number; releaseScheduled: boolean; }
const inFlight = new Map<string, Pending>();

function validCoordinate(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

export function coastalCoordinate(value: number): number { return Math.round(value * 100) / 100; }

function requestDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function coastalCacheKey(latitude: number, longitude: number, nowMs: number, kind: 'wind' | 'marine'): string {
  return `${PREFIX}${kind}:${coastalCoordinate(latitude).toFixed(2)},${coastalCoordinate(longitude).toFixed(2)}:${requestDay(nowMs)}`;
}

const WIND_HOURLY = ['wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'is_day'];
const MARINE_HOURLY = ['wave_height', 'swell_wave_height', 'swell_wave_period', 'swell_wave_direction', 'secondary_swell_wave_height', 'secondary_swell_wave_period', 'secondary_swell_wave_direction', 'sea_surface_temperature'];

function urlFor(latitude: number, longitude: number, nowMs: number, kind: 'wind' | 'marine'): string {
  const params = new URLSearchParams({
    latitude: coastalCoordinate(latitude).toFixed(2), longitude: coastalCoordinate(longitude).toFixed(2),
    hourly: (kind === 'wind' ? WIND_HOURLY : MARINE_HOURLY).join(','),
    timezone: 'auto', timeformat: 'unixtime', forecast_hours: '96',
    cell_selection: kind === 'wind' ? 'nearest' : 'sea',
  });
  if (kind === 'wind') params.set('wind_speed_unit', 'kn');
  return `${kind === 'wind' ? 'https://api.open-meteo.com/v1/forecast' : 'https://marine-api.open-meteo.com/v1/marine'}?${params.toString()}`;
}

export function coastalWindUrl(latitude: number, longitude: number, nowMs?: number): string { return urlFor(latitude, longitude, nowMs ?? Date.now(), 'wind'); }
export function coastalMarineUrl(latitude: number, longitude: number, nowMs?: number): string { return urlFor(latitude, longitude, nowMs ?? Date.now(), 'marine'); }

function finite(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function nonNegative(value: unknown): number | null { const n = finite(value); return n != null && n >= 0 ? n : null; }
function direction(value: unknown): number | null { const n = finite(value); return n != null && n >= 0 && n <= 360 ? n === 360 ? 0 : n : null; }
function boolDay(value: unknown): boolean | null { const n = finite(value); return n === 0 ? false : n === 1 ? true : null; }

function timestamp(value: unknown): number | null {
  const n = finite(value);
  if (n != null) return n < 10_000_000_000 ? n * 1000 : n;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function arrayAt(record: Record<string, unknown>, name: string, index: number): unknown { return Array.isArray(record[name]) ? record[name][index] : null; }

function validZone(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'UTC';
  try { Intl.DateTimeFormat(undefined, { timeZone: value }).format(); return value; } catch { return 'UTC'; }
}

function checkUnits(root: Record<string, unknown>, kind: 'wind' | 'marine'): void {
  if (!root.hourly_units || typeof root.hourly_units !== 'object') return;
  const units = root.hourly_units as Record<string, unknown>;
  const accepted: Record<string, string[]> = kind === 'wind'
    ? { wind_speed_10m: ['kn', 'kt'], wind_gusts_10m: ['kn', 'kt'], wind_direction_10m: ['°', 'deg'], is_day: [''] }
    : {
      wave_height: ['m'], swell_wave_height: ['m'], secondary_swell_wave_height: ['m'],
      swell_wave_period: ['s'], secondary_swell_wave_period: ['s'],
      swell_wave_direction: ['°', 'deg'], secondary_swell_wave_direction: ['°', 'deg'], sea_surface_temperature: ['°C', 'C'],
    };
  for (const [name, values] of Object.entries(accepted)) {
    const supplied = units[name];
    if (supplied !== undefined && (typeof supplied !== 'string' || !values.includes(supplied))) throw new Error(`Invalid coastal unit for ${name}`);
  }
}

export function parseCoastalForecast(response: unknown, kind: 'wind' | 'marine'): CoastalForecast {
  if (!response || typeof response !== 'object') throw new Error('Invalid coastal response');
  const root = response as Record<string, unknown>;
  if (!root.hourly || typeof root.hourly !== 'object') throw new Error('Coastal response has no hourly data');
  checkUnits(root, kind);
  const hourly = root.hourly as Record<string, unknown>;
  const rawTimes = Array.isArray(hourly.time) ? hourly.time : [];
  const times = rawTimes.map(timestamp);
  if (!times.length || times.some((value) => value == null)) throw new Error('Coastal response has invalid times');
  const validTimes = times as number[];
  if (validTimes.some((time, index) => index > 0 && time <= validTimes[index - 1])) throw new Error('Coastal times are not increasing');
  const zone = validZone(root.timezone);
  const hours = validTimes.map((time, index): CoastalHour => ({
    time,
    windKt: kind === 'wind' ? nonNegative(arrayAt(hourly, 'wind_speed_10m', index)) : null,
    gustKt: kind === 'wind' ? nonNegative(arrayAt(hourly, 'wind_gusts_10m', index)) : null,
    windFrom: kind === 'wind' ? direction(arrayAt(hourly, 'wind_direction_10m', index)) : null,
    daylight: kind === 'wind' ? boolDay(arrayAt(hourly, 'is_day', index)) : null,
    waveHeightM: kind === 'marine' ? nonNegative(arrayAt(hourly, 'wave_height', index)) : null,
    swellHeightM: kind === 'marine' ? nonNegative(arrayAt(hourly, 'swell_wave_height', index)) : null,
    swellPeriodS: kind === 'marine' ? nonNegative(arrayAt(hourly, 'swell_wave_period', index)) : null,
    swellFrom: kind === 'marine' ? direction(arrayAt(hourly, 'swell_wave_direction', index)) : null,
    secondaryHeightM: kind === 'marine' ? nonNegative(arrayAt(hourly, 'secondary_swell_wave_height', index)) : null,
    secondaryPeriodS: kind === 'marine' ? nonNegative(arrayAt(hourly, 'secondary_swell_wave_period', index)) : null,
    secondaryFrom: kind === 'marine' ? direction(arrayAt(hourly, 'secondary_swell_wave_direction', index)) : null,
    seaTempC: kind === 'marine' ? finite(arrayAt(hourly, 'sea_surface_temperature', index)) : null,
  }));
  return { hours, zone };
}

function storage(): Storage | null { try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; } }

function remember(key: string, forecast: CoastalForecast, fetchedAt: number): void {
  memory.delete(key); memory.set(key, { forecast, fetchedAt });
  while (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value as string);
}

function readCache(key: string): CoastalForecast | null {
  const hit = memory.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.forecast;
  memory.delete(key);
  try {
    const saved = storage()?.getItem(key);
    if (!saved) return null;
    const envelope = JSON.parse(saved) as { response?: unknown; fetchedAt?: number; kind?: 'wind' | 'marine' };
    if (!envelope.response || typeof envelope.fetchedAt !== 'number' || Date.now() - envelope.fetchedAt >= TTL_MS || !envelope.kind) return null;
    const parsed = parseCoastalForecast(envelope.response, envelope.kind);
    remember(key, parsed, envelope.fetchedAt); return parsed;
  } catch { return null; }
}

async function load(latitude: number, longitude: number, options: CoastalLoadOptions, kind: 'wind' | 'marine'): Promise<CoastalForecast> {
  if (!validCoordinate(latitude, longitude)) throw new Error('Invalid point coordinates');
  if (!Number.isFinite(options.nowMs)) throw new Error('Invalid forecast time');
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const key = coastalCacheKey(latitude, longitude, options.nowMs, kind);
  const cached = readCache(key); if (cached) return cached;
  let pending = inFlight.get(key);
  if (pending?.controller.signal.aborted) {
    if (inFlight.get(key) === pending) inFlight.delete(key);
    pending = undefined;
  }
  if (!pending) {
    const controller = new AbortController();
    const entry = { controller, subscribers: 0, releaseScheduled: false } as Pending;
    entry.promise = (async () => {
      try {
        const response = await (options.fetcher ?? fetch)(urlFor(latitude, longitude, options.nowMs, kind), { signal: controller.signal });
        if (!response.ok) throw new Error(`Coastal request failed (${response.status})`);
        const raw = await response.json();
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const fetchedAt = Date.now(); const parsed = parseCoastalForecast(raw, kind);
        if (inFlight.get(key) === entry && !controller.signal.aborted) {
          remember(key, parsed, fetchedAt);
          try {
            const store = storage();
            if (store) {
              store.setItem(key, JSON.stringify({ response: raw, fetchedAt, kind }));
              const keys: string[] = [];
              for (let i = 0; i < store.length; i += 1) { const stored = store.key(i); if (stored?.startsWith(PREFIX)) keys.push(stored); }
              while (keys.length > MAX_ENTRIES) store.removeItem(keys.shift()!);
            }
          } catch { /* private mode or quota: memory remains useful */ }
        }
        return parsed;
      } finally { if (inFlight.get(key) === entry) inFlight.delete(key); }
    })();
    // If every subscriber aborts, the underlying rejection still has a handler.
    entry.promise.catch(() => {});
    pending = entry;
    inFlight.set(key, entry);
  }
  return subscribe(pending, options.signal);
}

function subscribe(pending: Pending, signal?: AbortSignal): Promise<CoastalForecast> {
  if (signal?.aborted) {
    scheduleAbort(pending);
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  pending.subscribers += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    pending.subscribers -= 1;
    scheduleAbort(pending);
  };
  return new Promise<CoastalForecast>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const finish = (callback: () => void) => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      release(); callback();
    };
    onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.promise.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

function scheduleAbort(pending: Pending): void {
  if (pending.subscribers !== 0 || pending.releaseScheduled) return;
  pending.releaseScheduled = true;
  queueMicrotask(() => {
    pending.releaseScheduled = false;
    if (pending.subscribers === 0 && !pending.controller.signal.aborted) pending.controller.abort();
  });
}

export function loadCoastalWind(latitude: number, longitude: number, options: CoastalLoadOptions): Promise<CoastalForecast> { return load(latitude, longitude, options, 'wind'); }
export function loadCoastalMarine(latitude: number, longitude: number, options: CoastalLoadOptions): Promise<CoastalForecast> { return load(latitude, longitude, options, 'marine'); }

export function clearCoastalForecastCache(): void {
  memory.clear();
  for (const pending of inFlight.values()) pending.controller.abort();
  inFlight.clear();
  try { const store = storage(); if (store) for (let i = store.length - 1; i >= 0; i -= 1) { const key = store.key(i); if (key?.startsWith(PREFIX)) store.removeItem(key); } } catch { /* storage may be unavailable */ }
}
