import { test, expect } from '@playwright/test';

test.describe('WebGL chart context recovery', () => {
  test.setTimeout(120_000);

  async function paint(page: import('@playwright/test').Page) {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }

  async function platePixels(stage: import('@playwright/test').Locator) {
    const plate = await stage.evaluate(async (element: any) => {
      const result = await element.chartApi.readPlate();
      if (!result) throw new Error('WebGL plate unavailable');
      return {width: result.width, height: result.height, pixels: Array.from(result.data) as number[]};
    });
    // Reading a discarded drawing buffer returns zeroes and would make two
    // blank frames appear identical. Read via the renderer's draw-time capture.
    expect(plate.pixels.filter((value, index) => index % 4 === 3 && value > 0).length)
      .toBeGreaterThan(plate.width * plate.height * .95);
    expect(new Set(plate.pixels.filter((_, index) => index % 4 === 0)).size).toBeGreaterThan(8);
    return plate;
  }

  function changedRaw(before: Awaited<ReturnType<typeof platePixels>>, after: Awaited<ReturnType<typeof platePixels>>) {
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    let changed = 0;
    for (let i = 0; i < before.pixels.length; i += 4) {
      if (Math.abs(before.pixels[i] - after.pixels[i]) + Math.abs(before.pixels[i + 1] - after.pixels[i + 1]) + Math.abs(before.pixels[i + 2] - after.pixels[i + 2]) > 35) changed += 1;
    }
    return changed / (before.pixels.length / 4);
  }

  test('restores the chart and keeps camera, time, and lens state', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/history?event=everest-1953&terrain=photo');
    const stage = page.locator('[data-api="1"]');
    const canvas = stage.locator('canvas[data-chart-layer="webgl"]');
    await stage.waitFor();
    await expect(stage).toHaveAttribute('data-renderer', 'webgl2');
    await expect(stage).toHaveAttribute('data-terrain-imagery', 'ready', { timeout: 60000 });
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await stage.evaluate((element: any) => element.chartApi.setView(27.9881, 86.925, 0.13));
    await page.getByRole('button', { name: '3D map', exact: true }).click();
    await page.locator('[data-lens="wind"]').first().click();
    await paint(page);

    await expect.poll(() => stage.evaluate((e: any) => e.chartApi.terrain()?.painted), {timeout: 60000}).toBe(true);
    const before = await platePixels(stage);
    const state = () => stage.evaluate((element: any) => ({
      camera: element.chartApi.camera(),
      tilt: element.chartApi.tilt(),
      time: element.dataset.validMs,
      wind: element.querySelector('[data-lens="wind"]')?.getAttribute('aria-checked'),
    }));
    const saved = await state();
    await canvas.evaluate((node: HTMLCanvasElement) => {
      const gl = node.getContext('webgl2');
      const extension = gl?.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('WEBGL_lose_context unavailable on the WebGL chart canvas');
      (window as any).__isobarContextLossExtension = extension;
      extension.loseContext();
    });
    await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.getContext('webgl2')?.isContextLost()), { timeout: 20_000 }).toBe(true);
    await page.evaluate(() => (window as any).__isobarContextLossExtension.restoreContext());
    await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.getContext('webgl2')?.isContextLost()), { timeout: 20_000 }).toBe(false);
    await expect(canvas).toHaveAttribute('data-context-state', 'ready', { timeout: 15000 });
    await paint(page);
    const after = await platePixels(stage);
    expect(await state()).toEqual(saved);
    expect(changedRaw(before, after)).toBeLessThan(0.12);
    expect(errors).toEqual([]);
  });

  test('close 3D terrain remains rendered while orbiting', async ({ page }, info) => {
    await page.goto('/history?event=everest-1953&terrain=photo');
    const stage = page.locator('[data-api="1"]');
    const canvas = stage.locator('canvas[data-chart-layer="webgl"]');
    await stage.waitFor();
    await expect(stage).toHaveAttribute('data-renderer', 'webgl2');
    await expect(stage).toHaveAttribute('data-terrain-imagery', 'ready', { timeout: 60000 });
    await expect(stage).toHaveAttribute('data-map-ready', 'true');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await stage.evaluate((element: any) => element.chartApi.setView(27.9881, 86.925, 0.13));
    await page.getByRole('button', { name: '3D map', exact: true }).click();
    await paint(page);
    await expect.poll(() => stage.evaluate((e: any) => e.chartApi.terrain()?.painted), {timeout: 60000}).toBe(true);
    const before = await platePixels(stage);
    const box = (await stage.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
    await page.mouse.wheel(120, 0);
    await paint(page);
    const afterPlate = await platePixels(stage);
    await page.screenshot({ path: info.outputPath('close-terrain-ridge.png') });
    // Capture is from the plate renderer before any overlays are composited.
    expect(changedRaw(before, afterPlate)).toBeGreaterThan(0.01);
  });
});
