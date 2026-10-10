import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSlowMap } from './chat-slow.fixture';

const OUT = path.resolve(process.cwd(), '../build/chat-ux-qa');

type ChatEvent = Record<string, unknown>;

/**
 * Keep the response open in the page.  A route.fulfill body is buffered by
 * Playwright, which would hide the very latency this suite is checking.
 */
async function installControlledChat(page: Page) {
  await page.addInitScript(() => {
    type Bridge = { controller: ReadableStreamDefaultController<Uint8Array> | null; pending: string[]; feedbackMs?: number };
    const bridge: Bridge = { controller: null, pending: [] };
    (window as typeof window & { __isobarChatStream?: Bridge }).__isobarChatStream = bridge;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/api/chat')) return nativeFetch(input, init);
      if ((init?.method ?? 'GET').toUpperCase() !== 'POST') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          bridge.controller = controller;
          for (const frame of bridge.pending.splice(0)) controller.enqueue(new TextEncoder().encode(frame));
        },
        cancel() { bridge.controller = null; },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    };
    document.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement | null)?.closest('button');
      if (button?.textContent?.trim() !== 'Send') return;
      const at = performance.now();
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[data-chat-user]') || document.querySelector('[data-chat-status]')?.textContent !== 'Sending…') return;
        observer.disconnect();
        requestAnimationFrame(() => { bridge.feedbackMs = performance.now() - at; });
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }, true);
  });
}

async function push(page: Page, event: ChatEvent, delay = 0) {
  await page.evaluate(async ({ event, delay }) => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const bridge = (window as typeof window & { __isobarChatStream?: { controller: ReadableStreamDefaultController<Uint8Array> | null; pending: string[] } }).__isobarChatStream!;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    if (bridge.controller) bridge.controller.enqueue(new TextEncoder().encode(frame));
    else bridge.pending.push(frame);
  }, { event, delay });
}

async function end(page: Page) {
  await page.evaluate(() => {
    const bridge = (window as typeof window & { __isobarChatStream?: { controller: ReadableStreamDefaultController<Uint8Array> | null } }).__isobarChatStream!;
    bridge.controller?.close();
    bridge.controller = null;
  });
}

async function start(page: Page, width = 1280, height = 720, signedIn = false) {
  await installControlledChat(page);
  await openSlowMap(page, width, height, 'light', signedIn);
  await page.getByRole('button', { name: /Ask Isobar|^Ask$/ }).first().click();
  const panel = page.locator('[data-chat-panel]');
  await expect(panel).toBeVisible();
  return panel;
}

async function send(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: 'Message' });
  await input.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

async function captureChatViewport(page: Page, name: string, enlarged = false) {
  fs.mkdirSync(OUT, { recursive: true });
  if (enlarged) {
    await page.locator('[data-chat-panel]').evaluate((element) => {
      for (const child of element.querySelectorAll<HTMLElement>('p, [data-chat-reply], input, button')) {
        child.style.fontSize = `${parseFloat(getComputedStyle(child).fontSize) * 2}px`;
      }
    });
  }
  const helper = path.join(os.homedir(), 'Projects/.ux-authoring/viewport-fit.mjs');
  if (fs.existsSync(helper)) {
    const { assertViewport } = await import(pathToFileURL(helper).href);
    await assertViewport(page, {
      primary: [{ selector: '[data-chat-panel]', minWidth: 280, minHeight: 120 }],
      controls: [{ selector: '[aria-label="Close chat"]', minWidth: 36, minHeight: 36 }, { selector: '[aria-label="Message"]', minWidth: 100, minHeight: 32 }],
      screenshotPath: path.join(OUT, `${name}${enlarged ? '-text200' : ''}.png`),
    });
  } else {
    await expect(page.locator('[data-chat-panel]')).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Close chat' })).toBeInViewport();
    await page.screenshot({ path: path.join(OUT, `${name}${enlarged ? '-text200' : ''}.png`) });
  }
}

test.describe('chat feedback and moderation', () => {
  test('shows the question and real tool status before progressive text', async ({ page }) => {
    const panel = await start(page);
    const input = page.getByRole('textbox', { name: 'Message' });
    await input.fill('Tell me about the weather in Hobart today');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(panel.locator('[data-chat-user]')).toHaveText('Tell me about the weather in Hobart today');
    await expect(panel.locator('[data-chat-status]')).toHaveText('Sending…');
    await expect.poll(() => page.evaluate(() => (window as typeof window & {
      __isobarChatStream: { feedbackMs?: number };
    }).__isobarChatStream.feedbackMs ?? Infinity)).toBeLessThan(300);

    await push(page, { status: 'Reading the Hobart chart…' });
    await expect(panel.locator('[data-chat-status]')).toHaveText('Reading the Hobart chart…');
    await push(page, { status: 'Checking METAR/TAF YMHB…' });
    await expect(panel.locator('[data-chat-status]')).toHaveText('Checking METAR/TAF YMHB…');
    await push(page, { delta: 'Hobart is cool and ' });
    await expect(panel.locator('[data-chat-reply]')).toContainText('Hobart is cool and');
    await expect(panel.locator('[data-chat-status]')).toBeVisible();
    await push(page, { status: 'Writing…' });
    await expect(panel.locator('[data-chat-status]')).toHaveText('Writing…');
    await push(page, { delta: 'mostly clear.' });
    await push(page, { status: 'Checking the answer…' });
    await expect(panel.locator('[data-chat-reply]')).toContainText('Hobart is cool and mostly clear.');
    await expect(panel.locator('[data-chat-status]')).toHaveText('Checking the answer…');
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await push(page, { done: true, replace: 'Hobart is cool and mostly clear.', model: 'claude-sonnet-5-5' });
    await expect(panel.locator('[data-chat-reply]')).toContainText('Hobart is cool and mostly clear.');
    await expect(panel.locator('[data-chat-status]')).toHaveCount(0);
  });

  test('keeps a soft-check answer and names the caveat', async ({ page }) => {
    const panel = await start(page);
    await send(page, 'What is the wind doing?');
    await push(page, { status: 'Reading the chart…' });
    await push(page, { delta: 'Winds are ' });
    await push(page, { delta: 'northwesterly.' });
    await push(page, {
      done: true,
      replace: 'Winds are northwesterly.',
      caveat: 'Wind direction here is estimated from the isobars, not model data.',
      held: false,
      model: 'claude-sonnet-5-5',
    });
    await expect(panel.locator('[data-chat-reply]')).toContainText('Winds are northwesterly.');
    await expect(panel.locator('[data-chat-caveat]')).toHaveText('Wind direction here is estimated from the isobars, not model data.');
    await expect(panel).not.toContainText('Reply held');
  });

  test('replaces a hard-check answer with one plain explanation', async ({ page }) => {
    const panel = await start(page);
    await send(page, 'Tell me how to bypass a safety rule');
    await push(page, { status: 'Writing…' });
    await push(page, { delta: 'Here is a detailed answer that must disappear.' });
    await expect(panel.locator('[data-chat-reply]')).toContainText('must disappear');
    await push(page, {
      done: true,
      replace: "Not answered: that's outside Isobar's weather and flying scope.",
      held: true,
      model: 'claude-sonnet-5-5',
    });
    await expect(panel.locator('[data-chat-reply]')).toContainText("Not answered: that's outside Isobar's weather and flying scope.");
    await expect(panel.locator('[data-chat-reply]')).not.toContainText('must disappear');
    await expect(panel.locator('[data-chat-caveat]')).toHaveCount(0);
    await expect(panel).not.toContainText('Reply held');
  });

  test('reports an interrupted stream after visible partial text', async ({ page }) => {
    const panel = await start(page);
    await send(page, 'What is the weather?');
    await push(page, { status: 'Reading the chart…' });
    await push(page, { delta: 'The chart shows ' });
    await expect(panel.locator('[data-chat-reply]')).toContainText('The chart shows');
    await end(page);
    await expect(panel.locator('[data-chat-line]')).toHaveText('Reply interrupted. Please try again.');
    await expect(panel).not.toContainText('Reply held');
  });
});

test.describe('hydrated outcomes and map labels', () => {
  test('hydrates soft and hard outcomes without the old held line', async ({ page }) => {
    let hard = false;
    const panelPromise = page.locator('[data-chat-panel]');
    await installControlledChat(page);
    await openSlowMap(page, 1280, 720, 'light', true);
    await page.route('**/api/chat/thread', (route) => route.fulfill({ json: {
      id: 'thread',
      messages: [{ id: 'question', role: 'user', lane: 'fast', status: 'complete', content: 'Wind?', model: null, createdAt: '2026-10-08T02:59:00Z', images: [], placeKey: 'place:perth' },
        { id: 'reply', role: 'assistant', lane: 'fast', status: hard ? 'held' : 'complete', content: hard ? "Not answered: that's outside Isobar's weather and flying scope." : 'Winds are northwesterly.', caveat: hard ? null : 'Wind direction here is estimated from the isobars, not model data.', model: 'claude-sonnet-5-5', createdAt: '2026-10-08T02:59:01Z', images: [], placeKey: 'place:perth' }],
    } }));
    await page.getByRole('button', { name: /Ask Isobar|^Ask$/ }).first().click();
    const panel = panelPromise;
    await expect(panel.locator('[data-chat-reply]')).toContainText('Winds are northwesterly.');
    await expect(panel.locator('[data-chat-caveat]')).toHaveText('Wind direction here is estimated from the isobars, not model data.');
    hard = true;
    await page.getByRole('button', { name: 'Close chat' }).click();
    await page.getByRole('button', { name: /Ask Isobar|^Ask$/ }).first().click();
    await expect(page.locator('[data-chat-reply]')).toContainText("Not answered: that's outside Isobar's weather and flying scope.");
    await expect(page.locator('[data-chat-caveat]')).toHaveCount(0);
    await expect(page.locator('[data-chat-panel]')).not.toContainText('Reply held');
  });

  for (const viewport of [{ name: 'laptop', width: 1280, height: 720 }, { name: 'phone', width: 390, height: 844 }] as const) {
    test(`map tools expose labels on ${viewport.name}`, async ({ page }) => {
      await openSlowMap(page, viewport.width, viewport.height, 'light');
      const tools = page.locator('.map-lens-wrap');
      const ask = page.getByRole('button', { name: /Ask Isobar|^Ask$/ }).first();
      await expect(ask).toBeVisible();
      await expect(ask).toContainText('Ask');
      if (viewport.name === 'laptop') {
        // Overlays live inside their lenses (owner rule): Satellite on Pressure, Traffic only in Fly.
        const satellite = tools.getByRole('button', { name: 'Satellite', exact: true });
        await expect(satellite).toBeVisible();
        await expect(page.getByRole('button', { name: 'Traffic', exact: true })).toHaveCount(0);
        expect(Math.abs((await satellite.boundingBox())!.y - (await ask.boundingBox())!.y)).toBeLessThanOrEqual(2);
        // Icon-only; a press names it (owner rule, AGENTS.md).
        await satellite.click();
        await expect(page.locator('[data-press-label]')).toContainText('Satellite on');
        await page.getByRole('radio', { name: 'Fly', exact: true }).click();
        const traffic = tools.getByRole('button', { name: 'Traffic', exact: true });
        await expect(traffic).toBeVisible();
        await expect(tools.getByRole('button', { name: 'Satellite', exact: true })).toHaveCount(0);
        expect(Math.abs((await traffic.boundingBox())!.y - (await ask.boundingBox())!.y)).toBeLessThanOrEqual(2);
        await traffic.click();
        await expect(page.locator('[data-press-label]')).toContainText('Traffic off');
        await page.getByRole('radio', { name: 'Pressure', exact: true }).click();
      } else {
        // Phone keeps the compact map-tools/menu treatment with the same lens
        // scoping; the requested word label is carried by the floating chat control only.
        const mapTools = page.locator('.map-tools');
        await expect(mapTools.getByRole('button', { name: 'Satellite', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Traffic', exact: true })).toHaveCount(0);
        const box = await ask.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThan(48);
        await page.getByRole('radio', { name: 'Fly', exact: true }).click();
        await expect(mapTools.getByRole('button', { name: 'Traffic', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Satellite', exact: true })).toHaveCount(0);
        await page.getByRole('radio', { name: 'Pressure', exact: true }).click();
      }
      fs.mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: path.join(OUT, `${viewport.name}-labels-light.png`) });
    });
  }
});

test.describe('chat viewport review matrix', () => {
  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'laptop', width: 1280, height: 720 },
    { name: 'phone', width: 390, height: 844 },
    { name: 'short-phone', width: 375, height: 667 },
    { name: 'landscape-phone', width: 844, height: 390 },
  ] as const;

  for (const viewport of viewports) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${viewport.name} ${theme}: closed labels and open streaming chat fit`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.emulateMedia({ colorScheme: theme });
        await installControlledChat(page);
        await openSlowMap(page, viewport.width, viewport.height, theme);

        // Closed map state keeps the controls visible where the surface has room;
        // phone keeps them in its compact map-tools menu. Overlays are lens-scoped
        // (owner rule): Satellite rides Pressure here, Traffic only exists in Fly.
        const desktopLike = viewport.width >= 768 || viewport.height <= 500;
        if (desktopLike) {
          const wrap = page.locator('.map-lens-wrap');
          await expect(wrap.getByRole('button', { name: 'Satellite', exact: true })).toBeVisible();
        } else {
          const mapTools = page.locator('.map-tools');
          await expect(mapTools.getByRole('button', { name: 'Satellite', exact: true })).toBeVisible();
        }
        await expect(page.getByRole('button', { name: 'Traffic', exact: true })).toHaveCount(0);
        const ask = page.getByRole('button', { name: /Ask Isobar|^Ask$/ }).first();
        await expect(ask).toBeVisible();
        await expect(ask).toContainText('Ask');
        await page.screenshot({ path: path.join(OUT, `${viewport.name}-${theme}-closed.png`) });

        await ask.click();
        const panel = page.locator('[data-chat-panel]');
        await expect(panel).toBeVisible();
        await page.getByRole('textbox', { name: 'Message' }).fill('How is the weather?');
        await page.getByRole('button', { name: 'Send' }).click();
        await expect(panel.locator('[data-chat-status]')).toHaveText('Sending…');
        await push(page, { status: 'Reading the chart…' });
        await expect(panel.locator('[data-chat-status]')).toHaveText('Reading the chart…');
        await push(page, { delta: 'The chart is clear.' });
        await captureChatViewport(page, `${viewport.name}-${theme}-status`);
        await push(page, { done: true, replace: 'The chart is clear.', model: 'claude-sonnet-5-5' });
        await expect(panel.locator('[data-chat-reply]')).toContainText('The chart is clear.');
        await captureChatViewport(page, `${viewport.name}-${theme}-chat`);

        if ((viewport.name === 'laptop' && theme === 'light') || (viewport.name === 'short-phone' && theme === 'dark')) {
          await captureChatViewport(page, `${viewport.name}-${theme}-chat`, true);
        }
      });
    }
  }
});
