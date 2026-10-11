import { test, expect, type Page, type Locator } from '@playwright/test';

test.setTimeout(180_000);

async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function checkpoint(stage: Locator, label: string, baselineCanvasCount: number) {
  const state = await stage.evaluate((node: HTMLElement) => {
    const webgl = node.querySelector<HTMLCanvasElement>('[data-chart-layer="webgl"]');
    const canvases = [...node.querySelectorAll<HTMLCanvasElement>('canvas')];
    const camera = (node as any).chartApi?.camera?.();
    const rect = node.getBoundingClientRect();
    return {
      finiteCamera: camera && [camera.centerX, camera.centerY, camera.halfWidth, camera.halfHeight, camera.bearingRadians ?? 0].every(Number.isFinite),
      halfHeight: camera?.halfHeight,
      tilt: Number(node.getAttribute('data-tilt')),
      renderer: node.getAttribute('data-renderer'),
      contextLost: webgl?.getContext('webgl2')?.isContextLost() ?? false,
      webglCount: node.querySelectorAll('[data-chart-layer="webgl"]').length,
      canvasCount: canvases.length,
      finiteCanvases: canvases.every(canvas => Number.isFinite(canvas.width) && Number.isFinite(canvas.height) && canvas.width >= 0 && canvas.height >= 0),
      maxCanvasWidth: Math.max(...canvases.map(canvas => canvas.width), 0),
      maxCanvasHeight: Math.max(...canvases.map(canvas => canvas.height), 0),
      responsive: rect.width >= 250 && rect.height >= 120 && rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1,
    };
  });
  expect(state.finiteCamera, `${label}: non-finite camera`).toBe(true);
  expect(state.halfHeight, `${label}: invalid camera scale`).toBeGreaterThan(0);
  expect(state.halfHeight, `${label}: runaway camera scale`).toBeLessThanOrEqual(90);
  expect(state.tilt, `${label}: invalid tilt`).toBeGreaterThanOrEqual(0);
  expect(state.tilt, `${label}: runaway tilt`).toBeLessThanOrEqual(1.3091);
  expect(state.renderer, `${label}: renderer lost`).toBe('webgl2');
  expect(state.contextLost, `${label}: context lost`).toBe(false);
  expect(state.webglCount, `${label}: WebGL canvas leaked`).toBe(1);
  expect(state.canvasCount, `${label}: canvas count grew`).toBeLessThanOrEqual(baselineCanvasCount + 1);
  expect(state.finiteCanvases, `${label}: invalid canvas dimensions`).toBe(true);
  expect(state.maxCanvasWidth, `${label}: canvas width runaway`).toBeLessThanOrEqual(8192);
  expect(state.maxCanvasHeight, `${label}: canvas height runaway`).toBeLessThanOrEqual(8192);
  expect(state.responsive, `${label}: map no longer fits viewport`).toBe(true);
}

async function clickLens(page: Page, name: 'pressure' | 'rain' | 'wind' | 'temp') {
  const lens = page.locator(`[data-lens="${name}"]`).first();
  await expect(lens, `${name} lens control missing`).toHaveCount(1);
  await expect(lens, `${name} lens control hidden`).toBeVisible();
  await lens.click();
  await expect(lens).toHaveAttribute('aria-checked', 'true');
}

async function inspectPanel(page: Page, stage: Locator) {
  const bounds = (await stage.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.58);
  const panel = page.locator('[data-point-panel]');
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Close point', exact: true }).click();
  await expect(panel).toHaveCount(0);
}

async function closeTerrainSlice(page: Page) {
  const toggle = page.getByRole('button', { name: 'Terrain and atmosphere slice', exact: true });
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(page.locator('.map-slice-position')).toHaveCount(1);
  const slider = page.locator('.map-slice-position');
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await toggle.click();
}

for (const scenario of [
  { name: 'current-everest', url: '/', lat: 27.9881, lon: 86.925, zoom: 0.13 },
  { name: 'everest-1953', url: '/history?event=everest-1953&terrain=photo', lat: 27.9881, lon: 86.925, zoom: 0.13 },
] as const) {
  test(`Everest endurance: ${scenario.name} survives repeated real controls`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(scenario.url);
    const stage = page.locator('[data-api="1"]');
    await stage.waitFor();
    await expect(stage).toHaveAttribute('data-renderer', 'webgl2');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await stage.evaluate((node: any, point) => node.chartApi.setView(point.lat, point.lon, point.zoom), scenario);
    await page.getByRole('button', { name: '3D map', exact: true }).click();
    await paint(page);
    const baselineCanvasCount = await stage.locator('canvas').count();
    await checkpoint(stage, `${scenario.name}: initial`, baselineCanvasCount);

    let cycle = 0;
    const cycleCheck = async (label: string) => {
      await paint(page);
      await checkpoint(stage, `${scenario.name}:${++cycle}:${label}`, baselineCanvasCount);
    };
    const bounds = () => stage.boundingBox();

    for (let round = 0; round < 22; round += 1) {
      const box = (await bounds())!;
      // Cycle within the map. An unbounded multiplier silently moved later
      // rounds outside the viewport, turning the soak into idle waiting.
      const x = box.x + box.width * (0.35 + (round % 3) * 0.12);
      const y = box.y + box.height * (0.42 + (round % 3) * 0.08);
      expect(x - 42).toBeGreaterThan(box.x); expect(x + 45).toBeLessThan(box.x + box.width);
      expect(y - 38).toBeGreaterThan(box.y); expect(y + 34).toBeLessThan(box.y + box.height);
      const beforeGesture = await stage.evaluate((node: any) => node.chartApi.camera());
      await page.mouse.move(x, y);
      await page.mouse.wheel(160, 0);
      await page.mouse.wheel(-120, 0);
      await page.mouse.wheel(0, 180);
      await page.mouse.wheel(0, -180);
      await page.keyboard.down('Control');
      try { await page.mouse.wheel(0, round % 2 ? -36 : 36); } finally { await page.keyboard.up('Control'); }
      await page.mouse.down();
      try {
        await page.mouse.move(x + 45, y - 38, { steps: 6 });
        await page.mouse.move(x - 42, y + 34, { steps: 6 });
      } finally { await page.mouse.up(); }
      await cycleCheck(`camera-${round}`);
      const afterGesture = await stage.evaluate((node: any) => node.chartApi.camera());
      expect(['centerX', 'centerY', 'halfHeight', 'bearingRadians'].some(key =>
        Math.abs((afterGesture[key] ?? 0) - (beforeGesture[key] ?? 0)) > 1e-8),
        `${scenario.name}: round ${round} must actually move the map`).toBe(true);
      await page.waitForTimeout(3_500);
    }

    // Push to the pitch limit, reverse the drag, then return through both modes.
    const box = (await bounds())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    let maxPitch = 0;
    for (let i = 0; i < 14; i += 1) {
      await page.mouse.wheel(0, -220);
      maxPitch = Math.max(maxPitch, Number(await stage.getAttribute('data-tilt')));
      if (maxPitch > 1.2) break;
    }
    if (maxPitch <= 1.2) {
      for (let i = 0; i < 14; i += 1) {
        await page.mouse.wheel(0, 220);
        maxPitch = Math.max(maxPitch, Number(await stage.getAttribute('data-tilt')));
        if (maxPitch > 1.2) break;
      }
    }
    expect(maxPitch, `${scenario.name}: pitch never reached close limit`).toBeGreaterThan(1.2);
    await page.mouse.down();
    try { await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.75, { steps: 10 }); } finally { await page.mouse.up(); }
    await page.mouse.down();
    try { await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.25, { steps: 10 }); } finally { await page.mouse.up(); }
    await cycleCheck('max-pitch-reversal');
    await page.getByRole('button', { name: 'North up', exact: true }).click();
    await expect(stage).toHaveAttribute('data-bearing', '0.0000');
    await page.getByRole('button', { name: '2D map', exact: true }).click();
    await cycleCheck('2d');
    await page.getByRole('button', { name: '3D map', exact: true }).click();
    await clickLens(page, 'pressure');
    const rain = page.locator('[data-lens="rain"]');
    if (scenario.name === 'current-everest') await clickLens(page, 'rain');
    else await expect(rain, 'historical rain lens should be absent when the lead window is unavailable').toHaveCount(0);
    await clickLens(page, 'wind'); await clickLens(page, 'temp');
    await inspectPanel(page, stage);
    await closeTerrainSlice(page);
    await cycleCheck('lenses-panel-slice');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
    await cycleCheck('phone-200pct');
    await page.screenshot({ path: info.outputPath(`${scenario.name}-phone-200pct.png`) });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; });
    await cycleCheck('laptop-restored');
    await page.screenshot({ path: info.outputPath(`${scenario.name}-laptop.png`) });
    expect(errors, `${scenario.name}: page errors`).toEqual([]);
  });
}
