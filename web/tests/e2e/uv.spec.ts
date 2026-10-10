import { expect, test, type Page, type Route } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { choosePlace } from './place-field';

const shots = path.join(os.homedir(), '.local/state/isobar-week/uv');
const PERTH = { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.86, icao: 'YPPH' };
const SYDNEY = { id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.87, lon: 151.21, icao: 'YSSY' };
const HOBART = { name: 'Hobart', lat: -42.88, lon: 147.33 };
const HOBART_ID = `t.${Math.round(HOBART.lat * 1000)}.${Math.round(HOBART.lon * 1000)}`;

function hoursOf(days: string[], uvAt: (day: string, hour: number) => number, temp: number) {
  const time: string[] = [];
  const uv: number[] = [];
  const temperature: number[] = [];
  for (const day of days) {
    for (let hour = 0; hour < 24; hour += 1) {
      time.push(`${day}T${String(hour).padStart(2, '0')}:00`);
      uv.push(uvAt(day, hour));
      temperature.push(temp);
    }
  }
  return { time, uv_index: uv, temperature_2m: temperature, dew_point_2m: temperature.map((value) => value - 4), wind_speed_10m: temperature.map(() => 12), wind_direction_10m: temperature.map(() => 270), cloud_cover: temperature.map(() => 20), precipitation: temperature.map(() => 0), surface_pressure: temperature.map(() => 1013) };
}

function perthSummer() {
  const days = ['2026-01-15', '2026-01-16', '2026-01-17'];
  return {
    latitude: -31.9,
    longitude: 115.9,
    timezone: 'Australia/Perth',
    utc_offset_seconds: 28800,
    model: 'ecmwf_ifs025',
    model_run: '2026-01-15T00:00:00Z',
    hourly: hoursOf(days, (day, hour) => {
      if (day === '2026-01-15' && hour >= 11 && hour <= 13) return 12;
      if (day === '2026-01-15' && hour >= 8 && hour <= 16) return 5;
      if (day === '2026-01-16' && hour >= 9 && hour <= 15) return 6;
      return 1;
    }, 31),
    daily: {
      time: days,
      temperature_2m_max: [34, 33, 20],
      temperature_2m_min: [18, 17, 12],
      precipitation_sum: [0, 0, 0.4],
      wind_speed_10m_max: [14, 12, 10],
      wind_direction_10m_dominant: [220, 200, 180],
      weather_code: [1, 1, 2],
      uv_index_max: [12, 6, 2],
    },
  };
}

function hobartWinter() {
  const days = ['2026-07-15', '2026-07-16', '2026-07-17'];
  return {
    latitude: -42.9,
    longitude: 147.3,
    timezone: 'Australia/Hobart',
    utc_offset_seconds: 36000,
    model: 'ecmwf_ifs025',
    model_run: '2026-07-15T00:00:00Z',
    hourly: hoursOf(days, () => 1, 9),
    daily: {
      time: days,
      temperature_2m_max: [11, 10, 12],
      temperature_2m_min: [4, 3, 5],
      precipitation_sum: [0.4, 1.2, 0],
      wind_speed_10m_max: [12, 15, 8],
      wind_direction_10m_dominant: [270, 250, 300],
      weather_code: [3, 61, 2],
      uv_index_max: [2, 1, 2],
    },
  };
}

async function installChart(page: Page, run: string, forecast: (url: string) => unknown) {
  const hours = Array.from({ length: 33 }, (_, index) => index * 3);
  const grid = { nx: 64, ny: 49, west: 105, east: 168, north: 0, south: -48, step: 1, dtype: 'uint16' };
  const variables = Object.fromEntries(['mslp', 'rain24', 't2m', 'wind', 'u10', 'v10'].map((name) => [name, {
    frames: hours.map(() => `${name}.bin`),
    units: name === 'mslp' ? 'hPa' : name === 't2m' ? '°C' : name === 'rain24' ? 'mm' : 'kt',
    scale: 1, offset: 0, fill: 65535,
  }]));
  const manifest = {
    schema: 2, contract: 'isobar-web', run, generated: run, forecast_hours: hours, grid, variables,
    places: [PERTH, SYDNEY], points: 'points.json', aviation: 'aviation.json',
    attribution: [{ source: 'Synthetic UV chart', licence: 'Test fixture' }],
  };
  const frames = new Map(Object.keys(variables).map((name) => {
    const body = Buffer.alloc(grid.nx * grid.ny * 2);
    for (let j = 0; j < grid.ny; j += 1) {
      for (let i = 0; i < grid.nx; i += 1) body.writeUInt16LE(name === 'mslp' ? 10130 : 20, (j * grid.nx + i) * 2);
    }
    return [name, body];
  }));
  const coast = Buffer.alloc(26);
  coast.write('OCST');
  coast.writeUInt16LE(1, 4);
  coast.writeUInt16LE(1, 6);
  coast.writeUInt16LE(4, 8);
  [[113, -35], [120, -35], [120, -20], [113, -20]].forEach(([lon, lat], index) => {
    coast.writeInt16LE(lon * 100, 10 + index * 4);
    coast.writeInt16LE(lat * 100, 12 + index * 4);
  });
  await page.route('https://tiles.mapterhorn.com/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('https://marine-api.open-meteo.com/**', (route) => route.abort('internetdisconnected'));
  await page.route('https://api.open-meteo.com/**', (route) => {
    const url = route.request().url();
    if (!url.includes('daily=')) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ json: forecast(url) });
  });
  await page.route('**/api/auth/**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/usage', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/coast/*.bin', (route) => route.fulfill({ body: coast, contentType: 'application/octet-stream' }));
  await page.route('**/places/world-places.json', (route) => route.fulfill({ json: [
    ['Perth', -31.95, 115.86, 1, 'AU'], ['Sydney', -33.87, 151.21, 1, 'AU'], [HOBART.name, HOBART.lat, HOBART.lon, 1, 'AU'],
  ] }));
  await page.route('**/places/airports.json', (route) => route.fulfill({ json: [] }));
  await page.route('**/data/**', (route: Route) => {
    const file = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (file === 'manifest.json') return route.fulfill({ json: manifest });
    if (file === 'points.json') return route.fulfill({ json: { run, hours, places: {
      perth: { t: hours.map((hour) => 18 + (hour % 12)), wspd: hours.map(() => 14), wdir: hours.map(() => 220), tp: hours.map(() => 0), cc: hours.map(() => 10) },
      sydney: { t: hours.map(() => 24), wspd: hours.map(() => 11), wdir: hours.map(() => 180), tp: hours.map(() => 0), cc: hours.map(() => 36) },
    } } });
    if (file === 'aviation.json') return route.fulfill({ json: { airports: [{ ...PERTH, metar: null, taf: null }], sigmets: [] } });
    if (file === 'sky.json') return route.fulfill({ json: { profiles: [] } });
    const body = frames.get(file.replace('.bin', ''));
    return body ? route.fulfill({ body, contentType: 'application/octet-stream' }) : route.fulfill({ status: 404 });
  });
}

async function open(page: Page, when: string, run: string, forecast: (url: string) => unknown) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('isobar-theme', 'light');
    localStorage.setItem('isobar.place', 'perth');
    localStorage.setItem('isobar.speed', '1');
  });
  await page.clock.setFixedTime(Date.parse(when));
  await installChart(page, run, forecast);
  await page.goto('/');
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true', { timeout: 60_000 });
  const pause = page.getByRole('button', { name: 'Pause' });
  if (await pause.isVisible().catch(() => false)) await pause.click();
  await expect(page.locator('.press-note')).toHaveCount(0);
}

async function theme(page: Page, mode: 'light' | 'dark') {
  const dark = await page.locator('html').evaluate((root) => root.classList.contains('dark'));
  if (dark === (mode === 'dark')) return;
  const name = mode === 'dark' ? 'Dark' : 'Light';
  if (!(await page.getByRole('button', { name, exact: true }).isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.locator('[data-map-menu]')).toBeVisible();
  }
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /dark/ : /^((?!dark).)*$/);
  if (await page.locator('[data-map-menu]').isVisible().catch(() => false)) await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(page.locator('[data-map-menu]')).toBeHidden();
}

test('a Perth summer day shows UV 12 in extreme colour', async ({ page }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(shots, { recursive: true });
  await open(page, '2026-01-15T04:00:00Z', '2026-01-15T00:00:00Z', () => perthSummer());
  const header = page.locator('.map-header [data-uv]');
  await expect(header).toHaveText('UV 12');
  await expect(header).toHaveAttribute('data-uv', 'extreme');
  await expect(header).toHaveAttribute('title', 'Sun protection 8 am–4 pm');
  await expect(header).toHaveCSS('color', 'rgb(107, 63, 160)');
  const tiles = page.locator('[aria-label="Forecast days"] [role="listitem"]');
  const today = tiles.filter({ hasText: 'Today' });
  await expect(today.locator('[data-uv]')).toHaveText('UV 12');
  await expect(today.locator('[data-uv]')).toHaveAttribute('data-uv', 'extreme');
  await expect(today.locator('[data-uv]')).toHaveAttribute('title', 'Sun protection 8 am–4 pm');
  await expect(today.locator('[data-uv]')).toHaveCSS('color', 'rgb(107, 63, 160)');
  const friday = tiles.filter({ hasText: 'Fri' });
  await expect(friday.locator('[data-uv]')).toHaveText('UV 6');
  await expect(friday.locator('[data-uv]')).toHaveAttribute('data-uv', 'high');
  const saturday = tiles.filter({ hasText: 'Sat' });
  await expect(saturday).toBeVisible();
  await expect(saturday.locator('[data-uv]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Data sources' }).click();
  await expect(page.locator('.map-sources')).toContainText('including the UV index');
  await page.getByRole('button', { name: 'Data sources' }).click();
  await expect(page.locator('.map-sources')).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, 'perth-light.png'), animations: 'disabled' });
  await theme(page, 'dark');
  await expect(header).toHaveCSS('color', 'rgb(215, 166, 240)');
  await page.screenshot({ path: path.join(shots, 'perth-dark.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(header).toHaveText('UV 12');
  await page.screenshot({ path: path.join(shots, 'perth-phone-dark.png'), animations: 'disabled' });
  await theme(page, 'light');
  await expect(header).toHaveCSS('color', 'rgb(107, 63, 160)');
  await page.screenshot({ path: path.join(shots, 'perth-phone-light.png'), animations: 'disabled' });
});

test('a winter Hobart day shows no UV', async ({ page }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(shots, { recursive: true });
  await open(page, '2026-07-15T02:00:00Z', '2026-07-15T00:00:00Z', () => hobartWinter());
  await choosePlace(page, 'Hobart', HOBART_ID);
  await expect(page.locator('[data-reading] > span').first()).toHaveText('9°');
  await expect(page.locator('[aria-label="Forecast days"]')).toContainText('11°');
  await expect(page.locator('[data-uv]')).toHaveCount(0);
  await expect(page.locator('[aria-label="Forecast days"] [role="listitem"]').filter({ hasText: 'Today' })).not.toContainText('UV');
  await page.screenshot({ path: path.join(shots, 'hobart-light.png'), animations: 'disabled' });
  await theme(page, 'dark');
  await expect(page.locator('[data-uv]')).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, 'hobart-dark.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-uv]')).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, 'hobart-phone-dark.png'), animations: 'disabled' });
  await theme(page, 'light');
  await page.screenshot({ path: path.join(shots, 'hobart-phone-light.png'), animations: 'disabled' });
});
