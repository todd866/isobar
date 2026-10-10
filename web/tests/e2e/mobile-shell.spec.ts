import { test, expect } from '@playwright/test';

// Browser-engine coverage, not an emulation of iOS's system scroll-edge blur.
// The installed web app must also be checked on an actual phone for that effect.
for (const theme of ['light', 'dark']) test(`phone history header stays opaque and usable in ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(theme => localStorage.setItem('isobar-theme', theme), theme);
  await page.goto('/history?event=everest-1953');
  const event = page.getByRole('combobox', { name: 'Historical event', exact: true });
  const day = page.getByRole('combobox', { name: 'Historical day', exact: true });
  await expect(event).toHaveValue('everest-1953');
  await expect(day).toBeVisible();
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
  else await expect(page.locator('html')).not.toHaveClass(/dark/);

  // Exercise real controls after rotation and return; don't just inspect CSS.
  for (const [width, height] of [[390, 844], [844, 390], [390, 664]]) {
    await page.setViewportSize({ width, height });
    await expect(event).toBeVisible();
    const shell = await page.locator('[data-map-shell=true]').evaluate(node => {
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      return { background: style.backgroundColor, top: box.top, left: box.left,
        right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight };
    });
    expect(shell.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(shell.top).toBe(0); expect(shell.left).toBe(0);
    expect(shell.right).toBeLessThanOrEqual(shell.width + 1);
    expect(shell.bottom).toBeLessThanOrEqual(shell.height + 1);
    expect(shell.scrollWidth).toBeLessThanOrEqual(shell.width + 1);
    expect(shell.scrollHeight).toBeLessThanOrEqual(shell.height + 1);
    for (const control of [event, page.getByRole('link', { name: 'Back to present day', exact: true }), day]) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
      expect(await control.evaluate(node => {
        for (let current: Element | null = node; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.filter !== 'none' || Number(style.opacity) < 1) return false;
        }
        return true;
      })).toBe(true);
    }
    await day.selectOption('1953-05-28'); await expect(day).toHaveValue('1953-05-28');
    await day.selectOption('1953-05-29'); await expect(day).toHaveValue('1953-05-29');
    await page.screenshot({ path: info.outputPath(`header-${width}-${height}.png`) });
  }
  const exit = page.getByRole('link', { name: 'Back to present day', exact: true });
  await expect(exit).toBeInViewport();
  expect((await exit.boundingBox())!.height).toBeGreaterThanOrEqual(36);
  await exit.click();
  await page.waitForURL(url => url.pathname === '/');
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
});
