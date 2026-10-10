import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Offline renderer gallery for traffic variant D. The page is a tiny document
 * with the production geometry and paint functions bundled into it; every
 * request is fulfilled or aborted by Playwright, so this test never starts a
 * server or contacts a feed.
 */

const WEB = path.resolve(process.cwd());
const OUT = path.join(WEB, '..', 'build', 'traffic-D', 'renderer');
const NOW = Date.UTC(2026, 9, 9, 4, 0, 0);

type SheetTrack = {
  id: string; kind: 'air' | 'ship'; type: string; callsign?: string; lon: number; lat: number;
  altitude_ft?: number; speed_kt?: number; track_deg?: number;
};

const sheet = JSON.parse(readFileSync(path.join(WEB, 'tools', 'traffic-sheet', 'fixture.json'), 'utf8')) as { tracks: SheetTrack[] };
const coast = readFileSync(path.join(WEB, 'public', 'coast', 'world.bin')).toString('base64');
const localCoast = readFileSync(path.join(WEB, '..', 'Resources', 'ownchart-coast.bin')).toString('base64');

const ICAO_BY_CLASS: Record<string, string> = {
  heavy: 'B77W', narrowbody: 'B738', regional: 'DH8D', bizjet: 'GLF6', ga: 'C172', helicopter: 'EC35',
};

function rows() {
  const seen = new Set<string>();
  return sheet.tracks.map((track, index) => {
    if (track.kind === 'ship') return { id: track.id, name: track.callsign ?? `AIS ${index + 1}`, shipType: ({ tanker: 80, cargo: 70, passenger: 60, fishing: 30, sail: 36, tug: 52 } as Record<string, number>)[track.type] ?? 52, latitude: track.lat, longitude: track.lon, positionTimeMs: NOW - 1_000, groundSpeedKt: track.speed_kt, trackDegrees: track.track_deg };
    const type = ICAO_BY_CLASS[track.type] ?? 'B738';
    const hex = track.id;
    const proposed = track.callsign ?? `TST${index}`;
    const callsign = !seen.has(track.type) && track.type === 'narrowbody' ? 'QFA642' : proposed === 'QFA642' ? `TST${index}` : proposed;
    seen.add(track.type);
    return { hex, callsign, registration: 'VH-TEST', type, latitude: track.lat, longitude: track.lon, pressureAltitudeFt: track.altitude_ft ?? 0, distanceNm: 10, positionTimeMs: NOW - 1_000, groundSpeedKt: track.speed_kt, trackDegrees: track.track_deg };
  });
}

async function bundle() {
  const contents = `
    import { layoutTraffic, paintTraffic, trafficScreen } from './lib/traffic';
    import { paintTrafficPaths, trackColor } from './lib/traffic-path-render';
    import { globalEquirectangular } from './lib/lambert';
    import { parseCoast } from './lib/coast';
    import { TRAFFIC_PALETTES } from './lib/traffic-symbols';
    const coasts = new Map();
    window.checkTrafficPaths = () => {
      const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 600;
      const ctx = canvas.getContext('2d'), geo = globalEquirectangular(116, -32);
      const camera = { centerX: 0, centerY: -32, halfWidth: 1, halfHeight: 1 };
      const aircraft = { hex: 'gap', callsign: 'GAP' };
      const points = [0, 60, 361, 362, 422].map((s, i) => ({ latitude: -32, longitude: 115.2 + i * .2, timeMs: s * 1000, pressureAltitudeFt: 37000 }));
      paintTrafficPaths(ctx, { selected: [{ hex: 'gap', colorIndex: 0 }], trails: new Map([['gap', { aircraft, points }]]), routes: new Map(), geo, camera, width: 900, height: 600, dark: false });
      const segments = [115.3, 115.5, 115.7, 115.9].map((lon) => {
        const p = trafficScreen(geo, camera, 900, 600, -32, lon);
        return ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data[3];
      });
      ctx.clearRect(0, 0, 900, 600);
      const turn = [{ latitude: -32, longitude: 115.2, timeMs: 0 }, { latitude: -31.8, longitude: 115.6, timeMs: 120000 }, { latitude: -32, longitude: 116, timeMs: 240000 }];
      paintTrafficPaths(ctx, { selected: [{ hex: 'gap', colorIndex: 0 }], trails: new Map([['gap', { aircraft, points: turn }]]), routes: new Map(), geo, camera, width: 900, height: 600, dark: false });
      const alpha = (lat) => { const p = trafficScreen(geo, camera, 900, 600, lat, 115.6); return ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data[3]; };
      return [...segments, alpha(-31.8), alpha(-32)];
    };
    window.renderTraffic = ({ tier, dark, rows, coastBytes, now, selectedColors, raster = false }) => {
      const canvas = document.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const width = canvas.clientWidth, height = canvas.clientHeight;
      const aircraft = rows.filter((row) => 'hex' in row);
      const vessels = rows.filter((row) => 'id' in row);
      const centreLatitude = tier === 'global' ? 0 : tier === 'regional' ? -26.5 : -31.96;
      const centreLongitude = tier === 'global' ? 0 : tier === 'regional' ? 134 : 115.885;
      const geo = globalEquirectangular(centreLongitude, centreLatitude);
      const camera = tier === 'global' ? { centerX: 0, centerY: 0, halfWidth: 180, halfHeight: 80 } : tier === 'regional' ? { centerX: 0, centerY: centreLatitude, halfWidth: 30 * geo.F, halfHeight: 17.5 } : { centerX: 0, centerY: centreLatitude, halfWidth: .28, halfHeight: .18 };
      const selections = [...selectedColors.keys()].map((hex, i) => ({ hex, colorIndex: i }));
      const selected = new Map(selections.map((item) => [item.hex, trackColor(item.colorIndex, dark)]));
      const trails = new Map(aircraft.filter((row) => selected.has(row.hex)).map((row) => [row.hex, { aircraft: row, points: Array.from({ length: 240 }, (_, i) => ({ latitude: row.latitude - (239 - i) * .001, longitude: row.longitude - (239 - i) * .001, timeMs: now - 1000 - (239 - i) * 10000, pressureAltitudeFt: row.pressureAltitudeFt })) }]));
      const routes = new Map();
      const glyphs = layoutTraffic({ aircraft, vessels, trails, nowMs: now, geo, camera, width, height, selectedColors: selected, showLabels: true });
      const key = tier + ':' + dark;
      if (!coasts.has(key)) {
        const plate = document.createElement('canvas'); plate.width = width; plate.height = height;
        const plateCtx = plate.getContext('2d');
        const parsed = parseCoast(Uint8Array.from(atob(coastBytes), (char) => char.charCodeAt(0)));
        plateCtx.fillStyle = dark ? '#232f3e' : '#e9eff4'; plateCtx.fillRect(0, 0, width, height);
        plateCtx.strokeStyle = dark ? '#b6b09b' : '#676a62'; plateCtx.fillStyle = dark ? '#665839' : '#f1ecbb'; plateCtx.lineWidth = .7;
        for (const ring of parsed.rings) {
          plateCtx.beginPath();
          for (let i = 0; i < ring.lon.length; i++) {
            const x = (1 + ((ring.lon[i] - centreLongitude) * geo.F - camera.centerX) / camera.halfWidth) * width / 2;
            const y = (1 - (ring.lat[i] - camera.centerY) / camera.halfHeight) * height / 2;
            if (i === 0) plateCtx.moveTo(x, y); else plateCtx.lineTo(x, y);
          }
          plateCtx.closePath(); plateCtx.fill(); plateCtx.stroke();
        }
        coasts.set(key, plate);
      }
      paintTraffic(ctx, glyphs, 1, dark, () => {
        ctx.drawImage(coasts.get(key), 0, 0);
        paintTrafficPaths(ctx, { selected: selections, trails, routes, geo, camera, width, height, dark });
      });
      const pixel = (mark) => {
        const x = Math.round(mark.x), y = Math.round(mark.y);
        return x >= 0 && x < width && y >= 0 && y < height ? Array.from(ctx.getImageData(x, y, 1, 1).data) : null;
      };
      if (raster) ctx.getImageData(0, 0, width, height); // Force queued canvas raster work into the sample.
      return { glyphs: glyphs.map((glyph) => ({ hex: glyph.hex, x: glyph.x, y: glyph.y, pixel: raster ? null : pixel(glyph), vesselId: glyph.vessel?.id ?? null, aircraft: glyph.aircraft?.callsign ?? null, symbolClass: glyph.symbolClass, altitudeBand: glyph.altitudeBand, size: glyph.size, vector: glyph.vector, label: glyph.label, labelOrigin: glyph.labelOrigin, densityDot: glyph.densityDot, selected: glyph.selected, color: glyph.color ?? null })), width, height, tier, dark, trackColor: trackColor(0, dark), quietAir: TRAFFIC_PALETTES[dark ? 'dark' : 'light'].dot_air, quietShip: TRAFFIC_PALETTES[dark ? 'dark' : 'light'].dot_ship };
    };
  `;
  const result = await build({ stdin: { contents, resolveDir: path.join(WEB, 'src') }, bundle: true, write: false, format: 'iife', target: 'es2022' });
  return result.outputFiles[0].text;
}

async function install(page: Page, script: string) {
  const payload = JSON.stringify({ rows: rows(), coast });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#111}canvas{display:block;width:900px;height:600px}</style><canvas width="900" height="600"></canvas><script>window.TRAFFIC_FIXTURE=${payload}</script><script src="/bundle.js"></script>` });
    return route.abort();
  });
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('http://traffic.local/');
}

test('variant D renders classes, vectors, selection colours, coast and quiet dots offline', async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });
  await install(page, await bundle());
  const [validBefore, gap, jump, validAfter, turn, shortcut] = await page.evaluate(() => window.checkTrafficPaths());
  expect(validBefore).toBeGreaterThan(0); expect(validAfter).toBeGreaterThan(0);
  expect(gap).toBe(0); expect(jump).toBe(0);
  expect(turn).toBeGreaterThan(0); expect(shortcut).toBe(0);
  const result = await page.evaluate(({ coast, localCoast, rows, now }) => {
    const selectedColors = new Map([['air-001', '#007e75'], ['ship:ship-001', '#926100']]);
    const output: Record<string, unknown> = {};
    for (const tier of ['global', 'regional', 'close'] as const) for (const dark of [false, true]) {
      const info = window.renderTraffic({ tier, dark, rows, coastBytes: tier === 'global' ? coast : localCoast, now, selectedColors });
      output[`${tier}-${dark ? 'dark' : 'light'}`] = info;
    }
    return output;
  }, { coast, localCoast, rows: rows(), now: NOW });
  const global = result['global-light'] as { glyphs: any[] };
  const regional = result['regional-light'] as { glyphs: any[] };
  const close = result['close-light'] as { glyphs: any[] };
  const allGlyphs = [...global.glyphs, ...regional.glyphs, ...close.glyphs];
  expect(global.glyphs.length).toBeGreaterThan(0);
  expect(global.glyphs.every((glyph) => glyph.densityDot)).toBe(true);
  expect(global.glyphs.length).toBeGreaterThan(250);
  for (const mode of ['light', 'dark']) {
    const frame = result[`global-${mode}`] as any;
    for (const [kind, color] of [['aircraft', frame.quietAir], ['vesselId', frame.quietShip]]) {
      const rgb = color.slice(1).match(/../g).map((hex: string) => parseInt(hex, 16));
      expect(frame.glyphs.some((glyph: any) => glyph[kind] && !glyph.selected && glyph.pixel?.slice(0, 3).every((n: number, i: number) => Math.abs(n - rgb[i]) < 8))).toBe(true);
    }
  }
  expect((result['global-dark'] as any).quietAir).not.toBe((result['global-light'] as any).quietAir);
  expect(regional.glyphs.some((glyph) => !glyph.densityDot && glyph.vector)).toBe(true);
  expect(close.glyphs.some((glyph) => glyph.aircraft === 'QFA642' && glyph.label?.includes('QFA642'))).toBe(true);
  expect(allGlyphs.some((glyph) => glyph.symbolClass === 'heavy')).toBe(true);
  expect(allGlyphs.some((glyph) => glyph.symbolClass === 'helicopter')).toBe(true);
  expect(allGlyphs.some((glyph) => glyph.symbolClass === 'tanker')).toBe(true);
  expect(close.glyphs.find((glyph) => glyph.aircraft === 'QFA642')?.color).toBe('#007e75');
  expect((result['close-dark'] as any).glyphs.find((glyph: any) => glyph.aircraft === 'QFA642')?.color).toBe('#35d6c7');
  expect(new Set(close.glyphs.map((glyph) => glyph.symbolClass)).size).toBe(12);
  expect(close.glyphs.every((glyph) => glyph.vesselId ? !['heavy', 'narrowbody', 'regional', 'bizjet', 'ga', 'helicopter'].includes(glyph.symbolClass) : true)).toBe(true);
  for (const key of Object.keys(result)) {
    const mode = key.endsWith('dark') ? 'dark' : 'light';
    const tier = key.split('-')[0];
    await page.evaluate(({ mode, tier, coast, localCoast, rows, now }) => window.renderTraffic({ tier, dark: mode === 'dark', rows, coastBytes: tier === 'global' ? coast : localCoast, now, selectedColors: new Map([['air-001', '#007e75'], ['ship:ship-001', '#926100']]) }), { mode, tier, coast, localCoast, rows: rows(), now: NOW });
    await page.screenshot({ path: path.join(OUT, `${mode}-${tier}.png`) });
  }

  // Include the raster/selection budget in this same offline browser context.
  const perf = await page.evaluate(({ coast, localCoast, rows, now }) => {
    const selectedColors = new Map(rows.filter((row) => 'hex' in row).slice(0, 8).map((row) => [row.hex, '']));
    const output = {};
    for (const tier of ['global', 'regional', 'close']) {
      for (let i = 0; i < 20; i++) window.renderTraffic({ tier, dark: false, rows, coastBytes: tier === 'global' ? coast : localCoast, now, selectedColors, raster: true });
      const samples = [];
      for (let i = 0; i < 120; i++) {
        const start = performance.now();
        const frame = window.renderTraffic({ tier, dark: false, rows, coastBytes: tier === 'global' ? coast : localCoast, now, selectedColors, raster: true });
        samples.push(performance.now() - start);
        if (!frame.glyphs.length) throw new Error('Performance sample has no traffic');
      }
      samples.sort((a, b) => a - b);
      output[tier] = { p95: samples[Math.floor(samples.length * .95)], max: samples.at(-1), samples };
    }
    return output;
  }, { coast, localCoast, rows: rows(), now: NOW });
  mkdirSync(path.dirname(path.join(OUT, '..', 'perf.json')), { recursive: true });
  writeFileSync(path.join(OUT, '..', 'perf.json'), `${JSON.stringify(perf, null, 2)}\n`);
  for (const result of Object.values(perf) as { p95: number }[]) expect(result.p95).toBeLessThanOrEqual(17);
});

declare global {
  interface Window {
    checkTrafficPaths: () => number[];
    TRAFFIC_FIXTURE: { rows: unknown[]; coast: string };
    renderTraffic: (input: any) => any;
  }
}
