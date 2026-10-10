import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { chartRoutes } from './map-fixture';

/** Header review sheet: 1440×900 and 2000×1290, light and dark. */
const OUT = path.resolve(process.env.ISOBAR_DESKTOP_DIR ?? path.join(process.cwd(), 'test-results/desktop-header'));

async function prepare(page: Page, mode: 'light' | 'dark', width: number, height: number) {
  await page.emulateMedia({ colorScheme: mode });
  await page.addInitScript((theme) => {
    localStorage.setItem('isobar-theme', theme);
    localStorage.setItem('isobar.place', 'perth');
  }, mode);
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  await chartRoutes(page);
  await page.goto('/');
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await page.waitForSelector('[data-frames="complete"]', { timeout: 60_000 });
}

for (const [width, height] of [[1440, 900], [2000, 1290]] as const) {
  for (const mode of ['light', 'dark'] as const) {
    test(`desktop header ${width}x${height} ${mode}`, async ({ page }) => {
      test.setTimeout(90_000);
      fs.mkdirSync(OUT, { recursive: true });
      await prepare(page, mode, width, height);
      const header = page.locator('.map-header');
      await expect(header.locator('.place-search-icon')).toBeVisible();
      await expect(header.locator('input[data-place]')).toHaveValue('Perth');
      await expect(header.locator('[data-reading]')).toContainText(/\d+°/);
      await expect(header.locator('[data-wind-words]')).toContainText(/\d+ kt/);
      await expect(header.locator('.when-long')).toBeVisible();
      await expect(header.locator('[data-learn-link]')).toHaveAttribute('href', '/train');
      // The menu lives in the header, so Units is a descendant. It is not a header control.
      await expect(header.locator('[data-map-menu] [data-units]')).toHaveCount(1);
      await expect(header.locator('[data-units]')).toBeHidden();
      await expect(header.locator('.learn-button, .learn-menu')).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
      await page.screenshot({ path: path.join(OUT, `${width}x${height}-${mode}.png`) });

      if (width === 1440 && mode === 'light') {
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(page.getByRole('status', { name: 'Paused' })).toBeVisible();
        await page.screenshot({ path: path.join(OUT, '1440x900-light-paused.png') });
        await page.getByRole('button', { name: 'Menu', exact: true }).click();
        const menu = page.locator('[data-map-menu]');
        await expect(menu.locator('[data-units]')).toBeVisible();
        await expect(menu.getByRole('button', { name: /Light|Dark/ })).toBeVisible();
        await expect(menu.getByText(/run\s+\d{2}Z/i)).toBeVisible();
        await expect(menu.getByRole('link', { name: 'Mac app', exact: true })).toBeVisible();
        await expect(menu.locator('.learn-menu, .learn-button')).toHaveCount(0);
        await page.screenshot({ path: path.join(OUT, '1440x900-light-menu.png') });
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await page.getByRole('button', { name: 'Data sources', exact: true }).click();
        const explain = page.getByRole('button', { name: 'Explain this chart', exact: true });
        await expect(explain).toBeVisible();
        const explainBox = await explain.boundingBox();
        const noteBox = await page.locator('.map-sources [role="note"]').boundingBox();
        expect(explainBox && noteBox).toBeTruthy();
        expect(explainBox!.width).toBeGreaterThan(120);
        expect(explainBox!.y + explainBox!.height).toBeLessThanOrEqual(noteBox!.y + 1);
        await page.screenshot({ path: path.join(OUT, '1440x900-light-sources.png') });
        await page.keyboard.press('Escape');
        await expect(explain).toHaveCount(0);
        await page.getByRole('button', { name: 'Recenter map', exact: true }).click();
        await expect(page.getByRole('status', { name: 'Recentered' })).toBeVisible();
        await page.screenshot({ path: path.join(OUT, '1440x900-light-recentered.png') });
      }

      if (width === 2000 && mode === 'dark') {
        await page.getByRole('button', { name: 'Menu', exact: true }).click();
        await page.screenshot({ path: path.join(OUT, '2000x1290-dark-menu.png') });
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Data sources', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Explain this chart', exact: true })).toBeVisible();
        await page.screenshot({ path: path.join(OUT, '2000x1290-dark-sources.png') });
      }
    });
  }
}
