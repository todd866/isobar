import { expect, test, type Page } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { australiaLambert, project, type Camera } from '../../src/lib/lambert';
import { chartRoutes } from './map-fixture';

const OUT = path.join(os.homedir(), '.local', 'state', 'isobar-week', 'location');
const TOWNS = [
  ['Townsville', -19.25, 146.77, 5, 'QLD'],
  ['Perth', -31.95, 115.86, 1, 'AU'],
  ['Sydney', -33.87, 151.21, 1, 'AU'],
];

async function install(page: Page, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((initialTheme) => {
    const chosen = sessionStorage.getItem('isobar-e2e-theme') || initialTheme;
    localStorage.setItem('isobar-theme', chosen);
    if (sessionStorage.getItem('isobar-e2e-location') === 'keep') return;
    localStorage.removeItem('isobar.place');
    localStorage.removeItem('isobar.places');
    localStorage.removeItem('isobar.place.hint');
  }, theme);
  await page.setExtraHTTPHeaders({
    'isobar-test': '1',
    'x-isobar-test-latitude': '-19.26',
    'x-isobar-test-longitude': '146.82',
  });
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  await chartRoutes(page);
  await page.route('**/places/world-places.json', (route) => route.fulfill({ json: TOWNS }));
  await page.route('https://api.open-meteo.com/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('https://marine-api.open-meteo.com/**', (route) => route.fulfill({ json: { hourly: { time: [] } } }));
  await page.route('**/api/chat', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({ delta: 'Noted.' })}\n\ndata: ${JSON.stringify({ done: true, model: 'fixture' })}\n\n`,
  }));
}

async function open(page: Page, width: number, height: number, theme: 'light' | 'dark' = 'light') {
  await page.setViewportSize({ width, height });
  await install(page, theme);
  await page.goto('/');
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true', { timeout: 60_000 });
}

async function camera(page: Page) {
  return page.locator('[data-map-ready]').evaluate((element) => {
    const api = (element as HTMLElement & { chartApi: { camera: () => Camera } }).chartApi;
    const shot = api.camera();
    return { x: shot.centerX, y: shot.centerY, w: shot.halfWidth, h: shot.halfHeight };
  });
}

async function aim(page: Page, lat: number, lon: number) {
  const point = project(australiaLambert(), lat, lon);
  expect(point).not.toBeNull();
  await page.locator('[data-map-ready]').evaluate((element, center) => {
    const api = (element as HTMLElement & { chartApi: { camera: () => Camera; redraw: () => void } }).chartApi;
    Object.assign(api.camera(), { centerX: center!.x, centerY: center!.y, halfWidth: 8, halfHeight: 5 });
    api.redraw();
  }, point);
}

test('first visit uses the coarse fix, shows the hint once, and / then Enter searches', async ({ page }) => {
  await open(page, 1280, 800);
  const field = page.getByRole('combobox', { name: 'Place' });
  await expect(field).toHaveValue('Townsville');
  await expect(page.locator('[data-place-hint]')).toHaveText('Not here? Search or ⌖');
  await page.keyboard.press('/');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('placeholder', 'Search a place or airport');
  await page.keyboard.type('Sy');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('Sydney');
  await expect(field).toHaveAttribute('data-place', 'sydney');
  await expect(page.locator('[data-place-hint]')).toHaveCount(0);
  await page.evaluate(() => sessionStorage.setItem('isobar-e2e-location', 'keep'));
  await page.reload();
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true');
  await expect(field).toHaveValue('Sydney');
  await expect(page.locator('[data-place-hint]')).toHaveCount(0);
});

test('locate button uses the browser fix, and denial is one line', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success: (position: GeolocationPosition) => void, error?: (err: GeolocationPositionError) => void) {
          const deny = sessionStorage.getItem('isobar-e2e-deny-geo') === '1';
          if (deny) error?.({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
          else success({ coords: { latitude: -31.95, longitude: 115.86, accuracy: 100, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() } as GeolocationPosition);
        },
        watchPosition() { return 0; },
        clearWatch() {},
      },
    });
  });
  await open(page, 1280, 800);
  await expect(page.locator('input[data-place]')).toHaveValue('Townsville');
  await page.locator('[data-locate]').click();
  await expect(page.locator('input[data-place]')).toHaveValue('Perth');
  await expect(page.locator('input[data-place]')).toHaveAttribute('data-place', 'perth');
  await expect(page.getByRole('status', { name: 'Located' })).toBeVisible();
  await expect(page.locator('[data-locate-note]')).toHaveCount(0);
  await page.evaluate(() => sessionStorage.setItem('isobar-e2e-deny-geo', '1'));
  await page.locator('[data-locate]').click();
  await expect(page.locator('[data-locate-note]')).toHaveText('Location off');
  await expect(page.locator('[data-locate-note]')).not.toContainText(/error/i);
  await expect(page.locator('input[data-place]')).toHaveValue('Perth');
});

test('a tapped offshore point can become the place, and the star lists it first', async ({ page }) => {
  await open(page, 1280, 800);
  await expect(page.locator('input[data-place]')).toHaveValue('Townsville');
  await page.waitForFunction(() => !!(document.querySelector('[data-map-ready]') as HTMLElement & { chartApi?: unknown }).chartApi);
  await aim(page, -19.25, 147.15);
  const canvas = page.locator('canvas[tabindex="0"]');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const panel = page.locator('[data-point-panel]');
  await expect(panel.locator('[data-point-title]')).toHaveText(/^Coral Sea, \d+ km E of Townsville$/);
  await expect(panel.locator('[data-point-coords]')).toHaveText(/\d+\.\d+°S \d+\.\d+°E/);
  await panel.locator('[data-set-place]').click();
  await expect(page.getByRole('status', { name: 'Set as my place' })).toBeVisible();
  await page.getByRole('button', { name: 'Show daily forecast', exact: true }).click();
  await expect(page.locator('input[data-place]')).toHaveValue(/^Coral Sea, \d+ km E of Townsville$/);
  await expect(page.locator('[data-place-hint]')).toHaveCount(0);
  await panel.locator('[data-set-place]').click();
  await expect(page.getByRole('status', { name: 'Restored' })).toBeVisible();
  await expect(page.locator('input[data-place]')).toHaveValue('Townsville');

  const id = await page.locator('input[data-place]').getAttribute('data-place');
  await page.getByRole('combobox', { name: 'Place' }).click();
  await expect(page.locator('[data-place-option]').first()).not.toHaveAttribute('data-place-option', id!);
  await page.keyboard.press('Escape');
  await page.locator('[data-save-place]').click();
  await expect(page.locator('[data-save-place]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status', { name: 'Saved' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Place' }).click();
  await expect(page.locator('[data-place-option]').first()).toHaveAttribute('data-place-option', id!);
  await page.keyboard.press('Escape');
  await page.locator('[data-save-place]').click();
  await expect(page.locator('[data-save-place]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('status', { name: 'Unsaved' })).toBeVisible();
});

test('right-click and a touch long-press open the point chip without moving the map', async ({ page }) => {
  await open(page, 1280, 800);
  await expect(page.locator('input[data-place]')).toHaveValue('Townsville');
  await page.waitForFunction(() => !!(document.querySelector('[data-map-ready]') as HTMLElement & { chartApi?: unknown }).chartApi);
  const canvas = page.locator('canvas[tabindex="0"]');
  const box = (await canvas.boundingBox())!;
  const x = box.x + box.width * 0.42;
  const y = box.y + box.height * 0.48;
  const before = await camera(page);
  await page.mouse.click(x, y, { button: 'right' });
  const chip = page.locator('[data-map-chip]');
  await expect(chip).toBeVisible();
  await expect(chip.locator('strong')).not.toHaveText('');
  await expect(page.locator('[data-point-panel]')).toHaveCount(0);
  expect(await camera(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(chip).toHaveCount(0);
  expect(await camera(page)).toEqual(before);

  await page.mouse.click(x, y, { button: 'right' });
  await expect(chip).toBeVisible();
  await chip.locator('[data-chip-section]').click();
  await expect(page.locator('[data-point-panel]')).toBeVisible();
  await expect(chip).toHaveCount(0);
  await page.getByRole('button', { name: 'Close point' }).click();

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.mouse.click(x, y, { button: 'right' });
  await chip.locator('[data-chip-copy]').click();
  await expect(chip.locator('.map-chip-note')).toHaveText('Copied');
  await chip.locator('[data-chip-ask]').click();
  await expect(page.locator('[data-chat-panel]')).toBeVisible();
  await expect(chip).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-chat-panel]')).toHaveCount(0);
  if (await page.locator('[data-point-panel]').count()) await page.getByRole('button', { name: 'Close point' }).click();

  const touchBox = (await canvas.boundingBox())!;
  const touchX = touchBox.x + touchBox.width * 0.35;
  const touchY = touchBox.y + touchBox.height * 0.55;
  const hold = (moved: boolean) => page.evaluate(async ({ x, y, moved }) => {
    const target = document.querySelector('canvas[tabindex="0"]') as HTMLCanvasElement;
    const event = (type: string, clientX: number, clientY: number, buttons: number) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX, clientY, pointerType: 'touch', pointerId: 7, isPrimary: true, button: 0, buttons,
    }));
    event('pointerdown', x, y, 1);
    if (moved) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      event('pointermove', x + 24, y, 1);
    }
    await new Promise((resolve) => setTimeout(resolve, moved ? 400 : 520));
    event('pointerup', moved ? x + 24 : x, y, 0);
  }, { x: touchX, y: touchY, moved });
  await hold(false);
  await expect(page.locator('[data-map-chip]')).toBeVisible();
  await page.mouse.click(touchBox.x + 12, touchBox.y + 12);
  await expect(page.locator('[data-map-chip]')).toHaveCount(0);
  await hold(true);
  await expect(page.locator('[data-map-chip]')).toHaveCount(0);
});

test('location review captures', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page, 1440, 900, 'light');
  await expect(page.locator('input[data-place]')).toHaveValue('Townsville');
  await expect(page.locator('[data-place-hint]')).toBeVisible();
  const shots: [string, number, number, 'light' | 'dark'][] = [
    ['desktop-light', 1440, 900, 'light'],
    ['desktop-dark', 1440, 900, 'dark'],
    ['phone-light', 390, 844, 'light'],
    ['phone-dark', 390, 844, 'dark'],
  ];
  const { mkdirSync } = await import('node:fs');
  mkdirSync(OUT, { recursive: true });
  for (const [name, width, height, theme] of shots) {
    await page.evaluate((next) => sessionStorage.setItem('isobar-e2e-theme', next), theme);
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height });
    await page.reload();
    await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true');
    await expect(page.locator('input[data-place]')).toHaveValue('Townsville', { timeout: 20_000 });
    await expect(page.locator('[data-place-hint]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => sessionStorage.setItem('isobar-e2e-theme', 'light'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true');
  await page.waitForFunction(() => !!(document.querySelector('[data-map-ready]') as HTMLElement & { chartApi?: unknown }).chartApi);
  await aim(page, -19.25, 146.77);
  const canvas = page.locator('canvas[tabindex="0"]');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('[data-point-title]')).toHaveText('Townsville');
  await page.screenshot({ path: path.join(OUT, 'desktop-light-point.png'), fullPage: false });
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3, { button: 'right' });
  await expect(page.locator('[data-map-chip]')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'desktop-light-chip.png'), fullPage: false });
});
