import { expect, test } from '@playwright/test';
import { chartRoutes } from './map-fixture';

test('fresh forecast keeps the run badge out of the place chip', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  await chartRoutes(page);
  await page.goto('/');
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await page.waitForSelector('[data-frames="complete"]', { timeout: 60_000 });

  await expect(page.locator('[data-run-chip]')).toHaveCount(0);
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
  await expect(chip).toHaveText('Forecast 27 h old');
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark'] as const) for (const age of [18, 22, 37]) test(`run warning boundary at ${age} hours fits the ${width} ${theme} place chip`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(theme => localStorage.setItem('isobar-theme', theme), theme);
  await page.clock.setFixedTime(Date.parse('2026-10-08T00:00:00Z') + age * 3600000);
  await chartRoutes(page);
  await page.goto('/');
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  const chip = page.locator('[data-run-chip]');
  if (age > 18) {
    await expect(chip).toHaveAttribute('data-run-stale', 'true');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(age <= 36 ? `Forecast ${age} h old` : 'Forecast from Thu 8 am');
  } else {
    await expect(chip).toHaveCount(0);
  }
  await page.waitForSelector('[data-frames="complete"]', { timeout: 60_000 });
  const geometry = await page.evaluate(() => {
    const place = document.querySelector('.map-header-place')!;
    const run = document.querySelector('[data-run-chip]');
    const input = document.querySelector<HTMLInputElement>('[aria-label="Place"]')!;
    const css = getComputedStyle(input), measure = document.createElement('canvas').getContext('2d')!;
    measure.font = css.font;
    return {
      place: place.getBoundingClientRect().toJSON(), run: run?.getBoundingClientRect().toJSON(),
      input: input.getBoundingClientRect().toJSON(), actions: document.querySelector('.map-header-actions')!.getBoundingClientRect().toJSON(),
      overflow: place.scrollWidth - place.clientWidth,
      nameWidth: measure.measureText(input.value).width + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) + 2,
    };
  });
  expect(geometry.overflow, 'place chip content must fit').toBeLessThanOrEqual(1);
  expect(geometry.nameWidth, 'Perth remains readable').toBeLessThanOrEqual(geometry.input.width + 1);
  expect(geometry.place.left).toBeGreaterThanOrEqual(0);
  expect(geometry.place.right).toBeLessThanOrEqual(geometry.actions.left);
  if (age > 18) {
    expect(geometry.run).toBeTruthy();
    expect(geometry.run.left).toBeGreaterThanOrEqual(geometry.place.left - 1);
    expect(geometry.run.right).toBeLessThanOrEqual(geometry.place.right + 1);
    expect(geometry.run.top).toBeGreaterThanOrEqual(geometry.place.top - 1);
    expect(geometry.run.bottom).toBeLessThanOrEqual(geometry.place.bottom + 1);
    if (width > 600) expect(geometry.run.left).toBeGreaterThanOrEqual(geometry.input.right);
  }
  await expect(page.locator('body')).not.toContainText('00Z');
  await expect(page.locator('[data-clock-zulu]')).toHaveCount(0);
  await page.screenshot({path: info.outputPath(`header-${width}-${theme}-${age}.png`)});
});

for (const viewport of [{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 720 }]) for (const theme of ['light', 'dark'] as const) test(`22-hour freshness fits at 200% text ${viewport.width} ${theme}`, async ({ page }, info) => {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(theme => localStorage.setItem('isobar-theme', theme), theme);
  await page.clock.setFixedTime(Date.parse('2026-10-08T22:00:00Z'));
  await chartRoutes(page);
  await page.goto('/');
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await expect(page.locator('[data-map-page]')).toHaveAttribute('data-map-text', 'enlarged');
  await expect(page.locator('[data-run-chip]')).toHaveText('Forecast 22 h old');
  await expect.poll(() => page.evaluate(() => {
    const place = document.querySelector<HTMLElement>('.map-header-place')!;
    const run = document.querySelector<HTMLElement>('[data-run-chip]')!;
    const p = place.getBoundingClientRect(), r = run.getBoundingClientRect();
    const selectors = ['.map-header-place', '.map-header-actions', '.map-lens-wrap', '.map-bottom-bar', '.map-tools'];
    const boxes = selectors.map(selector => document.querySelector(selector)!.getBoundingClientRect());
    return place.scrollWidth <= place.clientWidth + 1 && run.scrollWidth <= run.clientWidth + 1
      && r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom
      && boxes.every(a => a.left >= 0 && a.right <= innerWidth && a.top >= 0 && a.bottom <= innerHeight)
      && boxes.every((a, i) => boxes.slice(i + 1).every(b => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1));
  })).toBe(true);
  await page.screenshot({ path: info.outputPath(`header-22h-200pct-${viewport.width}-${theme}.png`) });
});
