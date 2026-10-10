import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/unit/fixtures/openmeteo-point.json'), 'utf8')) as {
  hourly: Record<string, unknown>;
  [key: string]: unknown;
};
const RUN = '2026-10-08T00:00:00Z';
const COLLECTOR_RUN = '2026-10-08T18:00:00Z';
const SHOTS = path.join(os.homedir(), '.local/state/isobar-week/fly-anywhere');
const PERTH = { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.86, icao: 'YPPH' };
const SYDNEY = { id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.87, lon: 151.21, icao: 'YSSY' };

function profileBody() {
  const body = structuredClone(fixture);
  body.model_run = RUN;
  for (const key of Object.keys(body.hourly)) {
    if (key.startsWith('relative_humidity_') && Array.isArray(body.hourly[key])) body.hourly[key] = (body.hourly[key] as number[]).map(() => 30);
  }
  body.hourly.cloud_cover_500hPa = [80, 80, 80, 80];
  body.hourly.cloud_cover_400hPa = [60, 60, 60, 60];
  return body;
}

async function openSeattle(page: Page, theme: 'light' | 'dark') {
  const profileUrls: string[] = [];
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript((mode) => {
    localStorage.setItem('isobar-theme', mode);
    localStorage.setItem('isobar.speed', '8');
  }, theme);
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  const hours = [...Array.from({ length: 49 }, (_, i) => i * 3), 150, 156, 162, 168];
  const grid = { nx: 720, ny: 361, west: -180, east: 179.5, north: 90, south: -90, step: .5, wraps_longitude: true, dtype: 'uint16' };
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
    for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) body.writeUInt16LE(name === 'mslp' ? 10130 : 20, (j * grid.nx + i) * 2);
    return [name, body];
  }));
  const coast = Buffer.alloc(26);
  coast.write('OCST'); coast.writeUInt16LE(1, 4); coast.writeUInt16LE(1, 6); coast.writeUInt16LE(4, 8);
  [[-123, 47], [-122, 47], [-122, 48], [-123, 48]].forEach(([lon, lat], i) => {
    coast.writeInt16LE(lon * 100, 10 + i * 4); coast.writeInt16LE(lat * 100, 12 + i * 4);
  });
  await page.route('https://tiles.mapterhorn.com/**', (route) => route.abort('internetdisconnected'));
  await page.route('**/api/auth/**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/usage', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/coast/*.bin', (route) => route.fulfill({ body: coast, contentType: 'application/octet-stream' }));
  await page.route('**/api/aviation?**', (route) => {
    const icao = new URL(route.request().url()).searchParams.get('icao');
    if (icao !== 'KBFI') return route.fulfill({ json: { icao, metar: null, taf: null } });
    return route.fulfill({ json: {
      icao: 'KBFI', name: 'King County International Airport - Boeing Field', lat: 47.527, lon: -122.3,
      metar: { raw: 'METAR KBFI 080255Z 18008KT 10SM FEW040 12/08 A3012', time: '2026-10-08T02:55:00Z' },
      taf: { raw: 'TAF KBFI 080200Z 0802/0906 18010KT P6SM FEW050', issue: '2026-10-08T02:00:00Z', from: '2026-10-08T02:00:00Z', to: '2026-10-09T06:00:00Z' },
    } });
  });
  await page.route('https://api.open-meteo.com/**', async (route) => {
    const url = new URL(route.request().url());
    const hourly = url.searchParams.get('hourly') ?? '';
    if (!hourly.includes('geopotential_height')) {
      return route.fulfill({ json: {
        latitude: 47.6, longitude: -122.3, timezone: 'America/Los_Angeles', utc_offset_seconds: -25200, model_run: RUN,
        hourly: { time: ['2026-10-08T03:00'], temperature_2m: [12], dew_point_2m: [8], wind_speed_10m: [8], wind_direction_10m: [180], cloud_cover: [40], precipitation: [0], surface_pressure: [1016] },
        daily: { time: ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'], temperature_2m_max: [16, 17, 15, 14, 13, 12, 18], temperature_2m_min: [9, 8, 7, 6, 5, 4, 10], precipitation_sum: [0, 0, 1, 0, 0, 0, 2], wind_speed_10m_max: [12, 10, 14, 8, 9, 11, 13], wind_direction_10m_dominant: [180, 200, 220, 190, 170, 160, 210], weather_code: [2, 1, 3, 0, 2, 1, 61] },
      } });
    }
    profileUrls.push(url.toString());
    expect(url.searchParams.get('latitude')).toBe('47.5');
    expect(url.searchParams.get('longitude')).toBe('-122.3');
    expect(hourly).toContain('cloud_cover_500hPa');
    await route.fulfill({ json: profileBody() });
  });
  await page.route('**/data/**', async (route) => {
    const file = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (file === 'manifest.json') return route.fulfill({ json: manifest });
    if (file === 'points.json') return route.fulfill({ json: { run: RUN, hours, places: {
      perth: { t: hours.map(() => 20), wspd: hours.map(() => 13), wdir: hours.map(() => 220), tp: hours.map(() => 0), cc: hours.map(() => 42) },
      sydney: { t: hours.map(() => 21), wspd: hours.map(() => 11), wdir: hours.map(() => 180), tp: hours.map(() => 0), cc: hours.map(() => 36) },
    } } });
    if (file === 'aviation.json') return route.fulfill({ json: { airports: [], sigmets: [] } });
    if (file === 'sky.json') return route.fulfill({ json: { profiles: [{
      icao: 'YPPH', source: 'ECMWF', model: 'ecmwf_ifs025', run: COLLECTOR_RUN, runKnown: true,
      lat: PERTH.lat, lon: PERTH.lon, elevationFt: 67, coastKm: -19, time: [Date.parse(COLLECTOR_RUN)],
      levels: [{ hPa: 1000, z: [100], t: [15], rh: [40], ws: [10], wd: [180], cc: [0], w: [null] }],
    }] } });
    const body = frames.get(file.replace('.bin', ''));
    return body ? route.fulfill({ body, contentType: 'application/octet-stream' }) : route.fulfill({ status: 404 });
  });
  await page.goto('/');
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true');
  const field = page.getByRole('combobox', { name: 'Place' });
  await field.click();
  await field.fill('Seattle');
  await page.locator('[data-place-option="t.47572.-122342"]').click();
  await page.getByRole('radio', { name: 'Fly', exact: true }).click();
  await expect(page.locator('[data-fly-readout]')).toContainText('KBFI');
  await expect(page.locator('[data-sky-run]')).toHaveText('IFS 0.25° · 08 00Z');
  await expect(page.locator('[data-sky-run]')).toHaveAttribute('title', 'Open-Meteo · IFS 0.25° · 08 00Z');
  await expect(page.locator('[data-sky-canvas="section"]')).toHaveAttribute('aria-label', /freezing level/);
  await expect(page.locator('[data-sky-canvas="section"]')).toHaveAttribute('aria-label', /wind /);
  await page.clock.runFor(1200);
  const sky = await page.locator('[data-sky-canvas="section"]').evaluate((canvas) => {
    const state = (canvas as HTMLCanvasElement & { skyState?: { hasProfile: boolean; freezingFt: number | null; winds: unknown[]; notes: string[]; layers: { source: string }[] } }).skyState;
    if (!state) return null;
    return { hasProfile: state.hasProfile, freezingFt: state.freezingFt, winds: state.winds.length, notes: state.notes, modelLayers: state.layers.filter((layer) => layer.source === 'model').length };
  });
  expect(sky?.hasProfile).toBe(true);
  expect(sky?.freezingFt).toBeGreaterThan(1000);
  expect(sky?.winds).toBeGreaterThan(0);
  expect(sky?.modelLayers).toBeGreaterThan(0);
  expect(sky?.notes ?? []).not.toContain('No model profile at this time');
  expect(profileUrls.length).toBeGreaterThan(0);
  const painted = await page.locator('[data-sky-canvas="section"]').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 400) if (data[i] > 0) lit++;
    return lit;
  });
  expect(painted).toBeGreaterThan(50);
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `kbfi-fly-${theme}.png`) });
}

for (const theme of ['light', 'dark'] as const) {
  test(`KBFI Fly uses an Open-Meteo sky section in ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openSeattle(page, theme);
    expect(errors).toEqual([]);
  });
}
