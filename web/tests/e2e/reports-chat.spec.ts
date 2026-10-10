import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSlowMap } from './chat-slow.fixture';

const SHOTS = path.resolve(import.meta.dirname, '../../../build/qa/reports-chat');
const line = 'This question needs a detailed report.';
const stream = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;

async function fixture(page: Page, theme: 'light' | 'dark', signedIn = true) {
  await openSlowMap(page, 1280, 720, theme, signedIn);
  let sent = false, report = false, cancelled = false, calls = 0, fail = false;
  const message = (id: string, role: string, content: string, extra = {}) => ({
    id, role, content, status: 'complete', lane: 'fast', model: null, images: [],
    placeKey: 'place:perth', createdAt: '2026-10-08T03:00:00Z', ...extra,
  });
  await page.route('**/api/chat/thread', route => route.fulfill({ json: { id: 'thread', messages: sent ? [
    message('question', 'user', 'Compare the fronts for my trip.'),
    message('answer', 'assistant', line, { userMessageId: 'question', reportOffer: true, ...(report ? { reportId: 'report-run' } : {}) }),
    ...(report ? [message('report-run', 'assistant', '', { lane: 'slow', source: 'report', status: cancelled ? 'cancelled' : 'pending', answerId: 'answer', userMessageId: 'question' })] : []),
  ] : [] } }));
  await page.route('**/api/chat', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true } });
    sent = true;
    return route.fulfill({ contentType: 'text/event-stream', body: stream({ done: true, replace: line, reportOffer: true, messageId: 'answer', userMessageId: 'question' }) });
  });
  await page.route('**/api/chat/report', route => {
    calls += 1;
    expect(route.request().postDataJSON()).toEqual({ messageId: 'answer' });
    if (fail) return route.fulfill({ status: 409, json: { ok: false, line: 'Detailed reports need a paid plan.' } });
    report = true;
    return route.fulfill({ json: { ok: true, reportId: 'report-run', line: 'Report queued.' } });
  });
  await page.route('**/api/chat/archive', route => {
    expect(route.request().postDataJSON()).toEqual({ action: 'cancel', messageId: 'report-run' });
    cancelled = true;
    return route.fulfill({ json: { status: 'cancelled', messageId: 'report-run' } });
  });
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('Compare the fronts for my trip.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-chat-reply]')).toContainText(line);
  return { calls: () => calls, fail: () => { fail = true; }, recover: () => { fail = false; } };
}

for (const theme of ['light', 'dark'] as const) test(`one-tap report, cancel and viewport: ${theme}`, async ({ page }) => {
  const f = await fixture(page, theme);
  const button = page.getByRole('button', { name: 'Email me a detailed report', exact: true });
  await expect(button).toBeVisible(); await expect(page.locator('[data-dig-deeper]')).toHaveCount(0);
  expect(f.calls()).toBe(0);
  const helper = process.env.ISOBAR_VIEWPORT_HELPER;
  if (helper) {
    const { assertViewport } = await import(pathToFileURL(helper).href);
    mkdirSync(SHOTS, { recursive: true });
    for (const [name, viewport] of Object.entries({ laptop: { width: 1280, height: 720 }, phone: { width: 390, height: 844 }, landscape: { width: 844, height: 390 } })) {
      await page.setViewportSize(viewport);
      await expect(button).toBeInViewport();
      await assertViewport(page, { primary: [{ selector: '[data-chat-panel]', minWidth: 280, minHeight: 120 }], controls: [
        { selector: '[data-email-report]', minWidth: 100, minHeight: 36 }, { selector: '[aria-label="Close chat"]', minWidth: 40, minHeight: 40 },
      ], screenshotPath: path.join(SHOTS, `${name}-${theme}.png`) });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const sizes = [...document.querySelectorAll<HTMLElement>('[data-chat-panel] *')].map(el => [el, parseFloat(getComputedStyle(el).fontSize)] as const);
    for (const [el, size] of sizes) el.style.fontSize = `${size * 2}px`;
  });
  await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(SHOTS, `phone-large-text-${theme}.png`) });
  await button.click(); await expect(page.getByRole('button', { name: 'Cancel report', exact: true })).toBeVisible();
  expect(f.calls()).toBe(1);
  await page.getByRole('button', { name: 'Close chat' }).click();
  await page.getByRole('button', { name: 'Ask Isobar' }).click();
  await page.getByRole('button', { name: 'Cancel report', exact: true }).click();
  await expect(page.locator('[data-email-report]')).toHaveText('Report cancelled');
  await expect(page.locator('[data-email-report]')).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.locator('[data-chat-panel]')).toHaveCount(0);
});

test('a free limit leaves the report action retryable after upgrade', async ({ page }) => {
  const f = await fixture(page, 'light'); f.fail();
  await page.locator('[data-email-report]').click();
  await expect(page.getByText('Detailed reports need a paid plan.', { exact: true })).toBeVisible();
  f.recover(); await page.locator('[data-email-report]').click();
  await expect(page.locator('[data-email-report]')).toHaveText('Cancel report');
  expect(f.calls()).toBe(2);
});

test('signed-out chat never renders the email action, even with offer metadata', async ({ page }) => {
  const f = await fixture(page, 'light', false);
  await expect(page.locator('[data-email-report]')).toHaveCount(0); expect(f.calls()).toBe(0);
});
