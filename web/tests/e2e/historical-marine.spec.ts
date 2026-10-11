import { expect, test } from '@playwright/test';

test.setTimeout(90_000);

test('Katrina replays marine observations and dated MODIS without moving the map', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/history?event=katrina-2005');

  const stage = page.locator('[data-map-ready="true"]');
  await stage.waitFor();
  await expect(stage).toHaveAttribute('data-renderer', 'webgl2');
  await expect(stage).toHaveAttribute('data-frames', 'complete');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Historical event', exact: true })).toHaveValue('katrina-2005');

  const camera = () => stage.evaluate((node) => (node as HTMLElement & { chartApi: { camera: () => Record<string, number> } }).chartApi.camera());
  const labels = () => stage.evaluate((node) => (node as HTMLElement & { chartApi: { labels: () => Array<{ text?: string }> } }).chartApi.labels());
  const stableCamera = (before: Record<string, number>, label: string) => expect.poll(async () => {
    const after = await camera();
    return ['centerX', 'centerY', 'halfWidth', 'halfHeight', 'bearingRadians'].every((key) => Math.abs((after[key] ?? 0) - (before[key] ?? 0)) < 1e-6);
  }, { message: `${label} changed the map camera` }).toBe(true);
  const panelShot = async (name: string) => page.locator('[data-map-panel]').screenshot({ path: info.outputPath(name) });

  const initialCamera = await camera();
  await expect(page.getByRole('combobox', { name: 'Historical day', exact: true })).toHaveValue('2005-08-29');
  await page.getByRole('radio', { name: 'Wind', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Wind', exact: true })).toHaveAttribute('aria-checked', 'true');
  await stableCamera(initialCamera, 'wind lens');

  const sea = page.getByRole('combobox', { name: 'Sea layer', exact: true });
  await sea.selectOption('waves');
  await expect(sea).toHaveValue('waves');
  await expect.poll(async () => (await labels()).some((label) => label.text?.startsWith('42040 · '))).toBe(true);
  const waves29 = await panelShot('katrina-waves-2005-08-29.png');
  expect(waves29.length).toBeGreaterThan(10_000);
  await stableCamera(initialCamera, 'wave layer');

  await sea.selectOption('surge');
  await expect(sea).toHaveValue('surge');
  await expect.poll(async () => (await labels()).some((label) => label.text?.startsWith('Alluvial City · '))).toBe(true);
  const surge29 = await panelShot('katrina-surge-2005-08-29.png');
  expect(surge29.length).toBeGreaterThan(10_000);
  await stableCamera(initialCamera, 'surge layer');

  await page.getByRole('combobox', { name: 'Historical day', exact: true }).selectOption('2005-08-28');
  await expect(page.getByRole('combobox', { name: 'Historical day', exact: true })).toHaveValue('2005-08-28');
  await expect(stage).toHaveAttribute('data-valid-ms', String(Date.parse('2005-08-28T00:00:00Z')));
  await expect.poll(async () => (await labels()).some((label) => label.text?.startsWith('Alluvial City · '))).toBe(false);
  const surge28 = await panelShot('katrina-surge-2005-08-28.png');
  expect(surge28.length).toBeGreaterThan(10_000);
  await stableCamera(initialCamera, 'historical day');

  await page.getByRole('radio', { name: 'Pressure', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Pressure', exact: true })).toHaveAttribute('aria-checked', 'true');
  const satellite = page.getByRole('button', { name: 'Satellite', exact: true });
  await satellite.click();
  await expect(satellite).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-cloud-legend]')).toContainText('MODIS · 2005-08-28');
  const modis28 = await panelShot('katrina-modis-2005-08-28.png');
  expect(modis28.length).toBeGreaterThan(10_000);
  await stableCamera(initialCamera, 'MODIS 28 August');

  await page.getByRole('combobox', { name: 'Historical day', exact: true }).selectOption('2005-08-29');
  await expect(page.getByRole('combobox', { name: 'Historical day', exact: true })).toHaveValue('2005-08-29');
  await expect(stage).toHaveAttribute('data-valid-ms', String(Date.parse('2005-08-29T00:00:00Z')));
  await expect(page.locator('[data-cloud-legend]')).toContainText('MODIS · 2005-08-29');
  const modis29 = await panelShot('katrina-modis-2005-08-29.png');
  expect(modis29.length).toBeGreaterThan(10_000);
  await stableCamera(initialCamera, 'MODIS 29 August');

  await page.getByRole('button', { name: '3D map', exact: true }).click();
  await expect(stage).toHaveAttribute('data-map-mode', '3d');
  const camera3d = await camera();
  expect(camera3d.centerX).toBeCloseTo(initialCamera.centerX, 6);
  expect(camera3d.centerY).toBeCloseTo(initialCamera.centerY, 6);
  await page.getByRole('button', { name: '2D map', exact: true }).click();
  await expect(stage).toHaveAttribute('data-map-mode', '2d');
  await stableCamera(initialCamera, '2D/3D round trip');

  await page.getByRole('link', { name: 'Back to present day', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/');
  const present = page.locator('[data-map-ready="true"]');
  await present.waitFor();
  await expect(page.locator('[data-map-page]')).not.toHaveAttribute('data-history-mode', 'true');
  await expect(page.getByRole('button', { name: 'Back to present day', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
