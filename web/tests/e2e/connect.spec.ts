import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const out = path.join(process.cwd(), 'test-results', 'visual');

async function shot(page: Page, name: string) {
  fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, name), fullPage: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, name).toBeLessThanOrEqual(1);
}

test('connect page, light and dark', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  for (const mode of ['light', 'dark'] as const) {
    await page.addInitScript((value) => localStorage.setItem('isobar-theme', value), mode);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/connect');
    await page.mouse.move(8, 8);
    await expect(page.locator('[data-connect-row]')).toHaveCount(4);
    const origin = new URL(page.url()).origin;
    await expect(page.locator('[data-connect-value="mcp"]')).toContainText(`${origin}/api/mcp`);
    await expect(page.locator('[data-connect-value="openapi"]')).toContainText(`${origin}/api/v1/openapi.json`);
    await expect(page.locator('[data-connect-value="chatgpt"]')).toHaveText('Actions → Import OpenAPI URL');
    await expect(page.locator('[data-connect-value="claude"]')).toHaveText('Settings → Connectors → paste MCP URL');
    const copy = page.getByRole('button', { name: 'Copy MCP URL' });
    await expect(copy).toBeVisible();
    const box = await copy.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThan(720);
    await shot(page, `connect-${mode}-desktop.png`);
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = await page.getByRole('button', { name: 'Copy OpenAPI URL' }).boundingBox();
    expect(phone).not.toBeNull();
    expect(phone!.y + phone!.height).toBeLessThan(844);
    await shot(page, `connect-${mode}-phone.png`);
    if (mode === 'light') {
      await page.setViewportSize({ width: 1280, height: 720 });
      await copy.click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/api/mcp`);
      await page.getByRole('button', { name: 'Copy OpenAPI URL' }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/api/v1/openapi.json`);
    }
  }
});
