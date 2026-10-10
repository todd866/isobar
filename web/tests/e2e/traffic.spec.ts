import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chartRoutes } from './map-fixture';
import { installTrainingFiles } from './training-files';

/**
 * ADS-B over the map. The browser only calls /api/traffic; ADSB.lol is aborted.
 * Positions are a fixture, not a live feed.
 */

const OUT = path.join(process.cwd(), '..', 'build', 'traffic-qa', 'web');

function aircraft(now: number, index: number) {
  const lon = 115.86 + (index - 1) * 0.7;
  const lat = -31.95 + (index % 5) * 0.28;
  return {
    hex: `abc${index.toString(16).padStart(3, '0')}`,
    callsign: index === 1 ? 'QFA642' : index === 2 ? 'VOZ771' : 'TEST123',
    registration: 'VH-TEST',
    type: index === 1 ? 'BE20' : 'B738',
    latitude: index === 1 ? -31.9 : lat,
    longitude: index === 1 ? 115.9 : lon,
    pressureAltitudeFt: index === 1 ? 18000 : index === 2 ? 24000 : 12000,
    distanceNm: 4,
    positionTimeMs: now - 2000,
    groundSpeedKt: index === 1 ? 240 : index === 2 ? 410 : 220,
    verticalRateFtMin: index === 1 ? 600 : index === 2 ? -400 : 0,
    squawk: index === 1 ? '1200' : '4321',
    trackDegrees: index === 1 ? 350 : (index * 40) % 360,
  };
}

async function install(page: Page, count: number, historyMinutes = 3) {
  const upstream: string[] = [];
  const hits: string[] = [];
  if (process.env.ISOBAR_E2E_FILES === '1') await installTrainingFiles(page.context());
  await chartRoutes(page);
  await page.route('https://api.adsb.lol/**', (route) => {
    upstream.push(route.request().url());
    return route.abort();
  });
  await page.route('https://api.open-meteo.com/**', (route) => route.abort());
  await page.route('https://marine-api.open-meteo.com/**', (route) => route.abort());
  await page.route('**/api/aviation**', (route) => route.fulfill({ json: { icao: 'YPPH', name: 'Perth', lat: -31.94, lon: 115.97, metar: null, taf: null } }));
  await page.route('**/api/traffic/trace**', async (route) => {
    const url = new URL(route.request().url());
    const hex = url.searchParams.get('hex') ?? '';
    const now = Date.now();
    const { latitude, longitude, pressureAltitudeFt } = aircraft(now, parseInt(hex.slice(-3), 16));
    const base = { latitude, longitude };
    await route.fulfill({ headers: { 'X-Traffic-Session': route.request().headers()['x-traffic-session'] ?? '' }, json: {
      source: 'session', points: Array.from({ length: historyMinutes + 1 }, (_, i) => ({ ...base, latitude: base.latitude - (historyMinutes - i) * (historyMinutes > 3 ? .002 : .1), longitude: base.longitude - (historyMinutes - i) * (historyMinutes > 3 ? .003 : .15), timeMs: now - 2000 - (historyMinutes - i) * 60_000, pressureAltitudeFt: pressureAltitudeFt - (historyMinutes - i) * (historyMinutes > 3 ? 100 : 2000) })),
    } });
  });
  await page.route('**/api/traffic/route-lookup**', async (route) => {
    await route.fulfill({ json: { route: { callsign: 'QFA642', origin: { icao: 'YPPH', iata: 'PER', name: 'Perth', latitude: -31.94, longitude: 115.97 }, destination: { icao: 'YPAD', iata: 'ADL', name: 'Adelaide', latitude: -34.95, longitude: 138.53 } } } });
  });
  await page.route('**/api/traffic?*', async (route) => {
    hits.push(route.request().url());
    const now = Date.now();
    const shift = (hits.length - 1) * 0.03;
    const rows = Array.from({ length: count }, (_, i) => aircraft(now, i + 1)).map((row, index) => (
      index === 0 ? { ...row, longitude: row.longitude + shift } : row
    ));
    await route.fulfill({
      json: { time: now, source: 'ADSB.lol', radiusNm: 80, sessionToken: 'fixture-session-abcdefghijklmnopqrstuvwxyz', routeLookupEnabled: true, aircraft: rows },
    });
  });
  return { upstream, hits };
}

async function openMap(page: Page, width: number, height: number, theme: 'light' | 'dark') {
  await page.addInitScript((mode) => localStorage.setItem('isobar-theme', mode), theme);
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
  await page.waitForFunction(() => {
    const stage = document.querySelector('[data-map-ready]') as (HTMLElement & { chartApi?: { setView?: unknown } }) | null;
    return !!stage?.chartApi?.setView;
  });
}

async function framePerth(page: Page) {
  await page.locator('[data-map-ready]').evaluate((node) => {
    (node as HTMLElement & { chartApi: { setView: (lat: number, lon: number, heightDeg: number) => void } }).chartApi.setView(-31.95, 115.86, 8);
  });
}

async function chooseTheme(page: Page, mode: 'light' | 'dark') {
  const button = page.getByRole('button', { name: mode === 'dark' ? 'Dark' : 'Light', exact: true });
  if (!(await button.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.locator('[data-map-menu]')).toBeVisible();
  }
  await button.click();
  if (await page.locator('[data-map-menu]').isVisible().catch(() => false)) await page.getByRole('button', { name: 'Menu', exact: true }).click();
}

async function checkViewport(page: Page, screenshotPath: string) {
  const helper = process.env.ISOBAR_VIEWPORT_HELPER;
  if (!helper) return;
  const { assertViewport } = await import(pathToFileURL(helper).href);
  await assertViewport(page, {
    primary: [{ selector: '[data-map-ready]', label: 'map', minWidth: 240, minHeight: 120 }],
    controls: [{ selector: '[data-lens-bar]', label: 'lens bar', minHeight: 36 }, { selector: '[data-timeline]', label: 'timeline', minHeight: 30 }],
    documentY: 'forbid',
    screenshotPath,
  });
}

async function glyphAt(page: Page, callsign: string) {
  return page.locator('canvas[data-traffic-layer]').evaluate((canvas, name) => {
    const glyphs = (canvas as HTMLCanvasElement & { trafficGlyphs?: { x: number; y: number; color?: string; aircraft: { callsign: string; latitude: number; longitude: number } }[] }).trafficGlyphs ?? [];
    const glyph = glyphs.find((item) => item.aircraft.callsign === name);
    if (!glyph) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    const px = Math.round(glyph.x * dpr);
    const py = Math.round(glyph.y * dpr);
    const data = ctx.getImageData(Math.max(0, px - 5), Math.max(0, py - 6), 12, 14).data;
    let alpha = 0;
    for (let i = 3; i < data.length; i += 4) alpha = Math.max(alpha, data[i]);
    return {
      x: glyph.x,
      y: glyph.y,
      alpha,
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      lat: glyph.aircraft.latitude,
      lon: glyph.aircraft.longitude,
      color: glyph.color ?? null,
    };
  }, callsign);
}

function hidePage() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function showPage() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  document.dispatchEvent(new Event('visibilitychange'));
}

test('Fly traffic supports three tracked paths, forecast ghosting, and reset', async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });
  const { upstream, hits } = await install(page, 3);
  await openMap(page, 1280, 720, 'light');
  await framePerth(page);
  await expect(page.getByRole('radio', { name: 'Pressure' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.map-lens-wrap').getByRole('button', { name: 'Traffic', exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Fly' }).click();
  const traffic = page.getByRole('button', { name: 'Traffic', exact: true }).first();
  await expect(traffic).toHaveAttribute('aria-pressed', 'true');
  // No tooltip: a press names what it did (owner rule, AGENTS.md).
  await expect(traffic).not.toHaveAttribute('title', /./);
  // Fly keeps the forecast clock; press Now so live glyphs are on screen.
  if (await page.getByRole('button', { name: 'Show daily forecast', exact: true }).isVisible()) await page.getByRole('button', { name: 'Show daily forecast', exact: true }).click();
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await framePerth(page);
  await expect.poll(async () => page.locator('canvas[data-traffic-layer]').evaluate((canvas) => {
    const marks = (canvas as HTMLCanvasElement & { trafficGlyphs?: { aircraft: { callsign: string }; label: string | null; symbolClass: string; vector: unknown }[] }).trafficGlyphs ?? [];
    const mark = marks.find((item) => item.aircraft.callsign === 'QFA642');
    return mark && { label: mark.label, symbolClass: mark.symbolClass, vector: !!mark.vector };
  })).toEqual({ label: 'QFA642 180 240', symbolClass: 'regional', vector: true });
  const stored = await page.evaluate(() => Object.keys(localStorage).sort());
  await expect.poll(() => hits.length).toBeGreaterThan(0);
  expect(hits[0]).toMatch(/lat=-3[12]\./);
  expect(hits[0]).toMatch(/lon=11[56]\./);
  expect(upstream).toEqual([]);
  // Entering Fly never moves the forecast clock (owner rule, J2); the user
  // presses Now to see live glyphs when playback has drifted ahead.
  if (await page.getByRole('button', { name: 'Show daily forecast', exact: true }).isVisible()) await page.getByRole('button', { name: 'Show daily forecast', exact: true }).click();
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await expect.poll(async () => (await glyphAt(page, 'QFA642'))?.alpha ?? 0).toBeGreaterThan(20);
  const glyph = await glyphAt(page, 'QFA642');
  expect(glyph).not.toBeNull();
  expect(Math.abs(glyph!.lat + 31.9)).toBeLessThan(0.2);
  expect(Math.abs(glyph!.lon - 115.9)).toBeLessThan(0.3);
  expect(Math.abs(glyph!.x - glyph!.width / 2)).toBeLessThan(glyph!.width * 0.25);
  expect(Math.abs(glyph!.y - glyph!.height / 2)).toBeLessThan(glyph!.height * 0.25);
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(stored);

  const canvas = await page.locator('canvas[data-traffic-layer]').boundingBox();
  expect(canvas).not.toBeNull();
  await page.mouse.click(canvas!.x + glyph!.x, canvas!.y + glyph!.y);
  await expect(page.locator('.map-notice')).toContainText('Tracking QFA642');
  await expect(page.locator('[data-traffic-card]')).toHaveCount(1);
  await expect(page.locator('[data-traffic-card]').first()).toContainText('QFA642');
  await expect(page.locator('[data-traffic-card]').first()).toContainText('Perth → Adelaide');
  await expect(page.locator('[data-traffic-card]').first()).toContainText('PAST');
  await expect(page.locator('[data-point-panel]')).toHaveCount(0);
  await page.mouse.click(canvas!.x + glyph!.x, canvas!.y + glyph!.y);
  await expect(page.locator('[data-traffic-card]')).toHaveCount(0);
  await expect(page.locator('.map-notice')).toContainText('Removed QFA642');
  await page.mouse.click(canvas!.x + glyph!.x, canvas!.y + glyph!.y);
  await expect(page.locator('[data-traffic-card]')).toHaveCount(1);

  const second = await glyphAt(page, 'VOZ771');
  const third = await glyphAt(page, 'TEST123');
  expect(second).not.toBeNull(); expect(third).not.toBeNull();
  await page.mouse.click(canvas!.x + second!.x, canvas!.y + second!.y);
  await expect(page.locator('.map-notice')).toContainText('Tracking VOZ771');
  await page.mouse.click(canvas!.x + third!.x, canvas!.y + third!.y);
  await expect(page.locator('.map-notice')).toContainText('Tracking TEST123');
  await expect(page.locator('[data-traffic-card]')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Remove QFA642' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove VOZ771' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove TEST123' })).toBeVisible();
  await expect(page.locator('canvas[data-traffic-layer]')).toHaveAttribute('data-traffic-paths', '3');
  const selectedByCallsign = await page.locator('canvas[data-traffic-layer]').evaluate((canvas) => {
    const glyphs = (canvas as HTMLCanvasElement & { trafficGlyphs?: { aircraft: { callsign: string }; selected: boolean; color?: string }[] }).trafficGlyphs ?? [];
    return Object.fromEntries(glyphs.filter((glyph) => glyph.selected).map((glyph) => [glyph.aircraft.callsign, glyph.color ?? '']));
  });
  expect(Object.keys(selectedByCallsign)).toHaveLength(3);
  expect(new Set(Object.values(selectedByCallsign)).size).toBe(3);
  await page.screenshot({ path: path.join(OUT, 'desktop-light-3-selected.png') });
  await chooseTheme(page, 'dark');
  await page.screenshot({ path: path.join(OUT, 'desktop-dark-3-selected.png') });
  await checkViewport(page, path.join(OUT, 'viewport-desktop-dark-3-selected.png'));
  await chooseTheme(page, 'light');
  // Arrow-right moves the forecast playhead away from now; live glyphs disappear while past paths remain.
  await page.getByRole('slider', { name: 'Forecast time' }).press('ArrowRight');
  await expect(page.locator('[data-map-time-state="forecast"]')).toContainText('FORECAST');
  await expect(page.locator('canvas[data-traffic-layer]')).toHaveAttribute('data-traffic-count', '0');
  await expect(page.locator('[data-traffic-card]')).toHaveCount(3);
  const pastCards = await page.locator('[data-traffic-card]').allTextContents();
  expect(pastCards).toHaveLength(3);
  expect(pastCards.every((text) => text.includes('PAST'))).toBe(true);
  await expect(page.locator('[data-traffic-replay]')).toContainText('No recorded traffic');
  if (await page.getByRole('button', { name: 'Show daily forecast', exact: true }).isVisible()) await page.getByRole('button', { name: 'Show daily forecast', exact: true }).click();
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(page.locator('[data-map-time-state="now"]')).toContainText('NOW');

  const pause = page.getByRole('button', { name: 'Pause', exact: true });
  if (await pause.count()) await pause.click();
  await page.screenshot({ path: path.join(OUT, 'desktop-light.png') });
  await checkViewport(page, path.join(OUT, 'viewport-desktop-light.png'));
  await page.locator('[data-map-ready]').screenshot({ path: path.join(OUT, 'map-light.png') });
  await page.getByRole('button', { name: 'Data sources' }).click();
  await expect(page.getByRole('note')).toContainText('ADSB.lol (ODbL)');
  await page.screenshot({ path: path.join(OUT, 'sources-light.png') });
  await page.getByRole('button', { name: 'Data sources' }).click();

  await chooseTheme(page, 'dark');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'desktop-dark.png') });
  await checkViewport(page, path.join(OUT, 'viewport-desktop-dark.png'));
  await page.locator('[data-map-ready]').screenshot({ path: path.join(OUT, 'map-dark.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  // The aerodrome panel leaves side mode for the bottom sheet before any fit
  // check: under load the React re-render can lag the resize, leaving a side
  // panel that squeezes the map.
  await expect(page.locator('[data-fly-panel]')).toHaveAttribute('data-fly-sheet', /./);
  await framePerth(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'phone-dark.png') });
  await checkViewport(page, path.join(OUT, 'viewport-phone-dark.png'));
  const phone = await traffic.boundingBox();
  expect(phone).not.toBeNull();
  expect(phone!.x).toBeGreaterThanOrEqual(0);
  expect(phone!.x + phone!.width).toBeLessThanOrEqual(392);
  expect(phone!.y + phone!.height).toBeLessThanOrEqual(844);
  await chooseTheme(page, 'light');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'phone-light.png') });
  await checkViewport(page, path.join(OUT, 'viewport-phone-light.png'));
  await page.setViewportSize({ width: 844, height: 390 });
  await framePerth(page);
  await page.screenshot({ path: path.join(OUT, 'landscape-light.png') });
  // Browser 200% zoom on a 1280×720 display has a 640×360 CSS viewport.
  // CSS zoom alone does not change media-query breakpoints and is not equivalent.
  await page.setViewportSize({ width: 640, height: 360 });
  await checkViewport(page, path.join(OUT, 'desktop-200-reflow.png'));
  await page.setViewportSize({ width: 390, height: 844 });
  // Same portrait settle as above: the sheet attribute marks the re-render.
  await expect(page.locator('[data-fly-panel]')).toHaveAttribute('data-fly-sheet', /./);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await checkViewport(page, path.join(OUT, 'phone-large-text.png'));
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.getByRole('button', { name: 'Remove VOZ771' }).click();
  await expect(page.locator('.map-notice')).toContainText('Removed VOZ771');
  await expect(page.locator('[data-traffic-card]')).toHaveCount(2);
  await expect(page.locator('canvas[data-traffic-layer]')).toHaveAttribute('data-traffic-paths', '2');
  const remainingColors = await page.locator('canvas[data-traffic-layer]').evaluate((canvas) => {
    const glyphs = (canvas as HTMLCanvasElement & { trafficGlyphs?: { aircraft: { callsign: string }; selected: boolean; color?: string }[] }).trafficGlyphs ?? [];
    return Object.fromEntries(glyphs.filter((glyph) => glyph.selected).map((glyph) => [glyph.aircraft.callsign, glyph.color ?? '']));
  });
  expect(remainingColors.QFA642).toBe(selectedByCallsign.QFA642);
  expect(remainingColors.TEST123).toBe(selectedByCallsign.TEST123);
  await page.keyboard.press('Escape');
  await expect(page.locator('.map-notice')).toContainText('Tracks cleared');
  await expect(page.locator('[data-traffic-card]')).toHaveCount(0);

  // Back to desktop: the Fly lens extras (barbs, section) live in the lens row there.
  await page.setViewportSize({ width: 1280, height: 720 });
  await framePerth(page);
  // The layer re-lays out after the resize: tap where the glyph is now.
  await expect.poll(async () => {
    const mark = await glyphAt(page, 'QFA642');
    const box = await page.locator('canvas[data-traffic-layer]').boundingBox();
    if (mark && box) await page.mouse.click(box.x + mark.x, box.y + mark.y);
    return page.locator('[data-traffic-card]').count();
  }, { timeout: 10_000 }).toBe(1);
  await page.getByRole('button', { name: 'Wind barbs', exact: true }).click();
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await expect(page.locator('[data-traffic-card]')).toHaveCount(0);
  await expect(page.locator('canvas[data-traffic-layer]')).toHaveAttribute('data-traffic-paths', '0');
  await expect(page.locator('.map-notice')).toContainText('replaced tracks');
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByRole('button', { name: 'Wind barbs', exact: true }).click();

  await page.evaluate(hidePage);
  await page.waitForTimeout(500);
  const beforeHide = hits.length;
  await page.waitForTimeout(11_000);
  expect(hits.length).toBe(beforeHide);
  await page.evaluate(showPage);
  await expect.poll(() => hits.length).toBeGreaterThan(beforeHide);
  expect(upstream).toEqual([]);

  await page.reload();
  await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
  await expect(page.getByRole('radio', { name: 'Pressure' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.map-lens-wrap').getByRole('button', { name: 'Traffic', exact: true })).toHaveCount(0);
});

test('phone traffic stays inside the 60 fps budget at CPU ÷4', async ({ page }) => {
  test.setTimeout(90_000);
  const chart = await install(page, 40);
  await openMap(page, 390, 844, 'light');
  await framePerth(page);
  await page.getByRole('radio', { name: 'Fly' }).click();
  // Phone keeps Traffic in the map tools column, not the lens row.
  await expect(page.getByRole('button', { name: 'Traffic', exact: true }).first()).toHaveAttribute('aria-pressed', 'true');
  // Fly keeps the forecast clock; press Now so live glyphs are on screen.
  if (await page.getByRole('button', { name: 'Show daily forecast', exact: true }).isVisible()) await page.getByRole('button', { name: 'Show daily forecast', exact: true }).click();
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await expect.poll(() => chart.hits.length).toBeGreaterThan(0);
  await expect.poll(async () => Number(await page.locator('canvas[data-traffic-layer]').getAttribute('data-traffic-count'))).toBeGreaterThan(0);
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.waitForTimeout(400);
  const sample = () => page.evaluate((duration) => new Promise<{ p50: number; p95: number; max: number; count: number; longTasks: number[] }>((resolve) => {
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => longTasks.push(Math.round(entry.duration))));
    observer.observe({ type: 'longtask' });
    const deltas: number[] = [];
    let last = performance.now();
    const start = last;
    const tick = (now: number) => {
      deltas.push(now - last);
      last = now;
      if (now - start < duration) requestAnimationFrame(tick);
      else {
        observer.disconnect();
        const sorted = deltas.slice(1).sort((a, b) => a - b);
        const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
        resolve({ p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1], count: sorted.length, longTasks });
      }
    };
    requestAnimationFrame(tick);
  }), 2500);
  const result = await sample();
  // Preserve the budget, but record the same map without traffic to distinguish
  // a traffic regression from the headless/software map's own frame cost.
  await page.getByRole('button', { name: 'Traffic', exact: true }).first().click();
  await expect(page.locator('canvas[data-traffic-layer]')).toHaveAttribute('data-traffic', 'off');
  const pause = page.getByRole('button', { name: 'Pause', exact: true });
  if (await pause.count()) await pause.click();
  await page.waitForTimeout(400);
  const withoutTraffic = await sample();
  console.log('phone without traffic', JSON.stringify(withoutTraffic));
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await client.detach();
  console.log('phone traffic', JSON.stringify(result));
  expect(Math.round(result.p95 * 10) / 10, 'phone CPU ÷4 p95').toBeLessThanOrEqual(16.8);
  expect(result.longTasks.filter((ms) => ms > 50), 'phone long tasks').toEqual([]);
});


test('Now follows real time and an observed hour can replay at an accelerated rate', async ({ page }) => {
  test.setTimeout(90_000);
  await install(page, 1, 90);
  await openMap(page, 1280, 720, 'light');
  await page.getByRole('radio', { name: 'Fly' }).click();
  if (await page.getByRole('button', { name: 'Show daily forecast', exact: true }).isVisible()) await page.getByRole('button', { name: 'Show daily forecast', exact: true }).click();
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await framePerth(page);
  const speed = page.locator('#playback-speed:visible');
  await expect(speed).toHaveValue('0');
  await expect.poll(async () => !!(await glyphAt(page, 'QFA642'))).toBe(true);
  const layer = page.locator('canvas[data-traffic-layer]');
  const before = Number(await layer.getAttribute('data-traffic-time'));
  await page.waitForTimeout(1500);
  const elapsed = Number(await layer.getAttribute('data-traffic-time')) - before;
  expect(elapsed).toBeGreaterThan(1000);
  expect(elapsed).toBeLessThan(3500);
  const glyph = (await glyphAt(page, 'QFA642'))!;
  const canvas = (await layer.boundingBox())!;
  await page.mouse.click(canvas.x + glyph.x, canvas.y + glyph.y);
  await expect(page.locator('[data-traffic-card]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const timeline = page.getByRole('slider', { name: 'Forecast time' });
  await timeline.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(layer).toHaveAttribute('data-traffic-mode', 'replay');
  await expect(page.locator('[data-traffic-replay]')).toHaveAttribute('data-traffic-replay', 'replay');
  const past = (await glyphAt(page, 'QFA642'))!;
  expect(past.lat).toBeLessThan(glyph.lat - .1);
  await expect(page.locator('[data-traffic-card]')).toContainText('Replay');
  await expect(page.locator('[data-traffic-card]')).not.toContainText('240 kt');
  await expect(speed).toHaveValue('0');
  await speed.selectOption('1');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(1500);
  const advanced = (await glyphAt(page, 'QFA642'))!;
  expect(advanced.lat).toBeGreaterThan(past.lat + .001);
  await page.screenshot({ path: test.info().outputPath('traffic-replay.png') });
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(speed).toHaveValue('0');
  await expect(layer).toHaveAttribute('data-traffic-mode', 'live');
});

test('holding live traffic freezes the displayed observation until Now or rewind is chosen', async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await install(page, 1, 90);
  await openMap(page, 1280, 720, 'light');
  await page.getByRole('radio', { name: 'Fly' }).click();
  if (await page.getByRole('button', { name: 'Show daily forecast', exact: true }).isVisible()) await page.getByRole('button', { name: 'Show daily forecast', exact: true }).click();
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await framePerth(page);
  const layer = page.locator('canvas[data-traffic-layer]');
  await expect.poll(async () => (await glyphAt(page, 'QFA642'))?.alpha ?? 0).toBeGreaterThan(20);
  const first = (await glyphAt(page, 'QFA642'))!;
  const canvas = (await layer.boundingBox())!;
  await page.mouse.click(canvas.x + first.x, canvas.y + first.y);
  await expect(page.locator('[data-traffic-card]')).toHaveCount(1);
  await expect(page.locator('[data-traffic-card]')).toContainText('Perth → Adelaide');
  await expect(page.locator('[data-traffic-card]')).toContainText('PAST');
  const hitsBefore = fixture.hits.length;

  // Pause/hold the clock, then let a fresh live poll replace the upstream
  // snapshot. The glyph and card must remain the observation at the hold.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  const cardBefore = await page.locator('[data-traffic-card]').textContent();
  await expect.poll(() => fixture.hits.length, { timeout: 20_000 }).toBeGreaterThan(hitsBefore);
  await page.waitForTimeout(250);
  const held = (await glyphAt(page, 'QFA642'))!;
  expect(Math.abs(held.lon - first.lon)).toBeLessThan(0.001);
  await expect(page.locator('[data-traffic-card]')).toHaveCount(1);
  expect(await page.locator('[data-traffic-card]').textContent()).toBe(cardBefore);

  // A recent rewind must sample the captured session, rather than showing the
  // latest live point, and Now must explicitly restore the live feed.
  const timeline = page.getByRole('slider', { name: 'Forecast time' });
  await timeline.focus();
  await timeline.press('ArrowLeft');
  await expect(layer).toHaveAttribute('data-traffic-mode', 'replay');
  const rewind = (await glyphAt(page, 'QFA642'))!;
  expect(rewind.lat).toBeLessThan(first.lat - 0.01);
  await expect(page.locator('[data-traffic-card]')).toContainText('Replay');
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(layer).toHaveAttribute('data-traffic-mode', 'live');
  await expect.poll(async () => (await glyphAt(page, 'QFA642'))?.lon ?? first.lon).not.toBe(first.lon);
});
