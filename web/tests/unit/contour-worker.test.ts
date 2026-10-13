import { afterEach, expect, it, vi } from 'vitest';
import { contourPressure, smoothGrid } from '../../src/lib/contour';
import { cycloneContours } from '../../src/lib/cyclone-contours';
import { sampleMonotoneBicubic } from '../../src/lib/cyclone-environment';
import { cycloneAt, type HistoricalCyclone } from '../../src/lib/historical-cyclone';

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])('worker and synchronous reconstruction agree (global=%s)', async (global) => {
  vi.resetModules();
  const worker = { onmessage: null as any, postMessage: vi.fn() };
  vi.stubGlobal('self', worker);
  await import('../../src/workers/contour.worker');
  const storm: HistoricalCyclone = { method: 'compact-vortex-v1', rmwKm: 11, source: 'fixture', track: [
    { time: '1974-12-24T18:00Z', lat: -12.4, lon: 130.9, windKt: 95, pressureHpa: 950 },
    { time: '1974-12-25T00:00Z', lat: -12.4, lon: 130.9, windKt: 95, pressureHpa: 950 },
  ] };
  const nx = global ? 144 : 17, ny = global ? 73 : 17, west = global ? -180 : 110, north = global ? 90 : 10;
  const data = { id: 7, cyclone: cycloneAt(storm, Date.parse(storm.track[0].time))!, nx, ny, west, north, dlon: 2.5, dlat: -2.5,
    mslp: Float32Array.from({ length: nx * ny }, (_, i) => 1004 + 7 * Math.sin(i % nx / 3) + 4 * Math.cos(Math.floor(i / nx) / 2)) };
  worker.onmessage({ data });
  const values = smoothGrid(smoothGrid(data.mslp, nx, ny, global), nx, ny, global);
  const grid = { values, nx, ny, west, north, step: 2.5, wrapsLongitude: global };
  const base = contourPressure(data.mslp, nx, ny, west, north, 2.5, -2.5, 4);
  const expected = cycloneContours(base, data.cyclone, (lon, lat) => sampleMonotoneBicubic(grid, lon, lat), grid);
  expect(worker.postMessage).toHaveBeenCalledWith({ id: 7, ...expected }, expect.any(Array));
  const sent = worker.postMessage.mock.calls[0];
  expect(sent[1]).toEqual(sent[0].lines.flatMap((line: any) => [line.lon.buffer, line.lat.buffer]));
  expect(expected.lines.length).toBeGreaterThan(0);
});
