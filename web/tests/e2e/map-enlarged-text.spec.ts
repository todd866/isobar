import { historyRoutes } from './history-layout-fixture';
import { test, expect } from '@playwright/test';

test.setTimeout(120_000);
test.use({ screenshot: 'only-on-failure' });

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
    const transportSelector = '.map-bottom-bar button[aria-label="Pause"], .map-bottom-bar button[aria-label="Play"]';
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
    // Bounds alone miss a floating chip intercepting another control.
    const assertChromeSeparation = async () => {
      const overlaps = await page.evaluate(() => {
        const selectors = ['.map-header-place', '.map-header-actions', '.map-lens-wrap', '.map-bottom-bar', '.map-tools', '[data-atmosphere-instrument]'];
        const boxes = selectors.flatMap(selector => {
          const node = document.querySelector<HTMLElement>(selector);
          if (!node || !node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') return [];
          return [{ selector, box: node.getBoundingClientRect() }];
        });
        return boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b => a.box.left < b.box.right - 1 && a.box.right > b.box.left + 1 && a.box.top < b.box.bottom - 1 && a.box.bottom > b.box.top + 1).map(b => `${a.selector} overlaps ${b.selector}`));
      });
      expect(overlaps, 'floating controls must remain independently reachable').toEqual([]);
    };
    await assertChromeSeparation();
    const compact = viewport.width < 700 || viewport.height < 620;
    if (compact) {
      const speed = page.getByRole('combobox', { name: 'Speed' });
      if (viewport.name === 'landscape') {
        const width = await page.locator('.forecast-days').evaluate(node => node.getBoundingClientRect().width);
        expect(width, 'scrollable scrubber remains reachable').toBeGreaterThan(40);
      }
      // Daily forecasts now live in the always-visible, horizontally scrolling timeline.
      const days = page.getByRole('list', { name: 'Forecast days' }).getByRole('listitem');
      await expect(days).toHaveCount(7);
      for (const day of [days.first(), days.last()]) {
        await day.scrollIntoViewIfNeeded();
        await expect(day).toHaveAttribute('aria-label', /High \d+°, low \d+°/);
        const label = await day.locator('.day-name:visible').boundingBox();
        const host = (await page.locator('.forecast-days').boundingBox())!;
        expect(label!.x).toBeGreaterThanOrEqual(host.x - 1);
        expect(label!.x + label!.width).toBeLessThanOrEqual(host.x + host.width + 1);
      }
      await days.first().scrollIntoViewIfNeeded();
      await speed.selectOption('256');
      await expect(speed).toHaveValue('256');
      await page.getByRole('button', { name: 'Now', exact: true }).click();
      await expect(speed).toHaveValue('0');
      await assertViewport(page, { primary: [{ selector: '[data-api="1"]', minWidth: 250, minHeight: 60 }], controls: [{ selector: '.map-bottom-bar select', minWidth: 36, minHeight: 36 }, { selector: '.map-bottom-bar [data-time-reset]', minWidth: 36, minHeight: 36 }], screenshotPath: info.outputPath('realtime-200pct.png') });
      await speed.selectOption('8');
      await expect(page.getByRole('button', { name: 'Map tools', exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Weather lens', exact: true })).toBeVisible();
      await expect(page.locator('[data-map-page] [data-map-ready]')).toBeVisible();
      const exposed = await page.evaluate(() => {
        const stage = document.querySelector('[data-api="1"]')!.getBoundingClientRect();
        const stageArea = stage.width * stage.height;
        const overlays = [...document.querySelectorAll<HTMLElement>('.map-tools, [data-atmosphere-instrument], .map-legend, [aria-label="Ask Isobar"]')]
          .filter(node => getComputedStyle(node).display !== 'none')
          .reduce((sum, node) => {
            const box = node.getBoundingClientRect();
            const width = Math.max(0, Math.min(box.right, stage.right) - Math.max(box.left, stage.left));
            const height = Math.max(0, Math.min(box.bottom, stage.bottom) - Math.max(box.top, stage.top));
            return sum + width * height;
          }, 0);
        return { mapShare: stage.height / innerHeight, overlayShare: overlays / Math.max(1, stageArea) };
      });
      await test.info().attach('visible-map-area', { body: JSON.stringify(exposed), contentType: 'application/json' });
      expect(exposed.mapShare, 'enlarged text must leave at least half the phone viewport for the map').toBeGreaterThan(0.5);
      expect(exposed.overlayShare, `closed secondary overlays must stay below 20% of map area (${JSON.stringify(exposed)})`).toBeLessThan(0.2);
      await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Map details', exact: true })).toBeHidden();
      await expect(page.locator('[data-secondary-control="recenter"]')).toBeHidden();
      await page.getByRole('button', { name: 'Map tools', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Map details', exact: true })).toBeVisible();
      const atmosphere = page.getByRole('button', { name: 'Atmospheric section', exact: true });
      await expect(atmosphere).toBeVisible();
      await assertChromeSeparation();
      {
        await atmosphere.click();
        await expect(page.locator('[data-atmosphere-section]')).toBeVisible();
        await expect(page.locator('[data-map-tools]')).toBeHidden();
        await assertChromeSeparation();
        await page.screenshot({ path: info.outputPath('atmosphere-open.png') });
        // Neutral header padding remains available when compact mode omits weather readings.
        await expect(page.locator('[data-map-page]')).toBeVisible();
        await expect(page.locator('[data-atmosphere-section]')).toBeVisible();
        await page.getByRole('button', { name: 'Close atmospheric section', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Map tools', exact: true })).toBeFocused();
        // Closing the section restores the tools that opened it.
        await expect(page.getByRole('button', { name: 'Map tools', exact: true })).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('[data-atmosphere-section]')).toHaveCount(0);
      }
      await page.getByRole('button', { name: 'Map details', exact: true }).click();
      await expect(page.locator('.map-details')).toBeVisible();
      await page.getByRole('button', { name: 'Map tools', exact: true }).click();
      await expect(page.locator('.map-details')).toHaveCount(0);
      await page.getByRole('button', { name: '2D map', exact: true }).click();
      await expect(page.getByRole('button', { name: '2D map', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: '3D map', exact: true }).click();
      await expect(page.getByRole('button', { name: 'North up', exact: true })).toBeVisible();
      await page.getByRole('combobox', { name: 'Weather lens', exact: true }).selectOption('wind');
      await expect(page.getByRole('combobox', { name: 'Weather lens', exact: true })).toHaveValue('wind');
      await assertViewport(page, { primary: [{ selector: '[data-api="1"]', minWidth: 250, minHeight: 60 }], controls: [{ selector: '[aria-label="Menu"]', minWidth: 30, minHeight: 30 }], screenshotPath: info.outputPath('forecast-open.png') });
      await page.getByRole('button', { name: 'Map tools', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Map tools', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Map tools', exact: true }).click();
      // The left edge is now the floating lens column; use exposed map.
      await stage.locator('canvas[tabindex="0"]').click({ position: { x: 100, y: (await stage.boundingBox())!.height * .65 } });
      await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeHidden();
      await page.setViewportSize({ width: 1280, height: 720 });
      await expect(page.locator('[data-map-page] [data-map-ready]')).toBeVisible();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(page.locator('[data-map-page] [data-map-ready]')).toBeVisible();
      if (viewport.name === 'phone' && theme === 'light') {
        // The earlier outside-tools map click selected a point. Close its sheet
        // before selecting another point; enlarged WebKit sheets cover this tap.
        const closePoint = page.getByRole('button', { name: 'Close point', exact: true });
        if (await closePoint.isVisible()) await closePoint.click();
        await expect(page.locator('[data-point-panel]')).toHaveCount(0);
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
        await expect(page.getByRole('button', { name: 'Map details', exact: true })).toBeHidden();
        await expect(page.getByRole('button', { name: 'North up', exact: true })).toBeHidden();
        const slider = page.getByRole('slider', { name: 'Slice position', exact: true });
        await slider.fill('-30');
        await expect(slider).toHaveValue('-30');
        const sectionBox = (await page.locator('[data-atmosphere-instrument]').boundingBox())!;
        const sliceBox = (await page.locator('.map-slice-control').boundingBox())!;
        expect(sectionBox.y + sectionBox.height).toBeLessThanOrEqual(sliceBox.y);
        await assertChromeSeparation();
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
      await historyRoutes(page);
      await page.goto('/history?event=dday');
      await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
      await expect(page.locator('[data-map-page][data-history-mode="true"]')).toBeVisible();
      await expect(page.locator('[data-map-page] [data-map-ready]')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Back to present day', exact: true })).toBeVisible();
      await page.getByRole('link', { name: 'Back to present day', exact: true }).click();
      await expect(page.locator('[data-map-page][data-history-mode="true"]')).toHaveCount(0);
      await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
      await expect(page.locator('[data-map-page] [data-map-ready]')).toBeVisible();
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
      await expect(page.locator('[data-map-page] [data-map-ready]')).toBeVisible();
    }
  });
}
