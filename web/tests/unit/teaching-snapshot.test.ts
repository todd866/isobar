import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { computeTeachingSnapshot, cropTeachingInput, teachingInput } from '../../src/lib/teaching-snapshot';
import type { ChartManifest } from '../../src/lib/manifest';
import { readManifest } from '../../src/lib/manifest';
import { decodeUint16 } from '../../src/lib/quantise';
import { windComponent } from '../../src/lib/wind-barbs';
import { FRAME_READY, FRAME_MISSING, type LoadedChart } from '../../src/lib/chart-store';

const root = path.resolve('public/data');
describe('complete teaching pipeline', () => {
  it.skipIf(!fs.existsSync(path.join(root, 'manifest.json')))('builds coherent lessons from the exported local synthetic fixture', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    // Never read weather outside the workspace. This integration case belongs to
    // the explicitly generated artificial fixture; other exports use unit cases.
    if (!raw.attribution[0].source.startsWith('Synthetic')) return;
    const m = readManifest(raw);
    const read = (name: string) => { const b = fs.readFileSync(path.join(root, m.variables[name].frames![0]!)); return decodeUint16(new Uint8Array(b), m.variables[name]); };
    const result = computeTeachingSnapshot({ manifest: m, mslp: read('mslp'), wind: read('wind'), rain: read('rain24'), u: read('u10'), v: read('v10'), airports: [], minute: 0, nowMs: Date.parse(m.run) });
    expect(result.tour).toHaveLength(5);
    expect(result.lessons.some((l) => l.kind === 'H')).toBe(true);
    expect(result.lessons.some((l) => l.kind === 'L')).toBe(true);
    expect(result.lessons.some((l) => l.kind === 'trough')).toBe(true);
    for (const l of result.lessons) {
      expect(l.why).not.toMatch(/NaN|Infinity/);
      if (l.axis) {
        expect(l.axis.points.length).toBeGreaterThan(2);
        for (let i = 1; i < l.axis.points.length; i++) expect(Math.hypot(l.axis.points[i].lon - l.axis.points[i-1].lon, l.axis.points[i].lat - l.axis.points[i-1].lat)).toBeLessThan(2);
      }
    }
  });
  it('crops a wrapping world grid to the Australian window', () => {
    const nx = 720;
    const ny = 361;
    const manifest = { nx, ny, west: -180, east: 179.5, north: 90, south: -90, wrapsLongitude: true, run: '2026-10-08T12:00:00Z', forecastHours: [0] } as ChartManifest;
    const cropped = cropTeachingInput({
      manifest, mslp: new Float32Array(nx * ny), wind: null, rain: null, u: null, v: null, minute: 0, nowMs: 0,
      airports: [{ icao: 'YPPH', name: 'Perth', lat: -31.94, lon: 115.97 }, { icao: 'KSEA', name: 'Seattle', lat: 47.45, lon: -122.3 }] as never,
    });
    expect(cropped.manifest.west).toBeGreaterThanOrEqual(105);
    expect(cropped.manifest.east).toBeLessThanOrEqual(168);
    expect(cropped.manifest.north).toBeLessThanOrEqual(0);
    expect(cropped.manifest.south).toBeGreaterThanOrEqual(-48);
    expect(cropped.manifest.wrapsLongitude).toBe(false);
    expect(cropped.manifest.nx).toBeLessThan(200);
    expect(cropped.mslp.length).toBe(cropped.manifest.nx * cropped.manifest.ny);
    expect(cropped.airports.map((airport) => airport.icao)).toEqual(['YPPH']);
  });

  it('interpolates signed wind vectors through time and preserves a missing frame', () => {
    const spec = { scale: .1, offset: -60, fill: 65535, units: 'm/s', frames: ['a', 'b'], file: null };
    const chart = { manifest: { forecastHours: [0, 3], nx: 1, ny: 1, variables: { u10: spec } }, state: { u10: new Uint8Array([FRAME_READY, FRAME_READY]) }, packed: { u10: new Uint16Array([500, 700]) } } as unknown as LoadedChart;
    expect(windComponent(chart, 'u10', 0, 0)).toBe(-10);
    expect(windComponent(chart, 'u10', 0, 90)).toBe(0);
    expect(windComponent(chart, 'u10', 0, 180)).toBe(10);
    chart.state.u10[1] = FRAME_MISSING;
    expect(windComponent(chart, 'u10', 0, 90)).toBeNull();
    expect(teachingInput(chart, 90)).toBeNull();
  });
});
