import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const RUN = '2026-10-08T00:00:00Z';
const PERTH = { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.86, icao: 'YPPH' };
const SYDNEY = { id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.87, lon: 151.21, icao: 'YSSY' };
const KELOWNA = { id: 'kelowna', name: 'Kelowna', zone: 'America/Vancouver', lat: 49.89, lon: -119.50, icao: 'CYLW' };

export async function openSlowMap(page: Page, width: number, height: number, theme: 'light' | 'dark', signedIn = false) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((mode) => { localStorage.setItem('isobar-theme', mode); localStorage.setItem('isobar.place', 'perth'); }, theme);
  await page.clock.install({ time: new Date('2026-10-08T03:00:00Z') });
  const hours = Array.from({ length: 41 }, (_, i) => i * 3);
  const grid = { nx: 64, ny: 49, west: 105, east: 168, north: 0, south: -48, step: 1, dtype: 'uint16' };
  const variables = Object.fromEntries(['mslp', 'rain24', 't2m', 'wind', 'u10', 'v10'].map((name) => [name, { frames: hours.map(() => `${name}.bin`), units: 'kt', scale: 1, offset: 0, fill: 65535 }]));
  const manifest = { schema: 2, contract: 'isobar-web', run: RUN, generated: RUN, forecast_hours: hours, grid, variables, places: [PERTH, SYDNEY, KELOWNA], points: 'points.json', aviation: 'aviation.json', attribution: [{ source: 'Synthetic slow lane', licence: 'Test fixture' }] };
  const frames = new Map(Object.keys(variables).map((name) => { const body = Buffer.alloc(grid.nx * grid.ny * 2); for (let i = 0; i < grid.nx * grid.ny; i++) body.writeUInt16LE(name === 'mslp' ? 10130 : 20, i * 2); return [name, body]; }));
  const coast = Buffer.alloc(26); coast.write('OCST'); coast.writeUInt16LE(1, 4); coast.writeUInt16LE(1, 6); coast.writeUInt16LE(4, 8); [[113, -35], [120, -35], [120, -20], [113, -20]].forEach(([lon, lat], i) => { coast.writeInt16LE(lon * 100, 10 + i * 4); coast.writeInt16LE(lat * 100, 12 + i * 4); });
  await Promise.all([
    page.route('**', (route) => {
      const url = new URL(route.request().url());
      if (['localhost', '127.0.0.1'].includes(url.hostname) && !url.pathname.startsWith('/api/')) {
        if (process.env.ISOBAR_E2E_FILES !== '1') return route.continue();
        // Same production page without a listening server; every API stays mocked.
        const file = url.pathname.startsWith('/_next/static/') ? `.next/${url.pathname.slice(7)}`
          : url.pathname === '/' ? '.next/server/app/index.html'
          : url.pathname === '/train' ? '.next/server/app/train.html' : `public${url.pathname}`;
        if (file.includes('..')) return route.abort();
        try {
          const contentType = ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' } as Record<string, string>)[path.extname(file)] ?? 'application/octet-stream';
          return route.fulfill({ body: readFileSync(file), contentType });
        } catch { return route.fulfill({ status: 404, body: '' }); }
      }
      return route.fulfill({ status: 404, body: '' });
    }),
    page.route('**/api/account/data', (route) => route.fulfill({ json: { docs: {} } })),
    page.route('https://tiles.mapterhorn.com/**', (route) => route.fulfill({ status: 404, body: '' })),
    page.route('**/api/auth/**', (route) => {
      const suffix = new URL(route.request().url()).pathname;
      if (suffix.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'fixture' } });
      if (suffix.endsWith('/signout')) return route.fulfill({ json: { url: 'http://127.0.0.1:4173/' } });
      return route.fulfill({ json: signedIn ? { user: { id: 'slow-user', email: 'pilot@example.test' } } : {} });
    }),
    page.route('**/coast/*.bin', (route) => route.fulfill({ body: coast, contentType: 'application/octet-stream' })),
    page.route('**/places/world-places.json', (route) => route.fulfill({ json: [['Perth', -31.95, 115.86, 1, 'AU'], ['Sydney', -33.87, 151.21, 1, 'AU'], ['Kelowna', 49.89, -119.50, 1, 'CA']] })),
    page.route('**/data/**', async (route) => {
      const file = new URL(route.request().url()).pathname.split('/').at(-1)!;
      if (file === 'manifest.json') return route.fulfill({ json: manifest });
      if (file === 'points.json') return route.fulfill({ json: { run: RUN, hours, places: { perth: { t: hours.map(() => 20), wspd: hours.map(() => 13), wdir: hours.map(() => 220), tp: hours.map(() => 0), cc: hours.map(() => 42) }, sydney: { t: hours.map(() => 21), wspd: hours.map(() => 11), wdir: hours.map(() => 180), tp: hours.map(() => 0), cc: hours.map(() => 36) }, kelowna: { t: hours.map(() => 12), wspd: hours.map(() => 7), wdir: hours.map(() => 290), tp: hours.map(() => 1), cc: hours.map(() => 60) } } } });
      if (file === 'aviation.json') return route.fulfill({ json: { airports: [], sigmets: [] } });
      if (file === 'sky.json') return route.fulfill({ json: { profiles: [] } });
      return frames.get(file.replace('.bin', '')) ? route.fulfill({ body: frames.get(file.replace('.bin', '')), contentType: 'application/octet-stream' }) : route.fulfill({ status: 404 });
    }),
  ]);
  await page.goto('/');
  await expect(page.locator('[data-map-ready]')).toHaveAttribute('data-map-ready', 'true', { timeout: 60_000 });
  const pause = page.getByRole('button', { name: 'Pause', exact: true });
  if (await pause.isVisible()) await pause.click();
}
