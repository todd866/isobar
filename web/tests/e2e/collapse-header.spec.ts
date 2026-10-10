import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chartRoutes, tapPoint } from './map-fixture';
import { choosePlace } from './place-field';

/**
 * The forecast bar collapses to one row, clocks follow the selected place,
 * and an open playhead is wall-clock now. The device zone is New York so
 * place-local AWST is distinct from "my local".
 */

const OUT = path.join(os.homedir(), '.local/state/isobar-week/collapse-header');
const FROZEN = Date.parse('2026-10-09T06:04:00Z');

test.use({ timezoneId: 'America/New_York' });

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
});

async function prepare(page: Page, width: number, height: number, mode: 'light' | 'dark', frozen = false) {
  await page.emulateMedia({ colorScheme: mode });
  await page.addInitScript((theme) => {
    localStorage.setItem('isobar-theme', theme);
    localStorage.setItem('isobar.place', 'perth');
    localStorage.setItem('isobar.speed', '1');
  }, mode);
  if (frozen) await page.clock.setFixedTime(FROZEN);
  await page.setViewportSize({ width, height });
  await chartRoutes(page);
  await page.route('https://api.open-meteo.com/**', (route) => route.abort());
  await page.route('https://marine-api.open-meteo.com/**', (route) => route.abort());
  await page.goto('/');
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await page.waitForFunction(() => {
    const stage = document.querySelector('[data-map-ready]') as (HTMLElement & { chartApi?: { camera?: () => unknown } }) | null;
    return typeof stage?.chartApi?.camera === 'function';
  });
}

async function camera(page: Page) {
  return page.locator('[data-map-ready]').evaluate((node) => {
    const view = (node as HTMLElement & { chartApi: { camera: () => { centerX: number; centerY: number; halfWidth: number; halfHeight: number } | null } }).chartApi.camera();
    if (!view) return null;
    return { centerX: view.centerX, centerY: view.centerY, halfWidth: view.halfWidth, halfHeight: view.halfHeight };
  });
}

async function swipe(page: Page, target: string, dy: number, pointerType: 'touch' | 'mouse' = 'touch') {
  const node = page.locator(target).first();
  const box = (await node.boundingBox())!;
  const x = box.x + Math.min(24, box.width / 2);
  const y = box.y + (dy < 0 ? Math.max(1, box.height - 8) : Math.min(16, box.height / 2));
  if (pointerType === 'touch') {
    const client = await page.context().newCDPSession(page);
    try {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 10; step++) {
        const nextY = Math.max(1, Math.min((page.viewportSize()?.height ?? 900) - 1, y + dy * step / 10));
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: nextY }] });
      }
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await client.detach(); }
  } else {
    const init = { pointerType, clientX: x, clientY: y, pointerId: 1, bubbles: true, cancelable: true };
    await node.dispatchEvent('pointerdown', init);
    await node.dispatchEvent('pointerup', { ...init, clientY: y + dy });
  }
}

function sameCentre(
  before: { centerX: number; centerY: number; halfWidth: number },
  after: { centerX: number; centerY: number; halfWidth: number },
) {
  expect(Math.abs(after.centerX - before.centerX)).toBeLessThan(1e-6);
  expect(Math.abs(after.centerY - before.centerY)).toBeLessThan(1e-6);
  expect(Math.abs(after.halfWidth - before.halfWidth) / Math.max(1, before.halfWidth)).toBeLessThan(0.03);
}

for (const [width, height] of [[390, 844], [1440, 900]] as const) {
  for (const mode of ['light', 'dark'] as const) {
    test(`collapse ${width}x${height} ${mode}`, async ({ page }) => {
      test.setTimeout(120_000);
      await prepare(page, width, height, mode, true);
      const chrome = page.locator('[data-map-chrome]');
      await expect(chrome).toHaveAttribute('data-collapsed', 'false');
      await expect(page.locator('[data-clock-local]:visible').first()).toContainText('AWST');
      await expect(page.locator('[data-clock-zulu]:visible').first()).toHaveText(/^\d{4}Z$/);
      await expect(page.locator('[data-map-time-state]:visible').first()).toContainText(/NOW|FORECAST|PAST/);

      const stageBefore = (await page.locator('[data-map-panel]').boundingBox())!;
      const viewBefore = await camera(page);
      expect(viewBefore).not.toBeNull();

      await swipe(page, '[role="listitem"]', -80);
      await expect(chrome).toHaveAttribute('data-collapsed', 'true');
      await expect(page.getByRole('status', { name: 'Days hidden' })).toBeVisible();
      await expect(page.locator('[data-compact-bar]')).toBeVisible();
      await expect(page.locator('.map-header')).toHaveCount(0);
      await expect(page.locator('[data-timeline]')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(1);
      const compact = page.locator('[data-compact-bar]');
      const overflow = await compact.evaluate((node) => node.scrollWidth - node.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.waitForTimeout(350);
      const stageAfter = (await page.locator('[data-map-panel]').boundingBox())!;
      expect(stageAfter!.height).toBeGreaterThan(stageBefore.height + 24);
      sameCentre(viewBefore!, (await camera(page))!);
      await page.screenshot({ path: path.join(OUT, `${width}x${height}-${mode}-collapsed.png`) });

      await swipe(page, '[data-timeline]', -80);
      await expect(chrome).toHaveAttribute('data-collapsed', 'true');
      await swipe(page, '[data-map-chrome]', -40, 'mouse');
      await expect(chrome).toHaveAttribute('data-collapsed', 'true');

      await page.locator('[data-expand-place]').click();
      await expect(chrome).toHaveAttribute('data-collapsed', 'false');
      await expect(page.locator('[data-place-menu]')).toHaveCount(0);
      await expect(page.getByRole('status', { name: 'Days shown' })).toBeVisible();
      await page.waitForTimeout(350);
      sameCentre(viewBefore!, (await camera(page))!);

      await page.getByRole('button', { name: 'Hide daily forecast' }).click();
      await expect(chrome).toHaveAttribute('data-collapsed', 'true');
      await page.keyboard.press('Escape');
      await expect(chrome).toHaveAttribute('data-collapsed', 'true');
      await page.getByRole('button', { name: 'Show daily forecast' }).click();
      await expect(chrome).toHaveAttribute('data-collapsed', 'false');
      await page.keyboard.press('Escape');
      await expect(chrome).toHaveAttribute('data-collapsed', 'false');

      await page.getByRole('radio', { name: 'Fly', exact: true }).click();
      await expect(page.locator('[data-fly-panel]')).toBeVisible();
      await expect(chrome).toHaveAttribute('data-collapsed', 'true');
      await page.getByRole('button', { name: 'Close Fly' }).click();
      await expect(page.locator('[data-fly-panel]')).toHaveCount(0);
      await expect(chrome).toHaveAttribute('data-collapsed', 'false');

      if (width === 1440) {
        await page.getByRole('button', { name: 'Section', exact: true }).click();
        await expect(page.locator('[data-fly-panel]')).toBeVisible();
        await expect(chrome).toHaveAttribute('data-collapsed', 'true');
        await page.getByRole('button', { name: 'Section', exact: true }).click();
        await expect(chrome).toHaveAttribute('data-collapsed', 'false');
      }

      await page.getByRole('radio', { name: 'Pressure', exact: true }).click();
      await expect(chrome).toHaveAttribute('data-collapsed', 'false');
      await tapPoint(page);
      await expect(chrome).toHaveAttribute('data-collapsed', 'true');
      await page.getByRole('button', { name: 'Close point' }).click();
      await expect(page.locator('[data-point-panel]')).toHaveCount(0);
      await expect(chrome).toHaveAttribute('data-collapsed', 'false');

      await page.screenshot({ path: path.join(OUT, `${width}x${height}-${mode}-expanded.png`) });
    });
  }
}

test('collapsed choice survives a reload and a new visitor starts expanded', async ({ page }) => {
  test.setTimeout(90_000);
  await prepare(page, 1440, 900, 'light', true);
  await page.getByRole('button', { name: 'Hide daily forecast' }).click();
  await expect(page.locator('[data-map-chrome]')).toHaveAttribute('data-collapsed', 'true');
  await page.reload();
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await expect(page.locator('[data-map-chrome]')).toHaveAttribute('data-collapsed', 'true');
  await page.evaluate(() => localStorage.removeItem('isobar.header-collapsed'));
  await page.reload();
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await expect(page.locator('[data-map-chrome]')).toHaveAttribute('data-collapsed', 'false');
});

test('reduced motion collapses without a height transition', async ({ page }) => {
  test.setTimeout(90_000);
  await prepare(page, 1440, 900, 'light', true);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Hide daily forecast' }).click();
  await expect(page.locator('[data-map-chrome]')).toHaveAttribute('data-collapsed', 'true');
  const duration = await page.locator('.map-chrome-body').evaluate((node) => getComputedStyle(node).transitionDuration);
  expect(duration === '0s' || duration === '0ms').toBe(true);
});

test('on open the playhead is wall-clock now', async ({ page }) => {
  test.setTimeout(60_000);
  await prepare(page, 1440, 900, 'light');
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-timeline]');
    if (!node) return false;
    const valid = Number(node.getAttribute('data-valid-ms'));
    return Number.isFinite(valid) && Math.abs(valid - Date.now()) < 60_000;
  }, undefined, { timeout: 15_000 });
});

test('Vancouver shows PDT and Vancouver’s today', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    localStorage.setItem('isobar-theme', 'light');
    localStorage.setItem('isobar.place', 'perth');
    localStorage.setItem('isobar.speed', '1');
  });
  await page.clock.setFixedTime(FROZEN);
  await page.setViewportSize({ width: 1440, height: 900 });
  await chartRoutes(page);
  await page.route('**/places/world-places.json', (route) => route.fulfill({ json: [
    ['Perth', -31.95, 115.86, 1, 'AU'],
    ['Sydney', -33.87, 151.21, 1, 'AU'],
    ['Vancouver', 49.283, -123.121, 1, 'CA'],
  ] }));
  await page.route('https://api.open-meteo.com/**', (route) => route.fulfill({ json: {
    latitude: 49.28,
    longitude: -123.12,
    timezone: 'America/Vancouver',
    utc_offset_seconds: -25200,
    model: 'ecmwf_ifs025',
    model_run: '2026-10-08T00:00:00Z',
    hourly: {
      time: ['2026-10-09T06:00:00Z', '2026-10-09T09:00:00Z'],
      temperature_2m: [12, 11],
      dew_point_2m: [8, 8],
      wind_speed_10m: [6, 6],
      wind_direction_10m: [180, 180],
      cloud_cover: [40, 40],
      precipitation: [0, 0],
      surface_pressure: [1013, 1013],
    },
    daily: {
      time: ['2026-10-08', '2026-10-09', '2026-10-10'],
      temperature_2m_max: [16, 15, 14],
      temperature_2m_min: [8, 7, 6],
      precipitation_sum: [0, 1, 0],
      wind_speed_10m_max: [10, 8, 9],
      wind_direction_10m_dominant: [180, 200, 160],
      weather_code: [1, 2, 0],
    },
  } }));
  await page.route('https://marine-api.open-meteo.com/**', (route) => route.abort());
  await page.goto('/');
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await choosePlace(page, 'Vancouver', 't.49283.-123121');
  await expect(page.locator('.when-long [data-clock-local]')).toContainText('PDT');
  await expect(page.locator('.when-long [data-clock-local]')).toContainText('Thu');
  await expect(page.locator('.when-long [data-clock-zulu]')).toHaveText('0604Z');
  await expect(page.getByRole('listitem').first()).toContainText('Today');
  await expect(page.getByRole('listitem').first()).toHaveAttribute('title', /^2026-10-08/);
  await expect(page.getByRole('listitem').nth(1)).toContainText('Fri');
  await expect(page.locator('.when-long')).not.toContainText('EDT');
  await expect(page.locator('.when-long')).not.toContainText('AWST');
});

test('Times switches place local, UTC and this device, and stays in this browser', async ({ page }) => {
  test.setTimeout(90_000);
  await prepare(page, 1440, 900, 'light', true);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const times = page.locator('select[data-times]');
  await expect(times).toBeVisible();
  await expect(times).toHaveValue('place');
  await page.screenshot({ path: path.join(OUT, '1440x900-light-menu.png') });
  await times.selectOption('utc');
  await expect(page.locator('.when-long [data-clock-local]')).toContainText('UTC');
  await expect(page.locator('.when-long [data-clock-zulu]')).toHaveCount(0);
  await expect(page.locator('[data-map-menu]')).toBeVisible();
  await times.selectOption('device');
  await expect(page.locator('.when-long [data-clock-local]')).toContainText('EDT');
  await expect(page.locator('.when-long [data-clock-zulu]')).toHaveText('0604Z');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-map-chrome]')).toHaveAttribute('data-collapsed', 'false');
  await page.reload();
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(page.locator('select[data-times]')).toHaveValue('device');
  await expect(page.locator('.when-long [data-clock-local]')).toContainText('EDT');
});

test('a traffic track collapses the bar and removing it restores the bar', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    localStorage.setItem('isobar-theme', 'light');
    localStorage.setItem('isobar.place', 'perth');
    localStorage.setItem('isobar.speed', '1');
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await chartRoutes(page);
  await page.route('https://api.adsb.lol/**', (route) => route.abort());
  await page.route('https://api.open-meteo.com/**', (route) => route.abort());
  await page.route('https://marine-api.open-meteo.com/**', (route) => route.abort());
  await page.route('**/api/traffic/trace**', async (route) => {
    const now = Date.now();
    await route.fulfill({
      headers: { 'X-Traffic-Session': route.request().headers()['x-traffic-session'] ?? '' },
      json: { source: 'session', points: [0, 1, 2].map((i) => ({ latitude: -31.9 - i * 0.1, longitude: 115.9 - i * 0.1, timeMs: now - i * 60_000, pressureAltitudeFt: 18000 - i * 1000 })) },
    });
  });
  await page.route('**/api/traffic/route-lookup**', (route) => route.fulfill({ json: { route: null } }));
  await page.route('**/api/traffic?*', (route) => route.fulfill({ json: {
    time: Date.now(), source: 'ADSB.lol', radiusNm: 80, sessionToken: 'fixture-session-abcdefghijklmnopqrstuvwxyz', routeLookupEnabled: false,
    aircraft: [{
      hex: 'abc001', callsign: 'QFA642', registration: 'VH-TEST', type: 'B738',
      latitude: -31.9, longitude: 115.9, pressureAltitudeFt: 18000, distanceNm: 4,
      positionTimeMs: Date.now() - 2000, groundSpeedKt: 240, verticalRateFtMin: 0, squawk: '1200', trackDegrees: 350,
    }],
  } }));
  await page.goto('/');
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await page.getByRole('radio', { name: 'Fly', exact: true }).click();
  await expect(page.locator('[data-map-chrome]')).toHaveAttribute('data-collapsed', 'true');
  await page.getByRole('button', { name: 'Show daily forecast', exact: true }).click();
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await page.getByRole('button', { name: 'Close Fly' }).click();
  await expect(page.locator('[data-map-chrome]')).toHaveAttribute('data-collapsed', 'false');
  await page.locator('[data-map-ready]').evaluate((node) => {
    (node as HTMLElement & { chartApi: { setView: (lat: number, lon: number, heightDeg: number) => void } }).chartApi.setView(-31.95, 115.86, 8);
  });
  await expect.poll(async () => page.locator('canvas[data-traffic-layer]').evaluate((canvas) => {
    const glyphs = (canvas as HTMLCanvasElement & { trafficGlyphs?: { x: number; y: number; aircraft: { callsign: string } }[] }).trafficGlyphs ?? [];
    const glyph = glyphs.find((item) => item.aircraft.callsign === 'QFA642');
    return glyph ? `${glyph.x},${glyph.y}` : '';
  }), { timeout: 15_000 }).not.toBe('');
  const canvas = (await page.locator('canvas[data-traffic-layer]').boundingBox())!;
  const glyph = await page.locator('canvas[data-traffic-layer]').evaluate((node) => {
    const glyphs = (node as HTMLCanvasElement & { trafficGlyphs?: { x: number; y: number; aircraft: { callsign: string } }[] }).trafficGlyphs ?? [];
    return glyphs.find((item) => item.aircraft.callsign === 'QFA642') ?? null;
  });
  await page.mouse.click(canvas.x + glyph!.x, canvas.y + glyph!.y);
  await expect(page.locator('[data-traffic-card]')).toContainText('PAST');
  await expect(page.locator('[data-map-chrome]')).toHaveAttribute('data-collapsed', 'true');
  await page.getByRole('button', { name: 'Remove QFA642' }).click();
  await expect(page.locator('[data-traffic-card]')).toHaveCount(0);
  await expect(page.locator('[data-map-chrome]')).toHaveAttribute('data-collapsed', 'false');
});
