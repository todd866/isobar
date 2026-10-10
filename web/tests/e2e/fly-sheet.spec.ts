import { expect, test, type Page } from '@playwright/test';

/**
 * Fly on a phone: one bottom sheet over the map, no cards inside it, nothing
 * clipped at the fold, and the map keeps at least 35 % of the viewport at peek.
 */

async function openFly(page: Page, width: number, height: number, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Fly', exact: true }).click();
  await page.waitForSelector('[data-fly-panel]');
  await page.waitForTimeout(400);
}

async function layout(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-fly-panel]') as HTMLElement;
    const map = document.querySelector('[data-map-panel]') as HTMLElement;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    // A card: a box with a border on every side and rounded corners.
    const cards = [...panel.querySelectorAll('*')].filter((el) => {
      const s = getComputedStyle(el);
      return visible(el) && parseFloat(s.borderTopWidth) > 0 && parseFloat(s.borderLeftWidth) > 0 && parseFloat(s.borderRightWidth) > 0
        && parseFloat(s.borderBottomWidth) > 0 && parseFloat(s.borderTopLeftRadius) > 0;
    }).length;
    const clipped = [...panel.querySelectorAll('button, span, canvas, [data-taf-timeline]'), ...document.querySelectorAll('[data-lens-bar] button')]
      .filter((el) => visible(el))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        // Elements scrolled inside the sheet are clipped by the sheet, not the viewport; check against both.
        const sheet = panel.getBoundingClientRect();
        const inSheet = panel.contains(el);
        const top = inSheet ? Math.max(0, sheet.top) : 0;
        const bottom = inSheet ? Math.min(vh, sheet.bottom) : vh;
        if (inSheet && (r.bottom <= sheet.top || r.top >= sheet.bottom)) return false; // scrolled out of the sheet body
        // The phone lens row scrolls. A segment parked off to the side is not
        // clipped; the selected lens must stay whole, and nothing may be cut vertically.
        if (!inSheet && el.closest('[data-lens-bar]')) {
          const bar = document.querySelector('[data-lens-bar]')!.getBoundingClientRect();
          const selected = el.getAttribute('aria-checked') === 'true';
          const vertical = r.top < -0.5 || r.bottom > vh + 0.5 || r.top < bar.top - 1 || r.bottom > bar.bottom + 1;
          const horizontal = r.left < bar.left - 0.5 || r.right > bar.right + 0.5;
          return vertical || (selected && horizontal);
        }
        return r.left < -0.5 || r.right > vw + 0.5 || r.top < top - 0.5 || r.bottom > bottom + 0.5;
      })
      .map((el) => `${el.tagName}.${(el as HTMLElement).dataset ? Object.keys((el as HTMLElement).dataset).join(',') : ''} ${(el.textContent ?? '').slice(0, 20)}`);
    const lens = document.querySelector('[data-lens-bar]')!.getBoundingClientRect();
    const sheet = panel.getBoundingClientRect();
    return {
      sheets: document.querySelectorAll('[data-fly-panel]').length,
      cards,
      clipped,
      mapShare: (sheet.top - map.getBoundingClientRect().top) / vh,
      sheetAboveLens: sheet.bottom <= lens.top + 0.5,
      detent: panel.dataset.flySheet,
      readout: (panel.querySelector('[data-fly-readout]') as HTMLElement | null)?.getBoundingClientRect().height ?? 0,
      section: (panel.querySelector('[data-sky-canvas="section"]') as HTMLElement | null)?.getBoundingClientRect().height ?? 0,
    };
  });
}

for (const [width, height] of [[390, 844], [375, 667]] as const) for (const theme of ['light', 'dark'] as const) {
  test(`Fly sheet ${width}x${height} ${theme}: one sheet, no nested cards, nothing clipped, map ≥ 35 % at peek`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openFly(page, width, height, theme);
    const peek = await layout(page);
    expect(peek.detent).toBe('peek');
    await expect(page.getByRole('button', { name: 'Close Fly', exact: true })).toBeVisible();
    expect(peek.sheets).toBe(1);
    expect(peek.cards).toBe(0);
    expect(peek.clipped).toEqual([]);
    expect(peek.sheetAboveLens).toBe(true);
    expect(peek.mapShare).toBeGreaterThanOrEqual(0.35);
    expect(peek.readout).toBeGreaterThan(20);

    await page.locator('[data-sheet-grabber]').click();
    await expect(page.locator('[data-fly-panel]')).toHaveAttribute('data-fly-sheet', 'full');
    await page.waitForTimeout(400);
    const full = await layout(page);
    expect(full.sheets).toBe(1);
    expect(full.cards).toBe(0);
    expect(full.clipped).toEqual([]);
    expect(full.section).toBeGreaterThan(125);
    // The time slider stays above the expanded sheet.
    const slider = (await page.locator('[data-timeline]').boundingBox())!;
    const sheetTop = (await page.locator('[data-fly-panel]').boundingBox())!.y;
    expect(slider.y + slider.height).toBeLessThanOrEqual(sheetTop);
    // The raw reports sit behind one disclosure.
    await expect(page.locator('[data-raw-reports] pre')).toHaveCount(0);
    await page.locator('[data-raw-reports] button').click();
    await expect(page.locator('[data-raw-reports] pre')).toHaveCount(1);

    await page.locator('[data-sheet-grabber]').click();
    await expect(page.locator('[data-fly-panel]')).toHaveAttribute('data-fly-sheet', 'peek');
    expect(errors).toEqual([]);
  });
}

test('Fly side panel on desktop draws the sky section', async ({ page }) => {
  await openFly(page, 1440, 900, 'light');
  const box = await page.locator('[data-sky-canvas="section"]').boundingBox();
  expect(box?.height).toBeGreaterThan(200);
  expect(box?.width).toBeGreaterThan(300);
  const painted = await page.locator('[data-sky-canvas="section"]').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 400) if (data[i] > 0) lit++;
    return lit;
  });
  expect(painted).toBeGreaterThan(100);
});

// Frame interval assumes a quiet machine (`--workers=1`). A shared worker under
// load can push p95 from about 16.7 ms to about 33 ms. Do not lower the budget.
test('Fly sheet scrub on a phone: sky frame work and frame interval', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Fly scrub browser error:', error.stack); });
  await openFly(page, 390, 844, 'light');
  await page.locator('[data-sheet-grabber]').click();
  await expect(page.locator('[data-fly-panel]')).toHaveAttribute('data-fly-sheet', 'full');
  await page.waitForTimeout(300);
  const slider = page.locator('[data-timeline]');
  const box = (await slider.boundingBox())!;
  const probe = page.evaluate(() => new Promise<number[]>((resolve) => {
    const deltas: number[] = [];
    let last = performance.now();
    const start = last;
    const tick = (now: number) => { deltas.push(now - last); last = now; if (now - start < 3000) requestAnimationFrame(tick); else resolve(deltas.slice(1)); };
    requestAnimationFrame(tick);
  }));
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 0; i <= 120; i++) {
    await page.mouse.move(box.x + 4 + ((box.width - 8) * (i % 60)) / 60, box.y + box.height / 2);
  }
  await page.mouse.up();
  const deltas = await probe;
  const work = await page.locator('[data-sky-canvas="section"]').evaluate((canvas) => (canvas as HTMLCanvasElement & { skyStats?: { frames: number[] } }).skyStats?.frames ?? []);
  const p95 = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length * 0.95)] ?? 0;
  console.log(`fly scrub: frame interval p95 ${p95(deltas).toFixed(1)} ms over ${deltas.length}; sky work p95 ${p95(work).toFixed(2)} ms over ${work.length} frames`);
  expect(work.length).toBeGreaterThan(0);
  expect(p95(work)).toBeLessThanOrEqual(8);
  expect(errors).toEqual([]);
});
