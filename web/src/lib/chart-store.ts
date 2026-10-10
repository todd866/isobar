import type {HistoricalCyclone} from './historical-cyclone';
import { decodeUint16 } from './quantise';
import { decodeFrameBytes } from './frame-codec';
import { parseCoast, simplifyCoast, type Coast } from './coast';
import { parseWater, type Water } from './water';
import { frameBlend } from './interpolate';
import { readPoints, type PointsFile } from './points';
import { readManifest, packedBytes, type ChartManifest, type VariableSpec } from './manifest';

export interface AviationAirport {
  icao: string;
  name: string;
  zone: string;
  lat: number;
  lon: number;
  metar: { raw: string; time: string | null } | null;
  taf: { raw: string; issue: string | null; from: string | null; to: string | null } | null;
}

export interface AviationFile {
  airports: AviationAirport[];
  sigmets: {
    fir: string;
    hazard: string;
    qualifier: string;
    base: number | null;
    top: number | null;
    raw: string;
    from: string | null;
    to: string | null;
  }[];
}

/** Per-frame load state. A pending frame is not missing: it just has not arrived. */
export const FRAME_PENDING = 0;
export const FRAME_READY = 1;
export const FRAME_MISSING = 2;
/** A listed frame could not be fetched/decoded. Retry is explicit, never a render-loop poll. */
export const FRAME_FAILED = 3;

export interface LoadedChart {
  cyclone?: HistoricalCyclone;
  manifest: ChartManifest;
  /** Batch/legacy storage. Interactive callers use chartFrame rather than assuming a whole variable. */
  packed: Record<string, Uint16Array>;
  /** Interactive charts keep individual frames; packed remains for legacy consumers/fixtures. */
  frames?: Record<string, Map<number, Uint16Array>>;
  state: Record<string, Uint8Array>;
  coast: Coast;
  coastLod: Coast[];
  /** Lakes and rivers. Empty when the water files are missing; the coast still draws. */
  water: Water;
  aviation: AviationFile | null;
  points: PointsFile | null;
  /** Called after each frame or file settles. */
  listeners: Set<() => void>;
  /** Initial preparation and aviation have settled; later wants resolve their own current blend. */
  complete: Promise<void>;
  /**
   * Requests a reader's current blend. Batch charts also queue the rest of
   * that variable; interactive charts retain only their bounded window.
   * Resolves once the two frames bracketing `minute` (default: now at open) have settled.
   */
  want: (name: string, minute?: number, priority?: 'lens') => Promise<void>;
  /** Replace the map's current demand. Neighbouring times are prepared within a bounded cache. */
  prepare?: (minute: number, names: string[]) => void;
  retry?: (minute: number, names: string[]) => void;
  cacheStats?: () => { bytes: number; frames: number; queued: number; active: number; limit: number };
}

export type Fetcher = (url: string) => Promise<Uint8Array | null>;

export interface LoadOptions {
  /** Wall clock that picks the first frames. Defaults to Date.now(). */
  nowMs?: number;
  /** The colour field the page opens with; its frames load right after MSLP's. */
  field?: string;
  fetchBytes?: Fetcher;
  /** Parallel background requests. */
  concurrency?: number;
  /**
   * 'all' (default) materializes every variable for offline/export consumers.
   * 'opened' retains individual frames within cacheBytes. prepare replaces the
   * map's current/nearby window; want loads only an explicit reader's blend.
   */
  fields?: 'all' | 'opened';
  /** Retained packed frame bytes for interactive charts (default 32 MiB). */
  cacheBytes?: number;
}

let loading: Promise<LoadedChart | null> | null = null;

const defaultFetch: Fetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
};

const FIELD_VARIABLE: Record<string, string> = { rain: 'rain24', temp: 't2m', wind: 'wind' };

/** Forecast minute (from the first listed hour) that matches the wall clock, clamped to the run. */
export function nowMinuteOf(manifest: ChartManifest, nowMs: number): number {
  const hours = manifest.forecastHours;
  const span = (hours[hours.length - 1] - hours[0]) * 60;
  const lead = (nowMs - Date.parse(manifest.run)) / 60000 - hours[0] * 60;
  return Math.min(span, Math.max(0, Number.isFinite(lead) ? lead : 0));
}

/** The two frames that bracket the wall clock: all the first paint needs. */
export function firstPaintFrames(manifest: ChartManifest, nowMs: number): number[] {
  const blend = frameBlend(manifest.forecastHours, manifest.forecastHours[0] * 60 + nowMinuteOf(manifest, nowMs));
  if (!blend) return [0];
  return blend.i0 === blend.i1 ? [blend.i0] : [blend.i0, blend.i1];
}

/**
 * Every frame, in the order the page wants them: MSLP at now, the open field
 * at now, then outward from now (forward first, the way playback drifts), MSLP
 * before u10/v10 at each index, then the remaining fields.
 */
export function loadOrder(manifest: ChartManifest, nowMs: number, field?: string): [string, number][] {
  const first = firstPaintFrames(manifest, nowMs);
  const count = manifest.forecastHours.length;
  const low = first[0];
  const high = first[first.length - 1];
  const distance = (index: number) => (index > high ? index - high : (low - index) + 0.5);
  const outward = Array.from({ length: count }, (_, index) => index)
    .filter((index) => !first.includes(index))
    .sort((a, b) => distance(a) - distance(b));
  const opened = field ? FIELD_VARIABLE[field] : undefined;
  const components = ['u10', 'v10'].filter((name) => manifest.variables[name]);
  const names = ['mslp', ...(opened ? [opened] : []), ...Object.keys(manifest.variables)
    .filter((name) => name !== 'mslp' && name !== opened)];
  const order: [string, number][] = [];
  for (const index of first) for (const name of ['mslp', ...(opened ? [opened] : []), ...components]) order.push([name, index]);
  for (const index of outward) for (const name of ['mslp', ...components]) order.push([name, index]);
  if (opened) order.push(...outward.map((index): [string, number] => [opened, index]));
  for (const name of names.slice(opened ? 2 : 1)) {
    if (components.includes(name)) continue;
    for (const index of [...first, ...outward]) order.push([name, index]);
  }
  return order;
}

export function loadChart(options: LoadOptions = {}): Promise<LoadedChart | null> {
  if (!loading) loading = openChart(options);
  return loading;
}

function frameUrl(manifest: ChartManifest, file: string): string {
  return `/data/${file}?run=${encodeURIComponent(manifest.run)}`;
}

/**
 * Resolves as soon as the manifest, the coastline and the MSLP frames at the
 * wall clock are in. Everything else streams in behind it; watch `listeners`
 * and `state`.
 */
export async function openChart(options: LoadOptions = {}): Promise<LoadedChart | null> {
  const fetchBytes = options.fetchBytes ?? defaultFetch;
  const nowMs = options.nowMs ?? Date.now();
  const manifestBytes = await fetchBytes('/data/manifest.json');
  if (!manifestBytes) return null;
  const manifest = readManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
  const count = manifest.forecastHours.length;
  const cells = manifest.nx * manifest.ny;
  const packed: Record<string, Uint16Array> = {};
  const frames: Record<string, Map<number, Uint16Array>> | undefined = options.fields === 'opened' ? {} : undefined;
  const state: Record<string, Uint8Array> = {};
  for (const name of Object.keys(manifest.variables)) {
    // A global variable is ~26 MiB. Allocate only fields actually opened.
    packed[name] = new Uint16Array(0);
    if (frames) frames[name] = new Map();
    state[name] = new Uint8Array(count);
  }
  const listeners = new Set<() => void>();
  const storage = (name: string) => {
    if (!packed[name].length) packed[name] = new Uint16Array(count * cells).fill(manifest.variables[name].fill);
    return packed[name];
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const loadFrame = async (name: string, index: number) => {
    const spec = manifest.variables[name];
    if (state[name][index] !== FRAME_PENDING) return;
    const file = spec.frames?.[index] ?? null;
    if (!file) {
      state[name][index] = FRAME_MISSING;
      return;
    }
    let bytes: Uint8Array | null = null;
    try {
      bytes = await fetchBytes(frameUrl(manifest, file));
      if (bytes) bytes = await decodeFrameBytes(bytes, spec.encoding);
    } catch {
      bytes = null;
    }
    if (!bytes || bytes.byteLength !== cells * 2) {
      state[name][index] = FRAME_FAILED;
      return;
    }
    const aligned = bytes.byteOffset % 2 === 0
      ? new Uint16Array(bytes.buffer, bytes.byteOffset, cells)
      : new Uint16Array(bytes.slice().buffer);
    state[name][index] = frameIsMissing(aligned, spec.fill) ? FRAME_MISSING : FRAME_READY;
    if (frames) {
      if (state[name][index] === FRAME_READY) frames[name].set(index, aligned.slice());
    } else storage(name).set(aligned, index * cells);
  };

  /** Legacy layout: the whole variable in one file. */
  const packedRequests = new Map<string, Promise<Uint8Array | null>>();
  const loadPacked = async (name: string, indices: number[]) => {
    const spec = manifest.variables[name];
    if (!spec.file || state[name].every((value) => value !== FRAME_PENDING)) return;
    let bytes: Uint8Array | null = null;
    try {
      let request = packedRequests.get(name);
      if (!request) {
        request = fetchBytes(`/data/${spec.file}`);
        packedRequests.set(name, request);
      }
      bytes = await request;
    } catch {
      bytes = null;
    }
    if (bytes && bytes.byteLength === packedBytes(manifest)) {
      const copy = bytes.byteOffset % 2 === 0
        ? new Uint16Array(bytes.buffer, bytes.byteOffset, count * cells)
        : new Uint16Array(bytes.slice().buffer);
      if (frames) {
        for (const index of indices) {
          const frame = frameSlice(copy, index, cells);
          state[name][index] = frameIsMissing(frame, spec.fill) ? FRAME_MISSING : FRAME_READY;
          if (state[name][index] === FRAME_READY) frames[name].set(index, frame.slice());
        }
      } else {
        storage(name).set(copy);
        for (let i = 0; i < count; i += 1) {
          state[name][i] = frameIsMissing(frameSlice(packed[name], i, cells), spec.fill) ? FRAME_MISSING : FRAME_READY;
        }
      }
    } else {
      if (frames) { for (const index of indices) if (state[name][index] !== FRAME_READY) state[name][index] = FRAME_FAILED; }
      else state[name].fill(FRAME_FAILED);
    }
    packedRequests.delete(name);
  };

  const load = (name: string, index: number, indices = [index]) => (manifest.variables[name].frames ? loadFrame(name, index) : loadPacked(name, indices));

  const first = firstPaintFrames(manifest, nowMs);
  const coastPromise = fetchBytes(manifest.wrapsLongitude ? '/coast/world.bin' : '/coast/ownchart-coast.bin').catch(() => null);
  const lakesPromise = manifest.wrapsLongitude ? fetchBytes('/coast/lakes.bin').catch(() => null) : Promise.resolve(null);
  const riversPromise = manifest.wrapsLongitude ? fetchBytes('/coast/rivers.bin').catch(() => null) : Promise.resolve(null);
  const pointsPromise = manifest.points
    ? fetchBytes(frameUrl(manifest, manifest.points)).then((bytes) => (bytes ? readPoints(JSON.parse(new TextDecoder().decode(bytes))) : null)).catch(() => null)
    : Promise.resolve(null);
  await Promise.all(first.map((index) => load('mslp', index, first)));
  if (first.every((index) => state.mslp[index] !== FRAME_READY)) throw new Error('mslp at now is missing');
  const coastBytes = await coastPromise;
  const coast = coastBytes ? parseCoast(coastBytes) : { rings: [] };
  if (manifest.wrapsLongitude && !coast.rings.length) throw new Error('Global coastline is unavailable');
  const water = parseWater(await lakesPromise, await riversPromise);

  const chart: LoadedChart = {
    manifest,
    packed,
    frames,
    state,
    coast,
    coastLod: [coast, simplifyCoast(coast, 0.05), simplifyCoast(coast, 0.15)],
    water,
    aviation: null,
    points: await pointsPromise,
    listeners,
    complete: Promise.resolve(),
    want: async () => {},
  };

  if (frames) {
    installFrameWindow(chart, options, load, notify);
    const aviationTask = fetchBytes(`/data/${manifest.aviation}`).then((bytes) => {
      chart.aviation = bytes ? JSON.parse(new TextDecoder().decode(bytes)) as AviationFile : null;
    }).catch(() => {}).then(notify);
    chart.complete = Promise.all([chart.complete, aviationTask]).then(() => undefined);
    return chart;
  }

  const opened = options.field ? FIELD_VARIABLE[options.field] : undefined;
  const queued = new Set(options.fields === 'opened' ? ['mslp', ...(opened ? [opened] : [])] : Object.keys(manifest.variables));
  const order = loadOrder(manifest, nowMs, options.field);
  const key = ([name, index]: [string, number]) => `${name}:${index}`;
  const rank = new Map(order.map((entry, index) => [key(entry), index]));
  const urgent = new Set<string>();
  const queue = order.filter(([name, index]) => queued.has(name) && state[name][index] === FRAME_PENDING);
  const requested = options.concurrency ?? 4;
  const concurrency = Number.isFinite(requested) ? Math.max(1, Math.min(8, Math.floor(requested))) : 4;
  let active = 0;
  const idle = new Set<() => void>();
  const pump = () => {
    while (active < concurrency && queue.length) {
      // Parallel fetches must not let background vectors finish ahead of the
      // pressure frame they accompany. Skip blocked wind to keep MSLP moving.
      const ready = queue.findIndex(([name, index]) => !['u10', 'v10'].includes(name)
        || urgent.has(key([name, index])) || state.mslp[index] !== FRAME_PENDING);
      if (ready < 0) break;
      const [next] = queue.splice(ready, 1);
      active += 1;
      void load(next[0], next[1]).catch(() => {
        state[next[0]][next[1]] = FRAME_MISSING;
      }).finally(() => {
        active -= 1;
        notify();
        pump();
        if (!active && !queue.length) { for (const done of idle) done(); idle.clear(); }
      });
    }
  };
  chart.want = async (name, minute, priority) => {
    if (!manifest.variables[name]) return;
    const at = minute ?? nowMinuteOf(manifest, nowMs);
    const blend = frameBlend(manifest.forecastHours, manifest.forecastHours[0] * 60 + at);
    const first = blend ? [...new Set([blend.i0, blend.i1])] : [0];
    if (!queued.has(name)) {
      queued.add(name);
      queue.push(...order.filter(([item, index]) => item === name && state[name][index] === FRAME_PENDING));
    }
    // A mount, barb toggle or second component cannot leapfrog the pressure
    // ladder. Lens promotion is bounded to its current blend, even if the
    // variable was already queued by the streaks.
    if (priority === 'lens') for (const index of first) urgent.add(key([name, index]));
    queue.sort((a, b) => Number(urgent.has(key(b))) - Number(urgent.has(key(a))) || rank.get(key(a))! - rank.get(key(b))!);
    pump();
    // Wait for the frames at `minute`; poll the state the pumps fill.
    while (first.some((index) => state[name][index] === FRAME_PENDING)) {
      await new Promise<void>((resolve) => {
        const done = () => { listeners.delete(done); resolve(); };
        listeners.add(done);
      });
    }
  };
  const aviationTask = fetchBytes(`/data/${manifest.aviation}`).then((bytes) => {
    chart.aviation = bytes ? JSON.parse(new TextDecoder().decode(bytes)) as AviationFile : null;
  }).catch(() => {
    chart.aviation = null;
  }).then(notify);
  const framesComplete = new Promise<void>((resolve) => { idle.add(resolve); });
  pump();
  if (!active && !queue.length) { for (const done of idle) done(); idle.clear(); }
  chart.complete = Promise.all([framesComplete, aviationTask]).then(() => undefined);
  return chart;
}

/** True when both frames of a blend have arrived. */
export function blendReady(chart: LoadedChart, name: string, i0: number, i1: number): boolean {
  const state = chart.state[name];
  return !!state && state[i0] === FRAME_READY && state[i1] === FRAME_READY;
}

/** Read a cached frame without forcing a whole forecast allocation. */
export function chartFrame(chart: LoadedChart, name: string, index: number): Uint16Array {
  return chart.frames ? chart.frames[name]?.get(index) ?? EMPTY_FRAME
    : frameSlice(chart.packed[name] ?? EMPTY_FRAME, index, chart.manifest.nx * chart.manifest.ny);
}

const EMPTY_FRAME = new Uint16Array(0);

/** One replaceable map window plus short-lived explicit readers, sharing a request/cache budget. */
function installFrameWindow(chart: LoadedChart, options: LoadOptions,
  load: (name: string, index: number, indices?: number[]) => Promise<void>, notify: () => void) {
  type Entry = [string, number];
  const { manifest, state, frames } = chart;
  const frameBytes = manifest.nx * manifest.ny * 2;
  const budget = Number.isFinite(options.cacheBytes) ? Math.max(frameBytes * 2, options.cacheBytes!) : 32 * 1024 * 1024;
  const concurrency = Number.isFinite(options.concurrency) ? Math.max(1, Math.min(8, Math.floor(options.concurrency!))) : 4;
  const key = ([name, index]: Entry) => `${name}:${index}`;
  const inflight = new Set<string>();
  const readers = new Map<string, { entry: Entry; count: number; urgent: boolean }>();
  const touched = new Map<string, number>();
  let serial = 0;
  let plan: Entry[] = [];
  let current = new Set<string>();
  let queue: Entry[] = [];
  let signature = '';
  const idle = new Set<() => void>();
  const bracket = (minute: number) => {
    const blend = frameBlend(manifest.forecastHours, manifest.forecastHours[0] * 60 + minute);
    return blend ? [...new Set([blend.i0, blend.i1])] : [];
  };
  const protectedKeys = () => new Set([...current, ...readers.keys()]);
  const limit = () => Math.max(budget, protectedKeys().size * frameBytes);
  const trim = () => {
    const held = protectedKeys();
    const entries = Object.entries(frames!).flatMap(([name, values]) => [...values.keys()].map((index): Entry => [name, index]));
    // Active blends are the small floor; all remaining retention is LRU.
    let bytes = entries.length * frameBytes;
    entries.sort((a, b) => (touched.get(key(a)) ?? 0) - (touched.get(key(b)) ?? 0));
    for (const entry of entries) {
      if (bytes <= limit()) break;
      if (held.has(key(entry))) continue;
      frames![entry[0]].delete(entry[1]);
      state[entry[0]][entry[1]] = FRAME_PENDING;
      touched.delete(key(entry));
      bytes -= frameBytes;
    }
  };
  const rebuild = () => {
    const explicit = [...readers.values()].sort((a, b) => Number(b.urgent) - Number(a.urgent)).map((item) => item.entry);
    const entries = [...plan.filter((entry) => current.has(key(entry))), ...explicit, ...plan.filter((entry) => !current.has(key(entry)))];
    const seen = new Set<string>();
    queue = entries.filter((entry) => {
      const id = key(entry);
      if (seen.has(id) || inflight.has(id) || state[entry[0]][entry[1]] !== FRAME_PENDING) return false;
      seen.add(id); return true;
    });
  };
  const pump = () => {
    while (inflight.size < concurrency && queue.length) {
      const entry = queue.shift()!;
      if (state[entry[0]][entry[1]] !== FRAME_PENDING) continue;
      const id = key(entry);
      inflight.add(id);
      const indices = [...new Set([entry, ...plan, ...[...readers.values()].map((item) => item.entry)]
        .filter(([name, index]) => name === entry[0] && state[name][index] === FRAME_PENDING).map(([, index]) => index))];
      void load(...entry, indices).catch(() => { state[entry[0]][entry[1]] = FRAME_FAILED; }).finally(() => {
        inflight.delete(id);
        touched.set(id, ++serial);
        trim();
        notify();
        pump();
      });
    }
    if (!inflight.size && !queue.length) { for (const done of idle) done(); idle.clear(); }
  };
  chart.prepare = (minute, names) => {
    const first = bracket(minute);
    const fields = [...new Set(['mslp', ...names])].filter((name) => !!manifest.variables[name]);
    const nextSignature = `${first.join(',')}:${fields.join(',')}`;
    if (nextSignature === signature) return;
    signature = nextSignature;
    current = new Set(first.flatMap((index) => fields.map((name) => key([name, index]))));
    const nearby = first.length ? [first[first.length - 1] + 1, first[0] - 1, first[first.length - 1] + 2]
      .filter((index) => index >= 0 && index < manifest.forecastHours.length) : [];
    plan = [...first, ...nearby].flatMap((index) => fields.map((name): Entry => [name, index]));
    for (const entry of [...plan].reverse()) touched.set(key(entry), ++serial);
    rebuild(); trim(); pump();
  };
  chart.want = async (name, minute = nowMinuteOf(manifest, options.nowMs ?? Date.now()), priority) => {
    if (!manifest.variables[name]) return;
    const entries = bracket(minute).map((index): Entry => [name, index]);
    for (const entry of entries) {
      const id = key(entry), prior = readers.get(id);
      readers.set(id, { entry, count: (prior?.count ?? 0) + 1, urgent: prior?.urgent || priority === 'lens' });
      touched.set(id, ++serial);
    }
    rebuild(); pump();
    try {
      while (entries.some(([field, index]) => state[field][index] === FRAME_PENDING)) {
        await new Promise<void>((resolve) => {
          const done = () => { chart.listeners.delete(done); resolve(); };
          chart.listeners.add(done);
        });
      }
    } finally {
      for (const entry of entries) {
        const reader = readers.get(key(entry))!;
        if (--reader.count === 0) readers.delete(key(entry));
      }
      trim();
    }
  };
  chart.retry = (minute, names) => {
    // A deliberate retry also restores nearby preparation after an outage.
    const first = bracket(minute);
    const indices = first.length ? [...first, first[first.length - 1] + 1, first[0] - 1, first[first.length - 1] + 2] : [];
    for (const name of ['mslp', ...names]) {
      if (!state[name]) continue;
      for (const index of indices) if (state[name][index] === FRAME_FAILED) state[name][index] = FRAME_PENDING;
    }
    signature = '';
    chart.prepare!(minute, names);
    notify();
  };
  chart.cacheStats = () => {
    const count = Object.values(frames!).reduce((sum, values) => sum + values.size, 0);
    return { bytes: count * frameBytes, frames: count, queued: queue.length, active: inflight.size, limit: limit() };
  };
  chart.complete = new Promise<void>((resolve) => idle.add(resolve));
  chart.prepare(nowMinuteOf(manifest, options.nowMs ?? Date.now()), options.field && FIELD_VARIABLE[options.field] ? [FIELD_VARIABLE[options.field]] : []);
}

export function frameSlice(packed: Uint16Array, index: number, count: number): Uint16Array {
  const start = index * count;
  return packed.subarray(start, start + count);
}

export function decodeFrame(frame: Uint16Array, spec: VariableSpec): Float32Array {
  const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  return decodeUint16(bytes, spec);
}

export function blendFrame(
  a: Uint16Array,
  b: Uint16Array,
  t: number,
  spec: VariableSpec,
): Float32Array {
  const out = new Float32Array(a.length);
  const keep = 1 - t;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === spec.fill || b[i] === spec.fill) out[i] = NaN;
    else out[i] = (a[i] * spec.scale + spec.offset) * keep + (b[i] * spec.scale + spec.offset) * t;
  }
  return out;
}

export function frameIsMissing(frame: Uint16Array, fill: number): boolean {
  for (let i = 0; i < frame.length; i += 1) if (frame[i] !== fill) return false;
  return true;
}
