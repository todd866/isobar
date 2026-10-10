import { expect, test as base } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { trainingFixture } from '../fixtures/training';
import { installTrainingFiles } from './training-files';

// A separate headless browser per test also supports the sandbox's single-process mode.
const test = base.extend({
  page: async ({ playwright, browserName, launchOptions, contextOptions, baseURL }, use) => {
    const browser = await playwright[browserName].launch(launchOptions);
    try {
      const context = await browser.newContext({ ...contextOptions, baseURL });
      if (process.env.ISOBAR_E2E_FILES === '1') await installTrainingFiles(context);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await use(page);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  },
});
const shots = path.join(process.cwd(), 'test-results', 'learn');

async function prepare(page: import('@playwright/test').Page, theme: 'light' | 'dark', units: 'aus' | 'us' = 'aus', cloud: string | null = 'FEW006 BKN012') {
  await page.route('**/data/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/data/aviation.json') {
      const aviation = JSON.parse(trainingFixture.get(pathname)!.body.toString());
      aviation.airports[0].metar = cloud == null ? null : {
        raw: `METAR YPPH 070300Z 24015G25KT 9999 ${cloud} 22/13 Q1016`, time: '2026-10-07T03:00:00Z',
      };
      return route.fulfill({ json: aviation });
    }
    const fixture = trainingFixture.get(pathname);
    return route.fulfill(fixture ?? { status: 404, body: '' });
  });
  await page.addInitScript(({ theme, units }) => {
    localStorage.setItem('isobar-theme', theme);
    localStorage.setItem('isobar.units', units);
    localStorage.removeItem('isobar.learn.v1');
    localStorage.setItem('isobar.place', 'perth');
  }, { theme, units });
  await page.route('**/api/learn/assign', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ goal: 'weather', level: 'curious', rules: null, strands: {}, source: 'default' }),
  }));
}

test('US units prefill US rules, Curious hides them, and the first card is the map', async ({ page }) => {
  await prepare(page, 'light', 'us');
  await page.goto('/train');
  await expect(page.getByRole('link', { name: 'Today’s tour' })).toHaveAttribute('href', '/?tour=1');
  await expect(page.locator('[data-learn-chip] option:checked')).toHaveText('Student pilot · US');
  await page.getByRole('button', { name: 'Weather' }).click();
  await expect(page.locator('[data-learn-chip] option:checked')).toHaveText('Curious');
  await page.getByRole('button', { name: 'Start' }).click();
  const stem = page.locator('.stem');
  await expect(stem).toContainText('Perth');
  await expect(stem).toContainText('24015G25KT');
  await expect(stem).not.toContainText(/FAA|14 CFR|MOS/);
  await expect(page.locator('[data-picture]')).toBeVisible();
  await expect(page.locator('[data-level-chip] option:checked')).toHaveText('Curious');
});

test('Airline United States uses actual cloud with an FAA citation, and Explain opens the card', async ({ page }) => {
  await prepare(page, 'light', 'us');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/train');
  await page.locator('[data-learn-chip]').selectOption('airline|us');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.stem')).toContainText('BKN012');
  await expect(page.locator('[data-example-chip]')).toHaveCount(0);
  await page.getByRole('button', { name: /Show answer/ }).click();
  await expect(page.locator('.review-card')).toContainText('1,200 ft AGL');
  await expect(page.locator('.review-card')).toContainText('FAA');
  await page.getByRole('button', { name: 'Explain this' }).click();
  await expect(page.locator('[data-chat-panel]')).toBeVisible();
  await expect(page.locator('[data-chat-chip]').filter({ hasText: 'learn.anchor' })).toBeVisible();
});

test('light and dark picker and card at desktop and phone', async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height, name] of [[1440, 900, '1440'], [390, 844, '390']] as const) {
      await prepare(page, theme, 'aus');
      await page.setViewportSize({ width, height });
      await page.goto('/train');
      await expect(page.locator('[data-learn-chip]')).toBeVisible();
      await page.screenshot({ path: path.join(shots, `picker-${theme}-${name}.png`) });
      await page.getByRole('button', { name: 'Weather' }).click();
      await page.getByRole('button', { name: 'Start' }).click();
      await expect(page.locator('.stem')).toContainText('Perth');
      await page.screenshot({ path: path.join(shots, `curious-${theme}-${name}.png`) });
    }
  }
});

async function viewport(page: import('@playwright/test').Page, example = false) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
  if (process.env.VIEWPORT_HELPER) {
    const { assertViewport } = await import(pathToFileURL(process.env.VIEWPORT_HELPER).href);
    await assertViewport(page, {
      primary: [{ selector: '.trainer .stage', minWidth: 280, minHeight: 100 }],
      controls: [{ selector: '[data-reveal]', minHeight: 44 }, ...(example ? [{ selector: '[data-example-chip]' }] : [])],
    });
  }
}

test('live ceiling and labelled examples fit laptop and phone in light and dark', async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  for (const theme of ['light', 'dark'] as const) for (const [width, height] of [[1280, 720], [390, 844], [844, 390]]) {
    for (const cloud of ['FEW006 BKN012', null]) {
      await prepare(page, theme, 'aus', cloud);
      await page.setViewportSize({ width, height });
      await page.goto('/train');
      await page.getByRole('button', { name: 'Start' }).click();
      if (cloud) {
        await expect(page.locator('.stem')).toContainText(cloud);
        await expect(page.locator('[data-example-chip]')).toHaveCount(0);
        await expect(page.locator('.choice').filter({ hasText: '1,200 ft AGL' })).toBeVisible();
      } else {
        await expect(page.locator('[data-example-chip]')).toBeVisible();
        await expect(page.locator('.stem')).toContainText('fictional aerodrome');
        await expect(page.locator('.review-card')).not.toContainText(/Perth|11:00 am/);
      }
      await viewport(page, !cloud);
      await page.screenshot({ path: path.join(shots, `${cloud ? 'ceiling' : 'example'}-${theme}-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    for (const node of document.querySelectorAll<HTMLElement>('.trainer *')) {
      if (node.children.length === 0) node.style.fontSize = `${parseFloat(getComputedStyle(node).fontSize) * 2}px`;
    }
  });
  await viewport(page, true);
  await page.locator('.choice').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'example-dark-390-200pct.png') });
});

test('no-ceiling and dry Defence fixtures never acquire invented weather', async ({ page }) => {
  await prepare(page, 'light', 'aus', 'FEW012');
  await page.goto('/train');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.stem')).toContainText('FEW012');
  await page.getByRole('button', { name: /Show answer/ }).click();
  await expect(page.locator('.review-card')).toContainText('No ceiling reported');
  await prepare(page, 'light', 'aus', 'CAVOK');
  await page.goto('/train');
  await page.getByRole('button', { name: 'Defence' }).click();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.stem')).toContainText('24015G25KT');
  await expect(page.locator('.stem')).not.toContainText('Rain is crossing');
  await expect(page.locator('[data-example-chip]')).toHaveCount(0);
});
