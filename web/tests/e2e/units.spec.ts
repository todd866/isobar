import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/unit/fixtures/openmeteo-point.json'), 'utf8'));
const shots = path.join(os.homedir(), '.local/state/isobar-week/units');
const RUN = '2026-10-08T00:00:00Z';
const PERTH = { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.86, icao: 'YPPH' };
const SYDNEY = { id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.87, lon: 151.21, icao: 'YSSY' };

const placeForecast = {
  latitude: 39.7,
  longitude: -105,
  timezone: 'America/Denver',
  utc_offset_seconds: -21600,
  model: 'ecmwf_ifs025',
  model_run: RUN,
  hourly: {
    time: ['2026-10-08T03:00:00Z'],
    temperature_2m: [14],
    dew_point_2m: [7],
    wind_speed_10m: [8],
    wind_direction_10m: [220],
    cloud_cover: [40],
    precipitation: [0],
    surface_pressure: [1013.25],
  },
  daily: {
    time: ['2026-10-07', '2026-10-08', '2026-10-09'],
    temperature_2m_max: [20, 20, 18],
    temperature_2m_min: [10, 10, 9],
    precipitation_sum: [2.5, 0, 1.2],
    wind_speed_10m_max: [12, 8, 10],
    wind_direction_10m_dominant: [220, 180, 200],
    weather_code: [1, 0, 2],
  },
};

async function open(page: Page, theme: 'light' | 'dark') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript((mode) => {
    localStorage.setItem('isobar-theme', mode);
    localStorage.setItem('isobar.place', 'perth');
    localStorage.setItem('isobar.speed', '8');
  }, theme);
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  const hours = [...Array.from({ length: 49 }, (_, i) => i * 3), 150, 156, 162, 168];
  const grid = { nx: 720, ny: 361, west: -180, east: 179.5, north: 90, south: -90, step: 0.5, wraps_longitude: true, dtype: 'uint16' };
  const variables = Object.fromEntries(['mslp', 'rain24', 't2m', 'wind', 'u10', 'v10'].map((name) => [name, {
    frames: hours.map(() => `${name}.bin`),
    units: name === 'mslp' ? 'hPa' : name === 't2m' ? '°C' : name === 'rain24' ? 'mm' : 'kt',
    scale: 1, offset: 0, fill: 65535,
  }]));
  const manifest = {
    schema: 2, contract: 'isobar-web', run: RUN, generated: RUN, forecast_hours: hours, grid, variables,
    places: [PERTH, SYDNEY], points: 'points.json', aviation: 'aviation.json',
    attribution: [{ source: 'Synthetic units chart', licence: 'Test fixture' }],
  };
  const cells = grid.nx * grid.ny;
  const frames = new Map(Object.keys(variables).map((name) => {
    const body = Buffer.alloc(cells * 2);
    const flat = name !== 'mslp';
    const constant = name === 't2m' ? 20 : name === 'rain24' ? 2 : 15;
    for (let j = 0; j < grid.ny; j++) {
      for (let i = 0; i < grid.nx; i++) {
        const value = flat ? constant : 1000 + Math.round(18 * Math.sin(i / 18) * Math.cos(j / 12));
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
  await page.route('https://tiles.mapterhorn.com/**', (route) => route.abort('internetdisconnected'));
  await page.route('**/coast/*.bin', (route) => route.fulfill({ body: coast, contentType: 'application/octet-stream' }));
  await page.route('**/data/**', async (route) => {
    const file = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (file === 'manifest.json') return route.fulfill({ json: manifest });
    if (file === 'points.json') return route.fulfill({ json: { run: RUN, hours, places: {
      perth: { t: hours.map(() => 20), wspd: hours.map(() => 13), wdir: hours.map(() => 220), tp: hours.map(() => 0), cc: hours.map(() => 42) },
      sydney: { t: hours.map(() => 21), wspd: hours.map(() => 11), wdir: hours.map(() => 180), tp: hours.map(() => 0), cc: hours.map(() => 36) },
    } } });
    if (file === 'aviation.json') return route.fulfill({ json: { airports: [{ ...PERTH, metar: { raw: 'METAR YPPH 080300Z 22013KT 9999 SCT030 19/11 Q1013', time: '2026-10-08T03:00:00Z' }, taf: null }], sigmets: [] } });
    if (file === 'sky.json') return route.fulfill({ json: { profiles: [] } });
    const body = frames.get(file.replace('.bin', ''));
    return body ? route.fulfill({ body, contentType: 'application/octet-stream' }) : route.fulfill({ status: 404 });
  });
  await page.route('**/places/world-places.json', (route) => route.fulfill({ json: [
    ['Perth', -31.95, 115.86, 1, 'AU'], ['Denver', 39.74, -104.99, 1, 'US'], ['Beijing', 39.9, 116.41, 1, 'CN'],
  ] }));
  await page.route('**/places/airports.json', (route) => route.fulfill({ json: [
    ['KDEN', 'DEN', 'Denver International', 39.86, -104.67, 'Denver', 0],
    ['ZBAA', 'PEK', 'Beijing Capital', 40.08, 116.58, 'Beijing', 0],
  ] }));
  await page.route('https://api.open-meteo.com/v1/forecast?**', (route) => {
    const url = route.request().url();
    return route.fulfill({ json: url.includes('daily=') ? placeForecast : fixture });
  });
  await page.route('https://marine-api.open-meteo.com/**', (route) => route.fulfill({ json: { hourly: {
    time: ['2026-10-08T00:00', '2026-10-08T03:00'],
    sea_surface_temperature: [18.4, 18.4],
    ocean_current_velocity: [null, null],
    ocean_current_direction: [null, null],
    wave_height: [null, null],
    swell_wave_height: [null, null],
    swell_wave_period: [null, null],
    swell_wave_direction: [null, null],
  } } }));
  await page.goto('/');
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true');
  await page.waitForFunction(() => !!(document.querySelector('[data-map-ready]') as HTMLElement & { chartApi?: unknown })?.chartApi);
}

const units = (page: Page) => page.locator('select[data-units]');

async function selectUnits(page: Page, value: string) {
  const control = units(page);
  if (!(await control.isVisible().catch(() => false))) {
    const expand = page.getByRole('button', { name: 'Show daily forecast', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.locator('[data-map-menu]')).toBeVisible();
  }
  await control.selectOption(value);
  // Keep the map unobstructed for the following lens and screenshot checks.
  const menuButton = page.getByRole('button', { name: 'Menu', exact: true });
  if (await page.locator('[data-map-menu]').isVisible().catch(() => false)) await menuButton.click();
}

async function setView(page: Page, lat: number, lon: number) {
  await page.locator('[data-map-ready]').evaluate((node, view) => {
    (node as HTMLElement & { chartApi: { setView: (lat: number, lon: number, height: number) => void } }).chartApi.setView(view.lat, view.lon, 18);
  }, { lat, lon });
}

async function labelText(page: Page): Promise<string> {
  return page.locator('[data-map-ready]').evaluate((node) => {
    const api = (node as HTMLElement & { chartApi?: { labels?: () => { text: string }[] } }).chartApi;
    return (api?.labels?.() ?? []).map((label) => label.text).join(' ');
  });
}

async function theme(page: Page, mode: 'light' | 'dark') {
  const dark = await page.locator('html').evaluate((root) => root.classList.contains('dark'));
  if (dark === (mode === 'dark')) return;
  if (!(await page.getByRole('button', { name: mode === 'dark' ? 'Dark' : 'Light', exact: true }).isVisible().catch(() => false))) {
    const expand = page.getByRole('button', { name: 'Show daily forecast', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.locator('[data-map-menu]')).toBeVisible();
  }
  await page.getByRole('button', { name: mode === 'dark' ? 'Dark' : 'Light' }).click();
  await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /dark/ : /^((?!dark).)*$/);
  if (await page.locator('[data-map-menu]').isVisible().catch(() => false)) await page.getByRole('button', { name: 'Menu', exact: true }).click();
}

/** Light and dark at the two review sizes. Restores the desktop light page. */
async function frames(page: Page, name: string) {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true');
    for (const mode of ['light', 'dark'] as const) {
      await theme(page, mode);
      await page.screenshot({ path: path.join(shots, `${name}-${mode}-${width}x${height}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await theme(page, 'light');
}

test('units follow the picker on every surface', async ({ page }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(shots, { recursive: true });
  await open(page, 'light');
  if (!(await units(page).isVisible().catch(() => false))) {
    const expand = page.getByRole('button', { name: 'Show daily forecast', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.locator('[data-map-menu]')).toBeVisible();
  }
  await expect(units(page)).toHaveAttribute('data-units', 'aus');
  await expect(units(page)).toHaveAttribute('data-pressure-unit', 'hPa');
  await expect(page.locator('[data-pressure-chip]')).toHaveText('hPa');
  await expect(page.locator('[data-reading]')).toContainText('20°');
  await expect(page.locator('[data-reading]')).not.toContainText('°F');
  await expect.poll(() => labelText(page), { timeout: 20_000 }).toMatch(/\b\d{3,4}\b/);
  expect(await labelText(page)).not.toMatch(/\bhPa\b/);
  if (await page.locator('[data-map-menu]').isVisible().catch(() => false)) await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await frames(page, 'aus');

  await selectUnits(page, 'us');
  await expect(units(page)).toHaveAttribute('data-pressure-unit', 'inHg');
  await expect(units(page)).toHaveAttribute('data-temp-unit', 'F');
  await expect(units(page)).toHaveAttribute('title', /inHg · °F/);
  await expect(page.locator('[data-reading]')).toContainText('68°F');
  await expect(page.getByRole('listitem').first()).toContainText('°F');
  await page.getByRole('radio', { name: 'Temp', exact: true }).click();
  await expect(page.locator('.map-legend')).toContainText('°F');
  await page.getByRole('radio', { name: 'Rain', exact: true }).click();
  await expect(page.locator('.map-legend')).toContainText(' in');
  await page.getByRole('radio', { name: 'Pressure', exact: true }).click();
  await expect(page.locator('[data-pressure-chip]')).toHaveText('inHg');
  await expect.poll(() => labelText(page), { timeout: 20_000 }).toMatch(/\d+\.\d{2}/);
  expect(await labelText(page)).not.toContain('inHg');
  await frames(page, 'us');
  // frames() lets the forecast play on. The METAR is only in force near now.
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await page.getByRole('radio', { name: 'Fly', exact: true }).click();
  await expect(page.locator('[data-fly-readout]')).toContainText('SM');
  await page.getByRole('radio', { name: 'Pressure', exact: true }).click();

  const map = page.locator('canvas[tabindex="0"]');
  const box = await map.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x + box!.width * 0.45, box!.y + box!.height * 0.4);
  await expect(page.locator('[data-point-panel]')).toBeVisible();
  await expect(page.locator('[data-readout]')).toContainText('°F');
  await expect(page.locator('[data-wind-row][data-level="1000"]')).toHaveAttribute('title', /inHg/);
  // The open point keeps framing its own place. Close it before LOCAL follows the camera.
  await page.getByRole('button', { name: 'Close point' }).click();
  await expect(page.locator('[data-point-panel]')).toBeHidden();

  await selectUnits(page, 'local');
  await expect(units(page)).toHaveAttribute('data-units-region', 'au');
  await setView(page, 39.74, -104.99);
  expect(await units(page).getAttribute('data-pressure-unit')).toBe('hPa');
  await page.clock.runFor(1200);
  await expect(units(page)).toHaveAttribute('data-pressure-unit', 'inHg');
  await expect(units(page)).toHaveAttribute('data-units-region', 'us');
  await expect(units(page)).toHaveAttribute('data-temp-unit', 'F');
  await expect(page.locator('[data-reading]')).toContainText('°F');
  await frames(page, 'local-denver');

  await setView(page, 39.9, 116.41);
  expect(await units(page).getAttribute('data-pressure-unit')).toBe('inHg');
  await page.clock.runFor(1200);
  await expect(units(page)).toHaveAttribute('data-height-unit', 'm');
  await expect(units(page)).toHaveAttribute('data-units-region', 'cn');
  await expect(units(page)).toHaveAttribute('data-flight-level', 'metric');
  await expect(units(page)).toHaveAttribute('data-temp-unit', 'C');
  await page.mouse.click(box!.x + box!.width * 0.45, box!.y + box!.height * 0.4);
  await expect(page.locator('[data-point-panel]')).toBeVisible();
  await expect(page.locator('[data-level-label]', { hasText: /^S\d{4}$/ }).first()).toBeVisible();
  const metric = page.locator('[data-wind-row]', { has: page.locator('[data-level-label]', { hasText: /^S\d{4}$/ }) }).first();
  await expect(metric).toHaveAttribute('title', /ft/);
  await frames(page, 'local-beijing');

  await selectUnits(page, 'us');
  const place = page.getByRole('combobox', { name: 'Place' });
  await place.click();
  await place.fill('Denver');
  const denver = page.locator('[data-place-option^="t."]').filter({ hasText: 'Denver' });
  await expect(denver).toBeVisible();
  await expect(denver).toContainText('US');
  await denver.click();
  await expect(page.locator('[data-place]')).toHaveAttribute('data-place', /t\.3974/);
  await expect(page.locator('[data-reading]')).toContainText('57°F');
  await expect(page.getByRole('listitem').first()).toContainText('°F');
});
