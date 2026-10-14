import { expect, test } from '@playwright/test';
import { chartRoutes } from './map-fixture';

test('header shows the compact forecast run and age chip', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  await chartRoutes(page);
  await page.goto('/');
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await page.waitForSelector('[data-frames="complete"]', { timeout: 60_000 });

  const chip = page.locator('[data-run-chip]');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(/^\d{2}Z \d+ h$/);
  await expect(chip).toHaveAttribute('aria-label', /ECMWF forecast run/);
  await expect(chip).toHaveAttribute('data-run-stale', 'false');
});

test('stale forecast run uses the amber warning marker', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(Date.parse('2026-10-09T03:00:00Z'));
  await chartRoutes(page);
  await page.goto('/');
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await page.waitForSelector('[data-frames="complete"]', { timeout: 60_000 });

  const chip = page.locator('[data-run-chip]');
  await expect(chip).toHaveAttribute('data-run-stale', 'true');
  await expect(chip.locator('span')).toHaveText('▲');
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark'] as const) for (const age of [18, 19]) test(`run warning boundary at ${age} hours fits the ${width} ${theme} header`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(theme => localStorage.setItem('isobar-theme', theme), theme);
  await page.clock.setFixedTime(Date.parse('2026-10-08T00:00:00Z') + age * 3600000);
  await chartRoutes(page);
  await page.goto('/');
  const chip = page.locator('[data-run-chip]');
  await expect(chip).toHaveAttribute('data-run-stale', String(age > 18));
  await expect(chip).toContainText(`00Z ${age} h`);
  const box = await chip.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  const place = await page.locator('.place-name').evaluate(e => ({width:e.clientWidth, full:e.scrollWidth}));
  expect(place.width, 'Perth remains readable beside the run chip').toBeGreaterThanOrEqual(place.full);
  await page.waitForSelector('[data-frames="complete"]', { timeout: 60_000 });
  await page.screenshot({path: info.outputPath(`header-${width}-${theme}-${age}.png`)});
});
