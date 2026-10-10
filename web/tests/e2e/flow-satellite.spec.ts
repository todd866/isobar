import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installChart } from './flow-fixture';

/**
 * Flow streaks on every lens, and the Satellite layer's observed-time gate.
 * The chart is a southern low with a westerly bias so streaks travel east
 * while circulating. GIBS is fulfilled locally; the test does not call NASA.
 */

const OUT = process.env.ISOBAR_FLOW_DIR ?? path.join(os.homedir(), '.local/state/isobar-week/flow');

function gibsTime(url: string): number {
  const match = url.match(/\/default\/([^/]+)\/2km\//);
  return match ? Date.parse(match[1]) : Number.NaN;
}

async function openMap(page: Page, width: number, height: number, theme: 'light' | 'dark') {
  await page.addInitScript((mode) => localStorage.setItem('isobar-theme', mode), theme);
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
  await page.waitForSelector('canvas[data-flow="live"]', { timeout: 20_000 });
  // Live means the simulation is running; its first appearance still fades
  // in over 1.5 s. Assert actual ink without racing that deliberate fade.
  await expect.poll(async () => (await inkSignature(page)).ink, { timeout: 4000 }).toBeGreaterThan(10);
  await expect(page.getByRole('radio', { name: 'Pressure' })).toHaveAttribute('aria-checked', 'true');
}

async function flowSample(page: Page) {
  return page.locator('[data-map-ready]').evaluate((node) => {
    const api = (node as HTMLElement & { chartApi?: { flowSample: () => { lon: number; lat: number; shift: number; travel: number; drawn: number; mode: string } | null } }).chartApi;
    return api?.flowSample() ?? null;
  });
}

async function inkSignature(page: Page) {
  return page.locator('canvas[data-flow-layer]').evaluate((canvas) => {
    const ctx = (canvas as HTMLCanvasElement).getContext('2d');
    if (!ctx) return { ink: 0, sig: 0 };
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    let sig = 0;
    for (let i = 3; i < data.length; i += 32) {
      if (data[i] > 12) {
        ink += 1;
        sig = (sig + data[i - 3] + data[i - 1] * 3 + (i % 997)) % 1000003;
      }
    }
    return { ink, sig };
  });
}

async function settleGibs(gibs: string[], page: Page) {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 30; i += 1) {
    if (gibs.length > 0 && gibs.length === last) {
      stable += 1;
      if (stable >= 3) return;
    } else stable = 0;
    last = gibs.length;
    await page.waitForTimeout(150);
  }
  expect(gibs.length, 'GIBS tile requests').toBeGreaterThan(0);
}

test('pressure streaks move, and satellite is observed only up to now', async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });
  const chart = installChart(page);
  await chart.ready;
  await page.addInitScript(() => localStorage.setItem('isobar.speed', '1'));
  await openMap(page, 1440, 900, 'light');
  await page.getByRole('button', { name: 'Pause' }).click();

  const first = await flowSample(page);
  expect(first?.mode).toBe('live');
  expect(first?.drawn ?? 0).toBeGreaterThan(20);
  expect(first?.travel ?? 0).toBeGreaterThan(0);
  expect(first?.shift ?? 0).toBeGreaterThan(0);
  const before = await inkSignature(page);
  expect(before.ink).toBeGreaterThan(10);
  await page.waitForTimeout(500);
  const after = await flowSample(page);
  expect(after?.shift ?? 0).toBeGreaterThan(0);
  expect(Math.abs((after?.lon ?? 0) - (first?.lon ?? 0)) + Math.abs((after?.lat ?? 0) - (first?.lat ?? 0))).toBeGreaterThan(0.02);

  const stage = page.locator('[data-map-ready]');
  for (let i = 0; i < 6; i += 1) {
    await stage.screenshot({ path: path.join(OUT, `sequence-light-${i}.png`) });
    await page.waitForTimeout(180);
  }
  await page.screenshot({ path: path.join(OUT, 'pressure-light.png') });

  await page.getByRole('radio', { name: 'Wind' }).click();
  await expect(page.getByRole('radio', { name: 'Wind' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.map-legend')).toContainText('Wind');
  await expect(page.locator('.map-legend')).toContainText('≥55 kt');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'wind-light.png') });
  await page.getByRole('radio', { name: 'Pressure' }).click();

  const stored = await page.evaluate(() => Object.keys(localStorage).sort());
  await page.getByRole('button', { name: 'Satellite' }).click();
  await expect(page.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(stored);
  await settleGibs(chart.gibs, page);
  const observed = chart.gibs.map(gibsTime).filter((time) => Number.isFinite(time));
  expect(observed.length).toBeGreaterThan(0);
  expect(Math.max(...observed)).toBeLessThanOrEqual(Date.now() - 50 * 60 * 1000 + 10 * 60 * 1000);
  expect(chart.gibs.every((url) => url.includes('Himawari_AHI_Band13_Clean_Infrared'))).toBe(true);
  // The legend names when the picture was taken (GIBS publishes ~50 min behind).
  await expect(page.locator('[data-cloud-legend="satellite"]')).toHaveText(/^Satellite \d{2}:\d{2}Z$/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'satellite-light.png') });
  await page.getByRole('button', { name: 'Data sources' }).click();
  await expect(page.getByRole('note')).toContainText('NASA GIBS');
  await page.screenshot({ path: path.join(OUT, 'sources-light.png') });
  await page.getByRole('button', { name: 'Data sources' }).click();

  const slider = page.getByRole('slider', { name: 'Forecast time' });
  const atNow = chart.gibs.length;
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => chart.gibs.length).toBeGreaterThan(atNow);
  const earlier = chart.gibs.slice(atNow).map(gibsTime).filter((time) => Number.isFinite(time));
  expect(earlier.length).toBeGreaterThan(0);
  expect(Math.max(...earlier)).toBeLessThanOrEqual(Date.now() - 50 * 60 * 1000);

  await settleGibs(chart.gibs, page);
  const marked = chart.gibs.length;
  await slider.focus();
  await page.keyboard.press('End');
  await expect(page.locator('[data-cloud-legend="model"]')).toHaveText('model');
  await expect(page.locator('[data-cloud-legend="model"]')).not.toHaveText('Satellite');
  await page.waitForTimeout(900);
  const ahead = chart.gibs.slice(marked);
  expect(ahead, 'no GIBS tiles for a forecast time').toEqual([]);
  await page.screenshot({ path: path.join(OUT, 'model-light.png') });

  await page.reload();
  await page.waitForSelector('canvas[data-flow="live"]', { timeout: 20_000 });
  await expect.poll(async () => (await inkSignature(page)).ink, { timeout: 4000 }).toBeGreaterThan(10);
  await expect(page.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'false');

  await page.addInitScript((mode) => localStorage.setItem('isobar-theme', mode), 'dark');
  await page.reload();
  await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
  await page.waitForSelector('canvas[data-flow="live"]', { timeout: 20_000 });
  await page.screenshot({ path: path.join(OUT, 'pressure-dark.png') });
  await page.getByRole('button', { name: 'Satellite' }).click();
  // The legend names when the picture was taken (GIBS publishes ~50 min behind).
  await expect(page.locator('[data-cloud-legend="satellite"]')).toHaveText(/^Satellite \d{2}:\d{2}Z$/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'satellite-dark.png') });
  await page.getByRole('radio', { name: 'Wind' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'wind-dark.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'phone-dark.png') });
});

test('reduced motion holds static streamlines', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const chart = installChart(page);
  await chart.ready;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((mode) => localStorage.setItem('isobar-theme', mode), 'light');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForSelector('canvas[data-flow="static"]', { timeout: 20_000 });
  const sample = await flowSample(page);
  expect(sample?.mode).toBe('static');
  expect(sample?.drawn ?? 0).toBeGreaterThan(10);
  expect(sample?.travel ?? 1).toBe(0);
  const ink = await inkSignature(page);
  expect(ink.ink).toBeGreaterThan(5);
  await page.waitForTimeout(300);
  const again = await flowSample(page);
  expect(again?.lon).toBe(sample?.lon);
  expect(again?.lat).toBe(sample?.lat);
  await page.screenshot({ path: path.join(OUT, 'reduced-light.png') });
});

test('phone flow stays inside the 60 fps budget at CPU ÷4', async ({ page }) => {
  test.setTimeout(90_000);
  const chart = installChart(page);
  await chart.ready;
  await openMap(page, 390, 844, 'light');
  await expect(page.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'false');
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.waitForTimeout(400);
  const result = await page.evaluate((duration) => new Promise<{ p50: number; p95: number; max: number; count: number; longTasks: number[] }>((resolve) => {
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
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await client.detach();
  console.log('phone flow', JSON.stringify(result));
  expect(Math.round(result.p95 * 10) / 10, 'phone CPU ÷4 p95').toBeLessThanOrEqual(16.8);
  expect(result.longTasks.filter((ms) => ms > 50), 'phone long tasks').toEqual([]);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'phone-light.png') });
});
