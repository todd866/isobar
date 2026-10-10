import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installWeatherFixture } from './weather-fixture';

const out = path.join(process.cwd(), 'test-results', 'visual');
async function open(page: Page, href = '/') {
  await installWeatherFixture(page);
  await page.goto(href);
  await page.waitForSelector('[data-isobars="true"]');
  await page.waitForSelector('[data-frames="complete"]');
}

async function explainChart(page: Page) {
  await page.getByRole('button', { name: 'Data sources', exact: true }).click();
  await page.getByRole('button', { name: 'Explain this chart', exact: true }).click();
}
async function fit(page: Page, label: string) {
  const helper = process.env.ISOBAR_VIEWPORT_HELPER ?? '';
  if (fs.existsSync(helper)) {
    const { assertViewport } = await import(pathToFileURL(helper).href);
    await assertViewport(page, { primary: [{ selector: '[data-map-ready]', minWidth: 250, minHeight: 160 }], controls: [{ selector: '.teach-card-foot', minHeight: 36 }] });
  }
  const bounds = await page.evaluate(() => {
    const selectors = ['[data-map-ready]', '[data-teach-card]', '.teach-card-foot', '[data-lens-bar]'];
    return { docWidth: document.documentElement.scrollWidth, docHeight: document.documentElement.scrollHeight, w: innerWidth, h: innerHeight,
      ellipsis: [...document.querySelectorAll('[data-teach-card] *')].some((e) => getComputedStyle(e).textOverflow === 'ellipsis'),
      rects: selectors.flatMap((s) => [...document.querySelectorAll(s)].map((e) => { const r = e.getBoundingClientRect(); return { selector: s, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; })) };
  });
  expect(bounds.docWidth, label).toBeLessThanOrEqual(bounds.w + 1);
  expect(bounds.docHeight, label).toBeLessThanOrEqual(bounds.h + 1);
  expect(bounds.ellipsis).toBe(false);
  for (const rect of bounds.rects) { expect(rect.x, label).toBeGreaterThanOrEqual(-1); expect(rect.y, label).toBeGreaterThanOrEqual(-1); expect(rect.right, label).toBeLessThanOrEqual(bounds.w + 1); expect(rect.bottom, label).toBeLessThanOrEqual(bounds.h + 1); }
}

test('tour teaches one step, supports a miss, restores the chart and works offline', async ({ page, context }) => {
  await open(page, '/?tour=1');
  const card = page.getByRole('complementary', { name: 'Chart tour' });
  await expect(card).toContainText('1 / 5');
  await expect(card).toContainText('southern hemisphere');
  const held = await page.getByRole('slider', { name: 'Forecast time' }).getAttribute('aria-valuenow');
  await page.waitForTimeout(350);
  expect(await page.getByRole('slider', { name: 'Forecast time' }).getAttribute('aria-valuenow')).toBe(held);
  await context.setOffline(true);
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toContainText('Guided estimate');
  await card.locator('.teach-choices button').first().click();
  await expect(card).toContainText('Try a smaller step');
  await card.getByRole('button', { name: 'Doubles', exact: true }).click();
  await expect(card).toContainText('That’s it.');
  await card.getByRole('button', { name: 'Back' }).click();
  await expect(card).toContainText('1 / 5');
  for (let i = 0; i < 4; i++) await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toContainText('Your turn');
  await card.getByRole('button', { name: 'Finish' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.locator('[data-learn-link]')).toBeFocused();
});

test('map feature markers, airports, keyboard and trackpad input', async ({ page }) => {
  await open(page);
  await explainChart(page);
  await page.getByRole('button', { name: 'Explain low pressure', exact: true }).first().click();
  const card = page.getByRole('complementary', { name: 'Chart explanation' });
  await expect(card).toContainText('Which way?');
  await card.getByRole('button', { name: 'Clockwise', exact: true }).click();
  await expect(card).toContainText('Yes.');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Recenter map' }).click();
  await explainChart(page);
  await page.getByRole('button', { name: 'Explain YPPH' }).click();
  await expect(card).toContainText('Thunderstorm');
  await expect(card).toContainText('METAR');
  await expect(card).toContainText('TAF');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Recenter map' }).click();
  const canvas = page.locator('canvas[tabindex="0"]');
  await canvas.focus();
  const camera = () => page.locator('[data-map-ready]').evaluate((e) => (e as HTMLElement & { chartApi: { camera: () => unknown } }).chartApi.camera());
  const a = await camera();
  await page.keyboard.press('+');
  const b = await camera(); expect(b).not.toEqual(a);
  await page.keyboard.press('Home'); expect({bearingRadians:0,...await camera()}).toEqual({bearingRadians:0,...a});
  await page.getByRole('button', { name: '3D map', exact: true }).click();
  await canvas.dispatchEvent('wheel', { deltaY: 30, deltaX: 20 });
  await expect.poll(() => page.locator('[data-map-ready]').getAttribute('data-tilt')).not.toBe('0');
  const tilted = await camera() as {centerX:number;centerY:number;bearingRadians?:number;halfHeight:number};
  expect(tilted.centerX).toBeCloseTo((a as {centerX:number}).centerX,6);
  expect(tilted.centerY).toBeCloseTo((a as {centerY:number}).centerY,6);
  expect(tilted.bearingRadians).toBeGreaterThan(0);
  expect(tilted.halfHeight).toBeLessThan((a as {halfHeight:number}).halfHeight);
  await page.getByRole('button', { name: 'Recenter map' }).click();
  await canvas.dispatchEvent('wheel', { deltaY: -20, ctrlKey: true, clientX: 500, clientY: 450 }); expect(await camera()).not.toEqual(a);
  // Wind barbs show only when the export carries wind components.
  if (await page.getByRole('button', { name: 'Wind barbs' }).count()) {
    await page.getByRole('button', { name: 'Wind barbs' }).click();
    await expect(page.getByText('10 m wind · barb = 10 kt · half = 5')).toBeVisible();
  }
});

test('teaching renders fit desktop and phone in both themes', async ({ page }) => {
  test.setTimeout(90_000);
  fs.mkdirSync(out, { recursive: true });
  for (const theme of ['light', 'dark']) for (const [label, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]] as const) {
    await page.addInitScript((mode) => localStorage.setItem('isobar-theme', mode), theme);
    await page.setViewportSize({ width, height }); await open(page);
    await page.screenshot({ path: path.join(out, `map-teach-${theme}-${label}-chart.png`) });
    await open(page, '/?tour=1');
    await page.getByRole('complementary', { name: 'Chart tour' }).waitFor();
    await fit(page, `${theme}-${label}`);
    await page.screenshot({ path: path.join(out, `map-teach-${theme}-${label}.png`) });
    await page.getByRole('button', { name: 'Next' }).click();
    await page.locator('.teach-choices button').first().click();
    await fit(page, `${theme}-${label}-support`);
    await page.screenshot({ path: path.join(out, `map-teach-${theme}-${label}-support.png`) });
    await page.keyboard.press('Escape');
  }
});


test('feature anchors follow keyboard and touch pan while teaching holds the clock', async ({ page }) => {
  await open(page);
  await explainChart(page);
  const marker = page.getByRole('button', { name: 'Explain low pressure', exact: true }).first();
  await expect(marker).toBeVisible();
  const before = await marker.boundingBox();
  const canvas = page.locator('canvas[tabindex="0"]');
  await canvas.focus(); await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await marker.boundingBox())?.x).not.toBe(before?.x);
  const moved = await marker.boundingBox();
  const r = await canvas.boundingBox();
  const x = r!.x + 80, y = r!.y + 80;
  const client = await page.context().newCDPSession(page);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 20, y: y + 5 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
  await expect.poll(async () => (await marker.boundingBox())?.x).not.toBe(moved?.x);
});
