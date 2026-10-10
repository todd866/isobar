import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { openSlowMap } from './chat-slow.fixture';

const SHOTS = path.resolve(import.meta.dirname, '../../../build/slow-lane-qa');
const row = (id: string, role: string, lane: string, status: string, content: string, second: number) => ({
  id, role, lane, status, content, model: role === 'assistant' && status === 'complete' ? 'claude-opus-5-5' : null,
  createdAt: `2026-10-08T02:59:0${second}Z`, images: [], placeKey: 'place:perth',
});
const snapshot = (complete = false) => ({ id: 'thread', messages: [
  row('question', 'user', 'fast', 'complete', 'What changed west of Perth?', 0),
  row('archive', 'assistant', 'slow', complete ? 'complete' : 'pending', complete ? 'The low deepened west of Perth. Run 20261008T00Z, valid Thu 06Z.' : '', 1),
  row('fast', 'assistant', 'fast', 'complete', 'The chart shows the approaching low.', 2),
] });
async function available(page: Page) {
  await page.route('**/api/chat', (route) => route.fulfill({ json: { ok: true } }));
}
async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const helper = path.join(os.homedir(), 'Projects/.ux-authoring/viewport-fit.mjs');
  if (fs.existsSync(helper)) {
    const { assertViewport } = await import(pathToFileURL(helper).href);
    await assertViewport(page, { primary: [{ selector: '[data-chat-panel]', minWidth: 280, minHeight: 140 }],
      controls: [{ selector: '[aria-label="Close chat"]', minWidth: 40, minHeight: 40 }, { selector: '[aria-label="Message"]', minWidth: 100, minHeight: 32 }],
      screenshotPath: path.join(SHOTS, name) });
  } else {
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Close chat' })).toBeInViewport();
    await page.screenshot({ path: path.join(SHOTS, name) });
  }
}

test('hydrates a pending thread, polls at 15s, replaces once and then stops', async ({ page }) => {
  await openSlowMap(page, 1280, 720, 'light', true); await available(page);
  let polls = 0;
  await page.route('**/api/chat/thread', (route) => route.fulfill({ json: snapshot(++polls > 1) }));
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await expect(page.locator('[data-archive]')).toHaveCount(1);
  await expect(page.getByText('What changed west of Perth?', { exact: true })).toHaveCount(1);
  await page.clock.runFor(14_000); expect(polls).toBe(1);
  await page.clock.runFor(1_100);
  await expect(page.locator('[data-chat-reply]').filter({ hasText: 'The low deepened' })).toHaveCount(1);
  await expect(page.locator('[data-chat-reply]').filter({ hasText: 'The low deepened' }).locator('[data-archive]')).toHaveCount(1);
  await expect(page.locator('[data-chat-reply]').filter({ hasText: 'The chart shows' }).locator('[data-archive]')).toHaveCount(0);
  await page.clock.runFor(30_000); expect(polls).toBe(2);
  await shot(page, 'slow-laptop-light.png');
});

test('streamed hand-off reconciles stable IDs without duplicate questions or glyphs', async ({ page }) => {
  await openSlowMap(page, 1280, 720, 'dark', true);
  let sent = false, complete = false;
  await page.route('**/api/chat/thread', (route) => route.fulfill({ json: sent ? snapshot(complete) : { id: 'thread', messages: [] } }));
  await page.route('**/api/chat', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true } });
    sent = true;
    return route.fulfill({ contentType: 'text/event-stream', body: [
      { delta: 'The chart shows the approaching low.' },
      { done: true, model: 'claude-opus-5-5', archive: true, archiveId: 'archive', messageId: 'fast', userMessageId: 'question' },
    ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join('') });
  });
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('What changed west of Perth?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('[data-archive]')).toHaveCount(1);
  complete = true; await page.clock.runFor(15_100);
  await expect(page.locator('[data-chat-reply]')).toHaveCount(2);
  await expect(page.getByText('What changed west of Perth?', { exact: true })).toHaveCount(1);
  await expect(page.locator('[data-archive]')).toHaveCount(1);
  await shot(page, 'slow-laptop-dark.png');
});

test('signed-out never polls even when a mocked hand-off is returned', async ({ page }) => {
  await openSlowMap(page, 390, 844, 'dark', false); let calls = 0;
  await available(page);
  await page.route('**/api/chat/thread', (route) => { calls++; return route.fulfill({ status: 401 }); });
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await page.clock.runFor(45_000); expect(calls).toBe(0);
});

test('keeps pending state through offline polling and rehydrates on reopen', async ({ page }) => {
  await openSlowMap(page, 390, 844, 'light', true); await available(page);
  let polls = 0;
  await page.route('**/api/chat/thread', (route) => ++polls === 2 ? route.abort() : route.fulfill({ json: snapshot(polls > 2) }));
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await expect(page.locator('[data-archive]')).toHaveCount(1);
  await page.clock.runFor(15_100); await expect(page.locator('[data-archive]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close chat' }).click();
  await page.clock.runFor(30_000); expect(polls).toBeGreaterThanOrEqual(3);
  await expect(page.locator('[data-archive-notice]')).toBeVisible();
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await expect(page.getByText(/The low deepened/)).toBeVisible();
  await shot(page, 'slow-phone-light.png');
});

test('late private responses cannot reappear after sign out', async ({ page }) => {
  await openSlowMap(page, 1280, 720, 'light', true); await available(page);
  let release!: () => void, requested = false, calls = 0;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/chat/thread', async (route) => {
    calls++; requested = true; await delayed;
    await route.fulfill({ json: snapshot(true) }).catch(() => {});
  });
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await expect.poll(() => requested).toBe(true);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('[data-map-menu] [data-account-button="in"]').click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  release(); await page.clock.runFor(30_000);
  await expect(page.getByText(/The low deepened/)).toHaveCount(0);
  expect(calls).toBe(1);
});

for (const [width, height, name] of [[390, 844, 'phone'], [844, 390, 'landscape']] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`archive answer fits ${name} ${theme}, including enlarged text`, async ({ page }) => {
      await openSlowMap(page, width, height, theme, true); await available(page);
      await page.route('**/api/chat/thread', (route) => route.fulfill({ json: snapshot(true) }));
      await page.getByRole('button', { name: 'Ask Isobar' }).click();
      await expect(page.getByText(/The low deepened/)).toBeVisible();
      await shot(page, `slow-${name}-${theme}.png`);
      await page.locator('[data-chat-panel]').evaluate((element) => {
        for (const child of element.querySelectorAll<HTMLElement>('p, [data-chat-reply], input, button')) {
          child.style.fontSize = `${parseFloat(getComputedStyle(child).fontSize) * 2}px`;
        }
      });
      await shot(page, `slow-${name}-${theme}-text200.png`);
    });
  }
}
