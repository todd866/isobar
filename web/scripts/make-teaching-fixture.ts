/**
 * Make a deterministic, synthetic chart for local map teaching/e2e work.
 *
 * This never runs as part of export-data or production loading. It writes only
 * web/public/data/frames, manifest.json, points.json and aviation.json. The
 * coastline is deliberately left alone. Set ISOBAR_FIXTURE_DATE=YYYY-MM-DD
 * to pin the run day; otherwise today's UTC date is used.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeUint16, UINT16_FILL, type QuantScale } from '../src/lib/quantise.ts';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(webRoot, 'public', 'data');
const west = 100;
const east = 160;
const north = -10;
const south = -50;
const step = 0.25;
const nx = Math.round((east - west) / step) + 1;
const ny = Math.round((north - south) / step) + 1;
const hours = Array.from({ length: 33 }, (_, i) => i * 3);
const cells = nx * ny;
const scales: Record<string, QuantScale> = {
  mslp: { scale: 0.1, offset: 850, fill: UINT16_FILL },
  rain24: { scale: 0.1, offset: 0, fill: UINT16_FILL },
  t2m: { scale: 0.1, offset: -40, fill: UINT16_FILL },
  wind: { scale: 0.1, offset: 0, fill: UINT16_FILL },
  u10: { scale: 0.1, offset: -60, fill: UINT16_FILL },
  v10: { scale: 0.1, offset: -60, fill: UINT16_FILL },
};

function atomic(file: string, value: Uint8Array | string): void {
  const partial = `${file}.partial`;
  fs.writeFileSync(partial, value);
  fs.renameSync(partial, file);
}

function gaussian(dx: number, dy: number, sx: number, sy: number): number {
  return Math.exp(-0.5 * ((dx / sx) ** 2 + (dy / sy) ** 2));
}

function fixtureTimes(): { runMs: number; observationMs: number } {
  const pinned = process.env.ISOBAR_FIXTURE_DATE;
  if (pinned) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pinned) || Number.isNaN(Date.parse(`${pinned}T00:00:00Z`))) {
      throw new Error('ISOBAR_FIXTURE_DATE must be YYYY-MM-DD');
    }
    const runMs = Date.parse(`${pinned}T00:00:00Z`);
    return { runMs, observationMs: runMs + 6 * 3_600_000 };
  }
  const nowMs = Date.now();
  const now = new Date(nowMs);
  const hour = now.getUTCHours() >= 12 ? 12 : 0;
  let runMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
  if (runMs > nowMs) runMs -= 12 * 3_600_000;
  return { runMs, observationMs: nowMs - 30 * 60_000 };
}

function tafStamp(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}`;
}

function metarStamp(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

function field(name: string, hour: number): Float32Array {
  const values = new Float32Array(cells);
  const phase = hour / 24;
  // A compact low migrates east, with a broad high and a weak trough: enough
  // structure for pressure curvature, gradient and wind teaching examples.
  const lowLon = 148 + hour * 0.12;
  const lowLat = -31 + Math.sin(phase * Math.PI * 2) * 1.5;
  for (let y = 0; y < ny; y += 1) {
    const lat = north - y * step;
    for (let x = 0; x < nx; x += 1) {
      const lon = west + x * step;
      const dx = lon - lowLon;
      const dy = lat - lowLat;
      const low = gaussian(dx, dy, 7.5, 5.0);
      const high = gaussian(lon - 113, lat + 25, 14, 10);
      const trough = Math.exp(-(((lon - (127 + hour * 0.05 + (lat + 30) * 0.35)) / 2.2) ** 2)) * 3.8;
      const ring = Math.exp(-((dx / 10) ** 2 + (dy / 7) ** 2)) * Math.sin(Math.atan2(dy, dx) * 2);
      const pressure = 1013 + 17 * high - 29 * low - trough + ring;
      const radial = gaussian(dx, dy, 10, 8);
      // Clockwise circulation around the Southern Hemisphere low.
      const u = 4.5 + radial * (dy / 5) * 18;
      const v = -1.5 - radial * (dx / 7) * 18;
      const speed = Math.hypot(u, v);
      const rain = Math.max(0, 18 * low + 3 * Math.max(0, trough - 1) + 1.5 * Math.sin((lon + hour) / 8));
      const temp = 29 - Math.abs(lat + 25) * 0.42 - 4 * low + 1.5 * Math.sin((hour / 24) * Math.PI * 2);
      const i = y * nx + x;
      if (name === 'mslp') values[i] = pressure;
      else if (name === 'u10') values[i] = u;
      else if (name === 'v10') values[i] = v;
      else if (name === 'wind') values[i] = speed * 1.943844;
      else if (name === 'rain24') values[i] = rain;
      else values[i] = temp;
    }
  }
  return values;
}

function pointSeries(name: string, lat: number, lon: number) {
  let totalRain = 0;
  return hours.map((hour) => {
    const lowLon = 148 + hour * 0.12;
    const lowLat = -31 + Math.sin((hour / 24) * Math.PI * 2) * 1.5;
    const dx = lon - lowLon;
    const dy = lat - lowLat;
    const radial = gaussian(dx, dy, 10, 8);
    const u = 4.5 + radial * (dy / 5) * 18;
    const v = -1.5 - radial * (dx / 7) * 18;
    if (name === 't') return Number((29 - Math.abs(lat + 25) * 0.42 - 4 * gaussian(dx, dy, 7.5, 5)).toFixed(1));
    if (name === 'wspd') return Number((Math.hypot(u, v) * 1.943844).toFixed(1));
    if (name === 'wdir') return Math.round((Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360);
    if (name === 'tp') {
      // tp is an accumulated total in the point contract, never a rate.
      totalRain += Math.max(0, 8 * gaussian(dx, dy, 10, 7)) * 3;
      return Number(totalRain.toFixed(2));
    }
    return Math.round(35 + 55 * gaussian(dx, dy, 9, 6));
  });
}

function main(): void {
  const times = fixtureTimes();
  const run = new Date(times.runMs).toISOString();
  const observation = new Date(times.observationMs).toISOString();
  const generated = observation;
  fs.mkdirSync(outDir, { recursive: true });
  const frameNames: Record<string, string[]> = {};
  let bytes = 0;
  for (const name of Object.keys(scales)) {
    const dir = path.join(outDir, 'frames', name);
    fs.mkdirSync(dir, { recursive: true });
    frameNames[name] = [];
    for (const hour of hours) {
      const rel = path.posix.join('frames', name, `f${String(hour).padStart(3, '0')}.u16`);
      const body = encodeUint16(field(name, hour), scales[name]);
      atomic(path.join(outDir, rel), body);
      frameNames[name].push(rel);
      bytes += body.byteLength;
    }
  }
  const places = [
    { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.9403, lon: 115.9672, icao: 'YPPH' },
    { id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.9461, lon: 151.1772, icao: 'YSSY' },
  ];
  const points = { run, hours, places: Object.fromEntries(places.map((place) => [place.id, {
    t: pointSeries('t', place.lat, place.lon), wspd: pointSeries('wspd', place.lat, place.lon),
    wdir: pointSeries('wdir', place.lat, place.lon), tp: pointSeries('tp', place.lat, place.lon),
    cc: pointSeries('cc', place.lat, place.lon),
  }])) };
  const validityEnd = times.runMs + 30 * 3_600_000;
  const tempoStart = Math.max(times.runMs, times.runMs + Math.floor((times.observationMs - times.runMs) / 3_600_000) * 3_600_000);
  const tempoEnd = Math.min(validityEnd, tempoStart + 3 * 3_600_000);
  const issueDay = tafStamp(times.runMs);
  const validity = `${tafStamp(times.runMs)}/${tafStamp(validityEnd)}`;
  const tempo = `${tafStamp(tempoStart)}/${tafStamp(tempoEnd)}`;
  const aviation = {
    airports: [
      { icao: 'YPPH', name: 'Perth', zone: 'Australia/Perth', lat: -31.9403, lon: 115.9672,
        metar: { raw: `METAR YPPH ${metarStamp(times.observationMs)}Z 32018G30KT 9999 VCTS FEW025CB SCT040 BKN090 24/18 Q1008`, time: observation },
        taf: { raw: `TAF YPPH ${issueDay}Z ${validity} 32015G25KT 9999 VCSH SCT030 TEMPO ${tempo} 3000 TSRA BKN015CB`, issue: run, from: run, to: new Date(validityEnd).toISOString() } },
      { icao: 'YSSY', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.9461, lon: 151.1772,
        metar: { raw: `METAR YSSY ${metarStamp(times.observationMs)}Z 18008KT CAVOK 19/11 Q1018`, time: observation },
        taf: { raw: `TAF YSSY ${issueDay}Z ${validity} 18010KT CAVOK`, issue: run, from: run, to: new Date(validityEnd).toISOString() } },
    ], sigmets: [],
  };
  const writeJson = (name: string, value: unknown) => { const text = `${JSON.stringify(value, null, 2)}\n`; atomic(path.join(outDir, name), text); bytes += Buffer.byteLength(text); };
  writeJson('points.json', points);
  writeJson('aviation.json', aviation);
  writeJson('manifest.json', {
    schema: 1, contract: 'isobar-web', run, generated, forecast_hours: hours, uniform_step_hours: 3,
    grid: { west, east, north, south, step, nx, ny, dtype: 'uint16', endian: 'little', order: 'one file per frame; north-to-south, west-to-east', fill: UINT16_FILL },
    variables: Object.fromEntries(Object.keys(scales).map((name) => [name, { frames: frameNames[name], units: name === 'mslp' ? 'hPa' : name === 'rain24' ? 'mm' : name === 't2m' ? 'C' : name === 'wind' ? 'kt' : 'm/s', ...scales[name] }])),
    places, aviation: 'aviation.json', points: 'points.json',
    attribution: [{ source: 'Synthetic teaching fixture — artificial weather, not today\'s forecast', licence: 'local test data' }],
  });
  console.log(`wrote synthetic teaching fixture ${outDir} (${(bytes / 1_000_000).toFixed(2)} MB), run ${run}`);
}

main();
