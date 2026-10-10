import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeUint16, encodeUint16, UINT16_FILL } from '../../src/lib/quantise';
import { readManifest } from '../../src/lib/manifest';
import { decodeFrameBytes } from '../../src/lib/frame-codec';
import { createWindSampler } from '../../src/lib/flow-wind';
import { createFlowLayer } from '../../src/lib/flow-layer';
import { FRAME_READY, type LoadedChart } from '../../src/lib/chart-store';
import { frameData } from '../../src/lib/camera';
import { globalEquirectangular, unproject, type Camera } from '../../src/lib/lambert';
import { MIN_STREAK_SPEED_MS, particleCount } from '../../src/lib/flow';
import { SCALES } from '../../scripts/export-scales';

describe('exported wind components', () => {
  it('round-trips signed u10/v10 values with a m/s scale', () => {
    const scale = { scale: 0.1, offset: -150, fill: UINT16_FILL };
    const values = Float32Array.from([-42.35, -0.04, 0, 17.86, NaN]);
    const decoded = decodeUint16(encodeUint16(values, scale), scale);
    expect(decoded[0]).toBeCloseTo(-42.3, 5);
    expect(decoded[1]).toBeCloseTo(0, 5);
    expect(decoded[2]).toBeCloseTo(0, 5);
    expect(decoded[3]).toBeCloseTo(17.9, 5);
    expect(Number.isNaN(decoded[4])).toBe(true);
  });

  it('keeps legacy manifests valid when u10/v10 are absent', () => {
    const hours = [0, 3];
    const variable = { file: 'field.u16', units: 'x', scale: 0.1, offset: 0, fill: UINT16_FILL };
    const manifest = readManifest({
      schema: 2,
      contract: 'isobar-web',
      run: '2026-10-07T00:00:00Z',
      generated: '2026-10-07T01:00:00Z',
      forecast_hours: hours,
      uniform_step_hours: 3,
      grid: { west: 100, east: 101, north: -10, south: -11, step: 1, nx: 2, ny: 2, dtype: 'uint16' },
      variables: { mslp: variable, rain24: variable, t2m: variable, wind: variable },
      places: [],
      aviation: 'aviation.json',
      attribution: [],
    });
    expect(manifest.variables.u10).toBeUndefined();
    expect(manifest.variables.v10).toBeUndefined();
  });
});

// The real export is deliberately not committed. This checkout exposes it via
// public/data; clean checkouts without local weather skip only these two cases.
const data = new URL('../../public/data/', import.meta.url);
describe.skipIf(!existsSync(new URL('frames/u10/f000.u16z', data)))('local exported wind frames', () => {
  let chart: LoadedChart;
  let referenceU: Float64Array;
  beforeAll(async () => {
    const manifest = readManifest(JSON.parse(readFileSync(new URL('manifest.json', data), 'utf8')));
    const cells = manifest.nx * manifest.ny;
    const packed: Record<string, Uint16Array> = {};
    for (const name of ['u10', 'v10']) {
      // A later legacy export can remove u/v from the shared manifest while
      // retaining the real frame files. Decode those with the exporter's own
      // contract, and check published metadata too whenever it is present.
      const spec = manifest.variables[name] ?? { file: null, frames: [`frames/${name}/f000.u16z`],
        encoding: 'shuffle-gzip' as const, units: 'm/s', ...SCALES[name] };
      manifest.variables[name] = spec;
      expect(spec.units).toBe('m/s');
      // Must agree with export-data.ts SCALES, not the old -60/-80 fixtures.
      expect([spec.scale, spec.offset, spec.fill]).toEqual([0.1, -150, 65535]);
      expect(SCALES[name]).toEqual({ scale: spec.scale, offset: spec.offset, fill: spec.fill });
      expect(spec.encoding).toBe('shuffle-gzip');
      const bytes = readFileSync(new URL(spec.frames![0]!, data));
      const decoded = await decodeFrameBytes(bytes, spec.encoding);
      expect(decoded.byteLength).toBe(cells * 2);
      packed[name] = new Uint16Array(decoded.buffer, decoded.byteOffset, cells);
      if (name === 'u10') {
        // Independent wire decode: gzip high-byte plane then low-byte plane.
        const planes = gunzipSync(bytes);
        referenceU = Float64Array.from({ length: cells }, (_, i) => {
          const raw = planes[i] * 256 + planes[cells + i];
          return raw === 65535 ? NaN : raw / 10 - 150;
        });
      }
    }
    chart = { manifest: { ...manifest, forecastHours: [manifest.forecastHours[0]] }, packed,
      state: { u10: new Uint8Array([FRAME_READY]), v10: new Uint8Array([FRAME_READY]) } } as LoadedChart;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('decodes real u10 bytes and samples signed m/s with the published scale/offset', () => {
    const spec = chart.manifest.variables.u10;
    const values = decodeUint16(new Uint8Array(chart.packed.u10.buffer), spec);
    let negative = 0, positive = 0;
    for (let i = 0; i < values.length; i++) {
      if (Number.isNaN(referenceU[i])) expect(Number.isNaN(values[i])).toBe(true);
      else {
        if (Math.abs(values[i] - referenceU[i]) > 0.00001) throw new Error(`u10 cell ${i}: ${values[i]} != ${referenceU[i]} m/s`);
        if (values[i] < -1) negative++;
        if (values[i] > 1) positive++;
      }
    }
    expect(negative).toBeGreaterThan(100);
    expect(positive).toBeGreaterThan(100);
    const sample = createWindSampler(chart, 0)!;
    expect(sample.source).toBe('model');
    const m = chart.manifest;
    for (let i = m.nx + 1; i < values.length - m.nx; i += 4093) {
      const lon = m.west + i % m.nx * (m.east - m.west) / (m.nx - 1);
      const lat = m.north - Math.floor(i / m.nx) * (m.north - m.south) / (m.ny - 1);
      expect(sample(lon, lat)?.u).toBeCloseTo(referenceU[i], 5);
    }
  });

  it('emits visible, bounded paths from real model frames after the appearance fade', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    let segments = 0, visible = 0, strokes = 0;
    const geo = globalEquirectangular();
    let camera: Camera;
    const sample = createWindSampler(chart, 0)!;
    const checkWind = (x: number, y: number) => {
      const at = unproject(geo, camera.centerX + (x / 1280 * 2 - 1) * camera.halfWidth,
        camera.centerY + (1 - y / 720 * 2) * camera.halfHeight)!;
      const wind = sample(at.lon, at.lat);
      if (!wind || Math.hypot(wind.u, wind.v) < MIN_STREAK_SPEED_MS - 1e-8) throw new Error('Streak reaches calm/missing real wind');
    };
    const ctx = { globalAlpha: 1, setTransform() {}, clearRect() { segments = 0; visible = 0; strokes = 0; },
      beginPath() {}, moveTo: checkWind, stroke() { strokes++; },
      bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
        if (![c1x, c1y, c2x, c2y, x, y].every(Number.isFinite)) throw new Error('Non-finite streak');
        checkWind(x, y); segments++; if (ctx.globalAlpha > 12 / 255) visible++;
      } };
    const canvas = { getContext: () => ctx, dataset: {} } as unknown as HTMLCanvasElement;
    for (const focus of [undefined, { lon: 115.86, lat: -31.95 }, { lon: 133, lat: -39 }]) {
      const layer = createFlowLayer(canvas)!;
      camera = frameData(geo, 1280, 720, chart.manifest, focus).home;
      for (let frame = 0; frame < 100; frame++) layer.draw({ chart, geo, camera, minute: 0,
        cssWidth: 1280, cssHeight: 720, dark: false, windLens: false, reduced: false, dt: 1 / 60 });
      expect(layer.sample().windSource).toBe('model');
      expect(layer.sample().drawn).toBeGreaterThan(100);
      expect(visible).toBeGreaterThan(100);
      expect(segments).toBeLessThanOrEqual(particleCount(1280 * 720, false) * 3);
      expect(strokes).toBeLessThanOrEqual(64);
      layer.destroy();
    }
  });
});
