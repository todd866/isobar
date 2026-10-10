import { expect, test, type Page } from '@playwright/test';

/**
 * Terrain (docs/design/terrain-and-sections.md, phase 1): zoomed in on the
 * Cascades and the Darling Range the land shows relief, the coast is crisp and
 * sits on the 1:10m coastline, town names are not repeated, missing tiles
 * leave a flat tint without errors, and panning with terrain on holds 60 fps.
 * Needs the network (Mapterhorn tiles); the offline journey blocks it.
 *
 * The pan/zoom budget runs in the frame-time Playwright project: one worker,
 * one retry, after the rest of the suite. A shared worker under load can push
 * p95 from about 16.7 ms to about 33 ms. Do not lower the 16.8 ms budget.
 */

type Cam = { centerX: number; centerY: number; halfWidth: number; halfHeight: number };
type Stats = { z: number | null; needed: number; loaded: number; missing: number; mosaics: number; covered: number; painted?: boolean };
type Plate = { width: number; height: number; data: Uint8ClampedArray };
type Api = {
  setView: (lat: number, lon: number, h: number) => void;
  camera: () => Cam;
  terrain: () => Stats | null;
  places: () => { ready: boolean; names: string[] };
  placeNames: () => string[];
  readPlate: () => Promise<Plate | null>;
  redraw: () => void;
};
const SEATTLE = { lat: 47.7, lon: -122.2 };
const PERTH = { lat: -31.95, lon: 116.1 };

async function open(page: Page, width = 1440, height = 900) {
  await page.addInitScript(() => localStorage.setItem('isobar-theme', 'light'));
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
  await page.waitForFunction(() => !!(document.querySelector('[data-api="1"]') as HTMLElement & { chartApi?: unknown })?.chartApi);
  // Hold the clock: the plate is compared across screenshots.
  await page.getByRole('button', { name: /pause/i }).first().click().catch(() => {});
}

async function view(page: Page, at: { lat: number; lon: number }, height = 8) {
  await page.evaluate(({ lat, lon, h }) => {
    (document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: Api }).chartApi.setView(lat, lon, h);
  }, { ...at, h: height });
}

/** Waits until the settled mosaic has been uploaded and drawn, and optionally until town names are drawn. */
async function settled(page: Page, places = false): Promise<Stats> {
  await page.waitForFunction((needPlaces) => {
    const api = (document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: Api }).chartApi;
    const stats = api.terrain();
    return !!stats?.painted && (!needPlaces || api.places().ready);
  }, places, { timeout: 60_000 });
  return page.evaluate(() => (document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: Api }).chartApi.terrain() as Stats);
}

/** Samples the WebGL plate after the next presented frame. */
async function plate<T>(page: Page, measure: string, arg: unknown): Promise<T> {
  return page.evaluate(async ({ measure, arg }) => {
    const api = (document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: Api }).chartApi;
    const image = await api.readPlate();
    if (!image) throw new Error('plate unavailable');
    const pixels = image.data;
    const cam = api.camera();
    // World plate: equirectangular, central meridian 0, unit scale.
    const toPx = (lat: number, lon: number) => ({
      x: Math.round(((lon - cam.centerX) / cam.halfWidth + 1) / 2 * image.width),
      y: Math.round((1 - (lat - cam.centerY) / cam.halfHeight) / 2 * image.height),
    });
    const lum = (x: number, y: number) => { const i = (y * image.width + x) * 4; return 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]; };
    const fn = new Function('toPx', 'lum', 'pixels', 'width', 'height', 'arg', measure);
    return fn(toPx, lum, pixels, image.width, image.height, arg);
  }, { measure, arg }) as Promise<T>;
}

/** Luminance standard deviation over a lat/lon box. */
const VARIANCE = `
  const a = toPx(arg.north, arg.west), b = toPx(arg.south, arg.east);
  let n = 0, sum = 0, sq = 0;
  for (let y = a.y; y < b.y; y += 2) for (let x = a.x; x < b.x; x += 2) { const v = lum(x, y); n++; sum += v; sq += v * v; }
  const mean = sum / n;
  return { std: Math.sqrt(Math.max(0, sq / n - mean * mean)), mean, n };
`;

const CASCADES = { north: 48.6, south: 46.6, west: -122.0, east: -120.6 };
const DARLING = { north: -31.6, south: -32.4, west: 115.9, east: 116.4 };

test.describe('terrain', () => {
  test.setTimeout(180_000);

  test('Seattle: relief, crisp coast on the coastline, no repeated names', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await open(page);
    await view(page, SEATTLE);
    const stats = await settled(page, true);
    expect(stats.loaded).toBeGreaterThan(4);
    const relief = await plate<{ std: number }>(page, VARIANCE, CASCADES);
    expect(relief.std, 'Cascades show relief').toBeGreaterThan(6);

    // The coast along 45.6°N (Oregon): plate edge narrow and on the vector coastline.
    const scan = `
      const y = toPx(arg.lat, 0).y;
      const sea = [233, 239, 244];
      const isSea = (x) => { const i = (y * width + x) * 4; return Math.abs(pixels[i] - sea[0]) + Math.abs(pixels[i + 1] - sea[1]) + Math.abs(pixels[i + 2] - sea[2]) < 10; };
      const from = toPx(arg.lat, arg.west).x, to = toPx(arg.lat, arg.east).x;
      let lastSea = -1, firstLand = -1;
      for (let x = from; x < to; x++) { if (isSea(x)) lastSea = x; else if (lastSea >= 0 && firstLand < 0) { const i = (y * width + x) * 4; if (pixels[i + 2] < 200) { firstLand = x; break; } } }
      return { lastSea, firstLand, y };
    `;
    const edge = await plate<{ lastSea: number; firstLand: number; y: number }>(page, scan, { lat: 45.6, west: -125, east: -122.5 });
    expect(edge.lastSea).toBeGreaterThan(0);
    expect(edge.firstLand - edge.lastSea, 'coast is crisp').toBeLessThanOrEqual(5);
    // The vector coastline on the overlay crosses the same row within a few pixels.
    const line = await page.evaluate(({ y, near }) => {
      const root = document.querySelector('[data-api="1"]')!;
      const plateCanvas = root.querySelector('canvas[data-chart-layer="webgl"]') as HTMLCanvasElement;
      const overlay = root.querySelector('canvas[aria-label]') as HTMLCanvasElement;
      const ctx = overlay.getContext('2d');
      if (!ctx || !plateCanvas.height) return Infinity;
      const scale = overlay.width / plateCanvas.width;
      const yy = Math.max(0, Math.min(overlay.height - 1, Math.round(y * (overlay.height / plateCanvas.height))));
      const row = ctx.getImageData(0, yy, overlay.width, 1).data;
      const centre = near * scale;
      let best = Infinity;
      // The thin coast stroke is anti-aliased: darker than the plate, not black.
      for (let x = Math.max(0, Math.floor(centre - 30 * scale)); x < Math.min(overlay.width, Math.ceil(centre + 30 * scale)); x++) {
        if (row[x * 4] + row[x * 4 + 1] + row[x * 4 + 2] < 420 && Math.abs(x - centre) < Math.abs(best - centre)) best = x;
      }
      return best / scale;
    }, { y: edge.y, near: edge.lastSea });
    expect(Math.abs(line - edge.lastSea), 'plate coast sits on the 1:10m coastline').toBeLessThanOrEqual(8);

    const names = await page.evaluate(() => (document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: Api }).chartApi.placeNames());
    expect(names).toContain('Seattle');
    expect(new Set(names).size, `no repeated names: ${names.join(', ')}`).toBe(names.length);
    const vancouvers = names.filter((name) => name.startsWith('Vancouver'));
    expect(vancouvers.sort()).toEqual(['Vancouver', 'Vancouver WA']);
    expect(errors).toEqual([]);
  });

  test('Perth: the Darling Range shows', async ({ page }) => {
    await open(page);
    await view(page, PERTH);
    await settled(page);
    const relief = await plate<{ std: number }>(page, VARIANCE, DARLING);
    expect(relief.std, 'scarp and plateau differ from the coastal plain').toBeGreaterThan(2);
  });

  test('offline tiles: flat tint, no errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !/mapterhorn|Failed to load resource/.test(`${message.text()} ${message.location().url}`)) errors.push(message.text());
    });
    await page.context().route('https://tiles.mapterhorn.com/**', (route) => route.abort('internetdisconnected'));
    await open(page);
    await view(page, SEATTLE);
    const stats = await settled(page);
    expect(stats.loaded).toBe(0);
    expect(stats.covered).toBe(0);
    const flat = await plate<{ std: number }>(page, VARIANCE, CASCADES);
    expect(flat.std, 'no invented relief').toBeLessThan(1);
    expect(errors).toEqual([]);
  });

  for (const device of [{ name: 'desktop', width: 1440, height: 900, cpu: 1 }, { name: 'phone', width: 390, height: 844, cpu: 4 }]) {
    test(`pan and zoom with terrain at 60 fps (${device.name}${device.cpu > 1 ? `, CPU ÷${device.cpu}` : ''})`, async ({ page }) => {
      // TERRAIN_BASELINE=1 blocks the tiles: the same journey on the flat plate, for comparison.
      if (process.env.TERRAIN_BASELINE) await page.context().route('https://tiles.mapterhorn.com/**', (route) => route.abort());
      await open(page, device.width, device.height);
      await view(page, SEATTLE);
      await settled(page);
      const client = await page.context().newCDPSession(page);
      if (device.cpu > 1) await client.send('Emulation.setCPUThrottlingRate', { rate: device.cpu });
      const box = (await page.locator('[data-api="1"]').boundingBox())!;
      const measure = () => page.evaluate((duration) => new Promise<{ p50: number; p95: number; max: number; count: number; longTasks: number[] }>((resolve) => {
        const longTasks: number[] = [];
        const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => longTasks.push(Math.round(entry.duration))));
        observer.observe({ type: 'longtask' });
        const deltas: number[] = [];
        let last = performance.now();
        const start = last;
        const tick = (now: number) => {
          deltas.push(now - last);
          last = now;
          if (now - start < duration) requestAnimationFrame(tick);
          else {
            observer.disconnect();
            const sorted = deltas.slice(1).sort((a, b) => a - b);
            const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
            resolve({ p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1], count: sorted.length, longTasks });
          }
        };
        requestAnimationFrame(tick);
      }), 3500);
      // Pan east and back across new tiles.
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      // Press first: the press pauses playback, a React re-render that predates terrain
      // (one ~55 ms task at CPU ÷4 with or without tiles). The drag is what is measured.
      await page.mouse.down();
      await page.waitForTimeout(200);
      let measuring = measure();
      await page.mouse.move(cx - box.width * 0.4, cy - 40, { steps: 60 });
      await page.mouse.move(cx, cy, { steps: 60 });
      const pan = await measuring;
      // Release resumes playback: the same pre-existing re-render, outside the window.
      await page.mouse.up();
      await page.waitForTimeout(300);
      // Wheel out to synoptic scale (~35° tall: relief fades, coarser tiles) and back in.
      measuring = measure();
      await page.keyboard.down('Control');
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 30); await page.waitForTimeout(120); }
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -30); await page.waitForTimeout(120); }
      await page.keyboard.up('Control');
      const zoom = await measuring;
      if (device.cpu > 1) await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await client.detach();
      console.log(`${device.name} terrain`, JSON.stringify({ pan, zoom }));
      for (const [name, result] of Object.entries({ pan, zoom })) {
        // rAF timestamps are quantised: a steady 60 Hz reads 16.6–16.8 ms.
        expect.soft(Math.round(result.p95 * 10) / 10, `${device.name} ${name} p95 frame interval`).toBeLessThanOrEqual(16.8);
        expect.soft(result.longTasks.filter((ms) => ms > 50), `${device.name} ${name} long tasks`).toEqual([]);
      }
    });
  }
});
