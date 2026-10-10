import { expect, test as base, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { drillCards } from '../../../training/src/skills/index.ts';
import { judge, retestCard, worksheet } from '../../../training/src/adaptive.ts';
import { installTrainingFiles } from './training-files';
import { installWeatherFixture } from './weather-fixture';

// A file-backed production check works in sandboxes that cannot listen on a
// socket. The normal run uses Next's HTTP server and the browser's real cache.
const files = process.env.ISOBAR_E2E_FILES === '1';
const test = base.extend({
  page: async ({ playwright, browserName, launchOptions, contextOptions, baseURL }, use) => {
    const browser = await playwright[browserName].launch(launchOptions);
    const context = await browser.newContext({ ...contextOptions, baseURL });
    if (files) await installTrainingFiles(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try { await use(page); expect(errors).toEqual([]); }
    finally { await browser.close(); }
  },
});

const out = path.join(process.cwd(), 'test-results', 'train');
const storageKey = 'isobar.training.v1';
const sections = (page: Page) => page.getByRole('navigation', { name: 'Training sections' });

async function open(page: Page, theme: 'light' | 'dark' = 'light', query = '') {
  await installWeatherFixture(page);
  await page.addInitScript((mode) => {
    localStorage.setItem('isobar-theme', mode);
    localStorage.setItem('isobar.learn.v1', JSON.stringify({ version: 1, started: true, classic: true }));
  }, theme);
  await page.goto(`/train${query}`);
  await expect(page.locator('.review-card')).toBeVisible();
}

async function fit(page: Page, label: string, action?: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), label).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), label).toBeLessThanOrEqual(1);
  if (process.env.VIEWPORT_HELPER) {
    const { assertViewport } = await import(pathToFileURL(process.env.VIEWPORT_HELPER).href);
    await assertViewport(page, {
      primary: [{ selector: '.trainer .stage', minWidth: 280, minHeight: 120 }],
      controls: [{ selector: '.sections', minHeight: 44 }, ...(action ? [{ selector: action, minHeight: 44 }] : [])],
    });
  }
}

test('cached /train shows a card within 1.5 seconds and fetches only the trainer snapshot', async ({ page }) => {
  await open(page);
  await page.waitForLoadState('networkidle');
  const requests: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/data/')) requests.push(request.url()); });
  await page.reload();
  await expect(page.locator('.review-card')).toBeVisible({ timeout: 1500 });
  const visibleMs = await page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => resolve(performance.now()))));
  expect(visibleMs).toBeLessThan(1500);
  await page.waitForLoadState('networkidle');
  expect(requests.filter((url) => url.includes('/frames/'))).toHaveLength(1);
  expect(requests.every((url) => /manifest\.json|points\.json|aviation\.json|frames\/mslp\//.test(url))).toBe(true);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'timing.json'), JSON.stringify({ visibleMs, files, requests }, null, 2));
});

test('numeric miss opens a checked worksheet, then a transfer; progress survives remount', async ({ page }) => {
  await open(page);
  await page.locator('[data-mode]').selectOption('performance');
  const stem = await page.locator('.stem').innerText();
  const original = drillCards().find((card) => card.stem === stem)!;
  expect(original).toBeTruthy();
  await page.locator('[data-numeric]').fill('999999');
  await page.keyboard.press('Enter');
  if (await page.locator('[data-support-return]').count()) await page.locator('[data-support-return]').click();
  await expect(page.getByRole('list', { name: 'Worksheet' })).toBeVisible();
  await expect(page.locator('.eyebrow')).toContainText('Same problem, in steps');
  const steps = worksheet(retestCard(original, judge(original, '999999', 1000))!);
  await page.locator('[data-step]').first().fill('999999');
  await expect(page.locator('.ws-step.bad')).toHaveCount(1);
  for (const step of steps) await page.locator(`[data-step="${step.id}"]`).fill(String(Number(step.value.toFixed(step.decimals))));
  await expect(page.locator('.verdict.good')).toBeVisible();
  await page.keyboard.press('3');
  await expect(page.locator('.eyebrow')).toContainText('New numbers');
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey);
  expect(saved.skills[original.drill!.skill].retests).toBeGreaterThan(0);
  await page.getByRole('link', { name: 'Download', exact: true }).filter({ visible: true }).click();
  await expect(page.locator('.trainer')).toHaveCount(0);
  await page.getByRole('link', { name: 'Train', exact: true }).filter({ visible: true }).click();
  await expect(page.locator('.review-card')).toBeVisible();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey)).toEqual(saved);
  await page.locator('[data-reveal]').click();
  await page.keyboard.press('3');
  await expect(page.locator('.grades')).toHaveCount(0); // no duplicate handlers after returning
});

test('slow or unavailable data never blocks review or replaces an answer draft', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/data/manifest.json', async (route) => { await held; await route.continue(); });
  await open(page);
  await page.locator('[data-mode]').selectOption('performance');
  await page.locator('[data-numeric]').fill('123');
  const prompt = await page.locator('.stem').innerText();
  release();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-numeric]')).toHaveValue('123');
  await expect(page.locator('.stem')).toHaveText(prompt);
  await sections(page).getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.locator('.live-card .taf-raw').first()).toContainText('TAF YPPH');
  const laterRequests: string[] = [];
  page.on('request', (request) => laterRequests.push(request.url()));
  await page.context().setOffline(true);
  await sections(page).getByRole('button', { name: 'Lab', exact: true }).click();
  await expect(page.getByRole('region', { name: 'E6-B flight computer' })).toBeVisible();
  await sections(page).getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.locator('[data-numeric]')).toBeVisible();
  expect(laterRequests).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) {
  for (const [device, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]] as const) {
    test(`train card, worksheet and Lab ${device} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, theme, '?card=drill.interpolate.r2');
      mkdirSync(out, { recursive: true });
      await fit(page, `${device} card`, '[data-numeric-submit]');
      await page.screenshot({ path: path.join(out, `web-train-${device}-${theme}-card.png`) });
      await page.locator('[data-numeric]').fill('999999');
      await page.keyboard.press('Enter');
      if (await page.locator('[data-support-return]').count()) await page.locator('[data-support-return]').click();
      await expect(page.locator('.worksheet')).toBeVisible();
      await fit(page, `${device} worksheet`, '[data-numeric-submit]');
      if (device === 'phone') await page.locator('.worksheet').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `web-train-${device}-${theme}-worksheet.png`) });
      await sections(page).getByRole('button', { name: 'Lab', exact: true }).click();
      await expect(page.locator('.e6b .flow')).toBeVisible();
      await fit(page, `${device} Lab`);
      await page.screenshot({ path: path.join(out, `web-train-${device}-${theme}-lab.png`), animations: 'disabled' });
    });
  }
}

test('short laptop, landscape phone, enlarged text and all sections remain reachable', async ({ page }) => {
  for (const [width, height] of [[1280, 720], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await open(page, 'dark');
    for (const label of ['Live', 'Plan', 'Practice Exam', 'Lab', 'Profile', 'Review']) {
      await sections(page).getByRole('button', { name: label, exact: true }).click();
      await fit(page, `${width} ${label}`);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'dark', '?card=drill.cg-shift.r2');
  await page.locator('[data-numeric]').fill('999999');
  await page.keyboard.press('Enter');
  if (await page.locator('[data-support-return]').count()) await page.locator('[data-support-return]').click();
  await page.evaluate(() => {
    for (const node of document.querySelectorAll<HTMLElement>('.trainer *')) {
      if (node.children.length === 0) node.style.fontSize = `${parseFloat(getComputedStyle(node).fontSize) * 2}px`;
    }
  });
  await page.locator('[data-step]').last().scrollIntoViewIfNeeded();
  await fit(page, '200% text', '[data-numeric-submit]');
  await page.screenshot({ path: path.join(out, 'web-train-phone-dark-200pct.png') });
});

async function noPageOverflow(page: Page) {
  // The face shadow is repositioned from a ResizeObserver, which runs before
  // paint. Measure after that, or a just-resized frame still carries the
  // previous face size and the page looks wider than it is.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
}

/** Desktop shows Computer/Wind on the strip. A phone builds them only while the
 *  menu is open, so a missing button is flipped through the instrument. */
async function showSide(page: Page, side: 'computer' | 'wind') {
  const button = page.locator(`.e6b button[data-side="${side}"]`);
  const clickable = await button.count() > 0 && await button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit === el || !!el.contains(hit);
  });
  if (clickable) await button.click();
  else await page.evaluate((next) => (window as unknown as { e6b: { flipTo(side: string): void } }).e6b.flipTo(next), side);
  await expect(page.locator(`.e6b[data-showing="${side}"]`)).toBeVisible();
}

for (const route of ['/train', '/e6b']) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${route} shared Lab index, offline navigation and viewport ${theme}`, async ({ page }) => {
      await page.addInitScript((mode) => {
        localStorage.setItem('isobar-theme', mode);
        localStorage.setItem('isobar.learn.v1', JSON.stringify({ version: 1, started: true, classic: true }));
      }, theme);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(route === '/train' ? `${route}?lab=wind&mode=free` : route);
      if (route === '/train') {
        await expect(page.locator('[data-instrument-id="wind"]')).toBeVisible();
        await expect(page.locator('[data-lab-select] option')).toHaveCount(6);
      } else {
        await expect(page.locator('.e6b .flow')).toBeVisible();
      }
      await page.waitForLoadState('networkidle');
      const requests: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      await page.context().setOffline(true);
      if (route === '/train') {
        for (const instrument of ['atmosphere', 'interpolation', 'balance', 'profile', 'wind']) {
          await page.locator('[data-lab-select]').selectOption(instrument);
          await expect(page.locator(`[data-instrument-id="${instrument}"]`)).toBeVisible();
          await page.locator('[data-i-mode="learn"]').click();
          await page.locator('[data-i-mode="free"]').click();
          await expect(page.locator('[data-lab-select]')).toHaveValue(instrument);
        }
      } else {
        await showSide(page, 'wind');
        await showSide(page, 'computer');
        await expect(page.locator('.e6b .flow')).toBeVisible();
      }
      mkdirSync(out, { recursive: true });
      for (const [width, height] of [[1440, 900], [390, 844], [1280, 720], [844, 390]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const surfaces = route === '/train' ? (['wind', 'e6b'] as const) : (['computer', 'wind'] as const);
        for (const surface of surfaces) {
          if (route === '/train') {
            // Wind is checked in free play. The E6-B opens on the teaching flow.
            if (surface === 'e6b') await page.locator('[data-i-mode="learn"]').click();
            await page.locator('[data-lab-select]').selectOption(surface);
            if (surface === 'wind') await page.locator('[data-i-mode="free"]').click();
            if (surface === 'e6b') await expect(page.locator('.e6b .flow')).toBeVisible();
          } else {
            await showSide(page, surface);
          }
          await noPageOverflow(page);
          if (process.env.VIEWPORT_HELPER) {
            const { assertViewport } = await import(pathToFileURL(process.env.VIEWPORT_HELPER).href);
            await assertViewport(page, {
              primary: [{ selector: route === '/e6b' || surface === 'e6b' ? '.e6b' : '.i-svg', minWidth: 230, minHeight: 100 }],
              controls: [{ selector: route === '/train' ? '[data-lab-select]' : '.e6b .flow', minHeight: 32 }],
            });
          }
          if (route === '/train') {
            const pickerFits = await page.locator('[data-lab-select]').evaluate((select: HTMLSelectElement) => {
              const style = getComputedStyle(select), canvas = document.createElement('canvas');
              const context = canvas.getContext('2d')!; context.font = style.font;
              const label = select.selectedOptions[0].text;
              return !label.includes('…') && style.textOverflow !== 'ellipsis' &&
                context.measureText(label).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) <= select.clientWidth + 1;
            });
            expect(pickerFits).toBe(true);
          }
          await page.screenshot({ path: path.join(out, `${route.slice(1)}-${surface}-${width}x${height}-${theme}.png`) });
        }
      }
      expect(requests).toEqual([]);
    });
  }
}
