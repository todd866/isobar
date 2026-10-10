import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHOTS = process.env.ISOBAR_BILLING_SHOTS ?? path.resolve(process.cwd(), '../build/billing-qa');

async function viewportCapture(page: Page, screenshotPath: string) {
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.locator('[data-account-sheet] button[aria-label="Close"]').evaluateAll((buttons) => {
    for (const button of buttons) button.toggleAttribute('data-visible-close', button.getBoundingClientRect().height > 0);
  });
  const helper = path.join(process.env.HOME ?? '', 'Projects/.ux-authoring/viewport-fit.mjs');
  if (fs.existsSync(helper)) {
    const { assertViewport } = await import(pathToFileURL(helper).href);
    await assertViewport(page, {
      primary: [{ selector: '[data-account-sheet]', minWidth: 280, minHeight: 100 }],
      controls: [{ selector: '[data-visible-close]', minWidth: 32, minHeight: 13 }, { selector: '[data-billing-row] select', minWidth: 70, minHeight: 32 }, { selector: '[data-billing-row] button', minWidth: 44, minHeight: 32 }],
      screenshotPath,
    });
  } else {
    await expect(page.locator('[data-account-sheet]')).toBeInViewport();
    await page.screenshot({ path: screenshotPath });
  }
}

async function installBuiltFiles(page: Page) {
  await page.route('**', async (route) => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) {
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { docs: {} } });
      if (process.env.ISOBAR_E2E_FILES !== '1') return route.continue();
      const file = url.pathname.startsWith('/_next/static/') ? `.next/${url.pathname.slice(7)}`
        : url.pathname === '/download' ? '.next/server/app/download.html' : `public${url.pathname}`;
      if (file.includes('..')) return route.abort();
      try {
        const extension = path.extname(file);
        const contentType = ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' } as Record<string, string>)[extension] ?? 'application/octet-stream';
        return route.fulfill({ body: fs.readFileSync(file), contentType });
      } catch { return route.fulfill({ status: 404, body: '' }); }
    }
    return route.abort();
  });
}

async function mockAccount(page: Page, billing: Record<string, unknown>) {
  await installBuiltFiles(page);
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: { user: { id: 'billing-user', email: 'billing@example.test' } } }));
  await page.route('**/api/billing', (route) => route.fulfill({ headers: { 'cache-control': 'no-store' }, json: billing }));
}

test.describe('billing account row', () => {
  test('Stripe disabled leaves no billing row', async ({ page }) => {
    await mockAccount(page, { enabled: false });
    await page.goto('/download?account=1');
    await expect(page.locator('[data-account-sheet]')).toBeVisible();
    await expect(page.locator('[data-billing-row]')).toHaveCount(0);
  });

  test('free row selects a period and starts checkout', async ({ page }) => {
    await mockAccount(page, { enabled: true, paid: false, plan: null, status: null });
    await page.route('**/api/billing/checkout', async (route) => {
      expect(await route.request().postDataJSON()).toEqual({ plan: 'yearly' });
      await route.fulfill({ json: { url: 'https://checkout.stripe.test/session' } });
    });
    await page.route('https://checkout.stripe.test/**', (route) => route.fulfill({ status: 200, body: 'Stripe Checkout mock' }));
    await page.goto('/download?account=1');
    await expect(page.locator('[data-billing-row]')).toContainText('Isobar AI');
    await page.locator('[data-billing-row] select').selectOption('yearly');
    await page.locator('[data-billing-row]').getByRole('button', { name: 'Upgrade' }).click();
    await expect(page).toHaveURL('https://checkout.stripe.test/session');
  });

  test('paid row opens portal and shows cancellation period', async ({ page }) => {
    await mockAccount(page, { enabled: true, paid: true, plan: 'monthly', status: 'active', currentPeriodEnd: '2026-11-09T00:00:00.000Z', cancelAtPeriodEnd: true });
    await page.route('**/api/billing/portal', (route) => route.fulfill({ json: { url: 'https://billing.stripe.test/portal' } }));
    await page.route('https://billing.stripe.test/**', (route) => route.fulfill({ status: 200, body: 'Stripe Portal mock' }));
    await page.goto('/download?account=1');
    await expect(page.locator('[data-billing-row]')).toContainText('Cancels');
    await page.locator('[data-billing-row]').getByRole('button', { name: 'Manage' }).click();
    await expect(page).toHaveURL('https://billing.stripe.test/portal');
  });

  test('terminal canceled or incomplete-expired status offers upgrade', async ({ page }) => {
    await mockAccount(page, { enabled: true, paid: false, plan: 'monthly', status: 'incomplete_expired' });
    await page.goto('/download?account=1');
    await expect(page.locator('[data-billing-row]')).toContainText('Upgrade');
    await expect(page.locator('[data-billing-row]').getByRole('button', { name: 'Manage' })).toHaveCount(0);
  });

  test('checkout return stays pending until the webhook changes entitlement', async ({ page }) => {
    let reads = 0;
    await mockAccount(page, { enabled: true, paid: false, plan: null, status: null });
    await page.unroute('**/api/billing');
    await page.route('**/api/billing', (route) => {
      reads += 1;
      return route.fulfill({ json: reads < 2 ? { enabled: true, paid: false, plan: null, status: null } : { enabled: true, paid: true, plan: 'monthly', status: 'active' } });
    });
    await page.goto('/download?account=1&billing=success');
    await expect(page.locator('[data-billing-row]')).toContainText('Confirming payment');
    await expect(page.locator('[data-billing-row]')).toContainText('Manage', { timeout: 5_000 });
    await expect(page).toHaveURL(/\/download$/);
  });

  test('billing errors offer a compact retry', async ({ page }) => {
    await mockAccount(page, { enabled: true, paid: false });
    await page.route('**/api/billing', (route) => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
    await page.goto('/download?account=1');
    await expect(page.locator('[data-billing-row]')).toContainText('Billing unavailable');
    await expect(page.locator('[data-billing-row]').getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('failed checkout is retryable and late completion after close does not redirect', async ({ page }) => {
    await mockAccount(page, { enabled: true, paid: false });
    let attempts = 0;
    await page.route('**/api/billing/checkout', async (route) => {
      attempts += 1;
      if (attempts === 1) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return route.fulfill({ json: { url: 'https://checkout.stripe.test/session' } });
    });
    await page.route('https://checkout.stripe.test/**', (route) => route.fulfill({ status: 200, body: 'Stripe Checkout mock' }));
    await page.goto('/download?account=1');
    const row = page.locator('[data-billing-row]');
    await row.getByRole('button', { name: 'Upgrade' }).click();
    await expect(row).toContainText('Try again');
    await row.getByRole('button', { name: 'Retry' }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await expect(page).toHaveURL(/\/download$/);
  });

  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    test(`fits ${viewport.width}×${viewport.height} in light and dark`, async ({ page }) => {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.setViewportSize(viewport);
      await mockAccount(page, { enabled: true, paid: false });
      await page.goto('/download?account=1');
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await page.locator('html').evaluate((html, selected) => html.classList.toggle('dark', selected === 'dark'), theme);
        const sheet = page.locator('[data-account-sheet]');
        await expect(sheet).toBeVisible();
        await viewportCapture(page, path.join(SHOTS, `billing-${viewport.width}x${viewport.height}-${theme}.png`));
      }
    });
  }

  test('account controls remain usable at 200% text', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAccount(page, { enabled: true, paid: false });
    await page.goto('/download?account=1');
    await page.locator('[data-account-sheet]').evaluate((element) => {
      for (const child of element.querySelectorAll<HTMLElement>('button, select, span')) child.style.fontSize = `${parseFloat(getComputedStyle(child).fontSize) * 2}px`;
    });
    await viewportCapture(page, path.join(SHOTS, 'billing-390x844-text200.png'));
  });
});
