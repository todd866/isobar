import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { installWeatherFixture } from './weather-fixture';

async function open(page: Page, owner = true) {
  await installWeatherFixture(page);
  await page.route('**/api/auth/session', r => r.fulfill({ json: { user: { id: 'owner-fixture', email: 'owner@example.test' } } }));
  await page.route('**/api/account/data', r => r.fulfill({ status: 404, json: {} }));
  await page.route('**/api/feedback?access=1', r => r.fulfill({ status: owner ? 200 : 404, json: owner ? { owner: true } : {} }));
  await page.goto('/');
  await expect(page.locator('[data-api="1"]')).toBeVisible();
}
const clock = (page: Page) => page.locator('[data-api="1"]').evaluate(node => (node as HTMLElement & { chartApi: { playback: () => { minute: number; playing: boolean } } }).chartApi.playback());

test('owner capture precedes note, freezes clock, saves verbatim and restores playback', async ({ page }) => {
  let posted: { record: { note: string; state: { playhead: unknown }; files: string[] }; screenshot: string | null } | null = null;
  await page.route('**/api/feedback', async r => { posted = r.request().postDataJSON(); await r.fulfill({ status: 201, json: { id: 'mock' } }); });
  await open(page);
  await expect(page.locator('[data-feedback-stamp]')).toBeVisible();
  await page.keyboard.press('Control+Alt+Shift+KeyF');
  const note = page.getByRole('textbox', { name: 'Feedback note' });
  await expect(note).toBeVisible();
  const held = await clock(page);
  await note.fill('  map jumped — keep these spaces  ');
  await page.waitForTimeout(300);
  expect(await clock(page)).toEqual(held);
  await page.keyboard.press('Enter');
  await expect(note).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Feedback saved' })).toBeVisible();
  expect(posted!.record.note).toBe('  map jumped — keep these spaces  ');
  expect(posted!.record.state.playhead).toBeTruthy();
  expect(posted!.screenshot === null || Buffer.from(posted!.screenshot, 'base64').byteLength <= 400_000).toBeTruthy();
  expect((await clock(page)).playing).toBe(held.playing);
  await page.keyboard.press('Control+Alt+Meta+KeyF');
  await expect(note).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(note).toBeHidden();
});

test('non-owner sees no capture control or shortcut response', async ({ page }) => {
  await open(page, false);
  await expect(page.locator('[data-feedback-stamp]')).toHaveCount(0);
  await page.keyboard.press('Control+Alt+Shift+KeyF');
  await expect(page.getByRole('textbox', { name: 'Feedback note' })).toHaveCount(0);
});

for (const theme of ['light', 'dark']) for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`feedback viewport ${theme} ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.addInitScript(mode => localStorage.setItem('isobar-theme', mode), theme);
    await open(page);
    const stamp = page.locator('[data-feedback-stamp]');
    await expect(stamp).toBeVisible();
    if (size.width === 390) {
      await stamp.dispatchEvent('pointerdown', { pointerType: 'touch' });
      await page.waitForTimeout(300);
      await stamp.dispatchEvent('pointercancel', { pointerType: 'touch' });
      await page.waitForTimeout(550);
      await expect(page.getByRole('dialog', { name: 'Feedback', exact: true })).toHaveCount(0);
      await stamp.dispatchEvent('pointerdown', { pointerType: 'touch' });
      await page.waitForTimeout(850);
      await stamp.dispatchEvent('pointerup', { pointerType: 'touch' });
    } else await page.keyboard.press('Control+Alt+Shift+KeyF');
    const row = page.getByRole('dialog', { name: 'Feedback', exact: true });
    await expect(row).toBeVisible();
    const box = (await row.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    if (process.env.VIEWPORT_HELPER) {
      const { assertViewport } = await import(pathToFileURL(process.env.VIEWPORT_HELPER).href);
      await assertViewport(page, { controls: [{ selector: '[aria-label="Feedback note"]', minHeight: 40 }, { selector: '[aria-label="Discard feedback"]', minHeight: 40 }] });
    }
    mkdirSync('test-results/feedback', { recursive: true });
    await page.screenshot({ path: `test-results/feedback/${theme}-${size.width}.png` });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await expect(page.getByRole('button', { name: 'Discard feedback' })).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(row).toBeHidden();
  });
}
