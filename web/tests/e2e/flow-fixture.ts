import type { Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { circularLowWind } from '../../src/lib/flow';

/** Synthetic vectors and pressure for renderer checks; never weather evidence. */
const LOW_LON = 133.5;
const LOW_LAT = -26;
const WEST = 110;
const NORTH = -8;
const STEP = 1;
const NX = 48;
const NY = 37;
const EAST = WEST + (NX - 1) * STEP;
const SOUTH = NORTH - (NY - 1) * STEP;

const PERTH = { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.86, icao: 'YPPH' };
const SYDNEY = { id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.87, lon: 151.21, icao: 'YSSY' };

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c ^= data[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Cold-bright infrared blob, so the translucent cloud layer is visible. */
function cloudPng(size = 96): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const luma = Math.round(255 * Math.exp(-((dx * 1.35) ** 2 + dy ** 2) * 3.4));
      const i = row + 1 + x * 4;
      raw[i] = luma;
      raw[i + 1] = luma;
      raw[i + 2] = Math.min(255, luma + 6);
      raw[i + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function quant(value: number, scale: number, offset: number): number {
  const raw = Math.round((value - offset) / scale);
  if (raw < 0 || raw > 65534) throw new Error(`value ${value} does not fit scale ${scale} offset ${offset}`);
  return raw;
}

export function installChart(page: Page, components = true) {
  const runMs = Date.now() - 6 * 3600 * 1000;
  const run = new Date(runMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const hours = Array.from({ length: 33 }, (_, i) => i * 3);
  const grid = { nx: NX, ny: NY, west: WEST, east: EAST, north: NORTH, south: SOUTH, step: STEP, dtype: 'uint16' };
  const spec = (units: string, scale: number, offset: number) => ({
    frames: hours.map(() => ''), units, scale, offset, fill: 65535,
  });
  const variables: Record<string, ReturnType<typeof spec>> = {
    mslp: spec('hPa', 0.1, 900),
    rain24: spec('mm', 0.1, 0),
    t2m: spec('°C', 0.1, -80),
    wind: spec('kt', 0.1, 0),
    u10: spec('m/s', 0.1, -80),
    v10: spec('m/s', 0.1, -80),
    tcc: spec('%', 0.1, 0),
  };
  if (!components) { delete variables.u10; delete variables.v10; }
  for (const [name, variable] of Object.entries(variables)) variable.frames = hours.map(() => `${name}.bin`);
  const manifest = {
    schema: 2, contract: 'isobar-web', run, generated: run, forecast_hours: hours, grid, variables,
    places: [PERTH, SYDNEY], points: 'points.json', aviation: 'aviation.json',
    attribution: [{ source: 'Synthetic point journey', licence: 'Test fixture' }],
  };
  const frames = new Map<string, Buffer>();
  for (const name of Object.keys(variables)) {
    const body = Buffer.alloc(NX * NY * 2);
    const variable = variables[name];
    for (let j = 0; j < NY; j += 1) {
      for (let i = 0; i < NX; i += 1) {
        const lon = WEST + i * STEP;
        const lat = NORTH - j * STEP;
        const radial = Math.hypot((lon - LOW_LON) * Math.cos((LOW_LAT * Math.PI) / 180), lat - LOW_LAT);
        const around = circularLowWind(lon, lat, LOW_LON, LOW_LAT, 16);
        const east = lon - LOW_LON;
        const north = lat - LOW_LAT;
        const mag = Math.hypot(east, north) || 1;
        const u = around.u - (east / mag) * 3 + 7;
        const v = around.v - (north / mag) * 3;
        const hPa = 1018 - 24 * Math.exp(-(radial * radial) / 36);
        let value = 0;
        if (name === 'mslp') value = hPa;
        else if (name === 't2m') value = 22 - radial * 0.15;
        else if (name === 'wind') value = Math.hypot(u, v) * 1.943844;
        else if (name === 'u10') value = u;
        else if (name === 'v10') value = v;
        else if (name === 'tcc') value = lat < -30 ? 88 : 42;
        body.writeUInt16LE(quant(value, variable.scale, variable.offset), (j * NX + i) * 2);
      }
    }
    frames.set(name, body);
  }
  const coast = Buffer.alloc(26);
  coast.write('OCST');
  coast.writeUInt16LE(1, 4);
  coast.writeUInt16LE(1, 6);
  coast.writeUInt16LE(4, 8);
  [[113, -35], [150, -35], [150, -18], [113, -18]].forEach(([lon, lat], i) => {
    coast.writeInt16LE(lon * 100, 10 + i * 4);
    coast.writeInt16LE(lat * 100, 12 + i * 4);
  });
  const png = cloudPng();
  const gibs: string[] = [];
  return {
    run,
    gibs,
    ready: Promise.all([
      page.route('https://tiles.mapterhorn.com/**', (route) => route.fulfill({ status: 404, body: '' })),
      page.route('https://gibs.earthdata.nasa.gov/**', (route) => {
        gibs.push(route.request().url());
        return route.fulfill({
          status: 200,
          contentType: 'image/png',
          headers: { 'access-control-allow-origin': '*' },
          body: png,
        });
      }),
      page.route('**/api/auth/**', (route) => route.fulfill({ json: {} })),
      page.route('**/api/usage', (route) => route.fulfill({ status: 204, body: '' })),
      page.route('**/coast/*.bin', (route) => route.fulfill({ body: coast, contentType: 'application/octet-stream' })),
      page.route('**/places/world-places.json', (route) => route.fulfill({ json: [
        ['Perth', -31.95, 115.86, 1, 'AU'], ['Sydney', -33.87, 151.21, 1, 'AU'],
      ] })),
      page.route('**/data/**', async (route) => {
        const file = new URL(route.request().url()).pathname.split('/').at(-1)!;
        if (file === 'manifest.json') return route.fulfill({ json: manifest });
        if (file === 'points.json') return route.fulfill({ json: { run, hours, places: {
          perth: { t: hours.map(() => 20), wspd: hours.map(() => 13), wdir: hours.map(() => 220), tp: hours.map(() => 0), cc: hours.map(() => 42) },
          sydney: { t: hours.map(() => 21), wspd: hours.map(() => 11), wdir: hours.map(() => 180), tp: hours.map(() => 0), cc: hours.map(() => 36) },
        } } });
        if (file === 'aviation.json') return route.fulfill({ json: { airports: [{ ...PERTH, metar: { raw: 'METAR YPPH 080300Z 22013KT 9999 SCT030 19/11 Q1013', time: run }, taf: null }], sigmets: [] } });
        if (file === 'sky.json') return route.fulfill({ json: { profiles: [] } });
        const body = frames.get(file.replace('.bin', ''));
        return body ? route.fulfill({ body, contentType: 'application/octet-stream' }) : route.fulfill({ status: 404 });
      }),
    ]),
  };
}

