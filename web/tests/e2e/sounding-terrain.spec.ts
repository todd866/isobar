import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { SUMMITS } from '../../src/lib/peaks';
import { tileXToLon, tileYToLat } from '../../src/lib/terrain/terrarium';

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/unit/fixtures/openmeteo-point.json'), 'utf8'));

const OUT = path.join(os.homedir(), '.local/state/isobar-week/sounding-terrain');
const RUN = '2026-10-08T00:00:00Z';
const PERTH = { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.86, icao: 'YPPH' };
const SYDNEY = { id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.87, lon: 151.21, icao: 'YSSY' };
const everest = SUMMITS.find((peak) => peak.name === 'Everest')!;
const aoraki = SUMMITS.find((peak) => peak.name === 'Aoraki')!;
const blanc = SUMMITS.find((peak) => peak.name === 'Mont Blanc')!;
const panel = (page: Page) => page.locator('[data-point-panel]');
const TILE = 32;

const RELIEF = [
  { lat: everest.lat, lon: everest.lon, metres: everest.elevationM, sigmaKm: 8 },
  { lat: aoraki.lat, lon: aoraki.lon, metres: aoraki.elevationM, sigmaKm: 6 },
  { lat: blanc.lat, lon: blanc.lon, metres: blanc.elevationM, sigmaKm: 5 },
];

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

/** RGB PNG whose pixels are terrarium codes. Row 0 is north. */
function png(width: number, height: number, at: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 3 + 1);
    raw[start] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = at(x, y);
      raw[start + 1 + x * 3] = r;
      raw[start + 2 + x * 3] = g;
      raw[start + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encode(metres: number): [number, number, number] {
  const scaled = Math.round((metres + 32768) * 256);
  return [(scaled >> 16) & 255, (scaled >> 8) & 255, scaled & 255];
}

/** Flat within 0.9 km of a summit, then a gaussian, so the tapped peak reads as a mountain. */
function dem(lat: number, lon: number): number {
  if (Math.abs(lat - PERTH.lat) < 4 && Math.abs(lon - PERTH.lon) < 4) return 20;
  let best = 0;
  for (const peak of RELIEF) {
    const dy = (lat - peak.lat) * 111.195;
    const dx = (lon - peak.lon) * 111.195 * Math.cos((peak.lat * Math.PI) / 180);
    const distance = Math.hypot(dx, dy);
    const shaped = distance < 0.9 ? peak.metres : peak.metres * Math.exp(-((distance - 0.9) ** 2) / (2 * peak.sigmaKm ** 2));
    if (shaped > best) best = shaped;
  }
  return best;
}

function tilePng(z: number, x: number, y: number): Buffer {
  return png(TILE, TILE, (col, row) => encode(dem(
    tileYToLat(y + (row + 0.5) / TILE, z),
    tileXToLon(x + (col + 0.5) / TILE, z),
  )));
}

/** Surface pressure that puts the ISA model ground on the named height when MSLP is 1012 hPa. */
function modelPressure(lat: number, lon: number): number | null {
  if (Math.abs(lat - 28) < 0.25 && Math.abs(lon - 86.9) < 0.25) return 511.22;
  if (Math.abs(lat + 43.6) < 0.25 && Math.abs(lon - 170.1) < 0.25) return 793.92;
  if (Math.abs(lat - 45.8) < 0.25 && Math.abs(lon - 6.9) < 0.25) return 745.85;
  return null;
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
    await route.fulfill({ body: tilePng(z, x, y), contentType: 'image/png' });
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
  await page.route('https://api.open-meteo.com/v1/forecast?**', (route) => {
    const url = new URL(route.request().url());
    const body = structuredClone(fixture);
    const lat = Number(url.searchParams.get('latitude'));
    const lon = Number(url.searchParams.get('longitude'));
    const pressure = modelPressure(lat, lon) ?? (Math.abs(lat + 31.9) < 0.25 && Math.abs(lon - 115.9) < 0.25 ? 1013 : null);
    if (pressure != null) body.hourly.surface_pressure = body.hourly.surface_pressure.map(() => pressure);
    return route.fulfill({ json: body });
  });
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
  const pause = page.getByRole('button', { name: 'Pause' });
  if (await pause.isVisible()) await pause.click();
}

async function settledMap(page: Page) {
  // ResizeObserver and the forecast header animation must finish before saving
  // a view or converting a fractional canvas position to a screen tap.
  await expect(page.locator('.map-chrome-body')).not.toHaveAttribute('data-anim', '1');
  await page.evaluate(() => new Promise<void>((resolve) => {
    let previous = '', stable = 0;
    const check = () => {
      const canvas = document.querySelector('canvas[tabindex="0"]')!;
      const r = canvas.getBoundingClientRect();
      const current = `${r.x},${r.y},${r.width},${r.height}`;
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (stable >= 4) resolve(); else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }));
}

async function openSpot(page: Page, lat: number, lon: number, name: string | null, offset: number) {
  if (await panel(page).count()) {
    await page.getByRole('button', { name: 'Close point' }).click();
    await expect(panel(page)).toHaveCount(0);
  }
  await settledMap(page);
  await page.locator('[data-map-ready]').evaluate((node, place) => {
    (node as HTMLElement & { chartApi: { setView: (lat: number, lon: number, heightDeg: number) => void } }).chartApi.setView(place.lat, place.lon, 8);
  }, { lat, lon });
  if (name) {
    await page.waitForFunction((peak) => {
      const api = (document.querySelector('[data-map-ready]') as HTMLElement & { chartApi?: { peaks: () => string[] } }).chartApi;
      return !!api?.peaks().some((label) => label.startsWith(peak));
    }, name);
  }
  await settledMap(page);
  const screen = await page.locator('[data-map-ready]').evaluate((node, place) => (
    (node as HTMLElement & { chartApi: { screen: (lat: number, lon: number) => { x: number; y: number } | null } }).chartApi.screen(place.lat, place.lon)
  ), { lat, lon });
  expect(screen).toBeTruthy();
  const box = (await page.locator('canvas[tabindex="0"]').boundingBox())!;
  await page.mouse.click(box.x + screen!.x + offset, box.y + screen!.y);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('[data-sounding]')).toBeVisible();
}

/** How many pixels higher the centre of the terrain fill sits than a shoulder. */
async function crestGap(page: Page): Promise<number> {
  return page.locator('[data-sounding] canvas').evaluate((canvas) => {
    const node = canvas as HTMLCanvasElement;
    const ctx = node.getContext('2d');
    if (!ctx) return 0;
    const { width, height } = node;
    const data = ctx.getImageData(0, 0, width, height).data;
    const earth = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      return r > 40 && r > b + 18 && g > b + 8;
    };
    const solid = (x: number) => {
      // Follow the ground attached to the bottom, not an isolated warm cloud
      // sprite or temperature mark higher in the atmospheric column.
      let found = false, gap = 0;
      for (let y = height - 1; y >= 0; y -= 1) {
        if (earth(x, y)) { found = true; gap = 0; }
        else if (found && ++gap >= 4) return y + gap;
      }
      return found ? 0 : height;
    };
    return solid(Math.floor(width * 0.12)) - solid(Math.floor(width / 2));
  });
}

test('a summit is a mountain in the profile and a flat coast stays flat', async ({ page }) => {
  test.setTimeout(360_000);
  fs.mkdirSync(OUT, { recursive: true });
  await install(page);
  const places = [
    { id: 'everest', peak: everest, label: 'SFC 8,849 m / 29,032 ft', model: '5400', mountain: true },
    { id: 'aoraki', peak: aoraki, label: 'SFC 3,724 m / 12,218 ft', model: '2000', mountain: true },
    { id: 'blanc', peak: blanc, label: 'SFC 4,808 m / 15,774 ft', model: '2500', mountain: true },
    { id: 'perth', peak: PERTH, label: 'SFC 20 m / 66 ft', model: '-8', mountain: false },
  ] as const;
  for (const theme of ['light', 'dark'] as const) {
    for (const device of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }] as const) {
      await boot(page, device.width, device.height, theme);
      if (device.name === 'desktop') {
        await page.locator('[data-map-ready]').evaluate((node) => {
          (node as HTMLElement & { chartApi: { setView: (lat: number, lon: number, heightDeg: number) => void } }).chartApi.setView(28, 86.9, 18);
        });
        await page.waitForFunction(() => {
          const api = (document.querySelector('[data-map-ready]') as HTMLElement & { chartApi?: { peaks: () => string[] } }).chartApi;
          return !!api?.peaks().some((label) => label.startsWith('Everest'));
        });
        await page.screenshot({ path: path.join(OUT, `labels-${theme}.png`), fullPage: false });
      }
      for (const place of places) {
        const named = 'name' in place.peak && place.peak.name !== 'Perth' ? place.peak.name : null;
        await openSpot(page, place.peak.lat, place.peak.lon, named, named ? 12 : 0);
        if (named) {
          const location = (await panel(page).getAttribute('data-point-location'))!.split(',').map(Number);
          expect(location[0]).toBeCloseTo(place.peak.lat, 8);
          expect(location[1]).toBeCloseTo(place.peak.lon, 8);
        }
        await expect(panel(page).locator('[data-level="surface"] [data-level-label]')).toHaveText(place.label, { timeout: 20_000 });
        await expect(panel(page).locator('[data-point-elevation]')).toHaveText(place.label.replace(/^SFC /, ''));
        await expect(panel(page).locator('[data-sounding]')).toHaveAttribute('data-model-ground-m', place.model);
        if (place.mountain) {
          await expect(panel(page).locator('[data-sounding]')).toHaveAttribute('data-section-mid', String(place.peak.elevationM), { timeout: 20_000 });
          await expect.poll(async () => {
            const node = panel(page).locator('[data-sounding]');
            return Number(await node.getAttribute('data-section-mid')) - Number(await node.getAttribute('data-section-edge'));
          }, { timeout: 20_000 }).toBeGreaterThan(1500);
          await expect.poll(() => crestGap(page), { timeout: 10_000 }).toBeGreaterThan(40);
        } else {
          await expect(panel(page).locator('[data-sounding]')).toHaveAttribute('data-section-mid', '20');
          await expect(panel(page).locator('[data-sounding]')).toHaveAttribute('data-section-edge', '20');
          await expect.poll(() => crestGap(page), { timeout: 10_000 }).toBeLessThan(18);
        }
        if (place.id === 'everest') {
          await expect(panel(page).locator('[data-level="600"]')).toHaveCount(0);
          await expect(panel(page).locator('[data-level="500"]')).toHaveCount(1);
          await expect(panel(page).locator('strong')).toHaveText('Everest');
        }
        await page.screenshot({ path: path.join(OUT, `${place.id}-${device.name}-${theme}.png`), fullPage: false });
      }
    }
  }
});
