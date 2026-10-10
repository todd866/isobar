import { expect, test, type Page } from '@playwright/test';
import { choosePlace } from './place-field';
import { inflateSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Real-map visual matrix. The full cross product runs only when
 * ISOBAR_E2E_MATRIX=1; the default subset stays small enough for the normal
 * suite. Screenshots and one contact sheet go to
 * ~/.local/state/isobar-week/map-polish/<run>/.
 *
 * Checks, every state: canvas labels (isobar, H/L, places) do not overlap;
 * controls are inside the viewport and do not overlap each other; text
 * contrast against the local background is at least 4.5:1; a phone shows at
 * most one sheet; with no sheet open the map is at least 45% of the phone
 * viewport; no page errors.
 */

const FULL = process.env.ISOBAR_E2E_MATRIX === '1';
const RUN = process.env.ISOBAR_MATRIX_RUN
  ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = process.env.ISOBAR_MATRIX_DIR
  ?? path.join(os.homedir(), '.local/state/isobar-week/map-polish', RUN);

const PLACES = [
  { id: 'perth', lat: -31.95, lon: 115.86, select: 'perth' },
  { id: 'sydney', lat: -33.95, lon: 151.18, select: 'sydney' },
  { id: 'seattle', lat: 47.6, lon: -122.33 },
  { id: 'denver', lat: 39.74, lon: -104.99 },
  { id: 'pacific', lat: 8, lon: 180 },
  { id: 'london', lat: 51.47, lon: -0.45 },
] as const;

const LENSES = ['pressure', 'rain', 'wind', 'temp', 'fly'] as const;
const THEMES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 390, h: 844 },
  { w: 375, h: 667 },
  { w: 844, h: 390 },
] as const;
const ZOOMS = [
  { id: 'synoptic', height: 48 },
  { id: 'regional', height: 8 },
] as const;

type Place = (typeof PLACES)[number];
type Lens = (typeof LENSES)[number];
type Theme = (typeof THEMES)[number];
type Zoom = (typeof ZOOMS)[number];

interface State {
  id: string;
  place: Place;
  lens: Lens;
  theme: Theme;
  w: number;
  h: number;
  zoom: Zoom;
}

function matrix(): State[] {
  const all: State[] = [];
  for (const place of PLACES) {
    for (const lens of LENSES) {
      for (const theme of THEMES) {
        for (const viewport of VIEWPORTS) {
          for (const zoom of ZOOMS) {
            all.push({
              id: `${place.id}-${lens}-${theme}-${viewport.w}x${viewport.h}-${zoom.id}`,
              place, lens, theme, w: viewport.w, h: viewport.h, zoom,
            });
          }
        }
      }
    }
  }
  if (FULL) return all;
  const keep = new Set([
    'perth-pressure-light-1440x900-synoptic',
    'sydney-rain-dark-390x844-regional',
    'seattle-wind-light-844x390-regional',
    'denver-temp-dark-375x667-synoptic',
    'pacific-pressure-light-1024x768-synoptic',
    'london-fly-dark-1440x900-regional',
  ]);
  return all.filter((state) => keep.has(state.id));
}

interface Box { x: number; y: number; w: number; h: number; text?: string }

function decodePng(buffer: Buffer): { width: number; height: number; data: Uint8Array } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Buffer[] = [];
  while (offset + 8 < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let src = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[src];
    src += 1;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i += 1) {
      const raw = inflated[src + i];
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i] ?? 0;
      const ul = i >= bpp ? prev[i - bpp] ?? 0 : 0;
      let value = raw;
      if (filter === 1) value = (raw + left) & 255;
      else if (filter === 2) value = (raw + up) & 255;
      else if (filter === 3) value = (raw + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) value = (raw + paeth(left, up, ul)) & 255;
      cur[i] = value;
    }
    src += stride;
    prev = cur;
    const dest = y * width * 4;
    if (bpp === 4) out.set(cur, dest);
    else {
      for (let x = 0; x < width; x += 1) {
        out[dest + x * 4] = cur[x * 3];
        out[dest + x * 4 + 1] = cur[x * 3 + 1];
        out[dest + x * 4 + 2] = cur[x * 3 + 2];
        out[dest + x * 4 + 3] = 255;
      }
    }
  }
  return { width, height, data: out };
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const left = luminance(...a);
  const right = luminance(...b);
  const [hi, lo] = left > right ? [left, right] : [right, left];
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast of the darkest and lightest pixels in a box expanded onto its background. */
function boxContrast(image: { width: number; height: number; data: Uint8Array }, box: Box): number {
  const x0 = Math.max(0, Math.floor(box.x) - 2);
  const y0 = Math.max(0, Math.floor(box.y) - 2);
  const x1 = Math.min(image.width - 1, Math.ceil(box.x + box.w) + 2);
  const y1 = Math.min(image.height - 1, Math.ceil(box.y + box.h) + 2);
  let minL = 2;
  let maxL = -1;
  let minC: [number, number, number] = [0, 0, 0];
  let maxC: [number, number, number] = [255, 255, 255];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * image.width + x) * 4;
      const rgb: [number, number, number] = [image.data[i], image.data[i + 1], image.data[i + 2]];
      const L = luminance(...rgb);
      if (L < minL) { minL = L; minC = rgb; }
      if (L > maxL) { maxL = L; maxC = rgb; }
    }
  }
  return contrast(minC, maxC);
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function phoneOf(state: State): boolean {
  return state.w < 768 || state.h <= 500;
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
  }));
}

test('visual matrix', async ({ page }) => {
  test.setTimeout(FULL ? 45 * 60_000 : 240_000);
  fs.mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  let stateName = 'load';
  page.on('pageerror', (error) => errors.push(`${stateName}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource|favicon|mapterhorn|net::ERR/.test(text)) return;
    errors.push(`${stateName}: ${text}`);
  });

  await page.addInitScript(() => localStorage.setItem('isobar-theme', 'light'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
  await page.waitForFunction(() => !!(document.querySelector('[data-api="1"]') as HTMLElement & { chartApi?: unknown })?.chartApi);

  const shots: { id: string; file: string; problems: string[] }[] = [];
  const failures: string[] = [];

  for (const state of matrix()) {
    stateName = state.id;
    await page.setViewportSize({ width: state.w, height: state.h });
    const dark = await page.locator('html').evaluate((root) => root.classList.contains('dark'));
    if (dark !== (state.theme === 'dark')) {
      const themeName = state.theme === 'dark' ? 'Dark' : 'Light';
      const themeButton = page.getByRole('button', { name: themeName, exact: true });
      if (!(await themeButton.isVisible().catch(() => false))) {
        const expand = page.getByRole('button', { name: 'Show daily forecast', exact: true });
        if (await expand.isVisible()) await expand.click();
        await page.getByRole('button', { name: 'Menu', exact: true }).click();
        await expect(page.locator('[data-map-menu]')).toBeVisible();
      }
      await themeButton.click();
      await expect(page.locator('html')).toHaveClass(state.theme === 'dark' ? /dark/ : /^((?!dark).)*$/, { timeout: 5_000 }).catch(async () => {
        await page.evaluate((mode) => document.documentElement.classList.toggle('dark', mode === 'dark'), state.theme);
      });
      if (await page.locator('[data-map-menu]').isVisible().catch(() => false)) await page.getByRole('button', { name: 'Menu', exact: true }).click();
    }
    if ('select' in state.place && state.place.select) {
      const name = state.place.select[0].toUpperCase() + state.place.select.slice(1);
      await choosePlace(page, name, state.place.select);
    }
    await page.getByRole('radio', { name: state.lens === 'pressure' ? 'Pressure' : state.lens === 'rain' ? 'Rain' : state.lens === 'wind' ? 'Wind' : state.lens === 'temp' ? 'Temp' : 'Fly', exact: true }).click();
    const pause = page.getByRole('button', { name: 'Pause', exact: true });
    if (await pause.count()) await pause.click();
    await page.evaluate(({ lat, lon, height }) => {
      const stage = document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: { setView: (lat: number, lon: number, h: number) => void } };
      stage.chartApi.setView(lat, lon, height);
    }, { lat: state.place.lat, lon: state.place.lon, height: state.zoom.height });
    if (state.lens !== 'pressure' && state.lens !== 'fly') {
      await page.waitForSelector('.map-legend-scale, [data-legend="missing"]', { timeout: 30_000 });
    }
    if (state.lens === 'fly') await page.waitForSelector('[data-fly-panel]', { timeout: 15_000 });
    if (state.zoom.id === 'regional') {
      await page.waitForFunction(() => {
        const api = (document.querySelector('[data-api="1"]') as HTMLElement & { chartApi?: { places?: () => { ready: boolean } } }).chartApi;
        return !api?.places || api.places().ready;
      }, { timeout: 20_000 }).catch(() => {});
    }
    // A press briefly names what it did (owner rule); the steady still waits out
    // the transient notice rather than freezing it over the map labels.
    await page.locator('.map-notice').waitFor({ state: 'detached', timeout: 6_000 });
    await page.waitForTimeout(350);
    await settle(page);

    const file = `${state.id}.png`;
    const png = await page.screenshot({ path: path.join(OUT, file), fullPage: false, animations: 'disabled' });
    const image = decodePng(png);
    const scale = image.width / state.w;

    const layout = await page.evaluate(() => {
      const stage = document.querySelector('[data-api="1"]') as HTMLElement & {
        chartApi?: { labels?: () => { text: string; x: number; y: number; w: number; h: number }[] };
      };
      const canvas = stage?.querySelector('canvas[aria-label]') as HTMLCanvasElement | null;
      const origin = canvas?.getBoundingClientRect();
      const labels = (stage?.chartApi?.labels?.() ?? []).map((label) => ({
        text: label.text,
        x: (origin?.left ?? 0) + label.x,
        y: (origin?.top ?? 0) + label.y,
        w: label.w,
        h: label.h,
      }));
      const selector = 'button, a, select, [role="slider"], .map-legend';
      const controls = [...document.querySelectorAll(selector)].filter((el) => {
        if (el.matches('a[href="#main-content"]')) return false;
        if ([...el.querySelectorAll(selector)].length) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
        if (rect.width < 2 || rect.height < 2) return false;
        if (rect.bottom < 0 || rect.right < 0) return false;
        return true;
      }).map((el) => {
        const rect = el.getBoundingClientRect();
        const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
        const bar = el.closest('[data-lens-bar]')?.getBoundingClientRect();
        const selected = el.getAttribute('aria-checked') === 'true';
        // A labelled lens row scrolls. A segment parked off to the side is not
        // clipped; the selected lens is brought fully into view.
        const scrolledLens = !!bar && !selected && (rect.left < bar.left - 0.5 || rect.right > bar.right + 0.5);
        return { name, x: rect.x, y: rect.y, w: rect.width, h: rect.height, scrolledLens };
      });
      const texts: { text: string; x: number; y: number; w: number; h: number }[] = [];
      const hiddenBox = (el: Element) => {
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return true;
        // Includes Tailwind's responsive sr-only once that media query applies.
        return style.position === 'absolute' && parseFloat(style.width) <= 1 && (style.overflow === 'hidden' || style.clip !== 'auto');
      };
      const clip = (rect: DOMRect, el: Element) => {
        let x = rect.x;
        let y = rect.y;
        let right = rect.right;
        let bottom = rect.bottom;
        let node: Element | null = el;
        while (node) {
          const style = getComputedStyle(node);
          const box = node.getBoundingClientRect();
          if (style.overflowX === 'hidden' || style.overflowX === 'clip') {
            x = Math.max(x, box.x);
            right = Math.min(right, box.right);
          }
          if (style.overflowY === 'hidden' || style.overflowY === 'clip') {
            y = Math.max(y, box.y);
            bottom = Math.min(bottom, box.bottom);
          }
          node = node.parentElement;
        }
        return { x, y, w: right - x, h: bottom - y };
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        const parent = node.parentElement;
        if (text && parent) {
          const option = parent.closest('option');
          const concealed = hiddenBox(parent) || !!parent.closest('[aria-hidden="true"]') || (!!option && !(option as HTMLOptionElement).selected);
          if (!concealed) {
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              const lens = parent.closest('[data-lens-bar]')?.getBoundingClientRect();
              if (lens && (rect.left < lens.left - 0.5 || rect.right > lens.right + 0.5 || rect.top < lens.top - 0.5 || rect.bottom > lens.bottom + 0.5)) continue;
              const box = clip(rect, parent);
              if (box.w >= 2 && box.h >= 2) texts.push({ text: text.slice(0, 32), ...box });
            }
          }
        }
        node = walker.nextNode();
      }
      const sheets = [...document.querySelectorAll('[data-fly-panel], [data-point-panel], [data-account-sheet]')].filter((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.position === 'fixed' && style.display !== 'none' && rect.height > 2;
      }).length;
      const map = stage?.getBoundingClientRect();
      return {
        hasLabels: typeof stage?.chartApi?.labels === 'function',
        labels,
        controls,
        texts,
        sheets,
        map: map ? { x: map.x, y: map.y, w: map.width, h: map.height } : null,
        scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scrollY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });

    const problems: string[] = [];
    if (!layout.hasLabels) problems.push('canvas label API missing');
    if (layout.scrollX > 1) problems.push(`horizontal overflow ${layout.scrollX.toFixed(0)}px`);
    if (layout.scrollY > 1) problems.push(`vertical overflow ${layout.scrollY.toFixed(0)}px`);
    for (let i = 0; i < layout.labels.length; i += 1) {
      for (let j = i + 1; j < layout.labels.length; j += 1) {
        if (overlapArea(layout.labels[i], layout.labels[j]) > 4) {
          problems.push(`labels overlap "${layout.labels[i].text}" / "${layout.labels[j].text}"`);
        }
      }
    }
    for (let i = 0; i < layout.texts.length; i += 1) {
      for (let j = i + 1; j < layout.texts.length; j += 1) {
        if (overlapArea(layout.texts[i], layout.texts[j]) > 4) {
          problems.push(`text overlap "${layout.texts[i].text}" / "${layout.texts[j].text}"`);
        }
      }
    }
    for (const label of layout.labels) {
      for (const text of layout.texts) {
        if (overlapArea(label, text) > 4) problems.push(`map label "${label.text}" overlaps "${text.text}"`);
      }
    }
    for (let i = 0; i < layout.controls.length; i += 1) {
      const control = layout.controls[i];
      if (!control.scrolledLens && (control.x < -1 || control.y < -1 || control.x + control.w > layout.vw + 1 || control.y + control.h > layout.vh + 1)) {
        problems.push(`control clipped "${control.name}"`);
      }
      for (let j = i + 1; j < layout.controls.length; j += 1) {
        if (overlapArea(control, layout.controls[j]) > 4) {
          problems.push(`controls overlap "${control.name}" / "${layout.controls[j].name}"`);
        }
      }
    }
    const sample = (box: Box, name: string) => {
      const scaled = { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale };
      if (scaled.x < 0 || scaled.y < 0 || scaled.x + scaled.w > image.width || scaled.y + scaled.h > image.height) return;
      if (scaled.w < 2 || scaled.h < 2) return;
      const ratio = boxContrast(image, scaled);
      if (ratio < 4.5) problems.push(`contrast ${ratio.toFixed(2)} "${name}"`);
    };
    for (const label of layout.labels) sample(label, label.text);
    for (const text of layout.texts) sample(text, text.text);
    if (phoneOf(state)) {
      if (layout.sheets > 1) problems.push(`${layout.sheets} sheets`);
      if (layout.sheets === 0 && layout.map) {
        const share = (layout.map.w * layout.map.h) / (layout.vw * layout.vh);
        if (share < 0.45) problems.push(`map area ${(share * 100).toFixed(0)}%`);
      }
    }
    if (problems.length) failures.push(`${state.id}: ${[...new Set(problems)].slice(0, 12).join('; ')}`);
    shots.push({ id: state.id, file, problems });
  }

  const cards = shots.map((shot) => {
    const bad = shot.problems.length ? ' bad' : '';
    const note = shot.problems.length ? `<br>${shot.problems.slice(0, 6).map((item) => item.replace(/[<>&]/g, '')).join('<br>')}` : '';
    return `<figure class="${bad.trim()}"><img src="${shot.file}" alt="${shot.id}"><figcaption>${shot.id}${note}</figcaption></figure>`;
  }).join('\n');
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<title>Isobar map matrix ${RUN}</title>
<style>
  body { margin: 0; background: #14181c; color: #e7e1d6; font: 12px/1.35 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 15px; font-weight: 600; padding: 12px 12px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; padding: 12px; }
  figure { margin: 0; background: #1c232a; }
  figure.bad { outline: 2px solid #e07a62; }
  img { width: 100%; height: auto; display: block; background: #c5d0d6; }
  figcaption { padding: 6px 8px; }
</style>
<h1>Isobar map · ${shots.length} states · ${RUN}</h1>
<div class="grid">
${cards}
</div>
`);

  expect(errors, 'console').toEqual([]);
  expect(failures, OUT).toEqual([]);
});
