import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { choosePlace } from './place-field';
import { openSlowMap } from './chat-slow.fixture';

const OUT = path.resolve(process.cwd(), '../build/chat-topic-qa');

type Row = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  placeKey: string | null;
  status?: 'complete' | 'pending';
};

function row(id: string, role: Row['role'], content: string, createdAt: string, placeKey: string | null): Row {
  return { id, role, content, createdAt, placeKey, status: 'complete' };
}

function thread(messages: Row[]) {
  return { id: 'topic-fixture', messages: messages.map((message) => ({ lane: 'fast', model: null, images: [], ...message })) };
}

async function installThread(page: Page, messages: Row[]) {
  let calls = 0;
  await page.route('**/api/chat/thread', async (route) => {
    calls += 1;
    await route.fulfill({ json: thread(messages) });
  });
  return () => calls;
}

async function installReply(page: Page, text = 'Fixture reply.') {
  await page.route('**/api/chat', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true } });
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ delta: text })}\n\ndata: ${JSON.stringify({ done: true, model: 'fixture' })}\n\n` });
  });
}

async function openChat(page: Page) {
  await page.getByRole('button', { name: /Ask Isobar|^Ask$/ }).first().click();
  const panel = page.locator('[data-chat-panel]');
  await expect(panel).toBeVisible();
  return panel;
}

async function viewportCapture(page: Page, name: string, enlarged = false) {
  fs.mkdirSync(OUT, { recursive: true });
  if (enlarged) {
    await page.locator('[data-chat-panel]').evaluate((element) => {
      for (const child of element.querySelectorAll<HTMLElement>('p, [data-chat-reply], input, button')) {
        child.style.fontSize = `${parseFloat(getComputedStyle(child).fontSize) * 2}px`;
      }
    });
  }
  const helper = path.join(os.homedir(), 'Projects/.ux-authoring/viewport-fit.mjs');
  const screenshotPath = path.join(OUT, `${name}${enlarged ? '-text200' : ''}.png`);
  if (fs.existsSync(helper)) {
    const { assertViewport } = await import(pathToFileURL(helper).href);
    await assertViewport(page, {
      primary: [{ selector: '[data-chat-panel]', minWidth: 280, minHeight: 120 }],
      controls: [{ selector: '[aria-label="Close chat"]', minWidth: 36, minHeight: 36 }, { selector: '[aria-label="Message"]', minWidth: 100, minHeight: 32 },
        { selector: '[data-chat-panel] button[aria-expanded]', minWidth: 44, minHeight: 44 }],
      screenshotPath,
    });
  } else {
    await expect(page.locator('[data-chat-panel]')).toBeInViewport();
    await page.screenshot({ path: screenshotPath });
  }
}

const PERTH_LOG = [
  row('p-q', 'user', 'Why is the Perth trough deepening?', '2026-10-08T02:58:00.000Z', 'place:perth'),
  row('p-a', 'assistant', 'Perth answer from the earlier conversation.', '2026-10-08T02:58:01.000Z', 'place:perth'),
];

test.describe('chat conversation topics', () => {
  test('a Perth thread is empty for Kelowna, Earlier reveals it, and reopening resets it', async ({ page }) => {
    await openSlowMap(page, 1280, 720, 'light', true);
    // Hold the clock inside the 5-minute window after the fixture rows (02:58)
    // so the Perth conversation is still current when the chat opens. A time
    // before the rows would make them "future" and break the conversation.
    await page.clock.setFixedTime(new Date('2026-10-08T02:59:00Z'));
    await installThread(page, PERTH_LOG);
    await installReply(page);
    const panel = await openChat(page);
    await expect(panel).toContainText('Perth answer from the earlier conversation.');
    await panel.getByRole('button', { name: 'Close chat' }).click();
    await choosePlace(page, 'Kelowna', 'kelowna');
    const kelowna = await openChat(page);
    await expect(kelowna).toHaveAttribute('data-chat-empty', 'true');
    await expect(kelowna).not.toContainText('Perth answer from the earlier conversation.');
    let earlier = kelowna.getByRole('button', { name: 'Earlier', exact: true });
    await expect(earlier).toHaveAttribute('aria-expanded', 'false');
    await earlier.click();
    earlier = kelowna.getByRole('button', { name: 'Hide earlier', exact: true });
    await expect(earlier).toBeVisible();
    await expect(earlier).toHaveAttribute('aria-expanded', 'true');
    await expect(kelowna).toContainText('Perth answer from the earlier conversation.');
    await earlier.click();
    earlier = kelowna.getByRole('button', { name: 'Earlier', exact: true });
    await expect(earlier).toHaveAttribute('aria-expanded', 'false');
    await expect(kelowna).not.toContainText('Perth answer from the earlier conversation.');
    await kelowna.getByRole('button', { name: 'Close chat' }).click();
    const reopened = await openChat(page);
    await expect(reopened).not.toContainText('Perth answer from the earlier conversation.');
    await reopened.getByRole('textbox', { name: 'Message' }).fill('Why does the Okanagan forecast look like this?');
    await reopened.getByRole('button', { name: 'Send' }).click();
    await expect(reopened).toContainText('Fixture reply.');
    await expect(reopened).not.toContainText('Perth answer from the earlier conversation.');
  });

  test('same place continues until exactly 5 minutes after its last message', async ({ page }) => {
    await openSlowMap(page, 1280, 720, 'light', true);
    await page.clock.setFixedTime(new Date('2026-10-08T03:00:00Z'));
    await installReply(page);
    await installThread(page, [
      row('q-under', 'user', 'Recent question inside the window', '2026-10-08T02:55:30.000Z', 'place:perth'),
      row('a-under', 'assistant', 'Recent answer inside the window', '2026-10-08T02:56:01.000Z', 'place:perth'),
    ]);
    const panel = await openChat(page);
    await expect(panel).toContainText('Recent answer inside the window');
    await expect(panel).toContainText('Recent question inside the window');
    await expect(panel.getByRole('button', { name: 'Earlier', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Close chat' }).click();
    await page.clock.setFixedTime(new Date('2026-10-08T03:01:01Z'));
    await openChat(page);
    await expect(panel.locator('[data-chat-user], [data-chat-reply]')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Earlier', exact: true })).toBeVisible();
  });

  test('signed-out entries stay local, follow place and gap rules, and never fetch a thread', async ({ page }) => {
    await openSlowMap(page, 1280, 720, 'light', false);
    const threadCalls = await installThread(page, []);
    await installReply(page, 'Local Perth reply.');
    const panel = await openChat(page);
    await panel.getByRole('textbox', { name: 'Message' }).fill('Local Perth question');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(panel).toContainText('Local Perth reply.');
    await panel.getByRole('button', { name: 'Close chat' }).click();
    await choosePlace(page, 'Kelowna', 'kelowna');
    const kelowna = await openChat(page);
    await expect(kelowna).toHaveAttribute('data-chat-empty', 'true');
    await expect(kelowna).not.toContainText('Local Perth question');
    let earlier = kelowna.getByRole('button', { name: 'Earlier', exact: true });
    await earlier.click();
    earlier = kelowna.getByRole('button', { name: 'Hide earlier', exact: true });
    await expect(earlier).toHaveAttribute('aria-expanded', 'true');
    await expect(kelowna).toContainText('Local Perth question');
    await earlier.click();
    await expect(kelowna.getByRole('button', { name: 'Earlier', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await kelowna.getByRole('button', { name: 'Close chat' }).click();
    await choosePlace(page, 'Perth', 'perth');
    const perth = await openChat(page);
    await expect(perth).toContainText('Local Perth question');
    await perth.getByRole('button', { name: 'Close chat' }).click();
    await page.clock.setSystemTime(new Date('2026-10-08T03:31:00.000Z'));
    const stale = await openChat(page);
    await expect(stale).not.toContainText('Local Perth question');
    const staleEarlier = stale.getByRole('button', { name: 'Earlier', exact: true });
    await staleEarlier.click();
    await expect(stale).toContainText('Local Perth question');
    expect(threadCalls()).toBe(0);
  });

  for (const viewport of [{ name: 'laptop', width: 1280, height: 720 }, { name: 'phone', width: 390, height: 844 }, { name: 'short-phone', width: 375, height: 667 }, { name: 'landscape', width: 844, height: 390 }] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`topic sheet fits ${viewport.name} ${theme}`, async ({ page }) => {
        await openSlowMap(page, viewport.width, viewport.height, theme, true);
        await installThread(page, PERTH_LOG);
        await installReply(page);
        await choosePlace(page, 'Kelowna', 'kelowna');
        const panel = await openChat(page);
        await expect(panel).not.toContainText('Perth answer from the earlier conversation.');
        const earlier = panel.getByRole('button', { name: 'Earlier', exact: true });
        await expect(earlier).toBeVisible();
        await expect(earlier).toHaveAttribute('aria-expanded', 'false');
        await viewportCapture(page, `${viewport.name}-${theme}`);
        await earlier.click();
        await expect(panel).toContainText('Perth answer from the earlier conversation.');
        await expect(panel.locator('button[aria-expanded="true"]')).toBeVisible();
        await viewportCapture(page, `${viewport.name}-${theme}-earlier`);
        await viewportCapture(page, `${viewport.name}-${theme}-earlier`, true);
      });
    }
  }
});
