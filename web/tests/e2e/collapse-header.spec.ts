import { expect, test, type Page } from '@playwright/test';
import { chartRoutes, tapPoint } from './map-fixture';
import { choosePlace } from './place-field';

const FROZEN = Date.parse('2026-10-09T06:04:00Z');
test.use({ timezoneId: 'America/New_York' });

async function prepare(page: Page, width: number, height: number, mode: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: mode });
  await page.addInitScript((theme) => {
    localStorage.setItem('isobar-theme', theme);
    localStorage.setItem('isobar.place', 'perth');
    localStorage.setItem('isobar.speed', '1');
  }, mode);
  await page.clock.setFixedTime(FROZEN);
  await page.setViewportSize({ width, height });
  await chartRoutes(page);
  await page.route('https://api.open-meteo.com/**', (route) => route.abort());
  await page.route('https://marine-api.open-meteo.com/**', (route) => route.abort());
  await page.goto('/');
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await page.waitForFunction(() => typeof (document.querySelector('[data-map-ready]') as any)?.chartApi?.camera === 'function');
}

async function camera(page: Page) {
  return page.locator('[data-map-ready]').evaluate((node) => {
    const view = (node as any).chartApi.camera();
    return view && { centerX: view.centerX, centerY: view.centerY, halfWidth: view.halfWidth, halfHeight: view.halfHeight };
  });
}

function expectSameCamera(before: any, after: any) {
  expect(after).not.toBeNull();
  for (const key of ['centerX', 'centerY', 'halfWidth', 'halfHeight']) expect(after[key]).toBeCloseTo(before[key], 5);
}

for (const [width, height] of [[390, 844], [1440, 900]] as const) for (const mode of ['light', 'dark'] as const) {
  test(`map-first chrome keeps clock, place and camera ${width}x${height} ${mode}`, async ({ page }) => {
    await prepare(page, width, height, mode);
    await expect(page.locator('[data-map-page]')).toBeVisible();
    await expect(page.locator('.map-header-place')).toContainText('Perth');
    const selected = page.locator('.map-selected-time:visible').first();
    await expect(selected).toHaveAttribute('aria-label', /AWST/);
    await page.locator('.forecast-days').hover();
    await expect(selected.locator('[data-clock-zulu]')).toHaveCount(0);

    const before = await camera(page);
    expect(before).not.toBeNull();
    await page.getByRole('radio', { name: 'Fly', exact: true }).click();
    await expect(page.locator('[data-fly-panel]')).toBeVisible();
    await page.locator('.forecast-days').hover();
    await expect(page.locator('[data-clock-zulu]:visible')).toHaveText(/\d{4}Z/);
    await page.getByRole('button', { name: 'Close Fly' }).click();
    expectSameCamera(before, await camera(page));
    await tapPoint(page);
    await page.getByRole('button', { name: 'Close point' }).click();
    expectSameCamera(before, await camera(page));
  });
}

test('place-local selected time remains explicit when the place changes', async ({ page }) => {
  await prepare(page, 1440, 900, 'light');
  await page.route('**/places/world-places.json', (route) => route.fulfill({ json: [
    ['Perth', -31.95, 115.86, 1, 'AU'], ['Vancouver', 49.283, -123.121, 1, 'CA'],
  ] }));
  await choosePlace(page, 'Vancouver', 't.49283.-123121');
  const selected = page.locator('.map-selected-time:visible').first();
  await expect(selected).toHaveAttribute('aria-label', /PDT/);
  await expect(selected).toHaveAttribute('aria-label', /0604Z/);
  await expect(selected).not.toHaveAttribute('aria-label', /AWST/);
});

test('selected time survives lens and point panels', async ({ page }) => {
  await prepare(page, 1440, 900, 'light');
  const selected = page.locator('.map-selected-time:visible').first();
  await expect(selected).toHaveAttribute('aria-label', /AWST/);
  await page.getByRole('radio', { name: 'Fly', exact: true }).click();
  await expect(page.locator('[data-fly-panel]')).toBeVisible();
  await expect(selected).toHaveAttribute('aria-label', /AWST/);
  await page.getByRole('button', { name: 'Close Fly' }).click();
  await tapPoint(page);
  await expect(selected).toHaveAttribute('aria-label', /AWST/);
});
