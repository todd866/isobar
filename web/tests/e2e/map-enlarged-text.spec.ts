import { test, expect } from '@playwright/test';

test.setTimeout(120_000);

for (const theme of ['light', 'dark'] as const) for (const viewport of [
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'small-phone', width: 375, height: 667 },
  { name: 'landscape', width: 844, height: 390 },
] as const) {
  test(`map chrome fits ${viewport.name} at 200% text (${theme})`, async ({ page }, info) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(value => localStorage.setItem('isobar-theme', value), theme);
    await page.goto('/');
    const stage = page.locator('[data-api="1"]');
    await stage.waitFor();
    await expect(stage).toHaveAttribute('data-renderer', 'webgl2');
    await page.getByRole('button', { name: '3D map', exact: true }).click();
    await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    const { assertViewport } = await import('../../../tools/viewport-fit.mjs');
    const transportSelector = viewport.width < 768 || viewport.height < 500
      ? '.transport-inline button[aria-label="Pause"], .transport-inline button[aria-label="Play"]'
      : '.transport-side button[aria-label="Pause"], .transport-side button[aria-label="Play"]';
    await assertViewport(page, {
      primary: [{ selector: '[data-api="1"]', label: 'map surface', minWidth: 250, minHeight: viewport.height < 500 ? 60 : 120 }],
      controls: [
        { selector: '[aria-label="Place"]', label: 'place search', minWidth: 36, minHeight: 36 },
        { selector: '[aria-label="Menu"]', label: 'map menu', minWidth: 36, minHeight: 36 },
        { selector: transportSelector, label: 'transport', minWidth: 36, minHeight: 36 },
        { selector: '[aria-label="2D map"]', label: '2D mode', minWidth: 36, minHeight: 36 },
        { selector: '[aria-label="3D map"]', label: '3D mode', minWidth: 36, minHeight: 36 },
        { selector: '[aria-label="North up"]', label: 'north up', minWidth: 36, minHeight: 36 },
      ],
      screenshotPath: info.outputPath(`${viewport.name}-200pct.png`),
    });

    const geometry = await page.evaluate(() => {
      const stage = document.querySelector('[data-api="1"]')!.getBoundingClientRect();
      const input = document.querySelector<HTMLInputElement>('[aria-label="Place"]')!;
      const search = input.getBoundingClientRect();
      const css = getComputedStyle(input);
      const textMeasure = document.createElement('canvas').getContext('2d')!;
      textMeasure.font = css.font;
      const placeFits = textMeasure.measureText(input.value).width + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) + 2 <= search.width + 1;
      const controls = [...document.querySelectorAll('[aria-label="Menu"], [aria-label="Pause"], [aria-label="Play"], [aria-label="2D map"], [aria-label="3D map"], [aria-label="North up"]')].map(node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      });
      return { stage, search, placeFits, controls, overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    expect(geometry.search.left, 'place search clipped left').toBeGreaterThanOrEqual(-1);
    expect(geometry.search.right, 'place search clipped right').toBeLessThanOrEqual(viewport.width + 1);
    expect(geometry.overflowX, 'map chrome widened the document').toBe(false);
    expect(geometry.placeFits, 'default city name must remain readable with enlarged text').toBe(true);
    for (const control of geometry.controls) {
      expect(control.left).toBeGreaterThanOrEqual(-1);
      expect(control.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(control.top).toBeGreaterThanOrEqual(-1);
      expect(control.bottom).toBeLessThanOrEqual(viewport.height + 1);
    }
    const compact = viewport.width < 700 || viewport.height < 620;
    if (compact) {
      const speed = page.locator('.transport-inline select');
      if (viewport.name === 'landscape') {
        const width = await page.locator('.time-block .timeline').evaluate(node => node.getBoundingClientRect().width);
        expect(width, 'scrubber must receive at least half the landscape width').toBeGreaterThan(viewport.width * .5);
      }
      await speed.selectOption('256');
      await expect(speed).toHaveValue('256');
      await page.getByRole('button', { name: 'Now', exact: true }).click();
      await expect(speed).toHaveValue('0');
      await assertViewport(page, { primary: [{ selector: '[data-api="1"]', minWidth: 250, minHeight: 60 }], controls: [{ selector: '.transport-inline select', minWidth: 36, minHeight: 36 }, { selector: '.transport-inline [data-time-reset]', minWidth: 36, minHeight: 36 }], screenshotPath: info.outputPath('realtime-200pct.png') });
      await speed.selectOption('8');
      await expect(page.getByRole('button', { name: 'Map tools', exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Weather lens', exact: true })).toBeVisible();
      await expect(page.locator('[data-map-density="compact"] [data-api="1"]')).toBeVisible();
      const exposed = await page.evaluate(() => {
        const stage = document.querySelector('[data-api="1"]')!.getBoundingClientRect();
        const chrome = document.querySelector('[data-map-chrome]')!.getBoundingClientRect();
        const stageArea = stage.width * stage.height;
        const overlays = [...document.querySelectorAll<HTMLElement>('.map-tools, [data-atmosphere-instrument], .map-legend, [aria-label="Ask Isobar"]')]
          .filter(node => getComputedStyle(node).display !== 'none')
          .reduce((sum, node) => {
            const box = node.getBoundingClientRect();
            const width = Math.max(0, Math.min(box.right, stage.right) - Math.max(box.left, stage.left));
            const height = Math.max(0, Math.min(box.bottom, stage.bottom) - Math.max(box.top, stage.top));
            return sum + width * height;
          }, 0);
        return { mapShare: stage.height / innerHeight, overlayShare: overlays / Math.max(1, stageArea), chromeHeight: chrome.height };
      });
      await test.info().attach('visible-map-area', { body: JSON.stringify(exposed), contentType: 'application/json' });
      expect(exposed.mapShare, 'enlarged text must leave at least half the phone viewport for the map').toBeGreaterThan(0.5);
      expect(exposed.overlayShare, `closed secondary overlays must stay below 20% of map area (${JSON.stringify(exposed)})`).toBeLessThan(0.2);
      await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Data sources', exact: true })).toBeHidden();
      await expect(page.locator('[data-secondary-control="recenter"]')).toBeHidden();
      await page.getByRole('button', { name: 'Map tools', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Data sources', exact: true })).toBeVisible();
      const atmosphere = page.getByRole('button', { name: 'Atmospheric section', exact: true });
      await expect(atmosphere).toBeVisible();
      {
        await atmosphere.click();
        await expect(page.locator('[data-atmosphere-section]')).toBeVisible();
        await expect(page.locator('[data-map-tools]')).toBeHidden();
        await page.screenshot({ path: info.outputPath('atmosphere-open.png') });
        await page.locator('[data-reading]').click();
        await expect(page.locator('[data-map-page]')).toHaveAttribute('data-map-tools-open', 'false');
        await expect(page.locator('[data-atmosphere-section]')).toBeVisible();
        await page.getByRole('button', { name: 'Close atmospheric section', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Map tools', exact: true })).toBeFocused();
        await page.getByRole('button', { name: 'Map tools', exact: true }).click();
        await expect(page.locator('[data-atmosphere-section]')).toHaveCount(0);
      }
      await page.getByRole('button', { name: 'Data sources', exact: true }).click();
      await expect(page.locator('.map-sources')).toBeVisible();
      await page.getByRole('button', { name: 'Map tools', exact: true }).click();
      await expect(page.locator('.map-sources')).toHaveCount(0);
      await page.getByRole('button', { name: '2D map', exact: true }).click();
      await expect(page.getByRole('button', { name: '2D map', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: '3D map', exact: true }).click();
      await expect(page.getByRole('button', { name: 'North up', exact: true })).toBeVisible();
      await page.getByRole('combobox', { name: 'Weather lens', exact: true }).selectOption('wind');
      await expect(page.getByRole('combobox', { name: 'Weather lens', exact: true })).toHaveValue('wind');
      const showDays = page.getByRole('button', { name: 'Show daily forecast', exact: true });
      await expect(showDays).toBeVisible();
      await showDays.click();
      await expect(page.getByRole('button', { name: 'Hide daily forecast', exact: true })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Forecast days', exact: true })).toBeVisible();
      await assertViewport(page, { primary: [{ selector: '[data-api="1"]', minWidth: 250, minHeight: 60 }], controls: [{ selector: '[aria-label="Hide daily forecast"]', minWidth: 30, minHeight: 30 }], screenshotPath: info.outputPath('forecast-open.png') });
      await page.getByRole('button', { name: 'Hide daily forecast', exact: true }).click();
      await expect(page.getByRole('list', { name: 'Forecast days', exact: true })).toBeHidden();
      await page.getByRole('button', { name: 'Map tools', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Map tools', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Map tools', exact: true }).click();
      await stage.click({ position: { x: 24, y: (await stage.boundingBox())!.height * .5 } });
      await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeHidden();
      await page.setViewportSize({ width: 1280, height: 720 });
      await expect(page.locator('[data-map-density="normal"]')).toBeVisible();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(page.locator('[data-map-density="compact"]')).toBeVisible();
      if (viewport.name === 'phone' && theme === 'light') {
        await stage.evaluate((element: any) => element.chartApi.setView(-31.95, 115.86, .12));
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const bounds = (await stage.boundingBox())!;
        await stage.locator('canvas[tabindex="0"]').click({ position: { x: bounds.width * .5, y: bounds.height * .45 } });
        await expect(page.locator('[data-point-panel]')).toBeVisible();
        await page.getByRole('button', { name: 'Map tools', exact: true }).click();
        const slice = page.getByRole('button', { name: 'Terrain and atmosphere slice', exact: true });
        await expect(slice).toBeEnabled();
        await slice.click();
        await expect(stage).toHaveAttribute('data-slice', 'ready', { timeout: 45000 });
        await page.getByRole('button', { name: 'Map tools', exact: true }).click();
        await expect(slice).toBeVisible();
        await page.getByRole('slider', { name: 'Slice position', exact: true }).fill('30');
        await expect(page.getByRole('slider', { name: 'Slice position', exact: true })).toHaveValue('30');
        await page.getByRole('button', { name: 'Map tools', exact: true }).click();
        await atmosphere.click();
        await expect(page.getByRole('button', { name: 'Map tools', exact: true })).toBeHidden();
        await expect(page.locator('[data-point-panel]')).toBeHidden();
        await expect(slice).toBeVisible();
        await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeHidden();
        await expect(page.getByRole('button', { name: 'Data sources', exact: true })).toBeHidden();
        await expect(page.getByRole('button', { name: 'North up', exact: true })).toBeHidden();
        const slider = page.getByRole('slider', { name: 'Slice position', exact: true });
        await slider.fill('-30');
        await expect(slider).toHaveValue('-30');
        const sectionBox = (await page.locator('[data-atmosphere-instrument]').boundingBox())!;
        const sliceBox = (await page.locator('.map-slice-control').boundingBox())!;
        expect(sectionBox.y + sectionBox.height).toBeLessThanOrEqual(sliceBox.y);
        await page.screenshot({ path: info.outputPath('atmosphere-slice-open.png') });
        await slice.click();
        await expect(slider).toHaveCount(0);
        await expect(atmosphere).toBeFocused();
        const selectedPoint = await page.locator('[data-point-panel]').getAttribute('data-point-location');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-atmosphere-section]')).toHaveCount(0);
        await expect(page.locator('[data-point-panel]')).toBeVisible();
        await expect(page.locator('[data-point-panel]')).toHaveAttribute('data-point-location', selectedPoint!);
        await expect(page.getByRole('button', { name: 'Map tools', exact: true })).toBeFocused();
      }
      await page.goto('/history?event=everest-1953');
      await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
      await expect(page.locator('[data-map-page][data-history-mode="true"]')).toBeVisible();
      await expect(page.locator('[data-map-density="compact"]')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Back to present day', exact: true })).toBeVisible();
      await page.getByRole('link', { name: 'Back to present day', exact: true }).click();
      await expect(page.locator('[data-map-page][data-history-mode="true"]')).toHaveCount(0);
      await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
      await expect(page.locator('[data-map-density="compact"]')).toBeVisible();
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
      await expect(page.locator('[data-map-density="normal"]')).toBeVisible();
    }
  });
}
