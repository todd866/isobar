import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { tileXToLon, tileYToLat } from '../../src/lib/terrain/terrarium';

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/unit/fixtures/openmeteo-point.json'), 'utf8'));

const OUT = path.join(os.homedir(), '.local/state/isobar-week/sounding-ground');
const RUN = '2026-10-08T00:00:00Z';
const PERTH = { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.86, icao: 'YPPH' };
const SYDNEY = { id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.87, lon: 151.21, icao: 'YSSY' };
const TIBET = { lat: 32.71, lon: 99.34 };
const panel = (page: Page) => page.locator('[data-point-panel]');

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c ^= data[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, crc]);
}

/** 1×1 RGB PNG. The terrain worker scales it to the tile. */
function png(r: number, g: number, b: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function terrarium(metres: number): Buffer {
  const encoded = Math.round(metres + 32768);
  return png((encoded >> 8) & 255, encoded & 255, 0);
}

function tileElevation(z: number, x: number, y: number): number {
  const lat = tileYToLat(y + 0.5, z);
  const lon = tileXToLon(x + 0.5, z);
  if (Math.hypot(lat - TIBET.lat, lon - TIBET.lon) < 25) return 4520;
  if (Math.hypot(lat - PERTH.lat, lon - PERTH.lon) < 25) return 20;
  return 0;
}

async function install(page: Page) {
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  const hours = [...Array.from({ length: 49 }, (_, i) => i * 3), 150, 156, 162, 168];
  const grid = { nx: 720, ny: 361, west: -180, east: 179.5, north: 90, south: -90, step: 0.5, wraps_longitude: true, dtype: 'uint16' };
  const variables = Object.fromEntries(['mslp', 'rain24', 't2m', 'wind', 'u10', 'v10'].map((name) => [name, {
    frames: hours.map(() => `${name}.bin`), units: name === 'mslp' ? 'hPa' : name === 't2m' ? '°C' : name === 'rain24' ? 'mm' : 'kt', scale: 1, offset: 0, fill: 65535,
  }]));
  const manifest = {
    schema: 2, contract: 'isobar-web', run: RUN, generated: RUN, forecast_hours: hours, grid, variables,
    places: [PERTH, SYDNEY], points: 'points.json', aviation: 'aviation.json',
    attribution: [{ source: 'Synthetic point journey', licence: 'Test fixture' }],
  };
  const frames = new Map(Object.keys(variables).map((name) => {
    const body = Buffer.alloc(grid.nx * grid.ny * 2);
    for (let j = 0; j < grid.ny; j += 1) {
      for (let i = 0; i < grid.nx; i += 1) {
        const value = name === 'mslp' ? 1012 : name === 't2m' ? 12 : name === 'rain24' ? 0 : 8;
        body.writeUInt16LE(value, (j * grid.nx + i) * 2);
      }
    }
    return [name, body];
  }));
  const coast = Buffer.alloc(26);
  coast.write('OCST');
  coast.writeUInt16LE(1, 4);
  coast.writeUInt16LE(1, 6);
  coast.writeUInt16LE(4, 8);
  [[113, -35], [120, -35], [120, -20], [113, -20]].forEach(([lon, lat], i) => {
    coast.writeInt16LE(lon * 100, 10 + i * 4);
    coast.writeInt16LE(lat * 100, 12 + i * 4);
  });
  await page.route('https://tiles.mapterhorn.com/**', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/').filter(Boolean);
    const z = Number(parts.at(-3));
    const x = Number(parts.at(-2));
    const y = Number(String(parts.at(-1)).replace(/\..*/, ''));
    if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return route.abort();
    await route.fulfill({ body: terrarium(tileElevation(z, x, y)), contentType: 'image/png' });
  });
  await page.route('**/coast/*.bin', (route) => route.fulfill({ body: coast, contentType: 'application/octet-stream' }));
  await page.route('**/data/**', async (route) => {
    const file = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (file === 'manifest.json') return route.fulfill({ json: manifest });
    if (file === 'points.json') return route.fulfill({ json: { run: RUN, hours, places: {
      perth: { t: hours.map(() => 20), wspd: hours.map(() => 13), wdir: hours.map(() => 220), tp: hours.map(() => 0), cc: hours.map(() => 42) },
      sydney: { t: hours.map(() => 21), wspd: hours.map(() => 11), wdir: hours.map(() => 180), tp: hours.map(() => 0), cc: hours.map(() => 36) },
    } } });
    if (file === 'aviation.json') return route.fulfill({ json: { airports: [{ ...PERTH, metar: null, taf: null }], sigmets: [] } });
    if (file === 'sky.json') return route.fulfill({ json: { profiles: [] } });
    const body = frames.get(file.replace('.bin', ''));
    return body ? route.fulfill({ body, contentType: 'application/octet-stream' }) : route.fulfill({ status: 404 });
  });
  await page.route('**/places/world-places.json', (route) => route.fulfill({ json: [
    ['Perth', PERTH.lat, PERTH.lon, 1, 'AU'],
  ] }));
  await page.route('https://api.open-meteo.com/v1/forecast?**', (route) => route.fulfill({ json: fixture }));
  await page.route('https://marine-api.open-meteo.com/**', (route) => route.fulfill({ json: { hourly: {
    time: ['2026-10-08T03:00'],
    sea_surface_temperature: [null], ocean_current_velocity: [null], ocean_current_direction: [null],
    wave_height: [null], swell_wave_height: [null], swell_wave_period: [null], swell_wave_direction: [null],
  } } }));
}

async function boot(page: Page, width: number, height: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height });
  await page.addInitScript((mode) => {
    localStorage.setItem('isobar-theme', mode);
    localStorage.setItem('isobar.place', 'perth');
    localStorage.setItem('isobar.speed', '8');
  }, theme);
  await page.goto('/');
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true');
  await page.waitForFunction(() => !!(document.querySelector('[data-map-ready]') as HTMLElement & { chartApi?: unknown })?.chartApi);
  await page.getByRole('radio', { name: 'Wind', exact: true }).click();
}

async function openPoint(page: Page, lat: number, lon: number) {
  if (await panel(page).count()) {
    await page.getByRole('button', { name: 'Close point' }).click();
    await expect(panel(page)).toHaveCount(0);
  }
  await page.locator('[data-map-ready]').evaluate((node, place) => {
    (node as HTMLElement & { chartApi: { setView: (lat: number, lon: number, heightDeg: number) => void } }).chartApi.setView(place.lat, place.lon, 8);
  }, { lat, lon });
  const box = (await page.locator('canvas[tabindex="0"]').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.32);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('[data-sounding]')).toBeVisible();
}

test('ground shows over Tibet and stays at the surface for Perth', async ({ page }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(OUT, { recursive: true });
  await install(page);
  for (const theme of ['light', 'dark'] as const) {
    for (const device of [{ name: 'desktop', width: 1280, height: 720 }, { name: 'phone', width: 390, height: 844 }] as const) {
      await boot(page, device.width, device.height, theme);
      await openPoint(page, TIBET.lat, TIBET.lon);
      await expect(panel(page).locator('[data-point-elevation]')).toHaveText('4,520 m / 14,829 ft', { timeout: 20_000 });
      await expect(panel(page).locator('[data-sounding]')).toHaveAttribute('data-ground-ft', '14829');
      await expect(panel(page).locator('[data-sounding]')).toHaveAttribute('data-section-mid', '4520');
      await expect(panel(page).locator('[data-sounding]')).toHaveAttribute('data-section-edge', '4520');
      await expect(panel(page).locator('[data-level="surface"] [data-level-label]')).toHaveText('SFC 4,520 m / 14,829 ft');
      await expect(panel(page).locator('[data-level="500"]')).toHaveCount(1);
      await page.screenshot({ path: path.join(OUT, `tibet-${device.name}-${theme}.png`), fullPage: false });

      await openPoint(page, PERTH.lat, PERTH.lon);
      await expect(panel(page).locator('[data-point-elevation]')).toHaveText('20 m / 66 ft', { timeout: 20_000 });
      await expect(panel(page).locator('[data-level="1000"] [data-level-label]')).toHaveText('500 ft');
      await expect(panel(page).locator('[data-level="surface"] [data-level-label]')).toHaveText('SFC 20 m / 66 ft');
      await expect(panel(page).locator('[data-sounding]')).toHaveAttribute('data-section-mid', '20');
      await expect(panel(page).locator('[data-sounding]')).toHaveAttribute('data-section-edge', '20');
      await expect(panel(page).locator('[data-wind-row]')).toHaveCount(11);
      await page.screenshot({ path: path.join(OUT, `perth-${device.name}-${theme}.png`), fullPage: false });
    }
  }
});
