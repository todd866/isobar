import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installChart } from './flow-fixture';

// Same offline fixture and deterministic clock for both builds. Override DIR
// when sandboxed. Label each capture 'before' or 'after'; baseline is 80c9600.
const out = process.env.ISOBAR_STREAKS_DIR ?? path.join(os.homedir(), '.local/state/isobar-week/wind-streaks');
const label = process.env.ISOBAR_STREAKS_LABEL ?? 'after';
const capture = process.env.ISOBAR_STREAKS_CAPTURE === '1';
const real = process.env.ISOBAR_STREAKS_REAL === '1';

async function open(page: Page, components = true) {
  // Suppress every external service; fixtures use only local intercepted data.
  await page.route('https://**/*', (route) => route.abort());
  if (!real) await installChart(page, components).ready;
  else {
    const manifest = await (await page.request.get('/data/manifest.json')).json();
    expect(manifest.variables.u10, 'real wind capture requires u10 in the exported manifest').toBeTruthy();
    expect(manifest.variables.v10, 'real wind capture requires v10 in the exported manifest').toBeTruthy();
  }
  await page.goto('/');
  await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
  await page.waitForSelector('canvas[data-flow="live"]', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('canvas[data-flow-layer]')).toHaveAttribute('data-wind-source', components ? 'model' : 'estimate', { timeout: 20_000 });
}

for (const components of [true, false]) test(`wind source legend: ${components ? 'model' : 'estimate'}`, async ({ page }) => {
  test.skip(real, 'Source-switch regression uses the synthetic fixture.');
  await open(page, components);
  await page.getByRole('button', { name: 'Data sources' }).click();
  await expect(page.getByRole('note')).toContainText(components ? 'Wind streaks: model 10 m wind' : 'Wind streaks: estimated from isobars');
  await expect(page.locator('canvas[data-flow-layer]')).toHaveAttribute('data-wind-source', components ? 'model' : 'estimate');
});

test('pending model frames keep estimated streaks visible, then crossfade with a live source legend', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.route('https://**/*', (route) => route.abort());
  await installChart(page).ready;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/data\/(u10|v10)\.bin\?/, async (route) => { await held; await route.fallback(); });
  try {
    await page.goto('/');
    await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
    const canvas = page.locator('canvas[data-flow-layer]');
    await expect(canvas).toHaveAttribute('data-wind-source', 'estimate');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Data sources' }).click();
    await expect(page.getByRole('note')).toContainText('Wind streaks: estimated from isobars');
    const visibleInk = () => canvas.evaluate((node) => {
      const c = node as HTMLCanvasElement;
      const rgba = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 3; i < rgba.length; i += 32) if (rgba[i] > 12) ink++;
      return ink;
    });
    await expect.poll(visibleInk).toBeGreaterThan(10);
    release();
    await expect(canvas).toHaveAttribute('data-wind-source', 'to-model');
    await expect(page.getByRole('note')).toContainText('isobar estimate → model 10 m wind');
    expect(await visibleInk()).toBeGreaterThan(10);
    await expect(canvas).toHaveAttribute('data-wind-source', 'model');
    await expect(page.getByRole('note')).toContainText('Wind streaks: model 10 m wind');
    expect(await visibleInk()).toBeGreaterThan(10);
  } finally { release(); }
});

for (const [width, height] of [[390, 844], [1440, 900]]) {
  for (const theme of ['light', 'dark'] as const) {
    for (const [place, lat, lon, degrees] of [['perth', -31.95, 115.86, 12], ['southern-ocean', -39, 133, 8]] as const) {
      test(`wind sequence ${width}x${height} ${theme} ${place}`, async ({ page }) => {
        test.skip(!capture, 'Opt-in viewport sequence, not a snapshot comparison.');
        await page.setViewportSize({ width, height });
        await page.addInitScript((mode) => localStorage.setItem('isobar-theme', mode), theme);
        await page.clock.install({ time: new Date('2026-10-09T06:00:00Z') });
        await open(page);
        await page.locator('[data-map-ready]').evaluate((node, view) => {
          const api = (node as HTMLElement & { chartApi: { setView: (lat: number, lon: number, height: number) => void } }).chartApi;
          api.setView(view.lat, view.lon, view.degrees);
        }, { lat, lon, degrees });
        // A fully prepared view; paused forecast, moving particles. Pausing
        // browser time then advancing it fixes the exact 200 ms spacing.
        await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
        await page.clock.runFor(2400);
        const dir = path.join(out, label, `${width}x${height}-${theme}-${place}`);
        fs.mkdirSync(dir, { recursive: true });
        if (process.env.ISOBAR_VIEWPORT_HELPER) {
          const { auditViewport } = await import(pathToFileURL(process.env.ISOBAR_VIEWPORT_HELPER).href);
          const report = await auditViewport(page, {
            primary: [{ selector: '[data-map-ready]', minWidth: 280, minHeight: 160 }],
            controls: [{ selector: '[aria-label="Data sources"]', minWidth: 24, minHeight: 24 },
              { selector: '[aria-label="Forecast time"]', minWidth: 160 }],
          });
          fs.writeFileSync(path.join(dir, 'viewport.json'), JSON.stringify(report, null, 2));
        }
        const samples: unknown[] = [];
        for (let i = 0; i < 5; i++) {
          if (i) await page.clock.runFor(200);
          samples.push(await page.locator('[data-map-ready]').evaluate((node) => {
            return (node as HTMLElement & { chartApi: { flowSample: () => unknown } }).chartApi.flowSample();
          }));
          await page.screenshot({ path: path.join(dir, `${i}.png`), fullPage: false });
        }
        fs.writeFileSync(path.join(dir, 'sequence.json'), JSON.stringify({ fixture: real ? 'local published data' : 'synthetic flow fixture', frameMs: 200, samples }, null, 2));
        expect(samples).toHaveLength(5);
      });
    }
  }
}
