import { test, expect, type Page } from '@playwright/test';

// Real controller/browser actions against a global-size, long-horizon fixture.
// Synthetic values are only acceptance evidence, never a weather claim.
async function install(page: Page) {
  const run = new Date(Date.now() - 4 * 3600000).toISOString();
  const hours = [...Array.from({ length: 49 }, (_, i) => i * 3), 150, 156, 162, 168];
  const names = ['mslp', 'rain24', 't2m', 'wind', 'u10', 'v10', 'tcc'];
  const nx = 720, ny = 361;
  const requests: string[] = [];
  let releaseRain: (() => void) | undefined;
  let rainGate: Promise<void> | null = null;
  let failRain = false;
  const bodies = new Map<string, Buffer>();
  for (const name of names) {
    const raw = new Uint16Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const value = name === 'mslp' ? 1010 + 15 * Math.cos(i / 45) * Math.sin(j / 40)
        : name === 'rain24' ? 3 + 2 * Math.cos(i / 80)
        : name === 't2m' ? -30 + j / 4 : name === 'wind' ? 18 : name === 'tcc' ? 40 : 5;
      raw[j * nx + i] = Math.round((value + 100) * 10);
    }
    bodies.set(name, Buffer.from(raw.buffer));
  }
  await page.route('https://tiles.mapterhorn.com/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/auth/**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/usage', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/data/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('manifest.json')) return route.fulfill({ json: {
      schema: 2, contract: 'isobar-web', run, generated: run, forecast_hours: hours,
      grid: { west: -180, east: 179.5, north: 90, south: -90, step: 0.5, nx, ny, dtype: 'uint16', wraps_longitude: true },
      variables: Object.fromEntries(names.map((name) => [name, { frames: hours.map((h) => `frames/${name}/f${String(h).padStart(3, '0')}.u16`), units: name === 't2m' ? 'C' : 'x', scale: 0.1, offset: -100, fill: 65535 }])),
      places: [{ id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.86, icao: 'YPPH' }],
      aviation: 'aviation.json', points: 'points.json', attribution: [{ source: 'Synthetic global loading fixture', licence: 'test' }],
    } });
    if (url.pathname.endsWith('aviation.json')) return route.fulfill({ json: { airports: [], sigmets: [] } });
    if (url.pathname.endsWith('points.json')) return route.fulfill({ json: { run, hours, places: { perth: {
      t: hours.map((hour) => 18 + 5 * Math.sin(hour / 12)), wspd: hours.map(() => 12),
      wdir: hours.map(() => 270), tp: hours.map((hour) => hour / 4), cc: hours.map(() => 40),
    } } } });
    const name = url.pathname.split('/')[3];
    if (!bodies.has(name)) return route.fulfill({ status: 404, body: '' });
    requests.push(url.pathname);
    if (name === 'rain24') {
      if (rainGate) await rainGate;
      if (failRain) return route.fulfill({ status: 503, body: '' });
    }
    return route.fulfill({ body: bodies.get(name)!, contentType: 'application/octet-stream' });
  });
  return { requests, holdRain: () => { rainGate = new Promise<void>((resolve) => { releaseRain = resolve; }); },
    release: () => { releaseRain?.(); rainGate = null; }, failRain: (fail: boolean) => { failRain = fail; } };
}
async function cache(page: Page) {
  return page.locator('[data-api="1"]').evaluate((node) => (node as HTMLElement & { chartApi: { cache: () => { bytes: number; frames: number; limit: number; active: number; queued: number } } }).chartApi.cache());
}
async function view(page: Page) {
  return page.locator('[data-api="1"]').evaluate((node) => (node as HTMLElement & { chartApi: { camera: () => unknown } }).chartApi.camera());
}
async function idle(page: Page) {
  await expect.poll(async () => { const c = await cache(page); return c.active + c.queued; }).toBe(0);
}
async function open(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-isobars="true"]')).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await idle(page);
}

test('cold modes, distant time, pan and warm offline revisit preserve the map within a memory budget', async ({ page }) => {
  const f = await install(page);
  try {
    await open(page);
    expect((await cache(page)).frames).toBeLessThanOrEqual(15);
    const stage = page.locator('[data-api="1"]');
    // A generated shader failure must not pass unnoticed via Canvas fallback.
    if (process.env.ISOBAR_E2E_SINGLE_PROCESS !== '1') await expect(stage).toHaveAttribute('data-renderer', 'webgl2');
    await stage.evaluate((node) => (node as HTMLElement & { chartApi: { setView: (lat: number, lon: number, height: number) => void } }).chartApi.setView(-31.95, 115.86, 8));
    await expect.poll(() => stage.evaluate((node) => (node as HTMLElement & { chartApi: { placeNames: () => string[] } }).chartApi.placeNames().some((name) => name.startsWith('Perth')))).toBe(true);
    const box = (await stage.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForTimeout(250);
    const before = await view(page);
    const time = await page.getByRole('slider', { name: 'Forecast time' }).getAttribute('aria-valuenow');
    f.holdRain();
    await page.locator('[data-lens="rain"]').first().click();
    await expect(page.locator('[data-legend="loading"]')).toBeVisible();
    await expect(page.getByRole('status', { name: '24 h rain loading for selected time' })).toBeVisible();
    expect(await view(page)).toEqual(before);
    expect(await page.getByRole('slider', { name: 'Forecast time' }).getAttribute('aria-valuenow')).toBe(time);
    f.release();
    await expect(page.locator('[data-legend="ready"]')).toBeVisible();
    await idle(page);
    for (const lens of ['temp', 'wind', 'pressure', 'rain']) {
      await page.locator(`[data-lens="${lens}"]`).first().click();
      await expect(page.locator('[data-legend="ready"]')).toBeVisible();
      await idle(page);
      expect(await view(page)).toEqual(before);
      const c = await cache(page); expect(c.bytes).toBeLessThanOrEqual(c.limit);
    }
    const slider = page.getByRole('slider', { name: 'Forecast time' });
    await slider.focus();
    await page.keyboard.press('End');
    await expect(page.locator('[data-legend="ready"]')).toBeVisible(); await idle(page);
    const c = await cache(page); expect(c.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 30, { steps: 6 }); await page.mouse.up();
    const panned = await view(page);
    const count = f.requests.length;
    await page.context().setOffline(true);
    await page.locator('[data-lens="pressure"]').first().click();
    await page.locator('[data-lens="rain"]').first().click();
    await expect(page.locator('[data-legend="ready"]')).toBeVisible();
    expect(await view(page)).toEqual(panned);
    expect(f.requests).toHaveLength(count);
  } finally { f.release(); await page.context().setOffline(false); }
});

test('failed field has explicit retry and recovers without moving the camera', async ({ page }) => {
  const f = await install(page);
  await open(page);
  f.failRain(true);
  const before = await view(page);
  await page.locator('[data-lens="rain"]').first().click();
  await expect(page.locator('[data-legend="error"]')).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry weather for selected time' });
  await expect(retry).toBeVisible();
  f.failRain(false);
  await retry.click();
  await expect(page.locator('[data-legend="ready"]')).toBeVisible();
  await expect(retry).toHaveCount(0);
  expect(await view(page)).toEqual(before);
});

test('enlarged phone readings stay separate and the selected mode remains reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await install(page);
  await open(page);
  await page.locator('[data-lens="temp"]').first().click();
  await expect(page.locator('[data-legend="ready"]')).toHaveCount(1);
  await expect(page.locator('.map-legend-scale')).toBeVisible();
  await page.evaluate(() => {
    const elements = [...document.querySelectorAll<HTMLElement>('*')].filter((element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()));
    const sizes = elements.map((element) => [element, parseFloat(getComputedStyle(element).fontSize)] as const);
    for (const [element, size] of sizes) element.style.fontSize = `${size * 2}px`;
  });
  await expect(page.locator('[data-map-page]')).toBeVisible();
  const lens = page.getByRole('combobox', { name: 'Weather lens', exact: true });
  await expect(lens).toBeVisible();
  await expect(lens).toHaveValue('temp');
  await expect.poll(() => page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const legend = box('.map-legend'), ask = box('[aria-label="Ask Isobar"]');
    const label = box('[data-timeline-label]');
    const clockFits = [...document.querySelectorAll('.map-clock-slot .map-clock > span')].every((node) => {
      const r = node.getBoundingClientRect();
      return r.left >= label.left - 1 && r.right <= label.right + 1;
    });
    const selected = box('[aria-label="Weather lens"]');
    return { clockFits, legendFits: legend.bottom <= ask.top || legend.right <= ask.left,
      labelFits: label.left >= 0 && label.right <= innerWidth,
      selectedFits: selected.left >= 0 && selected.right <= innerWidth,
    };
  })).toEqual({ clockFits: true, legendFits: true, labelFits: true, selectedFits: true });
  await page.screenshot({ path: test.info().outputPath('phone-200-percent.png') });
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const menu = page.locator('[data-map-menu]');
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeFocused();
  await expect(lens).toBeVisible();
  await lens.selectOption('wind');
  await expect(lens).toHaveValue('wind');
  await expect(page.getByRole('combobox', { name: 'Speed' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Forecast time' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('phone-200-percent-map-first.png') });
});
