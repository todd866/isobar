/**
 * Read-only export of the local Isobar archive into web/public/data.
 * Bureau of Meteorology products are not copied.
 *
 *   ISOBAR_STORE=~/Data/isobar npx tsx scripts/export-data.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFloat16 } from '../src/lib/float16.ts';
import { rainWindowSource, type RainRun } from '../src/lib/rain-window.ts';
import { SCHEMA1_HOURS } from '../src/lib/manifest.ts';
import { encodeUint16, UINT16_FILL, type QuantScale } from '../src/lib/quantise.ts';
import { SCALES } from './export-scales.ts';
import { shuffleUint16 } from '../src/lib/frame-codec.ts';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const outDir = path.join(webRoot, 'public', 'data');
const MS_TO_KT = 1.943844;
// Vector components are on by default for teaching and wind overlays. Set this
// to 0 for the legacy four-field export when the 16 MB static budget matters.
const includeWindComponents = process.env.ISOBAR_EXPORT_WIND_COMPONENTS !== '0';

const PLACES = [
  { id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.9461, lon: 151.1772, icao: 'YSSY' },
  { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.9403, lon: 115.9672, icao: 'YPPH' },
];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function storeRoot(): string {
  const given = process.env.ISOBAR_STORE || path.join(os.homedir(), 'Data', 'isobar');
  if (!fs.existsSync(given)) fail(`store not found: ${given}`);
  const store = fs.realpathSync(given);
  const output = path.resolve(outDir);
  if (output === store || output.startsWith(`${store}${path.sep}`) || store.startsWith(`${output}${path.sep}`)) {
    fail('refusing to write inside the weather store');
  }
  return store;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function stamp(name: string): number {
  const match = name.match(/(\d{4})(\d{2})(\d{2})T(\d{2})Z/);
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]));
}

function readGrid(file: string, cells: number): Float32Array {
  const bytes = fs.readFileSync(file);
  if (bytes.byteLength !== cells * 2) fail(`${file} is ${bytes.byteLength} bytes, expected ${cells * 2}`);
  return decodeFloat16(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

function listHours(dir: string, runMs: number): number[] {
  const hours = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.f16'))
    .map((name) => Math.round((stamp(name) - runMs) / 3_600_000))
    .filter((hour) => Number.isFinite(hour))
    .sort((a, b) => a - b);
  if (hours.length < 2) fail(`not enough MSLP frames in ${dir}`);
  for (let i = 1; i < hours.length; i += 1) {
    if (hours[i] === hours[i - 1]) fail(`duplicate forecast hour ${hours[i]}`);
  }
  return hours;
}

function fileFor(dir: string, runMs: number, hour: number): string | null {
  const when = new Date(runMs + hour * 3_600_000);
  const name = `${when.getUTCFullYear()}${String(when.getUTCMonth() + 1).padStart(2, '0')}${String(when.getUTCDate()).padStart(2, '0')}T${String(when.getUTCHours()).padStart(2, '0')}Z.f16`;
  const file = path.join(dir, name);
  return fs.existsSync(file) ? file : null;
}

function loadSeries(dir: string, runMs: number, hours: number[], cells: number): (Float32Array | null)[] {
  return hours.map((hour) => {
    const file = fileFor(dir, runMs, hour);
    return file ? readGrid(file, cells) : null;
  });
}

function accumulation(end: number, start: number): number {
  if (!Number.isFinite(end) || !Number.isFinite(start)) return NaN;
  if (end < start - 0.05) return NaN;
  return Math.max(0, end - start);
}

function allFill(body: Uint8Array): boolean {
  for (let i = 0; i < body.length; i += 1) if (body[i] !== 0xff) return false;
  return true;
}

/**
 * One file per frame, so the page paints the frame at "now" after a few
 * hundred kilobytes instead of waiting for every field. A missing frame is not
 * written; the manifest lists it as null. Paths are stable, so a re-export
 * overwrites in place; the manifest's run tag busts caches.
 *
 * Frames are byte-shuffled uint16 in gzip (`.u16z`, encoding `shuffle-gzip`):
 * lossless, every hour kept, and small over the wire on any static host. The
 * client decompresses with DecompressionStream.
 */
function writeFrames(
  name: string,
  hours: number[],
  frames: (Float32Array | null)[],
  scale: QuantScale,
): { names: (string | null)[]; bytes: number } {
  const relDir = path.posix.join('frames', name);
  fs.mkdirSync(path.join(outDir, relDir), { recursive: true });
  let bytes = 0;
  const names = frames.map((frame, index) => {
    if (!frame) return null;
    const body = encodeUint16(frame, scale);
    if (allFill(body)) return null;
    const rel = path.posix.join(relDir, `f${String(hours[index]).padStart(3, '0')}.u16z`);
    const packed = zlib.gzipSync(shuffleUint16(body), { level: 9 });
    writeAtomic(path.join(outDir, rel), packed);
    bytes += packed.byteLength;
    return rel;
  });
  const stale = fs.readdirSync(path.join(outDir, relDir)).filter((file) => /^f\d{3}\.u16$/.test(file));
  if (stale.length) console.log(`${stale.length} stale raw frames in ${relDir} are no longer used; move them out before deploying`);
  return { names, bytes };
}

function writeAtomic(file: string, bytes: Uint8Array | string) {
  const partial = `${file}.partial`;
  if (typeof bytes === 'string') fs.writeFileSync(partial, bytes);
  else fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, file);
}

function iso(value: unknown): string | null {
  if (typeof value === 'string' && value.includes('T')) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/** The collector's current aviation run; the loose files beside it are an old layout. */
function aviationDir(store: string): string | null {
  const root = path.join(store, 'products', 'aviation');
  const pointer = path.join(root, 'current.json');
  if (fs.existsSync(pointer)) {
    const latest = readJson(pointer).latest;
    if (typeof latest === 'string' && /^[0-9a-zA-Z_-]+$/.test(latest)) {
      const dir = path.join(root, 'runs', latest);
      if (fs.existsSync(dir)) return dir;
    }
  }
  return fs.existsSync(root) ? root : null;
}

function aviation(store: string) {
  const dir = aviationDir(store);
  if (!dir) return { airports: [], sigmets: [] };
  const airports = fs.readdirSync(dir)
    .filter((name) => /^[A-Z]{4}\.json$/.test(name))
    .sort()
    .map((name) => {
      const json = readJson(path.join(dir, name));
      const place = PLACES.find((item) => item.icao === json.icao) ?? PLACES.find((item) => `${item.icao}.json` === name);
      const metar = json.metar && typeof json.metar === 'object' ? json.metar as Record<string, unknown> : null;
      const taf = json.taf && typeof json.taf === 'object' ? json.taf as Record<string, unknown> : null;
      return {
        icao: typeof json.icao === 'string' ? json.icao : name.slice(0, 4),
        name: place?.name ?? name.slice(0, 4),
        zone: place?.zone ?? 'Australia/Sydney',
        lat: place?.lat ?? 0,
        lon: place?.lon ?? 0,
        metar: metar && typeof metar.raw === 'string' ? { raw: metar.raw, time: iso(metar.time) } : null,
        taf: taf && typeof taf.raw === 'string' ? {
          raw: taf.raw,
          issue: iso(taf.issue_time),
          from: iso(taf.valid_from),
          to: iso(taf.valid_to),
        } : null,
      };
    });
  const sigmetFile = path.join(dir, 'sigmet.json');
  const sigmets = fs.existsSync(sigmetFile)
    ? ((readJson(sigmetFile).features as Record<string, unknown>[] | undefined) ?? []).map((feature) => ({
      fir: typeof feature.firId === 'string' ? feature.firId : '',
      hazard: typeof feature.hazard === 'string' ? feature.hazard : '',
      qualifier: typeof feature.qualifier === 'string' ? feature.qualifier : '',
      base: typeof feature.base === 'number' ? feature.base : null,
      top: typeof feature.top === 'number' ? feature.top : null,
      raw: typeof feature.raw === 'string' ? feature.raw : '',
      from: iso(feature.valid_from),
      to: iso(feature.valid_to),
    }))
    : [];
  return { airports, sigmets };
}

/** Aerodrome elevation (AIP, ft) and the coast along the sky section's W–E line (km, negative = west). */
const AERODROMES: Record<string, { elevationFt: number; coastKm: number | null }> = {
  YPPH: { elevationFt: 67, coastKm: -19 },
  YSSY: { elevationFt: 21, coastKm: 6 },
};

/**
 * ECMWF upper-air point profiles at the configured aerodromes, for the Fly
 * sky section: 13 pressure levels, the latest run. Times are UTC. A missing
 * value stays null.
 */
function skyProfiles(store: string) {
  const root = path.join(store, 'products', 'points', 'ecmwf_ifs025_upper');
  const pointer = path.join(root, 'current.json');
  if (!fs.existsSync(pointer)) return { profiles: [] };
  const latest = readJson(pointer).latest;
  if (typeof latest !== 'string' || !/^[0-9TZ-]+$/.test(latest)) return { profiles: [] };
  const dir = path.join(root, 'runs', latest);
  const num = (value: unknown, digits: number) => (typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
  const profiles = PLACES.flatMap((place) => {
    const file = path.join(dir, `${place.icao}.json`);
    const meta = AERODROMES[place.icao];
    if (!fs.existsSync(file) || !meta) return [];
    const json = readJson(file);
    const times = Array.isArray(json.time) ? json.time as unknown[] : [];
    const time = times.map((value) => (typeof value === 'string' ? Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`) : NaN));
    if (!time.length || time.some((value) => !Number.isFinite(value))) return [];
    const levels = json.levels && typeof json.levels === 'object' ? json.levels as Record<string, Record<string, unknown[]>> : {};
    const series = (level: Record<string, unknown[]>, key: string, digits: number) => time.map((_, index) => num(level[key]?.[index], digits));
    return [{
      icao: place.icao,
      source: 'ECMWF',
      model: 'ecmwf_ifs025',
      run: typeof json.run === 'string' ? json.run : latest,
      runKnown: true,
      lat: place.lat,
      lon: place.lon,
      elevationFt: meta.elevationFt,
      coastKm: meta.coastKm,
      time,
      levels: Object.entries(levels)
        .map(([hPa, level]) => ({
          hPa: Number(hPa),
          z: series(level, 'height_m', 0),
          t: series(level, 'temperature_c', 1),
          rh: series(level, 'relative_humidity_pct', 0),
          ws: series(level, 'wind_speed_kt', 0),
          wd: series(level, 'wind_direction_deg', 0),
          cc: series(level, 'cloud_cover_pct', 0),
          w: series(level, 'vertical_velocity_ms', 2),
        }))
        .filter((level) => Number.isFinite(level.hPa))
        .sort((a, b) => b.hPa - a.hPa),
    }];
  });
  return { profiles };
}

function sameLadder(hours: number[]): boolean {
  return hours.length === SCHEMA1_HOURS.length && hours.every((hour, index) => hour === SCHEMA1_HOURS[index]);
}

function chooseFamily(store: string): { family: string; pointerFile: string } {
  const requested = process.env.ISOBAR_GRID_FAMILY;
  const families = requested ? [requested] : ['ecmwf_ifs_global', 'ecmwf_ifs025'];
  for (const family of families) {
    if (!/^[a-z0-9_-]+$/.test(family)) fail(`invalid grid family: ${family}`);
    const pointerFile = path.join(store, 'products', 'grids', family, 'current.json');
    if (fs.existsSync(pointerFile)) return { family, pointerFile };
  }
  fail(`no ECMWF grid pointer found in ${families.join(', ')}`);
}

function main() {
  const store = storeRoot();
  const selected = chooseFamily(store);
  const { family, pointerFile } = selected;
  const pointer = readJson(pointerFile);
  const latest = pointer.latest;
  if (typeof latest !== 'string') fail('grid pointer has no latest run');
  const runDir = path.join(store, 'products', 'grids', family, 'runs', latest);
  const sourceManifestFile = path.join(runDir, 'manifest.json');
  const sourceManifest = fs.existsSync(sourceManifestFile) ? readJson(sourceManifestFile) : {};
  const sourceGrid = sourceManifest.grid && typeof sourceManifest.grid === 'object' ? sourceManifest.grid as Record<string, unknown> : {};
  const mslpDir = path.join(runDir, 'mslp');
  const sampleName = fs.readdirSync(mslpDir).find((name) => name.endsWith('.json'));
  if (!sampleName) fail('MSLP sidecar is missing');
  const sidecar = readJson(path.join(mslpDir, sampleName));
  const gridValue = (name: string): number => {
    const derived: Record<string, number> = {
      west: typeof sidecar.lon0 === 'number' && typeof sidecar.dlon === 'number' ? sidecar.lon0 : NaN,
      east: typeof sidecar.lon0 === 'number' && typeof sidecar.dlon === 'number' && typeof sidecar.nx === 'number' ? sidecar.lon0 + (sidecar.nx - 1) * Math.abs(sidecar.dlon) : NaN,
      north: typeof sidecar.lat0 === 'number' ? sidecar.lat0 : NaN,
      south: typeof sidecar.lat0 === 'number' && typeof sidecar.dlat === 'number' && typeof sidecar.ny === 'number' ? sidecar.lat0 + (sidecar.ny - 1) * sidecar.dlat : NaN,
      step: typeof sidecar.dlon === 'number' ? Math.abs(sidecar.dlon) : NaN,
    };
    const value = sourceGrid[name] ?? sidecar[name] ?? derived[name];
    return typeof value === 'number' ? value : NaN;
  };
  const nx = gridValue('nx');
  const ny = gridValue('ny');
  const west = gridValue('west');
  const east = gridValue('east');
  const north = gridValue('north');
  const south = gridValue('south');
  const step = gridValue('step');
  const wrapsLongitude = sourceGrid.wraps_longitude === true || sidecar.wraps_longitude === true;
  if (![nx, ny, west, east, north, south, step].every((value) => typeof value === 'number' && Number.isFinite(value))) fail('grid geometry is incomplete');
  if (!(nx >= 2 && ny >= 2 && east > west && north > south && step > 0)) fail('grid geometry is invalid');
  const globalGeometry = nx === 720 && ny === 361 && Math.abs(west + 180) < 1e-6
    && Math.abs(east - 179.5) < 1e-6 && Math.abs(north - 90) < 1e-6
    && Math.abs(south + 90) < 1e-6 && Math.abs(step - 0.5) < 1e-6;
  if (globalGeometry !== wrapsLongitude) {
    fail(globalGeometry ? 'global grid must declare wraps_longitude' : 'wraps_longitude geometry is not the supported global grid');
  }
  const run = typeof sourceManifest.run === 'string' ? sourceManifest.run : typeof sidecar.run === 'string' ? sidecar.run : '';
  const runMs = Date.parse(run);
  if (!Number.isFinite(runMs)) fail('run time is missing');
  const cells = nx * ny;
  const sourceHours = Array.isArray(sourceManifest.forecast_hours)
    ? sourceManifest.forecast_hours.filter((hour): hour is number => typeof hour === 'number' && Number.isFinite(hour))
    : listHours(mslpDir, runMs);
  const hours = sourceHours.length >= 2 ? sourceHours : listHours(mslpDir, runMs);
  const schema = sameLadder(hours) ? 1 : 2;
  const gaps = hours.slice(1).map((hour, index) => hour - hours[index]);
  const uniform = gaps.every((gap) => gap === gaps[0]) ? gaps[0] : null;

  const mslp = loadSeries(mslpDir, runMs, hours, cells);
  if (mslp.some((frame) => !frame)) fail('an MSLP hour is missing; refusing to invent it');
  const t2m = loadSeries(path.join(runDir, 't2m'), runMs, hours, cells);
  const u10 = loadSeries(path.join(runDir, 'u10'), runMs, hours, cells);
  const v10 = loadSeries(path.join(runDir, 'v10'), runMs, hours, cells);
  const tp = loadSeries(path.join(runDir, 'tp'), runMs, hours, cells);
  const cloud = fs.existsSync(path.join(runDir, 'cloud_cover'))
    ? loadSeries(path.join(runDir, 'cloud_cover'), runMs, hours, cells)
    : hours.map(() => null);

  const wind = hours.map((_, index) => {
    const u = u10[index];
    const v = v10[index];
    if (!u || !v) return null;
    const frame = new Float32Array(cells);
    for (let i = 0; i < cells; i += 1) {
      frame[i] = Number.isFinite(u[i]) && Number.isFinite(v[i]) ? Math.hypot(u[i], v[i]) * MS_TO_KT : NaN;
    }
    return frame;
  });
  // The run's own tp covers 24 h windows from +24 h; earlier frames use the
  // newest earlier run holding both ends of the window (as the macOS app does).
  const runIds = Array.isArray(pointer.runs) ? (pointer.runs as unknown[]).filter((id): id is string => typeof id === 'string') : [];
  const rainRuns: RainRun[] = [latest, ...runIds.filter((id) => id !== latest).sort().reverse()]
    .map((id) => {
      const dir = path.join(store, 'products', 'grids', family, 'runs', id, 'tp');
      const idMs = stamp(id);
      return { id, runMs: idMs, has: (hour: number) => fs.existsSync(dir) && fileFor(dir, idMs, hour) !== null };
    })
    .filter((run) => Number.isFinite(run.runMs) && run.runMs <= runMs);
  const borrowed = new Set<string>();
  const rain = hours.map((hour, index) => {
    const source = rainWindowSource(runMs + hour * 3_600_000, rainRuns);
    if (!source) return null;
    let end: Float32Array | null;
    let start: Float32Array | null;
    if (source.id === latest) {
      end = tp[index];
      const startIndex = hours.indexOf(source.startHour);
      start = startIndex >= 0 ? tp[startIndex] : null;
    } else {
      const run = rainRuns.find((item) => item.id === source.id) as RainRun;
      const dir = path.join(store, 'products', 'grids', family, 'runs', source.id, 'tp');
      const endFile = fileFor(dir, run.runMs, source.endHour);
      const startFile = fileFor(dir, run.runMs, source.startHour);
      end = endFile ? readGrid(endFile, cells) : null;
      start = startFile ? readGrid(startFile, cells) : null;
      borrowed.add(source.id);
    }
    if (!end || !start) return null;
    const frame = new Float32Array(cells);
    for (let i = 0; i < cells; i += 1) frame[i] = accumulation(end[i], start[i]);
    return frame;
  });
  if (borrowed.size) console.log(`early 24 h rain from ${[...borrowed].join(', ')}`);

  fs.mkdirSync(outDir, { recursive: true });
  let bytes = 0;
  const frameNames: Record<string, (string | null)[]> = {};
  const series: Record<string, (Float32Array | null)[]> = { mslp, rain24: rain, t2m, wind };
  if (includeWindComponents) {
    series.u10 = u10;
    series.v10 = v10;
  }
  if (cloud.some((frame) => frame)) series.tcc = cloud;
  for (const [name, frames] of Object.entries(series)) {
    const written = writeFrames(name, hours, frames, SCALES[name]);
    frameNames[name] = written.names;
    bytes += written.bytes;
  }
  for (const name of ['mslp.u16', 'rain24.u16', 't2m.u16', 'wind.u16', 'u10.u16', 'v10.u16']) {
    if (fs.existsSync(path.join(outDir, name))) console.log(`stale ${name} is no longer used; remove it before deploying`);
  }
  // Point series at each place: the header's now reading and the day tiles.
  // Bilinear on the 0.25 degree grid; a missing hour stays null.
  const sample = (frame: Float32Array | null, lat: number, lon: number): number | null => {
    if (!frame) return null;
    const gx = (lon - west) / step;
    const gy = (north - lat) / step;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    if (x0 < 0 || y0 < 0 || x0 >= nx - 1 || y0 >= ny - 1) return null;
    const tx = gx - x0;
    const ty = gy - y0;
    const at = (x: number, y: number) => frame[y * nx + x];
    const value = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
    return Number.isFinite(value) ? value : null;
  };
  const round = (value: number | null, digits: number) => (value == null ? null : Number(value.toFixed(digits)));
  const points = {
    run,
    hours,
    places: Object.fromEntries(PLACES.map((place) => {
      const u = u10.map((frame) => sample(frame, place.lat, place.lon));
      const v = v10.map((frame) => sample(frame, place.lat, place.lon));
      return [place.id, {
        t: t2m.map((frame) => round(sample(frame, place.lat, place.lon), 1)),
        wspd: u.map((value, index) => (value == null || v[index] == null ? null : round(Math.hypot(value, v[index] as number) * MS_TO_KT, 1))),
        // Direction the wind blows FROM, degrees true.
        wdir: u.map((value, index) => {
          const vv = v[index];
          if (value == null || vv == null) return null;
          const deg = (Math.atan2(-value, -vv) * 180) / Math.PI;
          return Math.round(deg < 0 ? deg + 360 : deg);
        }),
        tp: tp.map((frame) => round(sample(frame, place.lat, place.lon), 2)),
        cc: cloud.map((frame) => round(sample(frame, place.lat, place.lon), 0)),
      }];
    })),
  };
  const pointsJson = `${JSON.stringify(points)}\n`;
  writeAtomic(path.join(outDir, 'points.json'), pointsJson);
  bytes += Buffer.byteLength(pointsJson);

  const flights = aviation(store);
  const aviationJson = `${JSON.stringify(flights)}\n`;
  writeAtomic(path.join(outDir, 'aviation.json'), aviationJson);
  bytes += Buffer.byteLength(aviationJson);

  const sky = skyProfiles(store);
  const skyJson = `${JSON.stringify(sky)}\n`;
  writeAtomic(path.join(outDir, 'sky.json'), skyJson);
  bytes += Buffer.byteLength(skyJson);

  const manifest = {
    schema,
    contract: 'isobar-web',
    run,
    generated: new Date().toISOString(),
    forecast_hours: hours,
    uniform_step_hours: schema === 1 ? 3 : uniform,
    grid: {
      west,
      east,
      north,
      south,
      step,
      nx,
      ny,
      ...(wrapsLongitude ? { wraps_longitude: true } : {}),
      dtype: 'uint16',
      endian: 'little',
      order: 'one file per frame; north-to-south, west-to-east',
      fill: UINT16_FILL,
    },
    variables: {
      mslp: { frames: frameNames.mslp, encoding: 'shuffle-gzip', units: 'hPa', ...SCALES.mslp },
      rain24: { frames: frameNames.rain24, encoding: 'shuffle-gzip', units: 'mm', ...SCALES.rain24 },
      t2m: { frames: frameNames.t2m, encoding: 'shuffle-gzip', units: 'C', ...SCALES.t2m },
      wind: { frames: frameNames.wind, encoding: 'shuffle-gzip', units: 'kt', ...SCALES.wind },
      ...(includeWindComponents ? {
        u10: { frames: frameNames.u10, encoding: 'shuffle-gzip', units: 'm/s', ...SCALES.u10 },
        v10: { frames: frameNames.v10, encoding: 'shuffle-gzip', units: 'm/s', ...SCALES.v10 },
      } : {}),
      ...(series.tcc ? {
        tcc: { frames: frameNames.tcc, encoding: 'shuffle-gzip', units: '%', ...SCALES.tcc },
      } : {}),
    },
    places: PLACES,
    aviation: 'aviation.json',
    points: 'points.json',
    sky: 'sky.json',
    attribution: [
      { source: 'ECMWF Open Data', licence: 'CC BY 4.0' },
      { source: 'aviationweather.gov', licence: 'US public domain' },
      { source: 'Natural Earth coastline and lakes', licence: 'public domain' },
    ],
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  writeAtomic(path.join(outDir, 'manifest.json'), manifestJson);
  bytes += Buffer.byteLength(manifestJson);
  const mebibytes = bytes / (1024 * 1024);
  console.log(`schema ${schema}, ${hours.length} hours, run ${run}`);
  console.log(`wrote ${outDir} ${(bytes / 1_000_000).toFixed(2)} MB (${mebibytes.toFixed(2)} MiB, frames as stored: gzip)`);
  if (bytes > 16_000_000) {
    if (wrapsLongitude) {
      console.warn(`global export is ${bytes} bytes; retaining full-resolution world coverage`);
    } else {
      fail(`export is over the 16 MB target (${bytes} bytes)`);
    }
  }
}

main();
