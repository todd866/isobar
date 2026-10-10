import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Accounts, end to end, against the configured database. Mail goes to the
 * in-process test mailbox (AUTH_TEST_MAILBOX=1, never on Vercel). Run with the
 * auth env loaded, e.g.
 *   ~/.local/state/isobar-auth/bin/with-env env AUTH_TEST_MAILBOX=1 npx playwright test tests/e2e/account.spec.ts
 * Every account made here is deleted at the end.
 */

const enabled = !!process.env.DATABASE_URL && process.env.AUTH_TEST_MAILBOX === '1';
test.skip(!enabled, 'needs DATABASE_URL and AUTH_TEST_MAILBOX=1');
test.describe.configure({ mode: 'serial' });
// Auth.js builds its URLs from the server's own host name (localhost under `next start`);
// a host-only session cookie set on 127.0.0.1 would not come back on localhost.
test.use({ baseURL: 'http://localhost:4173' });

const SHOTS = process.env.ISOBAR_AUTH_SHOTS ?? path.join(os.homedir(), '.local/state/isobar-auth/shots');
let email = '';
const freshEmail = () => { email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@isobar.test`; };
test.beforeEach(freshEmail);
const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

const memory = (reviews: number, at: string) => ({
  stabilityDays: 3, nextDueAt: at, lastReview: at, lastQuality: 4, totalReviews: reviews, correctCount: reviews,
  status: 'learning', consecutiveCorrectFast: 0, masteredAt: null, avgResponseTimeMs: 4000, retrievalStrength: 0.9,
  recentFailCount: 0, recentFailWindowStart: null, lastFailedAt: null, leechSuppressionCount: 0,
});

async function context(browser: Browser, viewport = { width: 1280, height: 860 }): Promise<BrowserContext> {
  return browser.newContext({ viewport, extraHTTPHeaders: { 'x-forwarded-for': randomIp() } });
}

async function seedGuest(page: Page, card: string, e6bSkill: string) {
  await page.goto('/download');
  const at = new Date().toISOString();
  await page.evaluate(([card, skill, value, day]) => {
    localStorage.setItem('isobar.training.v1', JSON.stringify({ version: 1, cards: { [card]: value }, streak: { count: 1, lastDay: day } }));
    localStorage.setItem('isobar.e6b.record', JSON.stringify({ version: 1, memories: {}, stages: { [skill]: 'solo' }, bests: { [skill]: 30_000 }, daily: null, streak: { count: 0, lastDay: null } }));
  }, [card, e6bSkill, memory(2, at), at.slice(0, 10)] as const);
}

async function mail(page: Page) {
  let found: { code: string; link: string } | null = null;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/auth-test/mailbox?email=${encodeURIComponent(email)}`);
    found = response.ok() ? await response.json() : null;
    return !!found;
  }, { timeout: 10_000 }).toBe(true);
  return found! as { code: string; link: string };
}

async function openSheet(page: Page) {
  // The map has no rail or tab bar. Its account trigger lives in the map Menu;
  // training, E6-B, and account pages retain their own direct trigger.
  const menuButton = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menuButton.isVisible().catch(() => false) && await menuButton.getAttribute('aria-expanded') !== 'true') {
    await menuButton.click();
    await expect(page.locator('[data-map-menu]')).toBeVisible();
  }
  const button = page.locator('[data-account-button]:visible');
  await button.click();
  await expect(page.locator('[data-account-sheet]')).toBeVisible();
}

async function requestCode(page: Page) {
  await openSheet(page);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByLabel('8-digit code')).toBeVisible();
}

async function serverDocs(page: Page) {
  const response = await page.request.get('/api/account/data');
  return response.ok() ? (await response.json()).docs : null;
}

async function waitSignedIn(page: Page) {
  await expect(page.locator('[data-account-button="in"]')).not.toHaveCount(0, { timeout: 15_000 });
}

test('sign in with the code, claim guest progress, sync to a second device, sign out, delete', async ({ browser }) => {
  const a = await context(browser);
  const b = await context(browser);
  try {
    // Device A: a guest with progress and a dark theme.
    const pa = await a.newPage();
    await seedGuest(pa, 'met:a', 'tsd');
    await pa.getByRole('button', { name: 'Dark' }).click();

    // A wrong code is refused and the sheet says so.
    await pa.goto('/train');
    await requestCode(pa);
    const sent = await mail(pa);
    expect(sent.code).toMatch(/^\d{8}$/);
    await pa.getByLabel('8-digit code').fill(sent.code === '00000000' ? '11111111' : '00000000');
    await pa.locator('[data-account-sheet]').getByRole('button', { name: 'Sign in' }).click();
    await expect(pa.locator('[data-account-sheet]').getByRole('alert')).toHaveText('Wrong or expired code');
    expect(new URL(pa.url()).pathname).toBe('/train');

    // The right code signs in and returns to the page.
    await pa.getByLabel('8-digit code').fill(`${sent.code.slice(0, 4)} ${sent.code.slice(4)}`);
    await pa.locator('[data-account-sheet]').getByRole('button', { name: 'Sign in' }).click();
    await waitSignedIn(pa);
    expect(new URL(pa.url()).pathname).toBe('/train');
    expect(new URL(pa.url()).search).toBe('');

    // The guest's progress and theme are now the account's.
    await expect.poll(async () => Object.keys((await serverDocs(pa))?.training?.data.cards ?? {}), { timeout: 15_000 }).toEqual(['met:a']);
    const first = await serverDocs(pa);
    expect(first.e6b.data.stages).toEqual({ tsd: 'solo' });
    expect(first.settings.data.values.theme).toBe('dark');

    // Device B: a different guest, signed in through the emailed link.
    const pb = await b.newPage();
    await seedGuest(pb, 'met:b', 'fuel');
    await pb.goto('/e6b');
    await requestCode(pb);
    const link = new URL((await mail(pb)).link);
    expect(link.pathname).toBe('/e6b');
    // The server's own callback URL, opened directly, does not sign in either:
    // it lands on the page with the code filled in.
    const { code: direct } = await mail(pb);
    await pb.goto(`/api/auth/callback/email?${new URLSearchParams({ token: direct, email: link.searchParams.get('signin_email') ?? '', callbackUrl: '/e6b' })}`);
    expect(await pb.evaluate(() => fetch('/api/auth/session').then((r) => r.json()).then((s) => !!s?.user))).toBe(false);
    // A cross-site post of the code is refused.
    const forged = await pb.request.post('/api/auth/verify', { headers: { origin: 'https://evil.example' }, form: { code: direct, email: 'x@example.com', callbackUrl: '/' } });
    expect(forged.status()).toBe(403);
    await pb.goto(link.pathname + link.search);
    // A link never signs in by itself (login CSRF): it fills the code and waits for a tap.
    await pb.waitForTimeout(1500);
    expect(await pb.evaluate(() => fetch('/api/auth/session').then((r) => r.json()).then((s) => !!s?.user))).toBe(false);
    await pb.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'Sign in', exact: true }).click();
    await waitSignedIn(pb);
    expect(new URL(pb.url()).pathname).toBe('/e6b');

    // Both guests' progress, on the server and on device B; B took A's dark theme.
    await expect.poll(async () => Object.keys((await serverDocs(pb))?.training?.data.cards ?? {}).sort(), { timeout: 15_000 }).toEqual(['met:a', 'met:b']);
    expect((await serverDocs(pb)).e6b.data.stages).toEqual({ tsd: 'solo', fuel: 'solo' });
    await expect.poll(() => pb.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('isobar.training.v1')!).cards).sort())).toEqual(['met:a', 'met:b']);
    await expect(pb.locator('html')).toHaveClass(/dark/);

    // A setting changed on B reaches A on its next load.
    await pb.goto('/download');
    await waitSignedIn(pb);
    await pb.getByRole('button', { name: 'Light' }).click();
    await expect.poll(async () => (await serverDocs(pb))?.settings?.data.values.theme, { timeout: 15_000 }).toBe('light');
    await pa.goto('/download');
    await waitSignedIn(pa);
    await expect(pa.locator('html')).not.toHaveClass(/dark/, { timeout: 15_000 });
    await expect.poll(() => pa.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('isobar.training.v1')!).cards).sort())).toEqual(['met:a', 'met:b']);

    // Sign out on B: the account is gone from B, the progress stays on the device.
    await openSheet(pb);
    await expect(pb.locator('[data-account-email]')).toHaveText(email);
    await pb.getByRole('button', { name: 'Sign out' }).click();
    await expect(pb.locator('[data-account-button="out"]:visible')).toBeVisible();
    expect((await pb.request.get('/api/account/data')).status()).toBe(401);
    expect(await pb.evaluate(() => !!localStorage.getItem('isobar.training.v1'))).toBe(true);

    // Delete from A: the user and every document go.
    pa.once('dialog', (dialog) => void dialog.accept());
    await openSheet(pa);
    await pa.getByRole('button', { name: 'Delete account' }).click();
    await expect(pa.locator('[data-account-button="out"]:visible')).toBeVisible();
    expect((await pa.request.get('/api/account/data')).status()).toBe(401);
  } finally {
    // Safety net if an assertion failed before the delete.
    for (const ctx of [a, b]) await ctx.request.delete('/api/account').catch(() => undefined);
    await a.close();
    await b.close();
  }
});

test('API refuses without a session, and refuses bad writes with one', async ({ request }) => {
  expect((await request.get('/api/account/data')).status()).toBe(401);
  expect((await request.put('/api/account/data', { data: { kind: 'settings', baseRev: 0, data: {} } })).status()).toBe(401);
  expect((await request.delete('/api/account')).status()).toBe(401);
  // A cross-site write is refused before the session is read.
  expect((await request.put('/api/account/data', { headers: { origin: 'https://evil.example' }, data: { kind: 'settings', baseRev: 0, data: {} } })).status()).toBe(403);
});

test('optimistic concurrency: a stale rev gets 409 and the current document', async ({ browser }) => {
  const ctx = await context(browser);
  try {
    const page = await ctx.newPage();
    await page.goto('/plan');
    await requestCode(page);
    await page.getByLabel('8-digit code').fill((await mail(page)).code);
    await page.locator('[data-account-sheet]').getByRole('button', { name: 'Sign in' }).click();
    await waitSignedIn(page);
    await expect.poll(async () => (await serverDocs(page))?.settings?.rev ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
    const settings = (await serverDocs(page)).settings;
    const write = (baseRev: number, speed: number) => page.request.put('/api/account/data', { data: { kind: 'settings', baseRev, data: { values: { speed }, at: { speed: new Date().toISOString() } } } });
    const ok = await write(settings.rev, 16);
    expect(ok.status()).toBe(200);
    const stale = await write(settings.rev, 32);
    expect(stale.status()).toBe(409);
    expect((await stale.json()).current.data.values.speed).toBe(16);
    expect((await write(0, 64)).status()).toBe(409);
    expect((await page.request.put('/api/account/data', { data: { kind: 'settings', baseRev: settings.rev + 1, data: { values: { speed: 3 }, at: {} } } })).status()).toBe(400);
    const big = { version: 1, cards: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`c${i}`, memory(1, new Date().toISOString())])), streak: { count: 0, lastDay: null } };
    expect((await page.request.put('/api/account/data', { data: { kind: 'training', baseRev: 0, data: big } })).status()).toBe(413);
  } finally {
    await ctx.request.delete('/api/account').catch(() => undefined);
    await ctx.close();
  }
});

for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
  test(`phone ${viewport.width}×${viewport.height}: account sheet and menu fit, nothing clipped`, async ({ browser }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const ctx = await context(browser, viewport);
    try {
      const page = await ctx.newPage();
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await page.goto('/');
        await openSheet(page);
        const box = await page.evaluate(() => {
          const visible = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
          const sheet = document.querySelector('[data-account-sheet]')!.getBoundingClientRect();
          const controls = [...document.querySelectorAll('[data-account-sheet] input, [data-account-sheet] button, [data-map-menu] a, [data-map-menu] button')].filter(visible);
          const clipped = controls.filter((el) => {
            const r = el.getBoundingClientRect();
            const label = el.querySelector('span:last-child') as HTMLElement | null;
            return r.left < -0.5 || r.right > innerWidth + 0.5 || r.top < -0.5 || r.bottom > innerHeight + 0.5 || (label && label.scrollWidth > label.clientWidth + 1);
          }).map((el) => el.getAttribute('aria-label') ?? el.textContent);
          return {
            sheets: document.querySelectorAll('[data-account-sheet], [data-fly-panel]').length,
            sheetInViewport: sheet.left >= -0.5 && sheet.right <= innerWidth + 0.5 && sheet.top >= -0.5 && sheet.bottom <= innerHeight + 0.5,
            sheetHeight: sheet.height,
            pageScroll: document.documentElement.scrollWidth > innerWidth,
            tabs: document.querySelectorAll('nav.tabbar > *').length,
            clipped,
          };
        });
        expect(box.sheets).toBe(1);
        expect(box.sheetInViewport).toBe(true);
        expect(box.sheetHeight).toBeLessThan(140);
        expect(box.pageScroll).toBe(false);
        expect(box.tabs).toBe(0);
        expect(box.clipped).toEqual([]);
        await page.screenshot({ path: path.join(SHOTS, `phone-${viewport.width}x${viewport.height}-${theme}-email.png`) });
        if (viewport.width === 390) {
          await page.getByLabel('Email', { exact: true }).fill(email);
          await page.getByRole('button', { name: 'Email me a link' }).click();
          await expect(page.getByLabel('8-digit code')).toBeVisible();
          await page.screenshot({ path: path.join(SHOTS, `phone-390x844-${theme}-code.png`) });
          await page.getByRole('button', { name: 'Change' }).click();
        }
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-account-sheet]')).toHaveCount(0);
      }
    } finally {
      await ctx.close();
    }
  });
}

test('desktop: map account opens from Menu, light and dark, signed out and in', async ({ browser }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const ctx = await context(browser, { width: 1440, height: 900 });
  try {
    const page = await ctx.newPage();
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/');
      await openSheet(page);
      const sheet = await page.locator('[data-account-sheet]').boundingBox();
      expect(sheet!.x).toBeGreaterThanOrEqual(-0.5);
      expect(sheet!.x + sheet!.width).toBeLessThanOrEqual(1440.5);
      expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(900);
      await page.screenshot({ path: path.join(SHOTS, `desktop-${theme}-email.png`) });
      await page.keyboard.press('Escape');
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await requestCode(page);
    await page.getByLabel('8-digit code').fill((await mail(page)).code);
    await page.locator('[data-account-sheet]').getByRole('button', { name: 'Sign in' }).click();
    await waitSignedIn(page);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
      await openSheet(page);
      await page.screenshot({ path: path.join(SHOTS, `desktop-${theme}-signed-in.png`) });
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await openSheet(page);
    await page.screenshot({ path: path.join(SHOTS, 'phone-390x844-dark-signed-in.png') });
  } finally {
    await ctx.request.delete('/api/account').catch(() => undefined);
    await ctx.close();
  }
});
