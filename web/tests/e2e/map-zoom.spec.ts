import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { chartRoutes } from './map-fixture';

/**
 * City-scale zoom, the scale bar, Kelowna at a British Columbia view, and a
 * point panel that leaves with its marker. The chart fixture would replace
 * the place list with Perth and Sydney, so this spec puts the real list back.
 * Theme lives in the menu on this branch.
 */

const SHOTS = process.env.ISOBAR_PHONE_DIR ?? path.join(process.cwd(), 'test-results', 'map-zoom');
const places = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/places/world-places.json'), 'utf8'));

type Cam = { centerX: number; centerY: number; halfWidth: number; halfHeight: number };
type Api = {
  setView: (lat: number, lon: number, heightDeg: number) => void;
  camera: () => Cam;
  places: () => { ready: boolean; names: string[] };
  placeNames: () => string[];
  redraw: () => void;
};

function widthKm(cam: Cam): number {
  const lat = (cam.centerY * Math.PI) / 180;
  const dLon = cam.halfWidth * 2 * (Math.PI / 180);
  const h = Math.cos(lat) ** 2 * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem('isobar-theme', 'light'));
  await page.setViewportSize({ width: 1280, height: 800 });
  await chartRoutes(page, true);
  await page.route('**/places/world-places.json', (route) => route.fulfill({ json: places }));
  await page.route('**/coast/*.bin', (route) => route.continue());
  await page.goto('/');
  await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
  await page.waitForFunction(() => !!(document.querySelector('[data-api="1"]') as HTMLElement & { chartApi?: Api }).chartApi);
  await page.getByRole('button', { name: /pause/i }).first().click().catch(() => {});
}

async function camera(page: Page): Promise<Cam> {
  return page.evaluate(() => (document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: Api }).chartApi.camera());
}

async function frameKm(page: Page, lat: number, lon: number, km: number) {
  await page.evaluate(({ lat, lon, km }) => {
    const api = (document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: Api }).chartApi;
    const widthKm = (cam: Cam) => {
      const φ = (cam.centerY * Math.PI) / 180;
      const dLon = cam.halfWidth * 2 * (Math.PI / 180);
      const h = Math.cos(φ) ** 2 * Math.sin(dLon / 2) ** 2;
      return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
    };
    api.setView(lat, lon, 12);
    const across = widthKm(api.camera());
    api.setView(lat, lon, (12 * km) / across);
  }, { lat, lon, km });
  await page.waitForFunction(() => {
    const api = (document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: Api }).chartApi;
    return api.places().ready && api.placeNames().length > 0;
  }, undefined, { timeout: 20_000 });
}

async function dark(page: Page) {
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Dark' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-map-menu]')).toBeHidden();
  await expect(page.locator('html')).toHaveClass(/dark/);
}

test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }); });

test('zoom in reaches the terrain-scale floor and then stops', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  await frameKm(page, 49.25, -123.1, 700);
  const started = widthKm(await camera(page));
  expect(started).toBeGreaterThan(500);
  await page.evaluate(() => {
    const button = document.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement;
    for (let i = 0; i < 60; i += 1) button.click();
  });
  const floored = await camera(page);
  const across = widthKm(floored);
  expect(across).toBeLessThan(3);
  expect(across).toBeGreaterThan(0.5);
  expect(floored.halfHeight).toBeGreaterThan(0.0049);
  expect(floored.halfHeight).toBeLessThan(0.0051);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const again = await camera(page);
  expect(again.halfWidth).toBeCloseTo(floored.halfWidth, 4);
  expect(again.halfHeight).toBeCloseTo(floored.halfHeight, 4);
  await page.screenshot({ path: `${SHOTS}/close-light.png` });
  await dark(page);
  await page.screenshot({ path: `${SHOTS}/close-dark.png` });
});

test('a 700 km British Columbia view names Kelowna and shows a scale', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  await frameKm(page, 48.2, -121.5, 700);
  const across = widthKm(await camera(page));
  expect(across).toBeGreaterThan(620);
  expect(across).toBeLessThan(780);
  const names = await page.evaluate(() => (document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: Api }).chartApi.placeNames());
  expect(names, names.join(', ')).toContain('Kelowna');
  expect(new Set(names).size, `no repeated names: ${names.join(', ')}`).toBe(names.length);
  const scale = page.locator('[data-scale-bar]');
  await expect(scale).toBeVisible();
  await expect(scale).toHaveAttribute('data-scale-primary', /^\d+(\.\d)? km$/);
  await expect(scale).toHaveAttribute('data-scale-nm', /^\d+(\.\d)? nm$/);
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-graticule', 'off');
  await page.screenshot({ path: `${SHOTS}/bc-700-light.png` });
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Latitude and longitude' }).click();
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-graticule', 'on');
  await expect(page.getByRole('status').filter({ hasText: 'Lat long on' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-map-menu]')).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/bc-700-graticule-light.png` });
  await dark(page);
  await page.screenshot({ path: `${SHOTS}/bc-700-graticule-dark.png` });
});

test('the point panel closes when its point leaves the view', async ({ page }) => {
  test.setTimeout(90_000);
  await page.route(/open-meteo\.com/, (route) => route.abort());
  await open(page);
  await frameKm(page, -19.25, 146.77, 400);
  const box = await page.locator('canvas[aria-label]').boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const panel = page.locator('[data-point-panel]');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-point-marker]')).toBeVisible();
  const marker = {
    lat: await page.locator('[data-point-marker]').getAttribute('data-lat'),
    lon: await page.locator('[data-point-marker]').getAttribute('data-lon'),
  };
  await expect(panel).toHaveAttribute('data-point-location', `${marker.lat},${marker.lon}`);
  const title = await panel.locator('strong').innerText();
  expect(title).not.toMatch(/146\.58/);
  expect(Number(marker.lon)).toBeGreaterThan(140);
  expect(Number(marker.lon)).toBeLessThan(150);
  await page.waitForFunction(() => {
    const api = (document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: Api }).chartApi;
    const cam = api.camera();
    const previous = (window as unknown as { __cam?: Cam }).__cam;
    (window as unknown as { __cam?: Cam }).__cam = cam;
    return !!previous && Math.abs(previous.centerX - cam.centerX) < 1e-4 && Math.abs(previous.centerY - cam.centerY) < 1e-4;
  });
  await frameKm(page, 49.25, -123.1, 700);
  await expect(panel).toHaveCount(0);
  await expect(page.locator('[data-point-marker]')).toHaveCount(0);
  const names = await page.evaluate(() => (document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: Api }).chartApi.placeNames());
  expect(names.join(' ')).not.toMatch(/19\.42/);
});
