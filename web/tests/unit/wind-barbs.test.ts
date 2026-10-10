import { describe, expect, it } from 'vitest';
import type { LoadedChart } from '../../src/lib/chart-store';
import { globalEquirectangular } from '../../src/lib/lambert';
import { withTilt } from '../../src/lib/tilt-navigation';
import { drawWindBarbs } from '../../src/lib/wind-barbs';

describe('world wind barbs', () => {
  it('keeps wind direction and coverage when the camera crosses a world copy', () => {
    const cells = 720 * 361;
    const chart = {
      manifest: { west: -180, east: 179.5, north: 90, south: -90, step: 0.5,
        nx: 720, ny: 361, wrapsLongitude: true, forecastHours: [0],
        variables: { u10: { scale: 1, offset: 0, fill: 65535 }, v10: { scale: 1, offset: 0, fill: 65535 } } },
      packed: { u10: new Uint16Array(cells).fill(10), v10: new Uint16Array(cells).fill(5) },
      state: { u10: new Uint8Array([1]), v10: new Uint8Array([1]) },
    } as unknown as LoadedChart;
    const render = (centerX: number) => {
      const angles: number[] = [];
      const ctx = new Proxy({ rotate: (angle: number) => angles.push(angle) }, {
        get: (object, key) => object[key as keyof typeof object] ?? (() => {}),
      }) as unknown as CanvasRenderingContext2D;
      drawWindBarbs(ctx, chart, globalEquirectangular(),
        { centerX, centerY: 0, halfWidth: 15, halfHeight: 10 }, 300, 200, 1, 0, false);
      return angles;
    };
    const baseline = render(179);
    expect(baseline.length).toBe(15);
    for (const center of [-181, 539]) {
      const repeated = render(center);
      expect(repeated.length).toBe(baseline.length);
      repeated.forEach((angle, i) => expect(angle).toBeCloseTo(baseline[i], 8));
    }
  });

  it('projects the shaft and feathers as elevated 3D segments when tilted', () => {
    const cells = 720 * 361;
    const chart = {
      manifest: { west: -180, east: 179.5, north: 90, south: -90, step: 0.5,
        nx: 720, ny: 361, wrapsLongitude: true, forecastHours: [0],
        variables: { u10: { scale: 1, offset: 0, fill: 65535 }, v10: { scale: 1, offset: 0, fill: 65535 } } },
      packed: { u10: new Uint16Array(cells).fill(10), v10: new Uint16Array(cells).fill(5) },
      state: { u10: new Uint8Array([1]), v10: new Uint8Array([1]) },
    } as unknown as LoadedChart;
    const heights: number[] = [], lines: Array<[number, number, number, number]> = [];
    let start: [number, number] | null = null;
    const ctx = {
      setTransform() {}, clearRect() {},
      beginPath() {}, closePath() {}, moveTo(x: number, y: number) { start = [x, y]; },
      lineTo(x: number, y: number) { if (start) lines.push([start[0], start[1], x, y]); },
      stroke() {}, fill() {}, arc() {},
    } as unknown as CanvasRenderingContext2D;
    const surface = {
      project(lat: number, lon: number, height = 0) { return { x: lon / 10, y: lat / 10 + height / 1e5, visible: true, depth: 1 }; },
      projectAboveGround(lat: number, lon: number, height: number) { heights.push(height); return { x: lon / 10, y: lat / 10 + height / 1e5, visible: true, depth: 1 }; },
      unproject() { return { lat: 0, lon: 0 }; },
    };
    drawWindBarbs(ctx, chart, globalEquirectangular(),
      { centerX: 0, centerY: 0, halfWidth: 15, halfHeight: 10, pitch: 0.6, surface }, 300, 200, 1, 0, false);
    expect(heights.length).toBeGreaterThan(20);
    expect(new Set(heights)).toEqual(new Set([10]));
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.some(([x0, y0, x1, y1]) => Math.hypot(x1 - x0, y1 - y0) > 0.35)).toBe(true);
  });

  it('keeps high-speed shafts visible through the real tilted globe at multiple zooms', () => {
    const cells = 720 * 361;
    const chart = {
      manifest: { west: -180, east: 179.5, north: 90, south: -90, step: 0.5,
        nx: 720, ny: 361, wrapsLongitude: true, forecastHours: [0],
        variables: { u10: { scale: 1, offset: 0, fill: 65535 }, v10: { scale: 1, offset: 0, fill: 65535 } } },
      packed: { u10: new Uint16Array(cells).fill(30), v10: new Uint16Array(cells).fill(8) },
      state: { u10: new Uint8Array([1]), v10: new Uint8Array([1]) },
    } as unknown as LoadedChart;
    const geo = globalEquirectangular(0, 0);
    for (const halfHeight of [45, 18]) {
      let strokes = 0, segments = 0, elevationReads = 0;
      let start: [number, number] | null = null;
      const ctx = {
        setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo(x: number, y: number) { start = [x, y]; },
        lineTo(x: number, y: number) { if (start) segments += Number.isFinite(x + y); },
        stroke() { strokes++; }, fill() {}, arc() {},
      } as unknown as CanvasRenderingContext2D;
      const camera = withTilt(geo, { centerX: 0, centerY: 0, halfWidth: halfHeight * 1.5, halfHeight }, 55,
        () => { elevationReads++; return 750; });
      drawWindBarbs(ctx, chart, geo, camera, 600, 400, 1, 0, false);
      expect(strokes).toBeGreaterThan(0);
      expect(segments).toBeGreaterThan(0);
      expect(elevationReads).toBeGreaterThan(20);
    }
  });
});
