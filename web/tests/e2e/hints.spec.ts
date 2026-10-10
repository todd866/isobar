import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { chartRoutes, tapPoint } from './map-fixture';

/** Review sheet for the hints pass. Explicit path; nothing is written into the repo. */
const OUT = path.resolve(process.env.ISOBAR_HINTS_DIR ?? path.join(process.env.HOME ?? '', '.local/state/isobar-week/hints'));
const SEEN = JSON.stringify({ point: true, gesture: true, lens: true });

async function prepare(page: Page, mode: 'light' | 'dark', width: number, height: number, seen = false, sticky = false) {
  await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' });
  await page.addInitScript(({ theme, token, sticky }) => {
    localStorage.setItem('isobar-theme', theme);
    localStorage.setItem('isobar.place', 'perth');
    localStorage.removeItem('isobar.speed');
    // A sticky visit keeps whatever the page stored, so a reload can prove it.
    if (sticky) return;
    if (token) localStorage.setItem('isobar.map.hints', token);
    else localStorage.removeItem('isobar.map.hints');
  }, { theme: mode, token: seen ? SEEN : '', sticky });
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  await chartRoutes(page);
  await page.goto('/');
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await page.waitForSelector('[data-frames="complete"]', { timeout: 60_000 });
}

function hint(page: Page, id?: string) {
  return page.locator(id ? `[data-map-hint="${id}"]` : '[data-map-hint]');
}

async function fits(page: Page, width: number) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const box = await page.locator('[data-hint-copy]').boundingBox();
  if (!box) return;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  const clipped = await page.locator('[data-map-hint]').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(clipped).toBe(false);
}

test('hints appear in order, leave when their action happens, and stay gone', async ({ page }) => {
  test.setTimeout(90_000);
  await prepare(page, 'light', 1440, 900, false, true);
  await expect(hint(page, 'point')).toContainText('Tap the map for the air above a point');
  await expect(hint(page, 'gesture')).toHaveCount(0);
  await expect(hint(page, 'lens')).toHaveCount(0);
  await expect(hint(page)).toHaveCSS('animation-name', 'none');

  await tapPoint(page);
  await expect(hint(page, 'point')).toHaveCount(0);
  await expect(hint(page, 'gesture')).toContainText('Hold to pause · drag to pan · pinch to zoom · 3D: two fingers to tilt');

  const canvas = page.locator('canvas[tabindex="0"]');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.35);
  await page.mouse.wheel(0, -80);
  await expect(hint(page, 'gesture')).toHaveCount(0);
  await expect(hint(page, 'lens')).toContainText('Pick a lens below for rain, wind, temp or flying');

  await page.getByRole('radio', { name: 'Rain', exact: true }).click();
  await expect(hint(page)).toHaveCount(0);

  await page.reload();
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await expect(hint(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('isobar.map.hints'))).toContain('"lens":true');
});

test('dismissing a hint with × advances without doing the action', async ({ page }) => {
  test.setTimeout(90_000);
  await prepare(page, 'light', 1440, 900);
  await hint(page, 'point').getByRole('button', { name: 'Dismiss hint' }).click();
  await expect(page.locator('[data-point-panel]')).toHaveCount(0);
  await expect(hint(page, 'gesture')).toBeVisible();
});

test('desktop labels fit at 1280 and 1440', async ({ page }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(OUT, { recursive: true });
  for (const [width, height] of [[1280, 800], [1440, 900]] as const) {
    await prepare(page, 'light', width, height);
    await expect(page.locator('[data-learn-link]')).toHaveText('Learn');
    await expect(page.locator('[data-learn-link]')).not.toHaveAttribute('title', /loading/i);
    await expect(page.locator('[data-chat-button]')).toContainText('Ask');
    await expect(page.locator('[data-pressure-chip]')).toHaveText('hPa');
    const speed = page.locator('.transport-side #playback-speed');
    await expect(speed).toHaveValue('8');
    await expect(page.getByRole('combobox', { name: 'Speed' })).toBeVisible();
    const satellite = page.getByRole('button', { name: 'Satellite', exact: true });
    await expect(satellite).toBeVisible();
    expect(await satellite.innerText()).toBe('');
    await expect(page.locator('.day-range').first()).toHaveAttribute('aria-label', 'temperature range, low to high');
    await expect(page.locator('.day-range').first()).toHaveAttribute('title', 'temperature range, low to high');
    await expect(page.locator('[aria-label="now"]')).toHaveCount(1);
    await fits(page, width);
    if (width === 1440) await page.screenshot({ path: path.join(OUT, '1440x900-light-first.png') });

    await speed.selectOption('16');
    await expect(page.getByRole('status', { name: 'Speed 16 min/s' })).toBeVisible();
    await satellite.click();
    await expect(page.locator('[data-press-label]')).toHaveText('Satellite on');
    await expect(satellite).toHaveAttribute('aria-pressed', 'true');
    await satellite.click();
    await expect(page.locator('[data-press-label]')).toHaveText('Satellite off');

    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const run = page.locator('.map-menu-run span');
    await expect(run).toContainText(/run \d{2}Z · \d+ h old/);
    await expect(run).toHaveAttribute('aria-label', /ECMWF forecast run, issued \d{2}Z, \d+ h ago/);
    await expect(page.locator('.map-menu-setting').filter({ hasText: 'Units' })).toBeVisible();
    await expect(page.locator('[data-units]')).toHaveValue('aus');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('[data-account-hint]')).toHaveText('Save places · more Ask Isobar');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-account-sheet]')).toHaveCount(0);
    await fits(page, width);
  }
});

test('returning desktop does not show hints', async ({ page }) => {
  test.setTimeout(90_000);
  fs.mkdirSync(OUT, { recursive: true });
  for (const mode of ['light', 'dark'] as const) {
    await prepare(page, mode, 1440, 900, true);
    await expect(hint(page)).toHaveCount(0);
    await expect(page.locator('[data-learn-link]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, `1440x900-${mode}-returning.png`) });
  }
  await prepare(page, 'dark', 1440, 900);
  await expect(hint(page, 'point')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, '1440x900-dark-first.png') });
});

test('phone hints fit, and a long press names an icon without pressing it', async ({ page }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(OUT, { recursive: true });
  for (const [width, height, name] of [[390, 844, '390x844'], [375, 667, '375x667']] as const) {
    await prepare(page, 'light', width, height);
    await expect(hint(page, 'point')).toContainText('Tap the map for the air above a point');
    await fits(page, width);
    if (name === '390x844') await page.screenshot({ path: path.join(OUT, '390x844-light-first.png') });
    await hint(page).getByRole('button', { name: 'Dismiss hint' }).click();
    await expect(hint(page, 'gesture')).toContainText('pinch to zoom');
    await fits(page, width);
    await hint(page).getByRole('button', { name: 'Dismiss hint' }).click();
    await expect(hint(page, 'lens')).toContainText('Pick a lens below for rain, wind, temp or flying');
    await fits(page, width);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }

  await prepare(page, 'dark', 390, 844);
  await expect(hint(page, 'point')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, '390x844-dark-first.png') });

  await prepare(page, 'light', 390, 844, true);
  await expect(hint(page)).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, '390x844-light-returning.png') });
  await prepare(page, 'dark', 390, 844, true);
  await expect(hint(page)).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, '390x844-dark-returning.png') });

  await prepare(page, 'light', 390, 844, true);
  const satellite = page.locator('.map-tools').getByRole('button', { name: 'Satellite', exact: true });
  await expect(satellite).toHaveAttribute('aria-pressed', 'false');
  const box = (await satellite.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.clock.runFor(600);
  await expect(page.locator('[data-hold-label]')).toHaveText('Satellite');
  await page.screenshot({ path: path.join(OUT, '390x844-light-hold.png') });
  await page.mouse.up();
  await expect(satellite).toHaveAttribute('aria-pressed', 'false');

  await page.mouse.down();
  await page.mouse.up();
  await expect(satellite).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.map-tools .press-note')).toHaveText('Satellite on');
});
