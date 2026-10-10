import { chartFrame, type LoadedChart } from './chart-store';
import { parseCoast, simplifyCoast, type Coast } from './coast';
import { parseWater } from './water';
import { fetchCatalog, fetchManifest, fetchWeather, availableDaysForWeather, type HistoricalCatalog, type HistoricalCollection, type HistoricalDay, type HistoricalWeather } from './history';
import { quantise } from './quantise';
import type { ChartManifest, VariableSpec } from './manifest';

export interface HistoricalChartResult {
  chart: LoadedChart;
  collection: HistoricalCollection;
  day: HistoricalDay;
  initialMs: number;
  catalog: HistoricalCatalog;
}

const MAX_FRAMES = 168;
const MAX_CELLS = 4_000_000;

const scales: Record<string, VariableSpec> = {
  mslp: { file: null, frames: null, encoding: 'raw', units: 'hPa', scale: 0.1, offset: 0, fill: 65535 },
  u10: { file: null, frames: null, encoding: 'raw', units: 'knots', scale: 0.1, offset: -3276.8, fill: 65535 },
  v10: { file: null, frames: null, encoding: 'raw', units: 'knots', scale: 0.1, offset: -3276.8, fill: 65535 },
  wind: { file: null, frames: null, encoding: 'raw', units: 'knots', scale: 0.1, offset: 0, fill: 65535 },
  t2m: { file: null, frames: null, encoding: 'raw', units: '°C', scale: 0.1, offset: -300, fill: 65535 },
};

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`Historical ${name} contains non-finite data`);
  return value;
}

function encode(values: readonly number[], spec: VariableSpec): Uint16Array {
  const output = new Uint16Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = finite(values[index]!, spec.units);
    const raw = quantise(value, spec);
    if (raw === spec.fill) throw new Error(`Historical ${spec.units} value is outside renderer range`);
    output[index] = raw;
  }
  return output;
}

function frameHours(times: string[]): number[] {
  const first = Date.parse(times[0]!);
  return times.map((time) => {
    const hour = (Date.parse(time) - first) / 3_600_000;
    if (!Number.isFinite(hour) || hour < 0) throw new Error('Historical frame times are invalid');
    return hour;
  });
}

/** Convert a validated normalized archive payload into the shared renderer contract. */
export function historicalToChart(weather: HistoricalWeather, coast: Coast, eventId?: string): LoadedChart {
  const { nx, ny } = weather.grid;
  const cells = nx * ny;
  if (weather.units?.pressure_msl !== 'hPa' || weather.units.u !== 'knots' || weather.units.v !== 'knots') throw new Error('Historical pressure or wind units are invalid');
  if (!Number.isInteger(cells) || cells < 1 || cells * weather.frames.length > MAX_CELLS) throw new Error('Historical chart exceeds renderer cell budget');
  if (!weather.frames.length || weather.frames.length > MAX_FRAMES) throw new Error('Historical chart has too many frames');
  if (weather.frames.length !== weather.times.length) throw new Error('Historical frame/time lengths differ');
  if (weather.times.some((time, index) => !Number.isFinite(Date.parse(time)) || (index > 0 && Date.parse(time) <= Date.parse(weather.times[index - 1]!)))) throw new Error('Historical frame times are invalid');
  const hours = frameHours(weather.times);
  const packed: Record<string, Uint16Array> = { mslp: new Uint16Array(cells * hours.length), u10: new Uint16Array(cells * hours.length), v10: new Uint16Array(cells * hours.length), wind: new Uint16Array(cells * hours.length) };
  const hasTemperature = weather.frames.some((frame) => frame.temperature !== undefined);
  if (hasTemperature && (weather.units?.temperature !== '°C' || weather.frames.some((frame) => !frame.temperature || frame.temperature.length !== cells))) throw new Error('Historical temperature units or data are invalid');
  if (hasTemperature) packed.t2m = new Uint16Array(cells * hours.length);
  weather.frames.forEach((frame, index) => {
    if (frame.pressure_msl.length !== cells || frame.u.length !== cells || frame.v.length !== cells) throw new Error('Historical frame cell count differs from grid');
    if (frame.time !== weather.times[index]) throw new Error('Historical frame time does not match times');
    const offset = index * cells;
    packed.mslp.set(encode(frame.pressure_msl, scales.mslp), offset);
    packed.u10.set(encode(frame.u, scales.u10), offset);
    packed.v10.set(encode(frame.v, scales.v10), offset);
    packed.wind.set(encode(frame.u.map((u, cell) => Math.hypot(finite(u, 'wind'), finite(frame.v[cell]!, 'wind'))), scales.wind), offset);
    if (hasTemperature) packed.t2m!.set(encode(frame.temperature!, scales.t2m), offset);
  });
  const variables: Record<string, VariableSpec> = { mslp: scales.mslp, wind: scales.wind, u10: scales.u10, v10: scales.v10 };
  if (hasTemperature) variables.t2m = scales.t2m;
  const historicalPlace = (eventId ?? weather.event?.id) === 'dday'
    ? { id: 'h.normandy', name: 'Normandy', zone: 'Europe/Paris', lat: 49.35, lon: -0.85, icao: '' }
    : (eventId ?? weather.event?.id) === 'cyclone-tracy' ? { id: 'h.darwin', name: 'Darwin', zone: 'Australia/Darwin', lat: -12.46, lon: 130.84, icao: '' }
    : { id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.8688, lon: 151.2093, icao: 'YSSY' };
  const manifest: ChartManifest = {
    schema: 2, contract: 'isobar-web', run: weather.times[0]!, generated: weather.provenance?.retrieved_at ?? weather.times[0]!, forecastHours: hours,
    uniformStepHours: hours.length > 1 && hours.every((value, index) => index === 0 || value - hours[index - 1]! === hours[1]! - hours[0]!) ? hours[1]! - hours[0]! : null,
    nx, ny, west: weather.grid.longitudes[0]!, east: weather.grid.longitudes[weather.grid.longitudes.length - 1]!, north: weather.grid.latitudes[0]!, south: weather.grid.latitudes[weather.grid.latitudes.length - 1]!, step: weather.grid.step_degrees ?? 1,
    wrapsLongitude: Math.abs(nx * (weather.grid.step_degrees ?? 0) - 360) < 1e-6, dtype: 'uint16', variables, places: [historicalPlace], aviation: '', points: null,
    attribution: [{ source: weather.provenance?.source ?? weather.provenance?.provider ?? 'Historical weather archive', licence: weather.provenance?.license ?? 'Source licence recorded in archive provenance' }],
  };
  const state: Record<string, Uint8Array> = {};
  for (const name of Object.keys(packed)) state[name] = new Uint8Array(hours.length).fill(1);
  return { manifest, packed, state, coast, coastLod: [coast, simplifyCoast(coast, 0.25)], water: parseWater(null, null), aviation: null, points: null, listeners: new Set(), complete: Promise.resolve(), want: async () => undefined };
}

async function getBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Historical coast unavailable (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function loadHistoricalChart(selection: { event?: string; date?: string; hour?: number } = {}): Promise<HistoricalChartResult> {
  if (selection.hour !== undefined && (!Number.isInteger(selection.hour) || selection.hour < 0 || selection.hour > 23)) throw new Error('Historical hour must be 0–23');
  const catalog = await fetchCatalog();
  const requested = selection.event ? catalog.collections.find((item) => item.id === selection.event) : catalog.collections.find((item) => item.id === 'dday') ?? catalog.collections[0];
  if (!requested) throw new Error('Historical collection unavailable');
  const manifest = await fetchManifest(requested.manifest);
  const manifestDays = manifest.days ?? [];
  const availableDay = (selection.date ? [...requested.days, ...manifestDays].find((item) => item.date === selection.date) : [...requested.days, ...manifestDays].find((item) => item.complete)) ?? null;
  const weatherSource = availableDay?.weather ?? manifest.weather;
  if (!weatherSource) throw new Error('Historical weather unavailable');
  const weather = await fetchWeather(weatherSource);
  if (!weather) throw new Error('Historical weather unavailable');
  if (weather.event?.id && weather.event.id !== requested.id) throw new Error('Historical weather event does not match collection');
  const days = availableDaysForWeather({ ...requested, days: [...requested.days, ...manifestDays] }, weather);
  const day = days.find((item) => item.date === selection.date) ?? (selection.date ? undefined : days[0]);
  if (!day) throw new Error('Requested historical date is unavailable');
  const frame = weather.frames.find((item) => item.time.slice(0, 10) === day.date && Number(item.time.slice(11, 13)) === (selection.hour ?? 0));
  if (!frame) throw new Error('Requested historical hour is unavailable');
  const coast = parseCoast(await getBytes('/history/world-coast.bin'));
  return { chart: historicalToChart(weather, coast, requested.id), collection: requested, day, initialMs: Date.parse(frame.time), catalog };
}

export { chartFrame };
