import { expect, type Page } from '@playwright/test';

const RUN = '2026-10-08T00:00:00Z';
const PERTH = { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.86, icao: 'YPPH' };
const SYDNEY = { id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.87, lon: 151.21, icao: 'YSSY' };

/** Synthetic chart plus the endpoints a headless map hits. Usage is acknowledged so a missing database is not a console error. */
export function chartRoutes(page: Page, global = false) {
  const hours = global ? [...Array.from({ length: 49 }, (_, i) => i * 3), 150, 156, 162, 168] : Array.from({ length: 41 }, (_, i) => i * 3);
  const grid = global
    ? { nx: 720, ny: 361, west: -180, east: 179.5, north: 90, south: -90, step: .5, wraps_longitude: true, dtype: 'uint16' }
    : { nx: 64, ny: 49, west: 105, east: 168, north: 0, south: -48, step: 1, dtype: 'uint16' };
  const variables = Object.fromEntries(['mslp', 'rain24', 't2m', 'wind', 'u10', 'v10'].map((name) => [name, {
    frames: hours.map(() => `${name}.bin`), units: name === 'mslp' ? 'hPa' : name === 't2m' ? '°C' : name === 'rain24' ? 'mm' : 'kt', scale: 1, offset: 0, fill: 65535,
  }]));
  const manifest = {
    schema: 2, contract: 'isobar-web', run: RUN, generated: RUN, forecast_hours: hours, grid, variables,
    places: [PERTH, SYDNEY], points: 'points.json', aviation: 'aviation.json',
    attribution: [{ source: 'Synthetic point journey', licence: 'Test fixture' }],
  };
  const frames = new Map(Object.keys(variables).map((name) => {
    const body = Buffer.alloc(grid.nx * grid.ny * 2);
    for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) body.writeUInt16LE(name === 'mslp' ? 10130 : 20, (j * grid.nx + i) * 2);
    return [name, body];
  }));
  const coast = Buffer.alloc(26);
  coast.write('OCST'); coast.writeUInt16LE(1, 4); coast.writeUInt16LE(1, 6); coast.writeUInt16LE(4, 8);
  [[113, -35], [120, -35], [120, -20], [113, -20]].forEach(([lon, lat], i) => {
    coast.writeInt16LE(lon * 100, 10 + i * 4); coast.writeInt16LE(lat * 100, 12 + i * 4);
  });
  return Promise.all([
    page.route('https://tiles.mapterhorn.com/**', (route) => route.fulfill({ status: 404, body: '' })),
    page.route('**/api/auth/**', (route) => route.fulfill({ json: {} })),
    page.route('**/api/usage', (route) => route.fulfill({ status: 204, body: '' })),
    page.route('**/coast/*.bin', (route) => route.fulfill({ body: coast, contentType: 'application/octet-stream' })),
    page.route('**/places/world-places.json', (route) => route.fulfill({ json: [
      ['Perth', -31.95, 115.86, 1, 'AU'], ['Sydney', -33.87, 151.21, 1, 'AU'],
    ] })),
    page.route('**/data/**', async (route) => {
      const file = new URL(route.request().url()).pathname.split('/').at(-1)!;
      if (file === 'manifest.json') return route.fulfill({ json: manifest });
      if (file === 'points.json') return route.fulfill({ json: { run: RUN, hours, places: {
        perth: { t: hours.map(() => 20), wspd: hours.map(() => 13), wdir: hours.map(() => 220), tp: hours.map(() => 0), cc: hours.map(() => 42) },
        sydney: { t: hours.map(() => 21), wspd: hours.map(() => 11), wdir: hours.map(() => 180), tp: hours.map(() => 0), cc: hours.map(() => 36) },
      } } });
      if (file === 'aviation.json') return route.fulfill({ json: { airports: [{ ...PERTH, metar: { raw: 'METAR YPPH 080300Z 22013KT 9999 SCT030 19/11 Q1013', time: '2026-10-08T03:00:00Z' }, taf: null }], sigmets: [] } });
      if (file === 'sky.json') return route.fulfill({ json: { profiles: [] } });
      const body = frames.get(file.replace('.bin', ''));
      return body ? route.fulfill({ body, contentType: 'application/octet-stream' }) : route.fulfill({ status: 404 });
    }),
  ]);
}

export async function tapPoint(page: Page) {
  const canvas = page.locator('canvas[tabindex="0"]');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.55);
  await expect(page.locator('[data-point-panel]')).toBeVisible();
  const raw = await page.locator('[data-point-panel]').getAttribute('data-point-location');
  const [lat, lon] = (raw ?? '').split(',').map(Number);
  expect(Number.isFinite(lat) && Number.isFinite(lon)).toBe(true);
  return { lat, lon };
}
