import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { chartRoutes } from './map-fixture';

/**
 * Kite/Surf on a phone: one bottom sheet at a peek, same map share as Fly
 * (web/tests/e2e/fly-sheet.spec.ts). Header, best line and three rows show;
 * the rest scrolls or the grabber expands the sheet.
 */

const NOW = Date.parse('2026-10-09T00:00:00Z');
const hour = 3_600_000;
const shots = process.env.ISOBAR_COASTAL_SHOTS;
const coast = fs.readFileSync(path.resolve('public/coast/ownchart-coast.bin'));
const time = Array.from({ length: 96 }, (_, i) => (NOW + i * hour) / 1000);
function clock(t: number) { const d = new Date(t * 1000 + 8 * hour); return { day: d.getUTCDate(), h: d.getUTCHours() }; }

function windBody(gustAtLimit = true) {
  return {
    timezone: 'Australia/Perth', hourly_units: { wind_speed_10m: 'kn', wind_gusts_10m: 'kn', wind_direction_10m: '°' },
    hourly: { time,
      wind_speed_10m: time.map((t) => { const { day, h } = clock(t); return day === 10 && h >= 13 && h <= 17 ? 20 : 12; }),
      wind_gusts_10m: time.map((t) => {
        const { day, h } = clock(t);
        if (gustAtLimit && day === 9 && h === 15) return 25.4;
        return day === 10 && h >= 13 && h <= 17 ? 24 : 14;
      }),
      wind_direction_10m: time.map((t) => clock(t).day === 10 ? 270 : 90),
      is_day: time.map((t) => clock(t).h >= 6 && clock(t).h < 18 ? 1 : 0),
    },
  };
}

async function open(page: Page, width: number, height: number, theme: 'light' | 'dark', wind = windBody()) {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(NOW);
  await page.addInitScript((mode) => { localStorage.setItem('isobar-theme', mode); localStorage.setItem('isobar.place', 'perth'); }, theme);
  await chartRoutes(page, true);
  await page.route('**/coast/*.bin', (route) => route.fulfill({ body: coast, contentType: 'application/octet-stream' }));
  await page.route('**/api/aviation**', (route) => route.fulfill({ status: 404 }));
  await page.route('https://api.open-meteo.com/**', (route) => route.fulfill({ json: wind }));
  await page.route('https://marine-api.open-meteo.com/**', (route) => route.fulfill({ json: {
    timezone: 'Australia/Perth', hourly: { time,
      wave_height: time.map(() => 1.8), swell_wave_height: time.map(() => 1.2),
      swell_wave_period: time.map((t) => clock(t).h >= 6 && clock(t).h <= 9 ? 12 : 8),
      swell_wave_direction: time.map(() => 225), sea_surface_temperature: time.map(() => 19),
    },
  } }));
  await page.goto('/');
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true', { timeout: 20_000 });
  await page.getByRole('radio', { name: 'Kite', exact: true }).click();
  await page.waitForSelector('[data-coastal-panel]');
  await expect(page.locator('[data-coastal-row]').nth(2)).toBeVisible();
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
}

async function layout(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-coastal-panel]') as HTMLElement;
    const map = document.querySelector('[data-map-panel]') as HTMLElement;
    const scroll = panel.querySelector('[data-coastal-scroll]') as HTMLElement;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const cards = [...panel.querySelectorAll('*')].filter((el) => {
      if (el.tagName === 'INPUT') return false;
      const s = getComputedStyle(el);
      return visible(el) && parseFloat(s.borderTopWidth) > 0 && parseFloat(s.borderLeftWidth) > 0 && parseFloat(s.borderRightWidth) > 0
        && parseFloat(s.borderBottomWidth) > 0 && parseFloat(s.borderTopLeftRadius) > 0;
    }).length;
    const clipped = [...panel.querySelectorAll('button, span, time, [data-coastal-row]'), ...document.querySelectorAll('[data-lens-bar] button')]
      .filter((el) => visible(el))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const sheet = panel.getBoundingClientRect();
        const inSheet = panel.contains(el);
        const top = inSheet ? Math.max(0, sheet.top) : 0;
        const bottom = inSheet ? Math.min(vh, sheet.bottom) : vh;
        const scroller = el.closest('[data-coastal-scroll]');
        if (scroller) {
          const host = scroller.getBoundingClientRect();
          if (r.bottom <= host.top + 0.5 || r.top >= host.bottom - 0.5) return false;
          // A row crossing the scroll fold is the list, not a clipped control.
          return r.left < sheet.left - 0.5 || r.right > Math.min(vw, sheet.right) + 0.5;
        }
        if (inSheet && (r.bottom <= sheet.top + 0.5 || r.top >= sheet.bottom - 0.5)) return false;
        if (!inSheet && el.closest('[data-lens-bar]')) {
          const bar = document.querySelector('[data-lens-bar]')!.getBoundingClientRect();
          const selected = el.getAttribute('aria-checked') === 'true';
          const vertical = r.top < -0.5 || r.bottom > vh + 0.5 || r.top < bar.top - 1 || r.bottom > bar.bottom + 1;
          const horizontal = r.left < bar.left - 0.5 || r.right > bar.right + 0.5;
          return vertical || (selected && horizontal);
        }
        return r.left < -0.5 || r.right > vw + 0.5 || r.top < top - 0.5 || r.bottom > bottom + 0.5;
      })
      .map((el) => `${el.tagName} ${(el.textContent ?? '').replace(/\s+/g, ' ').slice(0, 24)}`);
    const inside = (el: Element) => {
      const r = el.getBoundingClientRect();
      const host = (el.closest('[data-coastal-scroll]') ?? panel).getBoundingClientRect();
      return r.height > 1 && r.top >= host.top - 0.5 && r.bottom <= host.bottom + 0.5;
    };
    const lens = document.querySelector('[data-lens-bar]')!.getBoundingClientRect();
    const sheet = panel.getBoundingClientRect();
    const rows = [...panel.querySelectorAll('[data-coastal-row]')];
    return {
      sheets: document.querySelectorAll('[data-coastal-panel]').length,
      cards,
      clipped,
      mapShare: (sheet.top - map.getBoundingClientRect().top) / vh,
      sheetAboveLens: sheet.bottom <= lens.top + 0.5,
      detent: panel.dataset.coastalSheet,
      best: (panel.querySelector('[data-coastal-best-row]') as HTMLElement | null)?.getBoundingClientRect().height ?? 0,
      visibleRows: rows.filter(inside).length,
      laterHidden: rows.length > 3 && !inside(rows[3]),
      scrollable: scroll ? scroll.scrollHeight > scroll.clientHeight + 8 : false,
      headVisible: inside(panel.querySelector('[data-coastal-head]')!),
      bestVisible: inside(panel.querySelector('[data-coastal-best]')!),
    };
  });
}

for (const [width, height] of [[390, 844], [375, 667]] as const) for (const theme of ['light', 'dark'] as const) {
  test(`Coastal sheet ${width}x${height} ${theme}: peek keeps the map ≥ 35%, header, best line and 3 rows`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await open(page, width, height, theme);
    // The sheet height eases in; read it after the transition, as Fly does.
    await expect.poll(async () => layout(page), { timeout: 2_000 }).toMatchObject({
      detent: 'peek', sheets: 1, cards: 0, clipped: [], sheetAboveLens: true,
      visibleRows: 3, laterHidden: true, scrollable: true, headVisible: true, bestVisible: true,
    });
    const peek = await layout(page);
    expect(peek.mapShare).toBeGreaterThanOrEqual(0.35);
    expect(peek.best).toBeGreaterThan(20);
    await expect(page.locator('[data-coastal-best]')).toHaveText('best Sat 13–17');
    await expect(page.locator('[data-coastal-row]').first().locator('time')).toHaveText('Fri 8 am');
    const gust = page.locator('[data-coastal-row]', { hasText: 'Fri 3 pm' }).locator('[data-band]').nth(1);
    await expect(gust).toHaveText('25');
    await expect(gust).toHaveAttribute('data-band', 'inside');
    await shot(page, `${width}x${height}-${theme}-kite-peek`);

    const scroller = page.getByLabel('Forecast rows', { exact: true });
    await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect.poll(() => layout(page).then((box) => box.visibleRows)).toBeGreaterThan(0);
    const scrolled = await layout(page);
    expect(scrolled.clipped).toEqual([]);
    await scroller.evaluate((node) => { node.scrollTop = 0; });

    await page.locator('[data-sheet-grabber]').click();
    await expect(page.locator('[data-coastal-panel]')).toHaveAttribute('data-coastal-sheet', 'full');
    await page.waitForTimeout(400);
    const full = await layout(page);
    expect(full.sheets).toBe(1);
    expect(full.cards).toBe(0);
    expect(full.clipped).toEqual([]);
    expect(full.visibleRows).toBeGreaterThan(3);
    const slider = (await page.locator('[data-timeline]').boundingBox())!;
    const sheetTop = (await page.locator('[data-coastal-panel]').boundingBox())!.y;
    expect(slider.y + slider.height).toBeLessThanOrEqual(sheetTop + 0.5);
    await shot(page, `${width}x${height}-${theme}-kite-full`);

    await page.locator('[data-sheet-grabber]').click();
    await expect(page.locator('[data-coastal-panel]')).toHaveAttribute('data-coastal-sheet', 'peek');
    expect(errors).toEqual([]);
  });
}

test('Kite with no window names the viewer band', async ({ page }) => {
  const calm = windBody(false);
  calm.hourly.wind_gusts_10m = calm.hourly.wind_gusts_10m.map(() => 40);
  await open(page, 390, 844, 'light', calm);
  await expect(page.locator('[data-coastal-best]')).toHaveText('none in 15–25 kt');
  await expect(page.locator('[data-coastal-row]').first().locator('[data-band]').nth(1)).toHaveAttribute('data-band', 'above');
  await shot(page, '390x844-light-kite-none');
});

test('Surf peek uses the same sheet and the map clock', async ({ page }) => {
  await open(page, 390, 844, 'dark');
  await page.getByRole('radio', { name: 'Surf', exact: true }).click();
  await expect(page.locator('[data-coastal-panel="surf"]')).toBeVisible();
  await expect.poll(async () => layout(page), { timeout: 2_000 }).toMatchObject({
    detent: 'peek', visibleRows: 3, clipped: [], sheetAboveLens: true,
  });
  const box = await layout(page);
  expect(box.mapShare).toBeGreaterThanOrEqual(0.35);
  await expect(page.locator('[data-coastal-row]').first().locator('time')).toHaveText(/^(Fri|Sat|Sun|Mon|Tue|Wed|Thu) \d{1,2} (am|pm)$/);
  await shot(page, '390x844-dark-surf-peek');
});
