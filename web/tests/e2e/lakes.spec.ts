import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const out = path.join(process.env.HOME ?? '', '.local/state/isobar-week/lakes');

const SEA = {
  light: [233, 239, 244],
  dark: [35, 47, 62],
};
const LAND = {
  light: [241, 236, 187],
  dark: [102, 88, 57],
};

const places = [
  { name: 'okanagan', lat: 49.8542, lon: -119.5144, height: 1.6 },
  { name: 'great-lakes', lat: 47.7, lon: -87.5, height: 12 },
  { name: 'taupo', lat: -38.8, lon: 175.9, height: 4 },
  { name: 'geneva', lat: 46.43, lon: 6.53, height: 3 },
];

function distance(rgb: number[], target: number[]): number {
  return Math.hypot(rgb[0] - target[0], rgb[1] - target[1], rgb[2] - target[2]);
}

async function centrePixel(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const stage = document.querySelector('[data-api="1"]') as HTMLElement & {
      chartApi?: { readPlate: () => Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> };
    };
    const plate = await stage.chartApi?.readPlate();
    if (plate) {
      const x = Math.floor(plate.width / 2);
      const y = Math.floor(plate.height / 2);
      const index = (y * plate.width + x) * 4;
      return [plate.data[index], plate.data[index + 1], plate.data[index + 2]];
    }
    const canvas = document.querySelector('[data-chart-layer="canvas2d"]') as HTMLCanvasElement | null;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return [];
    const px = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return [px[0], px[1], px[2]];
  });
}

async function show(page: Page, place: { lat: number; lon: number; height: number }) {
  await page.evaluate(({ lat, lon, height }) => {
    const stage = document.querySelector('[data-api="1"]') as HTMLElement & {
      chartApi: { setView: (lat: number, lon: number, heightDeg: number) => void };
    };
    stage.chartApi.setView(lat, lon, height);
  }, place);
}

test.describe('inland lakes', () => {
  for (const mode of ['light', 'dark'] as const) {
    test(`${mode} sea colour at named lakes`, async ({ page }, testInfo) => {
      fs.mkdirSync(out, { recursive: true });
      await page.addInitScript((value) => localStorage.setItem('isobar-theme', value), mode);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/');
      await page.waitForSelector('[data-map-ready="true"]', { timeout: 120_000 });
      const renderer = await page.locator('[data-renderer]').getAttribute('data-renderer');
      expect(renderer, testInfo.project.name).toBe(testInfo.project.name === 'canvas-lakes' ? 'canvas' : 'webgl2');
      const sea = SEA[mode];
      const land = LAND[mode];
      for (const viewport of [
        { label: 'desktop', width: 1440, height: 900 },
        { label: 'phone', width: 390, height: 844 },
      ]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const place of places) {
          const height = viewport.label === 'phone' && place.name === 'great-lakes' ? 22 : place.height;
          await show(page, { ...place, height });
          await expect.poll(async () => {
            const rgb = await centrePixel(page);
            return rgb.length === 3 && distance(rgb, sea) < distance(rgb, land) && distance(rgb, sea) < 18;
          }, { timeout: 12_000, intervals: [200, 400, 800] }).toBe(true);
          const file = path.join(out, `${place.name}-${viewport.label}-${mode}-${renderer}.png`);
          await page.locator('[data-map-ready="true"]').screenshot({ path: file });
        }
      }
    });
  }
});
