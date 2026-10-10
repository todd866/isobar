import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { chartRoutes } from './map-fixture';
import { installTrainingFiles } from './training-files';
import { choosePlace } from './place-field';
import { globalEquirectangular, cameraProject, project, type Camera } from '../../src/lib/lambert';

// Software rendering in the restricted local runner shares the owner's CPU.
// These are interaction/viewport checks, not frame-time budgets.
test.setTimeout(90_000);

const NOW = Date.parse('2026-10-09T00:00:00Z');
const hour = 3_600_000;
const out = process.env.ISOBAR_KITE_SURF_SHOTS;
const coast = fs.readFileSync(path.resolve('public/coast/ownchart-coast.bin'));
const time = Array.from({ length: 96 }, (_, i) => (NOW + i * hour) / 1000);
function clock(t: number) { const d = new Date(t * 1000 + 8 * hour); return { day: d.getUTCDate(), h: d.getUTCHours() }; }
const wind = {
  timezone: 'Australia/Perth', hourly_units: { wind_speed_10m: 'kn', wind_gusts_10m: 'kn', wind_direction_10m: '°' },
  hourly: { time,
    wind_speed_10m: time.map((t) => { const { day, h } = clock(t); return day === 10 && h >= 13 && h <= 17 ? 20 : day === 11 && h >= 6 && h <= 9 ? 6 : 12; }),
    wind_gusts_10m: time.map((t) => { const { day, h } = clock(t); return day === 10 && h >= 13 && h <= 17 ? 24 : 14; }),
    wind_direction_10m: time.map((t) => clock(t).day === 10 ? 270 : 90),
    is_day: time.map((t) => clock(t).h >= 6 && clock(t).h < 18 ? 1 : 0),
  },
};
const marine = { timezone: 'Australia/Perth', hourly: { time,
  wave_height: time.map(() => 1.8), swell_wave_height: time.map(() => 1.2),
  swell_wave_period: time.map((t) => { const { day, h } = clock(t); return day === 11 && h >= 6 && h <= 9 ? 14 : 8; }),
  swell_wave_direction: time.map(() => 225), secondary_swell_wave_height: time.map((_, i) => i === 1 ? null : .4),
  secondary_swell_wave_period: time.map(() => 7), secondary_swell_wave_direction: time.map(() => 180), sea_surface_temperature: time.map(() => 19),
} };
async function open(page: Page, width = 1280, height = 720, theme = 'light') {
  if (process.env.ISOBAR_E2E_FILES === '1') await installTrainingFiles(page.context());
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(NOW);
  await page.addInitScript((theme) => { localStorage.setItem('isobar-theme', theme); localStorage.setItem('isobar.place', 'perth'); }, theme);
  await chartRoutes(page, true);
  await page.route('**/coast/*.bin', (r) => r.fulfill({ body: coast, contentType: 'application/octet-stream' }));
  await page.route('**/places/world-places.json', (r) => r.fulfill({ json: [['Perth', -31.95, 115.86, 1, 'AU'], ['Cottesloe', -31.998, 115.752, 1, 'AU'], ['Kalgoorlie', -30.75, 121.47, 1, 'AU']] }));
  await page.route('**/airports/**', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/aviation**', (r) => r.fulfill({ status: 404 }));
  let requests = 0, offline = false;
  await page.route('https://api.open-meteo.com/**', async (r) => {
    const u = new URL(r.request().url());
    if (!u.searchParams.get('hourly')?.includes('is_day')) return r.fulfill({ status: 503 });
    requests++;
    if (offline) return r.abort('internetdisconnected');
    expect(u.searchParams.get('forecast_hours')).toBe('96');
    await r.fulfill({ json: wind });
  });
  await page.route('https://marine-api.open-meteo.com/**', (r) => { requests++; return offline ? r.abort('internetdisconnected') : r.fulfill({ json: marine }); });
  await page.goto('/');
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true', { timeout: 20_000 });
  return { requests: () => requests, offline: () => { offline = true; } };
}
async function tapCoast(page: Page) {
  await page.evaluate(() => {
    const api = (document.querySelector('[data-map-ready]') as HTMLElement & { chartApi: { setView: (lat: number, lon: number, h: number) => void } }).chartApi;
    api.setView(-32, 115.8, 12);
  });
  const camera = await page.locator('[data-map-ready]').evaluate((node) => (node as HTMLElement & { chartApi: { camera: () => Camera } }).chartApi.camera());
  const p = project(globalEquirectangular(), -31.998, 115.752)!;
  const c = cameraProject(camera, p.x, p.y);
  const b = (await page.locator('canvas[tabindex="0"]').boundingBox())!;
  const x = b.x + (c.x + 1) * b.width / 2, y = b.y + (1 - c.y) * b.height / 2;
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, { x, y }), JSON.stringify({ x, y, camera, c, b })).toBe('CANVAS');
  await page.mouse.click(x, y);
  await shot(page, 'cottesloe-tap');
  await expect(page.locator('[data-coastal-panel]')).toContainText('Cottesloe');
}
async function shot(page: Page, name: string) {
  if (!out) return;
  fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false });
}
async function fit(page: Page) {
  // Existing authenticated Page only; the shared checker starts no browser.
  const modulePath = process.env.ISOBAR_VIEWPORT_HELPER;
  const lensHeight = page.viewportSize()!.height <= 500 ? 28 : 32; // Existing compact landscape chrome.
  if (modulePath) {
    const { assertViewport } = await import(/* webpackIgnore: true */ modulePath);
    await assertViewport(page, { primary: [{ selector: '[data-coastal-panel]', minWidth: 280, minHeight: 100 }, { selector: '[data-map-ready]', minWidth: 300, minHeight: 150 }], controls: [{ selector: '[data-coastal-panel] button[aria-label^="Close"]', minWidth: 36, minHeight: 40 }, { selector: '[data-lens="kite"]', minWidth: 24, minHeight: lensHeight }, { selector: '[data-lens="surf"]', minWidth: 24, minHeight: lensHeight }] });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await page.locator('[data-coastal-panel]').count()).toBe(1);
  expect(await page.locator('[data-point-panel]').count()).toBe(0);
}
for (const [size, width, height] of [['desktop', 1280, 720], ['phone', 390, 844]] as const) for (const theme of ['light', 'dark']) {
  test(`${size} ${theme}: Kite and Surf rows, best windows and one panel`, async ({ page }) => {
    await open(page, width, height, theme);
    await page.getByRole('radio', { name: 'Kite', exact: true }).click();
    await expect(page.locator('[data-coastal-row]').first()).toBeVisible();
    await expect(page.locator('[data-coastal-best]')).toHaveText('best Sat 13–17');
    await expect(page.locator('[data-hazard="true"]').first()).toContainText('offshore');
    await expect(page.locator('[data-kite-legend]')).toContainText('15–25');
    expect(await page.locator('[data-coastal-row][data-daylight="false"]').count()).toBe(0);
    await fit(page);
    await page.getByRole('button', { name: 'Coastal data sources' }).click();
    await expect(page.locator('[data-coastal-panel] [role=note]')).toContainText('CC BY 4.0');
    await page.getByRole('button', { name: 'Coastal data sources' }).click();
    await shot(page, `${size}-${theme}-kite`);
    await page.getByRole('radio', { name: 'Surf', exact: true }).click();
    await expect(page.locator('[data-coastal-panel="surf"]')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'swell m/s', exact: true })).toBeVisible();
    await expect(page.locator('[data-coastal-best]')).toHaveText('best Sun 06–09');
    await expect(page.locator('[data-coastal-panel]')).toContainText('1.2/8s');
    await expect(page.locator('[data-kite-legend]')).toHaveCount(0);
    await fit(page);
    await shot(page, `${size}-${theme}-surf`);
    await page.getByRole('button', { name: 'Close surf', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Pressure', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-coastal-panel]')).toHaveCount(0);
  });
}
test('Cottesloe tap, band persistence, cache offline reuse and inland Surf', async ({ page }) => {
  const network = await open(page);
  await page.getByRole('radio', { name: 'Kite', exact: true }).click();
  await expect(page.locator('[data-coastal-row]').first()).toBeVisible();
  await tapCoast(page);
  await expect(page.locator('[data-hazard="true"]').first()).toBeVisible();
  const min = page.getByRole('spinbutton', { name: 'Kite minimum knots' });
  await min.fill('18'); await min.press('Enter');
  await expect(page.locator('[data-kite-legend]')).toContainText('18–25');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('isobar.kite-band')!))).toEqual({ min: 18, max: 25 });
  await page.getByRole('button', { name: 'Close kite', exact: true }).click();
  await page.getByRole('radio', { name: 'Kite', exact: true }).click();
  await expect(page.locator('[data-coastal-row]').first()).toBeVisible();
  const calls = network.requests(); network.offline();
  await page.getByRole('button', { name: 'Close kite', exact: true }).click();
  await page.getByRole('radio', { name: 'Kite', exact: true }).click();
  await expect(page.locator('[data-coastal-row]').first()).toBeVisible();
  expect(network.requests()).toBe(calls);
  await expect(min).toHaveValue('18');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true', { timeout: 20_000 });
  await expect(page.getByRole('radio', { name: 'Pressure', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Kite', exact: true }).click();
  await expect(min).toHaveValue('18');
  await expect(page.locator('[data-coastal-row]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await choosePlace(page, 'Kalgoorlie', 't.-30750.121470');
  await page.getByRole('radio', { name: 'Surf', exact: true }).click();
  await expect(page.locator('[data-coastal-panel]')).toContainText('no coast within 50 km');
  await shot(page, 'desktop-light-surf-inland');
});
test('short phone, landscape resize and enlarged text keep controls reachable', async ({ page }) => {
  await open(page, 360, 640);
  await page.getByRole('radio', { name: 'Kite', exact: true }).click();
  await expect(page.locator('[data-coastal-row]').first()).toBeVisible();
  await fit(page); await shot(page, 'small-phone-kite');
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('[data-coastal-panel]')).toHaveAttribute('data-point-layout', 'side');
  await fit(page); await shot(page, 'landscape-kite');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => document.documentElement.style.fontSize = '200%');
  await expect(page.getByRole('spinbutton', { name: 'Kite minimum knots' })).toBeVisible();
  expect(await page.getByLabel('Forecast rows', { exact: true }).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await shot(page, 'desktop-text-200-kite');
  await page.getByRole('button', { name: 'Close kite', exact: true }).click();
  await expect(page.locator('[data-coastal-panel]')).toHaveCount(0);
});

test('Surf keeps swell when wind fails, shows no best, and retries', async ({ page }) => {
  await open(page);
  await page.route('https://api.open-meteo.com/**', (route) => route.fulfill({ status: 503 }));
  await page.getByRole('radio', { name: 'Surf', exact: true }).click();
  await expect(page.locator('[data-coastal-row]').first()).toBeVisible();
  await expect(page.locator('[data-coastal-panel]')).toContainText('1.2/8s');
  await expect(page.locator('[data-coastal-best]')).toHaveText('none');
  await expect(page.getByRole('button', { name: 'Retry forecast' })).toBeVisible();
  await page.route('https://api.open-meteo.com/**', (route) => route.fulfill({ json: wind }));
  await page.getByRole('button', { name: 'Retry forecast' }).click();
  await expect(page.locator('[data-coastal-best]')).toHaveText('best Sun 06–09');
});
