import { expect, test, type Page, type Request } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { australiaLambert, project, type Camera } from '../../src/lib/lambert';
import { chartRoutes, tapPoint } from './map-fixture';

const PERTH = { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.86, icao: 'YPPH' };
const SHOTS = path.join(os.homedir(), '.local', 'state', 'isobar-week', 'chat');

const REPLY = [
  `data: ${JSON.stringify({ delta: 'Perth ' })}\n\n`,
  `data: ${JSON.stringify({ delta: 'is clear.' })}\n\n`,
  `data: ${JSON.stringify({
    done: true,
    model: 'claude-opus-5-5',
    anchors: { places: [{ text: 'Perth', lat: PERTH.lat, lon: PERTH.lon }], times: [] },
    archive: true,
    held: false,
  })}\n\n`,
].join('');

async function openMap(page: Page, width: number, height: number, theme: 'light' | 'dark') {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((mode) => {
    localStorage.setItem('isobar-theme', mode);
    localStorage.setItem('isobar.place', 'perth');
    localStorage.setItem('isobar.speed', '8');
  }, theme);
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  await chartRoutes(page);
  await page.goto('/');
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true', { timeout: 60_000 });
  await page.waitForFunction(() => !!(document.querySelector('[data-map-ready]') as HTMLElement & { chartApi?: unknown })?.chartApi);
  await page.getByRole('radio', { name: 'Wind', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Forecast time' });
  await slider.focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '180');
  return errors;
}

function mockChat(page: Page, mode: 'stream' | 'quota' | 'rest') {
  let posts = 0;
  const sent: unknown[] = [];
  const handler = async (route: { request: () => Request; fulfill: (opts: object) => Promise<void> }) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    posts += 1;
    sent.push(request.postDataJSON());
    if (mode === 'rest' || (mode === 'quota' && posts > 3)) {
      await route.fulfill({
        json: { line: mode === 'rest' ? 'Chat is resting until tomorrow' : 'Sign in to keep going' },
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: REPLY });
  };
  return { sent, install: page.route('**/api/chat', handler) };
}

async function camera(page: Page): Promise<Camera> {
  return page.locator('[data-map-ready]').evaluate((element) => {
    const api = (element as HTMLElement & { chartApi: { camera: () => Camera } }).chartApi;
    return api.camera();
  });
}

test('desktop chat opens from the map, streams a reply, and a place link moves the view', async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const errors = await openMap(page, 1440, 900, 'light');
  const point = await tapPoint(page);
  const pointTitle = await page.locator('[data-point-panel] strong').innerText();
  const chat = mockChat(page, 'stream');
  await chat.install;
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  const panel = page.locator('[data-chat-panel]');
  await expect(panel).toHaveAttribute('data-chat-layout', 'side');
  await expect(page.locator('[data-point-panel]')).toHaveCount(0);
  await expect(page.locator('[data-fly-panel]')).toHaveCount(0);
  const chips = page.locator('[data-chat-chip]');
  await expect(chips).toHaveText(['Perth', 'Thu 03Z', 'Wind', pointTitle]);
  await expect(panel.getByText(/welcome|suggest/i)).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Message' }).fill('What is the wind at Perth?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('[data-chat-reply]')).toContainText('Perth is clear.');
  await expect(panel.locator('[data-chat-model]')).toHaveText('Opus');
  await expect(panel.locator('[data-archive]')).toBeVisible();
  const body = chat.sent[0] as { context: { place: { name: string }; lens: string; timeUtc: string; point: { lat: number; name: string | null } } };
  expect(body.context.place.name).toBe('Perth');
  expect(body.context.lens).toBe('wind');
  expect(body.context.timeUtc).toBe('2026-10-08T03:00:00.000Z');
  expect(body.context.point.lat).toBeCloseTo(point.lat, 4);
  expect(body.context.point.name).toBe(pointTitle);
  const before = await camera(page);
  await panel.locator('[data-chat-place="Perth"]').click();
  // A place link glides the view so the named place sits at the centre of the
  // map still exposed beside the chat panel, and never zooms the view out.
  // On the regional fixture the home view is already the widest allowed, so
  // the 12° look-closer request cannot tighten it; the pan into the exposed
  // half is the observable contract. Production data is global and zooms in.
  await expect.poll(async () => {
    const after = await camera(page);
    const perth = project(australiaLambert(), PERTH.lat, PERTH.lon);
    const map = await page.locator('[data-map-ready]').boundingBox();
    const side = await panel.boundingBox();
    if (!perth || !map || !side) return false;
    const x = map.x + ((perth.x - after.centerX) / after.halfWidth + 1) * map.width / 2;
    const y = map.y + (1 - (perth.y - after.centerY) / after.halfHeight) * map.height / 2;
    const exposedCentreX = map.x + Math.max(1, Math.min(map.width, side.x - map.x)) / 2;
    return Math.abs(x - exposedCentreX) < 24
      && Math.abs(y - (map.y + map.height / 2)) < 24
      && after.halfHeight <= before.halfHeight + 1e-9;
  }).toBe(true);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-light.png') });
  expect(errors).toEqual([]);
});

test('desktop chat in the dark', async ({ page }) => {
  const errors = await openMap(page, 1440, 900, 'dark');
  await tapPoint(page);
  const chat = mockChat(page, 'stream');
  await chat.install;
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await expect(page.locator('[data-chat-panel]')).toHaveAttribute('data-chat-layout', 'side');
  await page.getByRole('textbox', { name: 'Message' }).fill('Wind?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('[data-chat-reply]')).toContainText('Perth is clear.');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-dark.png') });
  expect(errors).toEqual([]);
});

test('phone chat is the one sheet, light and dark', async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const lightErrors = await openMap(page, 390, 844, 'light');
  await tapPoint(page);
  const chat = mockChat(page, 'stream');
  await chat.install;
  const button = page.getByRole('button', { name: 'Ask Isobar' });
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  await button.click();
  const panel = page.locator('[data-chat-panel]');
  await expect(panel).toHaveAttribute('data-chat-layout', 'sheet');
  await expect(page.locator('[data-point-panel], [data-fly-panel]')).toHaveCount(0);
  await expect(page.locator('[data-chat-chip]').nth(0)).toHaveText('Perth');
  await expect(page.locator('[data-chat-chip]').nth(2)).toHaveText('Wind');
  await page.getByRole('textbox', { name: 'Message' }).fill('Wind?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('[data-chat-reply]')).toContainText('Perth is clear.');
  await page.screenshot({ path: path.join(SHOTS, 'phone-light.png') });
  expect(lightErrors).toEqual([]);

  const darkErrors: string[] = [];
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (error) => darkErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') darkErrors.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem('isobar-theme', 'dark'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await expect(page.locator('[data-chat-panel]')).toHaveAttribute('data-chat-layout', 'sheet');
  await page.getByRole('textbox', { name: 'Message' }).fill('Wind?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('[data-chat-reply]')).toContainText('Perth is clear.');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({ path: path.join(SHOTS, 'phone-dark.png') });
  expect(darkErrors).toEqual([]);
});

test('three signed-out messages, then one line to sign in', async ({ page }) => {
  const errors = await openMap(page, 1440, 900, 'light');
  const chat = mockChat(page, 'quota');
  await chat.install;
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  const input = page.getByRole('textbox', { name: 'Message' });
  for (let i = 0; i < 3; i++) {
    await input.fill(`wind ${i}`);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('[data-chat-reply]')).toHaveCount(i + 1);
  }
  await input.fill('once more');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('[data-chat-line]')).toHaveText('Sign in to keep going');
  expect(errors).toEqual([]);
});

test('a spent budget is one resting line', async ({ page }) => {
  const errors = await openMap(page, 1440, 900, 'light');
  const chat = mockChat(page, 'rest');
  await chat.install;
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('wind');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('[data-chat-line]')).toHaveText('Chat is resting until tomorrow');
  await expect(page.locator('[data-chat-reply]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
