import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Web map vs the macOS popover. The popover renders are 2x PNGs of an
 * 818 x 900 pt panel; the web page is captured at the same content size
 * The map page is compared at the map content width; navigation lives in its
 * menu and does not take pixels from the chart.
 */

const out = path.join(process.cwd(), 'test-results', 'parity');
const REFS = {
  'light-none': process.env.ISOBAR_PARITY_LIGHT_NONE ?? '',
  'dark-rain': process.env.ISOBAR_PARITY_DARK_RAIN ?? '',
  'light-fly': process.env.ISOBAR_PARITY_LIGHT_FLY ?? '',
} as const;

type Case = { name: string; theme: 'light' | 'dark'; lens: 'none' | 'rain' | 'fly'; ref: string | null; width: number };

const CASES: Case[] = [
  { name: 'light-none', theme: 'light', lens: 'none', ref: REFS['light-none'], width: 818 },
  { name: 'dark-none', theme: 'dark', lens: 'none', ref: null, width: 818 },
  { name: 'light-rain', theme: 'light', lens: 'rain', ref: null, width: 818 },
  { name: 'dark-rain', theme: 'dark', lens: 'rain', ref: REFS['dark-rain'], width: 818 },
  { name: 'light-fly', theme: 'light', lens: 'fly', ref: REFS['light-fly'], width: 1272 },
  { name: 'dark-fly', theme: 'dark', lens: 'fly', ref: null, width: 1272 },
];

async function open(page: Page, item: Case, width: number, height: number) {
  await page.addInitScript((mode) => {
    localStorage.setItem('isobar-theme', mode);
    localStorage.setItem('isobar.place', 'perth');
  }, item.theme);
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
  await page.waitForSelector('[data-frames="complete"]', { timeout: 60_000 });
  if (item.lens === 'rain') await page.getByRole('radio', { name: 'Rain', exact: true }).click();
  if (item.lens === 'fly') {
    await page.getByRole('radio', { name: 'Fly', exact: true }).click();
    await page.waitForSelector('[data-fly-panel]');
  }
  // Hold the clock still for a comparable still.
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(500);
}

test('web vs popover, side by side', async ({ page, browser }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(out, { recursive: true });
  for (const item of CASES) {
    await open(page, item, item.width, 900);
    const web = path.join(out, `web-${item.name}.png`);
    await page.screenshot({ path: web });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, item.name).toBeLessThanOrEqual(1);
    if (!item.ref || !fs.existsSync(item.ref)) continue;
    const side = await browser.newPage({ viewport: { width: item.width + 20 + 900, height: 960 } });
    const toData = (file: string) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    await side.setContent(`<!doctype html><html><body style="margin:0;background:#888;display:flex;gap:20px;align-items:flex-start;font:600 13px system-ui">
      <figure style="margin:0"><figcaption style="padding:4px">web (${item.width}x900)</figcaption><img src="${toData(web)}" style="display:block;width:${item.width}px"></figure>
      <figure style="margin:0"><figcaption style="padding:4px">macOS popover</figcaption><img src="${toData(item.ref)}" style="display:block;width:900px"></figure>
      </body></html>`);
    await side.waitForTimeout(200);
    await side.screenshot({ path: path.join(out, `side-${item.name}.png`), fullPage: true });
    await side.close();
  }
});

test('phone parity', async ({ page }) => {
  for (const item of CASES.filter((entry) => entry.name.endsWith('none') || entry.name === 'light-fly')) {
    await open(page, item, 390, 844);
    await page.screenshot({ path: path.join(out, `phone-${item.name}.png`) });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, item.name).toBeLessThanOrEqual(1);
  }
});
