import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/unit/fixtures/openmeteo-point.json'), 'utf8'));
import { globalEquirectangular, project, type Camera } from '../../src/lib/lambert';
import { choosePlace } from './place-field';

const RUN = '2026-10-08T00:00:00Z';
const PERTH = { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.86, icao: 'YPPH' };
const SYDNEY = { id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.87, lon: 151.21, icao: 'YSSY' };
const panel = (page: Page) => page.locator('[data-point-panel]');
const canvas = (page: Page) => page.locator('canvas[tabindex="0"]');
const slider = (page: Page) => page.getByRole('slider', { name: 'Forecast time' });

function placeForecast(latitude: number, longitude: number) {
  const sydney = Math.abs(latitude - SYDNEY.lat) < 0.2 && Math.abs(longitude - SYDNEY.lon) < 0.2;
  const timezone = sydney ? 'Australia/Sydney' : 'Australia/Perth';
  const offset = sydney ? 36_000 : 28_800;
  const days = Array.from({ length: 7 }, (_, i) => `2026-10-${String(8 + i).padStart(2, '0')}`);
  const times = days.flatMap((day) => Array.from({ length: 24 }, (_, hour) => `${day}T${String(hour).padStart(2, '0')}:00`));
  const hourly = (value: number) => times.map(() => value);
  return {
    latitude, longitude, timezone, utc_offset_seconds: offset,
    hourly: {
      time: times,
      temperature_2m: hourly(sydney ? 21 : 20), dew_point_2m: hourly(12),
      wind_speed_10m: hourly(sydney ? 11 : 13), wind_direction_10m: hourly(sydney ? 180 : 220),
      cloud_cover: hourly(42), precipitation: hourly(0), surface_pressure: hourly(1013), uv_index: hourly(4),
    },
    daily: {
      time: days, temperature_2m_max: days.map(() => sydney ? 25 : 26), temperature_2m_min: days.map(() => sydney ? 14 : 13),
      precipitation_sum: days.map(() => 0), wind_speed_10m_max: days.map(() => sydney ? 18 : 20),
      wind_direction_10m_dominant: days.map(() => sydney ? 180 : 220), weather_code: days.map(() => 1), uv_index_max: days.map(() => 7),
    },
  };
}

/** Authored chart and Open-Meteo responses: no live weather/export dependency. */
async function open(page: Page, width: number, height: number, theme = 'light', global = false, skyRun?: string) {
  await page.setViewportSize({ width, height });
  await page.addInitScript((mode) => {
    localStorage.setItem('isobar-theme', mode); localStorage.setItem('isobar.place', 'perth'); localStorage.setItem('isobar.speed', '8');
  }, theme);
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  const hours = global ? [...Array.from({ length: 49 }, (_, i) => i * 3), 150, 156, 162, 168] : Array.from({ length: 41 }, (_, i) => i * 3);
  const grid = global
    ? { nx: 720, ny: 361, west: -180, east: 179.5, north: 90, south: -90, step: .5, wraps_longitude: true, dtype: 'uint16' }
    : { nx: 64, ny: 49, west: 105, east: 168, north: 0, south: -48, step: 1, dtype: 'uint16' };
  const variables = Object.fromEntries(['mslp', 'rain24', 't2m', 'wind', 'u10', 'v10'].map((name) => [name, {
    frames: hours.map(() => `${name}.bin`), units: name === 'mslp' ? 'hPa' : name === 't2m' ? '°C' : name === 'rain24' ? 'mm' : 'kt', scale: 1, offset: 0, fill: 65535,
  }]));
  const manifest = { schema: 2, contract: 'isobar-web', run: RUN, generated: RUN, forecast_hours: hours, grid, variables, places: [PERTH, SYDNEY], points: 'points.json', aviation: 'aviation.json', attribution: [{ source: 'Synthetic point journey', licence: 'Test fixture' }] };
  const frames = new Map(Object.keys(variables).map((name) => {
    const body = Buffer.alloc(grid.nx * grid.ny * 2);
    for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) body.writeUInt16LE(name === 'mslp' ? 1000 + Math.round(12 * Math.sin(i / grid.nx * 6) * Math.cos(j / grid.ny * 6)) : name === 't2m' ? 20 : name === 'rain24' ? 2 : 15, (j * grid.nx + i) * 2);
    return [name, body];
  }));
  const coast = Buffer.alloc(26); coast.write('OCST'); coast.writeUInt16LE(1, 4); coast.writeUInt16LE(1, 6); coast.writeUInt16LE(4, 8);
  [[113, -35], [120, -35], [120, -20], [113, -20]].forEach(([lon, lat], i) => { coast.writeInt16LE(lon * 100, 10 + i * 4); coast.writeInt16LE(lat * 100, 12 + i * 4); });
  await page.route('https://tiles.mapterhorn.com/**', (route) => route.abort('internetdisconnected'));
  await page.route('**/coast/*.bin', (route) => route.fulfill({ body: coast, contentType: 'application/octet-stream' }));
  await page.route('**/data/**', async (route) => {
    const file = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (file === 'manifest.json') return route.fulfill({ json: manifest });
    if (file === 'points.json') return route.fulfill({ json: { run: RUN, hours, places: {
      perth: { t: hours.map(() => 20), wspd: hours.map(() => 13), wdir: hours.map(() => 220), tp: hours.map(() => 0), cc: hours.map(() => 42) },
      sydney: { t: hours.map(() => 21), wspd: hours.map(() => 11), wdir: hours.map(() => 180), tp: hours.map(() => 0), cc: hours.map(() => 36) },
    } } });
    if (file === 'aviation.json') return route.fulfill({ json: { airports: [{ ...PERTH, metar: { raw: 'METAR YPPH 080300Z 22013KT 9999 SCT030 19/11 Q1013', time: '2026-10-08T03:00:00Z' }, taf: null }], sigmets: [] } });
    if (file === 'sky.json') return route.fulfill({ json: { profiles: skyRun ? [{
      icao: 'YPPH', source: 'ECMWF', model: 'ecmwf_ifs025', run: skyRun, runKnown: true,
      lat: PERTH.lat, lon: PERTH.lon, elevationFt: 67, coastKm: -19,
      time: [Date.parse(skyRun)],
      levels: [{ hPa: 1000, z: [100], t: [15], rh: [50], ws: [10], wd: [180], cc: [null], w: [null] }],
    }] : [] } });
    const body = frames.get(file.replace('.bin', ''));
    return body ? route.fulfill({ body, contentType: 'application/octet-stream' }) : route.fulfill({ status: 404 });
  });
  await page.route('**/places/world-places.json', (route) => route.fulfill({ json: [
    ['Canberra', -35.2809, 149.13, 1, 'AU'], ['Perth', -31.95, 115.86, 1, 'AU'], ['Sydney', -33.87, 151.21, 1, 'AU'],
  ] }));
  let requests = 0;
  await page.route('https://api.open-meteo.com/v1/forecast?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('daily')) {
      await route.fulfill({ json: placeForecast(Number(url.searchParams.get('latitude')), Number(url.searchParams.get('longitude'))) });
      return;
    }
    requests++;
    expect(url.searchParams.get('models')).toBe('ecmwf_ifs025'); expect(url.searchParams.get('timezone')).toBe('GMT');
    await route.fulfill({ json: fixture });
  });
  await page.route('https://marine-api.open-meteo.com/**', async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('timezone')).toBe('GMT');
    expect(url.searchParams.get('hourly')).toContain('wave_height');
    expect(url.searchParams.get('hourly')).toContain('ocean_current_direction');
    const lat = Number(url.searchParams.get('latitude'));
    const lon = Number(url.searchParams.get('longitude'));
    const ocean = Math.abs(lat + 25) < 0.2 && Math.abs(lon - 75) < 0.2;
    const hour = (name: string, sea: number, land: number | null = null) => ocean ? [sea, sea] : [land, land];
    await route.fulfill({ json: { hourly: {
      time: ['2026-10-08T00:00', '2026-10-08T03:00'],
      sea_surface_temperature: hour('sst', 18.4),
      ocean_current_velocity: hour('current', 2.8),
      ocean_current_direction: hour('dir', 92),
      wave_height: hour('wave', 1.7),
      swell_wave_height: hour('swell', 1.2),
      swell_wave_period: hour('period', 12),
      swell_wave_direction: hour('sdir', 215),
    } } });
  });
  await page.goto('/');
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true');
  await page.waitForFunction(() => !!(document.querySelector('[data-map-ready]') as HTMLElement & { chartApi?: unknown })?.chartApi);
  await page.getByRole('radio', { name: 'Wind', exact: true }).click();
  return () => requests;
}
async function settledMap(page: Page) {
  // ResizeObserver and the forecast header animation must finish before saving
  // a view or converting a fractional canvas position to a screen tap.
  await expect(page.locator('.map-chrome-body')).not.toHaveAttribute('data-anim', '1');
  await page.evaluate(() => new Promise<void>((resolve) => {
    let previous = '', stable = 0;
    const check = () => {
      const canvas = document.querySelector('canvas[tabindex="0"]')!;
      const r = canvas.getBoundingClientRect();
      const current = `${r.x},${r.y},${r.width},${r.height}`;
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (stable >= 4) resolve(); else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }));
}
async function tapMap(page: Page, fx = .45, fy = .18) {
  await settledMap(page);
  const b = (await canvas(page).boundingBox())!;
  await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('[data-wind-row]')).toHaveCount(11);
}
async function markerInsideExposedMap(page: Page) {
  return page.evaluate(() => {
    const marker = document.querySelector('[data-point-marker]')?.getBoundingClientRect();
    const stage = document.querySelector('[data-map-ready]')?.getBoundingClientRect();
    const panel = document.querySelector('[data-point-panel]'); const sheet = panel?.getBoundingClientRect();
    if (!marker || !stage || !sheet || !panel) return false;
    const exposed = panel.getAttribute('data-point-layout') === 'side'
      ? new DOMRect(stage.left, stage.top, Math.max(0, Math.min(stage.width, sheet.left - stage.left)), stage.height)
      : new DOMRect(stage.left, stage.top, stage.width, Math.max(0, sheet.top - stage.top));
    return marker.left >= exposed.left && marker.right <= exposed.right && marker.top >= exposed.top && marker.bottom <= exposed.bottom;
  });
}
async function expectPointVisible(page: Page) {
  await expect(page.locator('[data-point-marker]')).toHaveCount(1);
  await expect.poll(() => markerInsideExposedMap(page)).toBe(true);
}
async function expectMarkerCentered(page: Page, tolerance = 2) {
  await expect.poll(() => page.evaluate((tolerance) => {
    const marker = document.querySelector('[data-point-marker]')?.getBoundingClientRect();
    const stage = document.querySelector('[data-map-ready]')?.getBoundingClientRect();
    const panel = document.querySelector('[data-point-panel]'); const sheet = panel?.getBoundingClientRect();
    if (!marker || !stage || !sheet || !panel) return null;
    const exposed = panel.getAttribute('data-point-layout') === 'side'
      ? { left: stage.left, top: stage.top, right: Math.min(stage.right, sheet.left), bottom: stage.bottom }
      : { left: stage.left, top: stage.top, right: stage.right, bottom: sheet.top };
    const x = (marker.left + marker.right) / 2 - (exposed.left + exposed.right) / 2;
    const y = (marker.top + marker.bottom) / 2 - (exposed.top + exposed.bottom) / 2;
    return Math.abs(x) <= tolerance && Math.abs(y) <= tolerance;
  }, tolerance)).toBe(true);
}
async function camera(page: Page): Promise<Camera> {
  return page.locator('[data-map-ready]').evaluate((e) => ({ ...(e as HTMLElement & { chartApi: { camera: () => Camera } }).chartApi.camera() }));
}
async function fixedTime(page: Page) {
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await slider(page).focus(); await page.keyboard.press('Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(slider(page)).toHaveAttribute('aria-valuenow', '180');
  await settledMap(page);
}
async function fit(page: Page) {
  await expectPointVisible(page); await expectMarkerCentered(page);
  const result = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-point-panel]')!, scroll = panel.querySelector('[data-point-scroll]')!;
    const box = panel.getBoundingClientRect(), body = scroll.getBoundingClientRect(), close = panel.querySelector('button')!.getBoundingClientRect();
    const lens = document.querySelector('[data-lens-bar]')!.getBoundingClientRect(), stage = document.querySelector('[data-map-ready]')!.getBoundingClientRect();
    const inside = (r: DOMRect, outer: DOMRect) => r.left >= outer.left - 1 && r.right <= outer.right + 1 && r.top >= outer.top - 1 && r.bottom <= outer.bottom + 1;
    const badTitles = [...panel.querySelectorAll('[title]')].map((e) => e.getAttribute('title')!).filter((t) => t.length > 60 || t.includes('\n') || /\b(click|tap|drag|scroll|use|hold|press)\b/i.test(t));
    // The level list scrolls deliberately; all columns must still fit horizontally.
    const horizontalOverflow = [...scroll.querySelectorAll('[data-wind-row], [data-sea-row], canvas')].some((e) => { const r = e.getBoundingClientRect(); return r.left < body.left - 1 || r.right > body.right + 1; })
      || scroll.scrollWidth > scroll.clientWidth + 1;
    const rowsNoWrap = [...panel.querySelectorAll('[data-wind-row], [data-sea-row]')].every((cell) => getComputedStyle(cell).whiteSpace === 'nowrap');
    const aligned = (selector: string) => {
      const xs = [...panel.querySelectorAll(selector)].map((e) => e.getBoundingClientRect().x);
      return xs.length > 1 && Math.max(...xs) - Math.min(...xs) < 1;
    };
    const barbsAligned = aligned('[data-wind-text]') && aligned('[data-level-label]');
    const tabular = getComputedStyle(panel).fontVariantNumeric.includes('tabular-nums');
    const marker = document.querySelector('[data-point-marker]')?.getBoundingClientRect();
    const exposed = panel.dataset.pointLayout === 'side'
      ? new DOMRect(stage.left, stage.top, Math.max(0, Math.min(stage.width, box.left - stage.left)), stage.height)
      : new DOMRect(stage.left, stage.top, stage.width, Math.max(0, box.top - stage.top));
    const markerVisible = !!marker && marker.left >= exposed.left && marker.right <= exposed.right && marker.top >= exposed.top && marker.bottom <= exposed.bottom;
    const view = new DOMRect(0, 0, innerWidth, innerHeight);
    const fits = inside(box, view) && inside(body, box) && inside(close, box);
    return { fits, aboveLens: box.bottom <= lens.top + 1,
      mapExposed: markerVisible, horizontalOverflow, rowsNoWrap, barbsAligned, tabular, badTitles,
      overflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1 };
  });
  expect(result).toEqual({ fits: true, aboveLens: true, mapExposed: true, horizontalOverflow: false, rowsNoWrap: true, barbsAligned: true, tabular: true, badTitles: [], overflow: false });
  await expect(page.locator('[data-point-panel], [data-fly-panel]')).toHaveCount(1);
}

test('recorded winds and one point across lens changes', async ({ page }, info) => {
  const requests = await open(page, 1280, 720); await fixedTime(page); await tapMap(page);
  await expect(panel(page).locator('[data-point-source]')).toHaveAttribute('title', 'IFS 0.25° · latest 08 03Z · Open-Meteo · latest at fetch');
  const location = await panel(page).getAttribute('data-point-location');
  for (const [level, speed] of Object.entries({ surface: 13, 1000: 16, 925: 22, 850: 28, 700: 34, 600: 40, 500: 46, 400: 54, 300: 62, 250: 66, 200: 70 }))
    await expect(panel(page).locator(`[data-wind-row][data-level="${level}"] [data-wind-text]`)).toContainText(String(speed));
  const order = await panel(page).locator('[data-wind-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-level')));
  expect(order[0]).toBe('200');
  expect(order.at(-1)).toBe('surface');
  await expect(panel(page).locator('[data-wind-row][data-level="1000"] [data-level-label]')).toHaveText('500 ft');
  await expect(panel(page).locator('[data-wind-row][data-level="1000"]')).toHaveAttribute('title', '1000 hPa · 502 ft AMSL');
  await expect(panel(page).locator('[data-wind-row][data-level="200"] [data-level-label]')).toHaveText('FL390');
  await expect(panel(page).locator('[data-wind-row][data-level="surface"] [data-wind-text]')).toHaveText('220/13');
  // DEM is unavailable in this fixture: model elevation must not invent the tapped ground.
  await expect(panel(page).locator('[data-readout]')).toHaveText('SFC · +19°C · 220/13');
  await expect(panel(page).locator('[data-point-primary]')).toHaveAttribute('data-point-primary', 'wind');
  await expect(panel(page).locator('[data-sounding] canvas')).toBeVisible(); await expectPointVisible(page); await expectMarkerCentered(page); await fit(page);
  await page.screenshot({ path: info.outputPath('point-section-desktop-light.png'), fullPage: false });
  for (const [name, lens, primary] of [['Temp', 'temp', 'temp'], ['Rain', 'rain', 'cloud']] as const) {
    await page.getByRole('radio', { name, exact: true }).click();
    await expect(panel(page)).toHaveAttribute('data-point-location', location!); await expect(panel(page)).toHaveAttribute('data-point-emphasis', lens);
    await expect(panel(page).locator('[data-sounding]')).toHaveAttribute('data-point-primary', primary);
  }
  expect(requests()).toBe(1);
  await page.getByRole('button', { name: 'Close point' }).click(); await expect(panel(page)).toHaveCount(0); await expect(page.locator('[data-point-marker]')).toHaveCount(0);
});

async function exerciseLenses(page: Page, width: number, height: number, theme = 'light') {
  await open(page, width, height, theme); await fixedTime(page);
  const before = await camera(page);
  for (const [name, emphasis] of [['Pressure', 'pressure'], ['Rain', 'rain'], ['Wind', 'wind'], ['Temp', 'temp']] as const) {
    if (await panel(page).count()) {
      await page.getByRole('button', { name: 'Close point' }).click();
      await expect.poll(() => camera(page)).toEqual(before);
    }
    await page.getByRole('radio', { name, exact: true }).click(); await tapMap(page, .45, .70);
    await expect(panel(page)).toHaveAttribute('data-point-emphasis', emphasis);
    const primary = name === 'Temp' ? 'temp' : name === 'Rain' ? 'cloud' : 'wind';
    await expect(panel(page).locator('[data-sounding]')).toHaveAttribute('data-point-primary', primary);
    await expectPointVisible(page); await expectMarkerCentered(page);
  }
}

test('every weather lens opens a visible point on desktop', async ({ page }) => {
  await exerciseLenses(page, 1280, 720);
});

test('every weather lens opens a visible point on phone', async ({ page }) => {
  await exerciseLenses(page, 390, 844);
});

test('a lens change keeps the map where the user panned it, with a pin open', async ({ page }) => {
  // Owner, 9 Oct: "when I change the map-type it moves the map location … jumped back to the last spot I'd dropped a pin".
  await open(page, 1280, 720); await fixedTime(page);
  await tapMap(page, .45, .60); await expectPointVisible(page);
  await expect(page.locator('.map-chrome-body')).not.toHaveAttribute('data-anim', '1');
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * .3, box.y + box.height * .4, { steps: 8 }); await page.mouse.up();
  const panned = await camera(page);
  await page.getByRole('radio', { name: 'Temp' }).click();
  await page.waitForTimeout(400);
  expect(await camera(page)).toEqual(panned);
  await page.getByRole('radio', { name: 'Rain' }).click();
  await page.waitForTimeout(400);
  expect(await camera(page)).toEqual(panned);
});

test('point camera is restored on close, place changes clear it, and landscape uses a side panel', async ({ page }) => {
  await open(page, 390, 844); await fixedTime(page);
  const before = await camera(page); await tapMap(page, .45, .70); await expectPointVisible(page); await expectMarkerCentered(page);
  // A replacement tap must still restore the exact camera from before the
  // first point was opened.
  const firstLocation = await panel(page).getAttribute('data-point-location');
  const replacementCanvas = (await canvas(page).boundingBox())!;
  await page.mouse.click(replacementCanvas.x + 40, replacementCanvas.y + 40);
  await expect(panel(page)).toHaveAttribute('data-point-location', /,/);
  expect(await panel(page).getAttribute('data-point-location')).not.toBe(firstLocation);
  await page.getByRole('button', { name: 'Close point' }).click(); await expect(panel(page)).toHaveCount(0);
  await expect.poll(async () => camera(page)).toEqual(before);
  await tapMap(page, .45, .70); await page.keyboard.press('Escape'); await expect(panel(page)).toHaveCount(0);
  await expect.poll(async () => camera(page)).toEqual(before);
  await tapMap(page, .45, .70); await choosePlace(page, 'Sydney', 'sydney');
  await expect(panel(page)).toHaveCount(0); await expect(page.locator('[data-point-marker]')).toHaveCount(0);
  await choosePlace(page, 'Perth', 'perth');
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(panel(page)).toHaveCount(0); await tapMap(page, .25, .35); await expectPointVisible(page); await expectMarkerCentered(page);
  await expect(panel(page)).toHaveAttribute('data-point-layout', 'side');
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(panel(page)).toHaveAttribute('data-point-layout', 'sheet'); await expectPointVisible(page); await expectMarkerCentered(page);
});

test('nearest catalogue place names the point, with coordinate fallback', async ({ page }) => {
  await open(page, 1280, 720, 'light', true); await fixedTime(page);
  const canberra = project(globalEquirectangular(), -35.2809, 149.13)!;
  await page.locator('[data-map-ready]').evaluate((e, p) => {
    const api = (e as HTMLElement & { chartApi: { camera: () => Camera; redraw: () => void } }).chartApi;
    Object.assign(api.camera(), { centerX: p.x, centerY: p.y, halfWidth: 12, halfHeight: 8 }); api.redraw();
  }, canberra);
  await tapMap(page, .5, .5); await expect(panel(page).locator('strong')).toHaveText('Canberra');
  await choosePlace(page, 'Sydney', 'sydney'); await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('[data-point-marker]')).toHaveCount(0);
  const p = project(globalEquirectangular(), -25, 75)!;
  await page.locator('[data-map-ready]').evaluate((e, point) => {
    const api = (e as HTMLElement & { chartApi: { camera: () => Camera; redraw: () => void } }).chartApi;
    Object.assign(api.camera(), { centerX: point.x, centerY: point.y, halfWidth: 12, halfHeight: 8 }); api.redraw();
  }, p);
  await tapMap(page, .5, .5); await expect(panel(page).locator('strong')).toHaveText('Indian Ocean');
  await expect(panel(page).locator('[data-point-coords]')).toHaveText('25.00°S 75.00°E');
});

for (const theme of ['light', 'dark'] as const) {
  test(`landscape phone side panel ${theme}`, async ({ page }, info) => {
    await open(page, 844, 390, theme); await fixedTime(page); await tapMap(page, .25, .35);
    await expect(panel(page)).toHaveAttribute('data-point-layout', 'side'); await expectPointVisible(page); await fit(page);
    await page.screenshot({ path: info.outputPath(`point-section-landscape-844x390-${theme}.png`), fullPage: false });
    if (process.env.ISOBAR_POINT_SHOTS) await page.screenshot({ path: `${process.env.ISOBAR_POINT_SHOTS}/844x390-${theme}.png`, fullPage: false });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`desktop map fills the content width ${theme}`, async ({ page }) => {
    await open(page, 1440, 900, theme); await fixedTime(page); await tapMap(page, .45, .18);
    await expect(panel(page)).toHaveAttribute('data-point-layout', 'side');
    const edges = await page.evaluate(() => {
      const stage = document.querySelector('[data-map-ready]')!.getBoundingClientRect();
      const host = document.querySelector('[data-map-panel]')!.getBoundingClientRect();
      return { left: stage.left - host.left, right: host.right - stage.right, stageLeft: stage.left };
    });
    expect(edges.left).toBeLessThan(4);
    expect(edges.right).toBeLessThan(4);
    expect(edges.stageLeft).toBeLessThan(160);
    await expectPointVisible(page);
    if (process.env.ISOBAR_POINT_SHOTS) await page.screenshot({ path: `${process.env.ISOBAR_POINT_SHOTS}/1440x900-${theme}.png`, fullPage: false });
  });
}

test('geographic Perth, mid-ocean and Rockies taps replace one marker', async ({ page }) => {
  await open(page, 1280, 720, 'light', true); await fixedTime(page);
  for (const point of [{ lat: -31.95, lon: 115.86, name: 'Perth' }, { lat: -25, lon: 75, name: 'Indian Ocean' }, { lat: 40, lon: -106, name: '40.00°N 106.00°W' }]) {
    if (await panel(page).count()) { await page.getByRole('button', { name: 'Close point' }).click(); await expect(panel(page)).toHaveCount(0); }
    const p = project(globalEquirectangular(), point.lat, point.lon)!;
    // Prepare a geographic camera view, then use the real pointer hit testing.
    await page.locator('[data-map-ready]').evaluate((e, p) => {
      const api = (e as HTMLElement & { chartApi: { camera: () => Camera; redraw: () => void } }).chartApi;
      Object.assign(api.camera(), { centerX: p.x, centerY: p.y, halfWidth: 30, halfHeight: 20 }); api.redraw();
    }, p);
    await tapMap(page, .5, .5); await expect(panel(page).locator('strong')).toHaveText(point.name);
    const sea = panel(page).locator('[data-sea-row]');
    if (point.lon === 75) {
      await expect(sea).toHaveCount(4);
      const column = await panel(page).locator('[data-wind-row], [data-sea-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-level') ?? row.getAttribute('data-sea-row')));
      expect(column.slice(column.indexOf('surface'))).toEqual(['surface', 'current', 'sst', 'wave', 'swell']);
      await expect(panel(page).locator('[data-sea-row="current"]')).toHaveText(/to 090\/1\.5/);
      await expect(panel(page).locator('[data-sea-row="sst"]')).toHaveText('18°C');
      await expect(panel(page).locator('[data-sea-row="wave"]')).toHaveText('1.7 m');
      await expect(panel(page).locator('[data-sea-row="swell"]')).toHaveText('1.2 m · 12 s · 220°');
    } else await expect(sea).toHaveCount(0);
    const picked = (await panel(page).getAttribute('data-point-location'))!.split(',').map(Number);
    expect(picked[0]).toBeCloseTo(point.lat, 3); expect(picked[1]).toBeCloseTo(point.lon, 3);
    await expect(page.locator('[data-point-marker]')).toHaveCount(1); await expect(page.locator('[data-point-panel], [data-fly-panel]')).toHaveCount(1);
  }
});

test('hold freezes and resumes; drag pans without selecting', async ({ page }) => {
  await open(page, 1280, 720);
  const b = (await canvas(page).boundingBox())!, x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(250);
  const held = Number(await slider(page).getAttribute('aria-valuenow')); await page.waitForTimeout(600);
  expect(Number(await slider(page).getAttribute('aria-valuenow'))).toBe(held); await page.mouse.up();
  await expect(panel(page)).toHaveCount(0); await expect.poll(async () => Number(await slider(page).getAttribute('aria-valuenow'))).toBeGreaterThan(held);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const before = await camera(page);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 100, y + 35, { steps: 8 }); await page.mouse.up();
  const after = await camera(page); expect([after.centerX, after.centerY]).not.toEqual([before.centerX, before.centerY]); await expect(panel(page)).toHaveCount(0);
  await tapMap(page); await expectMarkerCentered(page); const location = await panel(page).getAttribute('data-point-location');
  const moved = (await canvas(page).boundingBox())!;
  await page.mouse.move(moved.x + moved.width * .2, moved.y + moved.height * .2); await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up();
  await expect(panel(page)).toHaveAttribute('data-point-location', location!);
});

test('Fly keeps the aerodrome sheet and does not select arbitrary points', async ({ page }) => {
  const requests = await open(page, 1280, 720, 'light', false, '2026-10-08T18:00:00Z'); await tapMap(page);
  const location = await panel(page).getAttribute('data-point-location');
  await page.getByRole('radio', { name: 'Fly', exact: true }).click(); await expect(page.locator('[data-fly-panel]')).toBeVisible(); await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('[data-sky-run]')).toHaveText('IFS 0.25° · 08 18Z');
  await expect(page.locator('[data-sky-run]')).toHaveAttribute('title', 'ECMWF · IFS 0.25° · 08 18Z');
  const before = requests(), b = (await canvas(page).boundingBox())!;
  await page.mouse.click(b.x + b.width * .3, b.y + b.height * .2); await expect(panel(page)).toHaveCount(0); expect(requests()).toBe(before);
  await expect(page.locator('[data-point-panel], [data-fly-panel]')).toHaveCount(1);
  await page.getByRole('radio', { name: 'Wind', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-point-location', location!);
  await expectPointVisible(page); await expectMarkerCentered(page);
});

test('moving a point discards a late response and revisiting survives offline reload', async ({ page }) => {
  await open(page, 1280, 720); await fixedTime(page);
  let count = 0, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('https://api.open-meteo.com/v1/forecast?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('daily')) {
      await route.fulfill({ json: placeForecast(Number(url.searchParams.get('latitude')), Number(url.searchParams.get('longitude'))) });
      return;
    }
    const first = ++count === 1;
    if (first) await gate;
    const payload = structuredClone(fixture);
    payload.hourly.wind_speed_10m = payload.hourly.wind_speed_10m.map(() => first ? 99 : 13);
    // Fulfilling an aborted route may fail in Chromium after the second tap.
    await route.fulfill({ json: payload }).catch((error) => { if (!first) throw error; });
  });
  try {
    const b = (await canvas(page).boundingBox())!;
    await page.mouse.click(b.x + b.width * .25, b.y + b.height * .18);
    await expect.poll(() => count).toBe(1);
    await expectMarkerCentered(page);
    await tapMap(page, .20, .25);
    const selected = (await panel(page).getAttribute('data-point-location'))!.split(',').map(Number);
    release();
    const surfaceWind = panel(page).locator('[data-level="surface"] [data-wind-text]');
    await expect(surfaceWind).toContainText('13'); await expect(surfaceWind).not.toContainText('99');
    // A reload removes the module cache. The same location must now come from
    // sessionStorage even when the external endpoint has become unavailable.
    await page.route('https://api.open-meteo.com/v1/forecast?**', (route) => route.abort());
    await page.reload();
    await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true');
    await page.getByRole('radio', { name: 'Wind', exact: true }).click(); await fixedTime(page);
    // Use the actual Lambert projection to reconstruct the tap after resize.
    const { australiaLambert, cameraProject } = await import('../../src/lib/lambert');
    const projected = project(australiaLambert(), selected[0], selected[1])!;
    await page.locator('[data-map-ready]').evaluate((e, p) => {
      const api = (e as HTMLElement & { chartApi: { camera: () => Camera; redraw: () => void } }).chartApi;
      Object.assign(api.camera(), { centerX: p.x, centerY: p.y }); api.redraw();
    }, projected);
    const clip = cameraProject(await camera(page), projected.x, projected.y);
    await tapMap(page, (clip.x + 1) / 2, (1 - clip.y) / 2);
    await expect(panel(page).locator('[data-level="surface"] [data-wind-text]')).toContainText('13');
    expect(count).toBe(2);
  } finally { release(); }
});

for (const [width, height] of [[390, 844], [375, 667]] as const) for (const theme of ['light', 'dark']) {
  test(`phone ${width}x${height} ${theme}: one sheet, reachable levels, exposed map`, async ({ page }, info) => {
    await open(page, width, height, theme); await fixedTime(page); await tapMap(page, .45, .70); await expectPointVisible(page); await fit(page);
    const scroll = panel(page).locator('[data-point-scroll]');
    for (const level of ['200', 'surface']) {
      await scroll.evaluate((e, last) => { e.scrollTop = last ? e.scrollHeight : 0; }, level === '200');
      expect(await panel(page).locator(`[data-wind-row][data-level="${level}"]`).evaluate((e) => {
        const r = e.getBoundingClientRect(), b = e.closest('[data-point-scroll]')!.getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
      })).toBe(true);
    }
    await page.getByRole('radio', { name: 'Rain', exact: true }).click(); await fit(page);
    await page.getByRole('radio', { name: 'Temp', exact: true }).click(); await fit(page);
    const exposed = await page.evaluate(() => {
      const stage = document.querySelector('[data-map-ready]')!.getBoundingClientRect();
      const sheet = document.querySelector('[data-point-panel]')!.getBoundingClientRect();
      const graphic = document.querySelector('[data-sounding]')!.getBoundingClientRect();
      return { mapPx: sheet.top - stage.top, graphic: graphic.height / sheet.height };
    });
    // A strip of map keeps the tapped point in view above the sheet. (40% of the
    // viewport is impossible on a phone: the chrome already takes most of it.)
    expect(exposed.mapPx).toBeGreaterThanOrEqual(100);
    expect(exposed.graphic).toBeGreaterThanOrEqual(0.5);
    await page.screenshot({ path: info.outputPath(`point-section-${width}x${height}-${theme}.png`), fullPage: false });
    if (process.env.ISOBAR_POINT_SHOTS) await page.screenshot({ path: `${process.env.ISOBAR_POINT_SHOTS}/${width}x${height}-${theme}.png`, fullPage: false });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await expect(page.getByRole('button', { name: 'Close point' })).toBeInViewport(); await page.getByRole('button', { name: 'Close point' }).click(); await expect(panel(page)).toHaveCount(0);
  });
}


test('delayed profile expands from a compact phone inspector with the pin still visible', async ({ page }, info) => {
  await open(page, 390, 844); await fixedTime(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('https://api.open-meteo.com/v1/forecast?**', async route => {
    if (new URL(route.request().url()).searchParams.has('daily')) return route.fallback();
    await pending;
    try { await route.fulfill({ json: fixture }); } catch { /* closed point cancels */ }
  });
  await settledMap(page);
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * .45, box.y + box.height * .7);
  await expect(panel(page)).toHaveAttribute('data-point-state', 'loading');
  expect((await panel(page).boundingBox())!.height).toBeLessThan(150);
  const time = await page.locator('[data-map-ready]').getAttribute('data-valid-ms');
  release();
  await expect(panel(page)).toHaveAttribute('data-point-state', 'ready');
  await expectPointVisible(page); await expectMarkerCentered(page);
  expect(await page.locator('[data-map-ready]').getAttribute('data-valid-ms')).toBe(time);
  await page.screenshot({path: info.outputPath('delayed-profile-expanded.png')});
});
