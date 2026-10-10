import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chartRoutes, tapPoint } from './map-fixture';

const SHOTS = path.join(os.tmpdir(), 'isobar-2e-chat-love');

const DIGEST = {
  since: '2026-10-07T12:00:00.000Z',
  until: '2026-10-08T12:00:00.000Z',
  threads: [{
    threadId: 't1',
    user: 'pilot@example.com',
    costUsd: 0.42,
    turns: [{
      question: 'Why is the wind backing over Perth?',
      context: { place: { name: 'Perth' } },
      replyId: 'm2',
      reply: 'A ridge is sitting to the west.',
      model: 'claude-opus-5-5',
      grade: 'interesting',
      gradeReason: 'the ridge',
      toolCalls: ['sample_field'],
      example: false,
    }],
    handoffs: [{ question: 'What did the model get wrong yesterday?', status: 'complete', outcome: 'The 00Z run was 2 hPa high.' }],
    missed: 'The reply never said how long the ridge holds.',
  }],
};

async function theme(page: Page, mode: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: mode });
  await page.addInitScript((value) => { localStorage.setItem('isobar-theme', value); }, mode);
}

test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }); });

test('admin digest lists a seeded day and can mark an example', async ({ page }) => {
  await page.route('**/api/chat/digest?view=1', (route) => route.fulfill({ json: DIGEST }));
  let posted = '';
  await page.route('**/api/admin/chat', async (route) => {
    posted = route.request().postData() ?? '';
    await route.fulfill({ status: 303, headers: { location: '/admin/chat/digest' } });
  });
  await page.setViewportSize({ width: 1100, height: 800 });
  await theme(page, 'light');
  await page.goto('/admin/chat/digest');
  const thread = page.locator('[data-digest-thread="t1"]');
  await expect(thread.locator('[data-digest-user]')).toHaveText('pilot@example.com');
  await expect(thread.locator('[data-digest-question]')).toHaveText('Why is the wind backing over Perth?');
  await expect(thread.locator('[data-digest-reply]')).toHaveText('A ridge is sitting to the west.');
  await expect(thread.locator('[data-digest-grade]')).toHaveText('interesting');
  await expect(thread.locator('[data-digest-tool]')).toHaveText('sample_field');
  await expect(thread.locator('[data-digest-cost]')).toHaveText('$0.42');
  await expect(thread.locator('[data-digest-outcome]')).toHaveText('complete · The 00Z run was 2 hPa high.');
  await expect(thread.locator('[data-digest-missed]')).toHaveText('The reply never said how long the ridge holds.');
  await page.screenshot({ path: path.join(SHOTS, 'digest-light.png'), fullPage: true });
  await theme(page, 'dark');
  await page.reload();
  await expect(thread.locator('[data-digest-question]')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'digest-dark.png'), fullPage: true });
  await page.locator('[data-digest-example="m2"]').click();
  await expect.poll(() => posted).toContain('action=example');
  expect(posted).toContain('messageId=m2');
});

test('privacy page states what is kept', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await theme(page, 'light');
  await page.goto('/privacy');
  await expect(page.locator('[data-privacy-row="what"]')).toContainText('Questions, replies, grades');
  await expect(page.locator('[data-privacy-row="why"]')).toContainText('Improve Isobar');
  await expect(page.locator('[data-privacy-row="where"]')).toContainText('Private database');
  await expect(page.locator('[data-privacy-row="kept"]')).toContainText('While the account exists');
  await expect(page.locator('[data-privacy-row="download"]')).toContainText('Ask from the account');
  await expect(page.locator('[data-privacy-row="delete"]')).toContainText('anonymises use');
  await page.screenshot({ path: path.join(SHOTS, 'privacy-light.png'), fullPage: true });
  await theme(page, 'dark');
  await page.reload();
  await expect(page.locator('[data-privacy-row="what"]')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'privacy-dark.png'), fullPage: true });
});

test('a lens switch and a point tap are posted, and the notice is on sign-in and chat', async ({ page }) => {
  const bodies: { events?: { kind: string }[] }[] = [];
  await page.route('**/api/chat', (route) => route.fulfill({ json: { ok: true } }));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await theme(page, 'light');
  await page.addInitScript(() => {
    localStorage.setItem('isobar.place', 'perth');
    localStorage.setItem('isobar.speed', '8');
  });
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  await chartRoutes(page);
  await page.route('**/api/usage', async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 204, body: '' });
  });
  await page.goto('/');
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(page.locator('[data-map-menu]')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('[data-account-sheet] [data-usage-notice]')).toContainText('Conversations and use are stored to improve Isobar');
  await expect(page.locator('[data-account-sheet] [data-usage-notice] a')).toHaveAttribute('href', '/privacy');
  await page.locator('[data-account-scrim]').click({ position: { x: 8, y: 8 } });
  await page.getByRole('radio', { name: 'Wind', exact: true }).click();
  await tapPoint(page);
  await page.getByRole('button', { name: 'Ask Isobar', exact: true }).click();
  // No boilerplate in the chat sheet (owner, 9 Oct); the notice lives in ☰ and the account sheet.
  await expect(page.locator('[data-chat-panel] [data-usage-notice]')).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, 'chat-notice-light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: path.join(SHOTS, 'chat-notice-dark.png') });
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => bodies.flatMap((body) => body.events?.map((event) => event.kind) ?? [])).toEqual(
    expect.arrayContaining(['lens', 'point']),
  );
  expect(errors).toEqual([]);
});
