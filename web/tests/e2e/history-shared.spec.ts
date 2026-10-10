import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';

// Uses genuine packaged archive data rather than generated weather fixtures.
test('history shares animated map controls without current weather requests', async ({ page }) => {
  test.skip(!existsSync('public/history/catalog.json'), 'Package historical assets first');
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/history?event=dday&date=1944-06-06&hour=12');
  const stage = page.locator('[data-map-ready=true]');
  await expect(stage).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => stage.evaluate((e: any) => e.chartApi.flowSample()?.drawn)).toBeGreaterThan(0);
  await expect.poll(() => stage.evaluate((e: any) => e.chartApi.flowSample()?.travel)).toBeGreaterThan(0);
  expect(new Date(Number(await stage.getAttribute('data-valid-ms'))).getUTCFullYear()).toBe(1944);
  const camera = await stage.evaluate((e: any) => e.chartApi.camera());
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => stage.evaluate((e: any) => e.chartApi.camera())).not.toEqual(camera);
  const timeline = page.getByRole('slider', { name: 'Forecast time' });
  const before = await timeline.getAttribute('aria-valuenow');
  await timeline.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(timeline).not.toHaveAttribute('aria-valuenow', before!);
  await page.getByLabel('Historical event').selectOption('cyclone-tracy');
  await expect.poll(async () => new Date(Number(await stage.getAttribute('data-valid-ms'))).getUTCFullYear()).toBe(1974);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const start = Number(await stage.getAttribute('data-valid-ms'));
  await expect.poll(async () => Number(await stage.getAttribute('data-valid-ms'))).toBeGreaterThan(start);
  expect(requests.filter(url => /api\/(traffic|forecast)|open-meteo|\/data\/(manifest|sky)\.json/.test(url))).toEqual([]);
});
