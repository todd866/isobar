import { historyRoutes } from './history-layout-fixture';
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
// Owner's shared geometry check; browser remains the project's headless page.
// @ts-ignore local reusable QA helper has no declaration file
import { assertViewport } from '../../../tools/viewport-fit.mjs';

for (const theme of ['light', 'dark'] as const) {
  for (const [width, height] of [[1280, 720], [390, 844], [844, 390]] as const) {
    test(`About and map ${width}x${height} ${theme}`, async ({ page }, info) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height });
      await page.addInitScript(mode => localStorage.setItem('isobar-theme', mode), theme);
      await page.goto('/');
      await expect(page.locator('[data-map-ready=true]')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: /^(Data sources|Sources|Coastal data sources)$/ })).toHaveCount(0);
      await expect(page.locator('.map-sources, [data-attribution]')).toHaveCount(0);
      await expect(page.locator('[title*="CC BY"], [title*="Mapterhorn"]')).toHaveCount(0);
      await expect(page.getByText(/CC BY 4\.0|© DLR|Mapterhorn/)).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'About Isobar', exact: true })).toBeHidden();
      await assertViewport(page, {
        primary: [{ selector: '[data-map-ready]', minWidth: 240, minHeight: 100 }],
        controls: [{ selector: '[aria-label="Menu"]', minWidth: 36, minHeight: 36 }],
        screenshotPath: info.outputPath('map.png'),
      });
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('link', { name: 'About Isobar', exact: true }).click();
      await expect(page).toHaveURL(/\/about$/);
      const about = page.locator('[data-about-page]');
      const plist = fs.readFileSync(path.resolve(process.cwd(), '../Info.plist'), 'utf8');
      const version = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)![1];
      await expect(page.locator('[data-app-version]')).toHaveText(version);
      for (const source of ['ECMWF Open Data', 'Mapterhorn', 'Copernicus GLO-30', 'Geoscience Australia', 'Natural Earth', 'Bureau of Meteorology', 'aviationweather.gov', 'Open-Meteo', 'ADSB.lol', 'NASA Blue Marble']) {
        await expect(about.getByRole('link', { name: source, exact: true })).toHaveCount(1);
      }
      await expect(about).toContainText('© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA');
      await expect(about).toContainText('Weather and UV index · CC BY 4.0');
      await assertViewport(page, {
        documentY: 'allow',
        primary: [{ selector: '[data-about-page]', fit: 'visible', minWidth: 280, minHeight: 100 }],
        controls: [{ selector: '[aria-label="Back"]', minWidth: 36, minHeight: 36 }],
        screenshotPath: info.outputPath('about.png'),
      });
      // Read the bottom rows as well as the initial viewport; no clipping at 200% text.
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await page.screenshot({ path: info.outputPath('about-large-text.png') });
      await about.locator('.about-row').last().scrollIntoViewIfNeeded();
      await expect(about.locator('.about-row').last()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath('about-last-rows.png') });
      await page.keyboard.press('Escape');
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('[data-map-ready=true]')).toBeVisible({ timeout: 60_000 });
    });
  }
}

for (const route of ['/history', '/historical']) {
  test(`${route} has no map credits`, async ({ page }) => {
    await historyRoutes(page);
    await page.goto(`${route}?event=dday`);
    await expect(page.locator('[data-map-ready=true]')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: /^(Data sources|Sources)$/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Map details', exact: true }).click();
    await expect(page.locator('.map-details')).not.toContainText(/CC BY|Mapterhorn|© DLR|ODbL/);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Map details', exact: true })).toBeFocused();
  });
}
