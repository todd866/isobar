import { expect, test, type Page } from '@playwright/test';
import { cameraInside, frameData } from '../../src/lib/camera';
import { globalEquirectangular, project, type Camera } from '../../src/lib/lambert';

/**
 * The map never shows past the data. The published grid is the global 0.5°
 * ladder (720×361, longitude wraps). The home view is framed on the home
 * place. Zoom and pan stay inside that grid: no page background at the edges,
 * and no blank margin past the poles when the camera is clamped.
 */

const GEO = globalEquirectangular();

interface GridFile {
  nx: number;
  ny: number;
  west: number;
  east: number;
  south: number;
  north: number;
  wraps_longitude?: boolean;
}
interface ManifestFile {
  grid: GridFile;
  places: { id: string; name: string; lat: number; lon: number }[];
}

async function open(page: Page, width: number, height: number, theme: 'light' | 'dark' = 'light') {
  await page.addInitScript((mode) => localStorage.setItem('isobar-theme', mode), theme);
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
  await page.waitForTimeout(400);
}

async function camera(page: Page): Promise<Camera> {
  return page.locator('[data-map-ready]').evaluate((e) => (e as HTMLElement & { chartApi: { camera: () => Camera } }).chartApi.camera());
}

async function manifest(page: Page): Promise<ManifestFile> {
  return page.evaluate(async () => (await fetch('/data/manifest.json')).json());
}

function dataBox(grid: GridFile) {
  return { west: grid.west, east: grid.east, south: grid.south, north: grid.north };
}

/** Fraction of samples along the stage's four edges whose colour is the chart plate (sea or land). */
async function plateAtEdges(page: Page): Promise<number> {
  // The moving wind streaks and aircraft sit above the plate; this check is about
  // the plate reaching the edges, so sample without those overlays.
  await page.evaluate(() => document.querySelectorAll<HTMLElement>('[data-flow-layer], [data-traffic-layer]').forEach((el) => { el.style.visibility = 'hidden'; }));
  const shot = await page.locator('[data-map-ready]').screenshot();
  await page.evaluate(() => document.querySelectorAll<HTMLElement>('[data-flow-layer], [data-traffic-layer]').forEach((el) => { el.style.visibility = ''; }));
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const plates = [[0xe9, 0xef, 0xf4], [0xf1, 0xec, 0xbb], [0x23, 0x2f, 0x3e], [0x66, 0x58, 0x39]];
    const inset = 6;
    const points: [number, number][] = [];
    for (let k = 1; k < 20; k += 1) {
      const fx = Math.round((image.width * k) / 20);
      const fy = Math.round((image.height * k) / 20);
      points.push([fx, inset], [fx, image.height - 1 - inset], [inset, fy], [image.width - 1 - inset, fy]);
    }
    let plate = 0;
    for (const [x, y] of points) {
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      if (plates.some(([pr, pg, pb]) => Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb) < 30)) plate += 1;
    }
    return plate / points.length;
  }, shot.toString('base64'));
}

/** The chart canvas covers the stage, so the page background cannot show as a margin. */
async function canvasCoversStage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-map-ready]')!.getBoundingClientRect();
    const canvas = [...document.querySelectorAll<HTMLCanvasElement>('canvas[data-chart-layer]')]
      .find((node) => getComputedStyle(node).display !== 'none');
    if (!canvas) return false;
    const box = canvas.getBoundingClientRect();
    return Math.abs(box.left - stage.left) <= 1 && Math.abs(box.top - stage.top) <= 1
      && Math.abs(box.right - stage.right) <= 1 && Math.abs(box.bottom - stage.bottom) <= 1;
  });
}

function insidePoles(view: Camera): boolean {
  return view.centerY - view.halfHeight >= -90 - 1e-3 && view.centerY + view.halfHeight <= 90 + 1e-3;
}

for (const [label, width, height] of [['desktop', 1440, 900], ['tablet', 1024, 768], ['phone', 393, 659]] as const) {
  test(`map stays inside the data grid: ${label}`, async ({ page }) => {
    await open(page, width, height);
    const file = await manifest(page);
    expect(file.grid.wraps_longitude, 'global wrapping grid').toBe(true);
    expect(file.grid.nx).toBe(720);
    expect(file.grid.ny).toBe(361);
    const box = dataBox(file.grid);
    const stage = (await page.locator('[data-map-ready]').boundingBox())!;
    const placeId = await page.getByRole('combobox', { name: 'Place', exact: true }).getAttribute('data-place');
    const place = file.places.find((item) => item.id === placeId);
    expect(place, 'home place').toBeTruthy();
    const expected = frameData(GEO, stage.width, stage.height, box, place!);
    const home = await camera(page);
    const point = project(GEO, place!.lat, place!.lon);
    expect(point, 'home place projects').toBeTruthy();
    expect(Math.abs(home.centerX - expected.home.centerX), 'framed on the home place').toBeLessThan(1);
    expect(Math.abs(home.centerY - expected.home.centerY), 'framed on the home place').toBeLessThan(1);
    expect(Math.abs(home.halfWidth - expected.home.halfWidth) / expected.home.halfWidth).toBeLessThan(0.02);
    expect(Math.abs(point!.x - home.centerX)).toBeLessThan(home.halfWidth * 0.25);
    expect(Math.abs(point!.y - home.centerY)).toBeLessThan(home.halfHeight * 0.25);
    expect(cameraInside(GEO, home, box)).toBe(true);
    expect(insidePoles(home)).toBe(true);
    expect(await canvasCoversStage(page)).toBe(true);
    // The home frame is open sea and land. A zoomed frame is crossed by isobars
    // and the coast, so the margin check after a move is the canvas and the poles.
    expect(await plateAtEdges(page)).toBeGreaterThan(0.8);

    const canvas = page.locator('canvas[tabindex="0"]');
    await canvas.focus();
    for (const key of ['-', '-', '-', '-']) await page.keyboard.press(key);
    expect(cameraInside(GEO, await camera(page), box)).toBe(true);
    expect(insidePoles(await camera(page))).toBe(true);
    for (const key of ['+', '+', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp']) {
      await page.keyboard.press(key);
      const view = await camera(page);
      expect(cameraInside(GEO, view, box), key).toBe(true);
      expect(insidePoles(view), key).toBe(true);
    }
    for (let k = 0; k < 12; k += 1) await canvas.dispatchEvent('wheel', { deltaX: -200, deltaY: -200, ctrlKey: true });
    const clamped = await camera(page);
    expect(cameraInside(GEO, clamped, box)).toBe(true);
    expect(insidePoles(clamped)).toBe(true);
    expect(await canvasCoversStage(page)).toBe(true);
  });
}

test('day tiles fit a 393 pt phone without overlap', async ({ page }) => {
  await open(page, 393, 659);
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const tiles = [...document.querySelectorAll('[aria-label="Forecast days"] > button')].map((tile) => tile.getBoundingClientRect());
    tiles.forEach((tile, index) => {
      const next = tiles[index + 1];
      if (next && tile.right > next.left + 0.5) out.push(`tile ${index} overlaps ${index + 1}`);
    });
    for (const tile of document.querySelectorAll('[aria-label="Forecast days"] > button')) {
      const t = tile.getBoundingClientRect();
      for (const el of tile.querySelectorAll('span')) {
        if (!el.textContent?.trim() || getComputedStyle(el).visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width && (r.left < t.left - 0.5 || r.right > t.right + 0.5)) out.push(`"${el.textContent.trim()}" leaves its tile`);
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push(`"${el.textContent.trim()}" truncated`);
      }
    }
    return out;
  });
  expect(problems).toEqual([]);
});

test('lens row: one lens at a time, never truncated', async ({ page }) => {
  for (const [width, height] of [[393, 659], [1440, 900]] as const) {
    await open(page, width, height);
    const lens = page.getByRole('radiogroup', { name: 'Lens' });
    await expect(lens.getByRole('radio')).toHaveCount(7);
    for (const label of ['Pressure', 'Rain', 'Wind', 'Temp', 'Kite', 'Surf', 'Fly']) {
      await expect(lens.getByRole('radio', { name: label, exact: true }).getByText(label, { exact: true })).toBeVisible();
    }
    await expect(lens.getByRole('radio', { name: 'Pressure' })).toHaveAttribute('aria-checked', 'true');
    await lens.getByRole('radio', { name: 'Rain' }).click();
    await expect(lens.getByRole('radio', { checked: true })).toHaveCount(1);
    await lens.getByRole('radio', { name: 'Fly' }).click();
    await expect(lens.getByRole('radio', { name: 'Fly' })).toHaveAttribute('aria-checked', 'true');
    await expect(lens.getByRole('radio', { name: 'Rain' })).toHaveAttribute('aria-checked', 'false');
    await lens.getByRole('radio', { name: 'Pressure' }).click();
    const clipped = await page.evaluate(() => [...document.querySelectorAll('[data-lens-bar] button, [data-lens-bar] span')]
      // Icons can be hidden; every lens name remains a full visible word in the scroll strip.
      .filter((el) => el.getBoundingClientRect().width > 1)
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === 'ellipsis').length);
    expect(clipped).toBe(0);
  }
});

test('zero page errors, including when opened hours after the build', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.clock.install({ time: Date.now() + 7 * 3_600_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.clock.runFor(3000);
  await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
  expect(errors).toEqual([]);
  // No credit text on the map until its ⓘ is opened, and no teaching buttons on the map surface.
  await expect(page.locator('[data-map-ready]').getByText('CC BY 4.0')).toHaveCount(0);
  await expect(page.locator('[data-map-ready]').getByRole('button', { name: /Explain|tour/ })).toHaveCount(0);
});
