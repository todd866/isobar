/** Offline historical weather/map catalogue primitives. The browser only reads
 * prepared public assets; this module deliberately has no live API fallback. */

export interface HistoricalDay {
  date: string;
  label?: string;
  weather?: string;
  map?: string;
  complete?: boolean;
}

export interface HistoricalCollection {
  id: string;
  title: string;
  description?: string;
  manifest: string;
  days: HistoricalDay[];
}

export interface HistoricalCatalog {
  schema_version: number;
  collections: HistoricalCollection[];
}

export interface HistoricalWeatherFrame {
  time: string;
  pressure_msl: number[];
  u: number[];
  v: number[];
  temperature?: number[];
}

export interface HistoricalWeather {
  schema_version: number;
  product: 'isobar-historical-weather' | string;
  event?: { id?: string; label?: string; start_date?: string; end_date?: string };
  model?: string;
  grid: {
    latitudes: number[];
    longitudes: number[];
    nx: number;
    ny: number;
    order?: string;
    step_degrees?: number;
  };
  times: string[];
  units?: { pressure_msl?: string; u?: string; v?: string; temperature?: string };
  frames: HistoricalWeatherFrame[];
  provenance?: {
    provider?: string;
    dataset?: string;
    source?: string;
    license?: string;
    sampling_limitations?: string;
    retrieved_at?: string;
  };
}

export interface HistoricalManifest {
  schema_version?: number;
  collection?: Pick<HistoricalCollection, 'id' | 'title' | 'description'>;
  weather?: string | HistoricalWeather;
  maps?: Array<{ id?: string; title?: string; url: string; attribution?: string; source?: string }>;
  days?: HistoricalDay[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function normalizeCatalog(raw: unknown): HistoricalCatalog {
  const source = isRecord(raw) ? raw : {};
  const collectionSource = Array.isArray(source.collections) ? source.collections : [];
  const collections = collectionSource.flatMap((item): HistoricalCollection[] => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const title = stringValue(item.title);
    const manifest = stringValue(item.manifest) ?? stringValue(item.url);
    if (!id || !title || !manifest) return [];
    const days = normalizeDays(item.days);
    return [{ id, title, manifest, days, description: stringValue(item.description) }];
  });
  return { schema_version: typeof source.schema_version === 'number' ? source.schema_version : 1, collections };
}

export function normalizeDays(raw: unknown): HistoricalDay[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): HistoricalDay[] => {
    if (!isRecord(item) || !validDate(item.date)) return [];
    return item.complete === true ? [{ date: item.date, label: stringValue(item.label), weather: stringValue(item.weather), map: stringValue(item.map), complete: true }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export function availableDays(collection: HistoricalCollection): HistoricalDay[] {
  return collection.days.filter((day) => day.complete === true);
}

/** Only a full set of 24 distinct hourly UTC frames makes a day available. */
export function availableDaysForWeather(collection: HistoricalCollection, weather: HistoricalWeather | null): HistoricalDay[] {
  if (!weather) return [];
  const dates = new Map<string,Set<string>>();
  for(const frame of weather.frames){const day=frame.time.slice(0,10);if(!dates.has(day))dates.set(day,new Set());dates.get(day)!.add(frame.time.slice(11,13));}
  return availableDays(collection).filter((day) => dates.get(day.date)?.size===24);
}

export function normalizeWeather(raw: unknown): HistoricalWeather | null {
  if (!isRecord(raw) || raw.schema_version !== 1 || raw.product !== 'isobar-historical-weather' || !isRecord(raw.grid) || !Array.isArray(raw.frames) || !Array.isArray(raw.times)) return null;
  const grid = raw.grid;
  const nx = typeof grid.nx === 'number' ? grid.nx : NaN;
  const ny = typeof grid.ny === 'number' ? grid.ny : NaN;
  const count = nx * ny;
  if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 2 || ny < 2 || !Number.isInteger(count) || count > 300_000) return null;
  if (!Array.isArray(grid.latitudes) || !Array.isArray(grid.longitudes)) return null;
  const times = raw.times.filter((value): value is string => typeof value === 'string');
  if (times.length !== raw.times.length) return null;
  if (!grid.latitudes.every((value) => typeof value === 'number' && Number.isFinite(value)) || !grid.longitudes.every((value) => typeof value === 'number' && Number.isFinite(value)) || grid.latitudes.length !== ny || grid.longitudes.length !== nx) return null;
  if (!isRecord(raw.units) || raw.units.pressure_msl !== 'hPa' || raw.units.u !== 'knots' || raw.units.v !== 'knots') return null;
  const step = typeof grid.step_degrees === 'number' && Number.isFinite(grid.step_degrees) && grid.step_degrees > 0 ? grid.step_degrees : NaN;
  const uniform = (values: number[], descending = false) => values.every((value, index) => index === 0 || (descending ? values[index - 1]! - value : value - values[index - 1]!) > 0 && Math.abs((descending ? values[index - 1]! - value : value - values[index - 1]!) - step) < 1e-6);
  if (!Number.isFinite(step) || !uniform(grid.latitudes, true) || !uniform(grid.longitudes) || grid.latitudes.some((value) => value < -90 || value > 90) || grid.longitudes.some((value) => value < -180 || value > 180)) return null;
  if (!times.every((time) => /^\d{4}-\d{2}-\d{2}T\d{2}:00Z$/.test(time) && validDate(time.slice(0,10)) && !Number.isNaN(Date.parse(time)))) return null;
  const parsedTimes = times.map((time) => Date.parse(time));
  if (parsedTimes.some((time, index) => index > 0 && time <= parsedTimes[index - 1]!)) return null;
  const frames = raw.frames.filter((frame): frame is HistoricalWeatherFrame => isRecord(frame)
    && typeof frame.time === 'string' && !Number.isNaN(Date.parse(frame.time))
    && Array.isArray(frame.pressure_msl) && Array.isArray(frame.u) && Array.isArray(frame.v)
    && frame.pressure_msl.every((value) => typeof value === 'number' && Number.isFinite(value))
    && frame.u.every((value) => typeof value === 'number' && Number.isFinite(value))
    && frame.v.every((value) => typeof value === 'number' && Number.isFinite(value)));
  if (!frames.length || frames.length !== times.length) return null;
  if (frames.some((frame) => frame.pressure_msl.length !== count || frame.u.length !== count || frame.v.length !== count)) return null;
  const hasTemperature = frames.some((frame) => frame.temperature !== undefined);
  if (hasTemperature && (raw.units.temperature !== '°C' || frames.some((frame) => !Array.isArray(frame.temperature) || frame.temperature.length !== count || frame.temperature.some((value) => typeof value !== 'number' || !Number.isFinite(value))))) return null;
  if (frames.some((frame, index) => frame.time !== times[index])) return null;
  return raw as unknown as HistoricalWeather;
}

export function normalizeManifest(raw: unknown): HistoricalManifest {
  if (!isRecord(raw)) return {};
  if (raw.product === 'isobar-historical-weather') {
    const weather = normalizeWeather(raw);
    if (!weather) throw new Error('Historical weather payload is invalid');
    return { weather };
  }
  const collection = isRecord(raw.collection) && stringValue(raw.collection.id) && stringValue(raw.collection.title)
    ? { id: stringValue(raw.collection.id) as string, title: stringValue(raw.collection.title) as string, description: stringValue(raw.collection.description) }
    : undefined;
  const maps = Array.isArray(raw.maps) ? raw.maps.flatMap((item) => {
    if (!isRecord(item) || !stringValue(item.url)) return [];
    return [{ id: stringValue(item.id), title: stringValue(item.title), url: stringValue(item.url) as string, attribution: stringValue(item.attribution), source: stringValue(item.source) }];
  }) : undefined;
  return {
    schema_version: typeof raw.schema_version === 'number' ? raw.schema_version : undefined,
    collection,
    weather: typeof raw.weather === 'string' ? raw.weather : normalizeWeather(raw.weather) ?? undefined,
    maps,
    days: normalizeDays(raw.days),
  };
}

export function frameAt(weather: HistoricalWeather, time: string | number): HistoricalWeatherFrame | null {
  if (!weather.frames.length) return null;
  const target = typeof time === 'number' ? time : Date.parse(time);
  if (!Number.isFinite(target)) return weather.frames[0] ?? null;
  let best = weather.frames[0];
  let distance = Math.abs(Date.parse(best.time) - target);
  for (const frame of weather.frames.slice(1)) {
    const next = Math.abs(Date.parse(frame.time) - target);
    if (next < distance) { best = frame; distance = next; }
  }
  return best;
}

export function utcDateLabel(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(value.getTime()) ? date : new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(value);
}

export function utcTimeLabel(time: string): string {
  const value = new Date(time);
  return Number.isNaN(value.getTime()) ? time : new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }).format(value).replace(',', '') + 'Z';
}

export async function fetchCatalog(url = '/history/catalog.json'): Promise<HistoricalCatalog> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Historical catalogue unavailable (${response.status})`);
  return normalizeCatalog(await response.json());
}

export async function fetchManifest(url: string): Promise<HistoricalManifest> {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Historical collection unavailable (${response.status})`);
  return normalizeManifest(await response.json());
}

export async function fetchWeather(source: string | HistoricalWeather): Promise<HistoricalWeather | null> {
  if (typeof source !== 'string') {
    const weather = normalizeWeather(source);
    if (!weather) throw new Error('Historical weather payload is invalid');
    return weather;
  }
  const response = await fetch(source, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Historical weather unavailable (${response.status})`);
  const weather = normalizeWeather(await response.json());
  if (!weather) throw new Error('Historical weather payload is invalid');
  return weather;
}
