import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSlowMap } from './chat-slow.fixture';
import { installTrainingFiles } from './training-files';

const SHOTS = path.resolve(import.meta.dirname, '../../../build/escalation-qa');
const CHECKING = 'Checking the archive for more (a few minutes)';
const SYDNEY = { text: 'Sydney', lat: -33.87, lon: 151.21 };
const eventStream = (events: Record<string, unknown>[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
const message = (id: string, role: string, content: string, second: number, extra: Record<string, unknown> = {}) => ({
  id, role, content, status: 'complete', lane: 'fast', model: role === 'assistant' ? 'claude-haiku-5-5' : null,
  createdAt: new Date(Date.parse('2026-10-08T03:00:00Z') - 100 + second).toISOString(), placeKey: 'place:perth', images: [], ...extra,
});

async function fixture(page: Page, { width = 1280, height = 720, theme = 'light' as 'light' | 'dark', automatic = false } = {}) {
  if (process.env.ISOBAR_E2E_FILES === '1') await installTrainingFiles(page.context());
  await openSlowMap(page, width, height, theme, true);
  let later = false;
  let sent = false, status: 'pending' | 'claimed' | 'complete' | 'cancelled' | null = null;
  const calls: { action: string; messageId: string }[] = [];
  const snapshot = () => ({ id: 'thread', messages: sent ? [
    message('user', 'user', 'Rain around Sydney?', 0),
    message('fast', 'assistant', 'Sydney rain is light.', 1, { userMessageId: 'user', anchors: { places: [SYDNEY], times: [] }, ...(automatic ? { archiveId: 'slow' } : {}) }),
    ...(status ? [message('slow', 'assistant', status === 'complete' ? 'Sydney has the wettest coastal samples; the earlier run was drier.' : '', 2,
      { lane: 'slow', status, answerId: 'fast', userMessageId: 'user', anchors: { places: [SYDNEY], times: [] } })] : []),
    ...(later ? [
      message('later-user', 'user', 'What about the next day?', 3),
      message('later-answer', 'assistant', 'Later weather evidence. '.repeat(100), 4, { userMessageId: 'later-user' }),
    ] : []),
  ] : [] });
  await page.route('**/api/chat/thread', (route) => route.fulfill({ json: snapshot() }));
  await page.route('**/api/chat/archive', (route) => {
    const input = route.request().postDataJSON(); calls.push(input);
    if (input.action === 'queue') { status = 'pending'; return route.fulfill({ json: { status: 'queued', messageId: 'slow', line: CHECKING } }); }
    if (status === 'claimed') return route.fulfill({ json: { status: 'claimed' } });
    status = 'cancelled'; return route.fulfill({ json: { status: 'cancelled', messageId: 'slow' } });
  });
  await page.route('**/api/chat', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true } });
    sent = true; if (automatic) status = 'pending';
    return route.fulfill({ contentType: 'text/event-stream', body: eventStream([
      { delta: 'Sydney rain is light.' },
      { done: true, messageId: 'fast', userMessageId: 'user', model: 'claude-haiku-5-5', anchors: { places: [SYDNEY], times: [] }, archive: automatic,
        ...(automatic ? { archiveId: 'slow', archiveLine: CHECKING } : {}) },
    ]) });
  });
  const initialCamera = await page.locator('[data-map-ready]').evaluate((element) => (element as HTMLElement & { chartApi: { camera: () => { centerX: number; centerY: number } } }).chartApi.camera());
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('Rain around Sydney?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('[data-chat-reply]').first()).toContainText('Sydney rain is light.');
  await expect(page.locator('[data-dig-deeper]').first()).toBeVisible();
  return { calls, initialCamera, addLater: () => { later = true; }, complete: () => { status = 'complete'; }, claim: () => { status = 'claimed'; } };
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  const helper = process.env.ISOBAR_VIEWPORT_HELPER;
  if (!helper) return;
  const { assertViewport } = await import(pathToFileURL(helper).href);
  await assertViewport(page, { primary: [{ selector: '[data-chat-panel]', minWidth: 280, minHeight: 120 }], controls: [
    { selector: '[aria-label="Close chat"]', minWidth: 40, minHeight: 40 },
    { selector: '[aria-label="Message"]', minWidth: 100, minHeight: 32 },
  ], screenshotPath: path.join(SHOTS, name) });
}

test('Dig deeper is undoable; cancellation never erases the fast answer, including after reload', async ({ page }) => {
  const f = await fixture(page);
  const button = page.locator('[data-dig-deeper]').first();
  await expect(button).toHaveText('Dig deeper'); await button.click();
  await expect(button).toHaveText('Cancel archive check');
  await expect(page.getByText(CHECKING, { exact: true })).toHaveCount(1);
  await button.click();
  await expect(button).toHaveText('Dig deeper');
  await expect(page.locator('[data-chat-reply]').first()).toContainText('Sydney rain is light.');
  await expect(page.getByText('Archive check cancelled', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close chat' }).click();
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await expect(button).toHaveText('Dig deeper');
  await expect(page.locator('[data-chat-reply]').first()).toContainText('Sydney rain is light.');
  expect(f.calls).toEqual([{ action: 'queue', messageId: 'fast' }, { action: 'cancel', messageId: 'slow' }]);
});

test('a claimed check names the result of pressing cancel and cannot be cancelled', async ({ page }) => {
  const f = await fixture(page, { automatic: true });
  f.claim();
  await page.locator('[data-dig-deeper]').first().click();
  await expect(page.locator('[data-dig-deeper]').first()).toHaveText('Archive check started');
  await expect(page.locator('[data-dig-deeper]').first()).toBeDisabled();
  await expect(page.locator('[data-chat-reply]').first()).toContainText('Sydney rain is light.');
});

test('closed sheet continues polling, notifies once, and opens the completed answer in its exchange', async ({ page }) => {
  const f = await fixture(page, { automatic: true });
  await expect(page.getByText(CHECKING, { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Close chat' }).click();
  f.complete(); await page.clock.runFor(15_100);
  await expect(page.locator('[data-archive-notice]')).toBeVisible();
  await page.locator('[data-archive-notice]').click();
  await expect(page.locator('[data-chat-reply]').filter({ hasText: 'wettest coastal samples' })).toBeVisible();
  await expect(page.locator('[data-chat-reply]').filter({ hasText: 'wettest coastal samples' }).locator('[data-archive]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close chat' }).click();
  await page.clock.runFor(30_000); await expect(page.locator('[data-archive-notice]')).toHaveCount(0);
});

test('answer anchors automatically move the map to the named off-screen place', async ({ page }) => {
  const f = await fixture(page);
  // The fixture opens over Perth. The completion anchor must invoke the same
  // navigation as a place link, without requiring the user to click that link.
  await page.clock.runFor(1_000);
  const first = await page.locator('[data-map-ready]').evaluate((element) => (element as HTMLElement & { chartApi: { camera: () => { centerX: number; centerY: number } } }).chartApi.camera());
  expect(Math.abs(first.centerX - f.initialCamera.centerX) + Math.abs(first.centerY - f.initialCamera.centerY)).toBeGreaterThan(0.001);
  await page.locator('[data-chat-place="Sydney"]').click(); await page.clock.runFor(1_000);
  const second = await page.locator('[data-map-ready]').evaluate((element) => (element as HTMLElement & { chartApi: { camera: () => { centerX: number; centerY: number } } }).chartApi.camera());
  expect(first.centerX).toBeCloseTo(second.centerX, 3); expect(first.centerY).toBeCloseTo(second.centerY, 3);
});

for (const [width, height, label] of [[1280, 720, 'laptop'], [390, 844, 'phone'], [844, 390, 'landscape']] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`archive controls fit ${label} ${theme}`, async ({ page }) => {
      const f = await fixture(page, { width, height, theme, automatic: true });
      await shot(page, `${label}-${theme}-pending.png`);
      f.complete(); await page.clock.runFor(15_100);
      await expect(page.locator('[data-chat-reply]').filter({ hasText: 'wettest coastal samples' })).toBeVisible();
      await shot(page, `${label}-${theme}-complete.png`);
      if (theme === 'light') {
        await page.locator('[data-chat-panel]').evaluate((panel) => {
          for (const node of panel.querySelectorAll<HTMLElement>('p, [data-chat-reply], input, button')) node.style.fontSize = `${parseFloat(getComputedStyle(node).fontSize) * 2}px`;
        });
        await shot(page, `${label}-${theme}-text200.png`);
      }
    });
  }
}


test('a laptop anchor already in the exposed map leaves the camera unchanged', async ({ page }) => {
  const f = await fixture(page, { automatic: true });
  await page.clock.runFor(1_000);
  const camera = () => page.locator('[data-map-ready]').evaluate((element) => (element as HTMLElement & { chartApi: { camera: () => { centerX: number; centerY: number } } }).chartApi.camera());
  const before = await camera();
  f.complete(); await page.clock.runFor(15_100);
  await expect(page.locator('[data-chat-reply]').filter({ hasText: 'wettest coastal samples' })).toBeVisible();
  const after = await camera();
  expect(after.centerX).toBeCloseTo(before.centerX, 5);
  expect(after.centerY).toBeCloseTo(before.centerY, 5);
});

test('a closed completion after the conversation gap opens the reply through Earlier', async ({ page }) => {
  const f = await fixture(page, { automatic: true });
  await page.getByRole('button', { name: 'Close chat' }).click();
  // Jump the conversation gap: runFor would replay five minutes of animation
  // frames on the live map and overrun the test budget; fastForward fires the
  // due poll timers once, which is all the gap needs.
  await page.clock.fastForward(5 * 60_000);
  f.addLater();
  f.complete(); await page.clock.runFor(15_100);
  await page.locator('[data-archive-notice]').click();
  await expect(page.getByRole('button', { name: 'Hide earlier' })).toBeVisible();
  await expect(page.locator('[data-chat-reply]').filter({ hasText: 'wettest coastal samples' })).toBeInViewport();
  await page.getByRole('button', { name: 'Hide earlier' }).click();
  await expect(page.locator('[data-chat-reply]')).toHaveCount(0);
});
