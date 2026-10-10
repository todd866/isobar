import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const out = path.join(process.cwd(), 'test-results', 'visual');

async function shot(page: Page, name: string) {
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, name);
  await page.screenshot({ path: file, fullPage: false });
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    text: document.body.innerText.includes('…') || document.body.innerText.includes('...'),
  }));
  expect(overflow.x, name).toBeLessThanOrEqual(1);
  expect(overflow.text, name).toBe(false);
}

async function theme(page: Page, mode: 'light' | 'dark') {
  await page.addInitScript((value) => localStorage.setItem('isobar-theme', value), mode);
}

test('map desktop and phone, light and dark', async ({ page }) => {
  for (const mode of ['light', 'dark'] as const) {
    await theme(page, mode);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForSelector('[data-map-ready="true"]', { timeout: 30_000 });
    await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
    await page.waitForSelector('[data-frames="complete"]', { timeout: 60_000 });
    await page.waitForTimeout(600);
    await shot(page, `map-${mode}-desktop.png`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await shot(page, `map-${mode}-phone.png`);
  }
});

test('train before and after reveal', async ({ page }) => {
  await theme(page, 'light');
  await page.setViewportSize({ width: 1440, height: 900 });
  // A returning learner skips the goal picker (as train.spec does).
  await page.addInitScript(() => localStorage.setItem('isobar.learn.v1', JSON.stringify({ version: 1, started: true, classic: true })));
  await page.goto('/train');
  await page.waitForSelector('[data-training-ready="true"]');
  await page.getByRole('button', { name: 'Show answer · Space' }).waitFor();
  await shot(page, 'train-before.png');
  await page.getByRole('button', { name: 'Show answer · Space' }).click();
  await page.locator('[data-grade="3"]').waitFor();
  await shot(page, 'train-after.png');

  await page.addInitScript((value) => localStorage.setItem('isobar-theme', value), 'dark');
  await page.goto('/train');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForSelector('[data-training-ready="true"]');
  await shot(page, 'train-dark-before.png');
});
