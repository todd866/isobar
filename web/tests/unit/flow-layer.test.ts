import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlowLayer, type FlowDraw } from '../../src/lib/flow-layer';
import type { LoadedChart } from '../../src/lib/chart-store';
import { australiaLambert, globalEquirectangular, project } from '../../src/lib/lambert';
import { FLOW_FADE_SECONDS, particleCount } from '../../src/lib/flow';

type Segment = { x: number; y: number; alpha: number; startX: number; startY: number; c1x: number; c1y: number; c2x: number; c2y: number };
function scene() {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  let segments: Segment[] = [];
  let startX = 0, startY = 0;
  const ctx = {
    globalAlpha: 1, setTransform() {}, clearRect() { segments = []; }, beginPath() {}, stroke() {},
    moveTo(x: number, y: number) { startX = x; startY = y; },
    bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
      segments.push({ x, y, alpha: ctx.globalAlpha, startX, startY, c1x, c1y, c2x, c2y });
    },
  };
  const canvas = { getContext: () => ctx, dataset: {} } as unknown as HTMLCanvasElement;
  const cells = 81 * 71;
  const chart = {
    manifest: { nx: 81, ny: 71, west: 80, east: 160, north: 0, south: -70, wrapsLongitude: false,
      forecastHours: [0, 3, 6], variables: {
        u10: { scale: 1, offset: -80, fill: 65535 }, v10: { scale: 1, offset: -80, fill: 65535 },
        mslp: { scale: 0.1, offset: 500, fill: 65535 },
      } },
    packed: { u10: new Uint16Array(cells * 3).fill(84), v10: new Uint16Array(cells * 3).fill(79),
      // Northward pressure gradient gives eastward flow in the southern hemisphere.
      mslp: Uint16Array.from({ length: cells * 3 }, (_, i) => 5600 - Math.floor(i % cells / 81) * 10) },
    state: { u10: new Uint8Array([1, 1, 1]), v10: new Uint8Array([1, 1, 1]), mslp: new Uint8Array([1, 1, 1]) },
  } as unknown as LoadedChart;
  const input: FlowDraw = { chart, minute: 90, geo: globalEquirectangular(120, -35),
    camera: { centerX: 0, centerY: -35, halfWidth: 12, halfHeight: 12 },
    dark: false, windLens: false, reduced: false, dt: 0.05, cssWidth: 400, cssHeight: 400 };
  return { layer: createFlowLayer(canvas)!, input, segments: () => segments.slice(), canvas };
}
afterEach(() => vi.unstubAllGlobals());

describe('flow renderer continuity', () => {
  it.each(['equirectangular', 'lambert'])('shortens the same wind in wide %s views instead of stretching it across systems', (projection) => {
    const s = scene();
    if (projection === 'lambert') {
      s.input.geo = australiaLambert();
      const centre = project(s.input.geo, -35, 120)!;
      s.input.camera = { centerX: centre.x, centerY: centre.y, halfWidth: 0.2, halfHeight: 0.2 };
    }
    s.input.chart.packed.u10.fill(96);
    s.input.chart.packed.v10.fill(80);
    for (let i = 0; i < 40; i++) s.layer.draw(s.input);
    const medianLength = () => {
      const lengths = s.segments().map(p => Math.hypot(p.x - p.startX, p.y - p.startY)).sort((a, b) => a - b);
      expect(lengths.length).toBeGreaterThan(50);
      return lengths[Math.floor(lengths.length / 2)];
    };
    const regional = medianLength();
    s.input.camera.halfWidth *= 8 / 3; s.input.camera.halfHeight *= 8 / 3;
    for (let i = 0; i < 40; i++) s.layer.draw(s.input);
    expect(medianLength()).toBeLessThan(regional * 0.7);
  });

  it('joins curved wind pieces with the same tangent rather than angular elbows', () => {
    const s = scene();
    s.input.chart.packed.u10.fill(96);
    for (let i = 0; i < s.input.chart.packed.v10.length; i++) s.input.chart.packed.v10[i] = 65 + Math.floor((i % 81) / 2);
    for (let i = 0; i < 40; i++) s.layer.draw(s.input);
    const pieces = s.segments();
    let joins = 0;
    for (const a of pieces) {
      const b = pieces.find(p => p.startX === a.x && p.startY === a.y);
      if (!b) continue;
      const ax = a.x - a.c2x, ay = a.y - a.c2y;
      const bx = b.c1x - b.startX, by = b.c1y - b.startY;
      expect((ax * bx + ay * by) / Math.hypot(ax, ay) / Math.hypot(bx, by)).toBeGreaterThan(0.99999);
      joins++;
    }
    expect(joins).toBeGreaterThan(50);
  });

  it('draws labelled pressure estimates until both model components arrive, then crossfades ink', () => {
    const s = scene();
    s.input.chart.state.v10[1] = 0;
    for (let i = 0; i < 40; i++) s.layer.draw(s.input);
    expect(s.layer.sample().mode).toBe('live');
    expect(s.layer.sample().drawn).toBeGreaterThan(80);
    expect(s.canvas.dataset.windSource).toBe('estimate');
    // Opposite vectors cannot cancel out during the source switch.
    s.input.chart.packed.u10.fill(64);
    s.input.chart.state.v10[1] = 1;
    s.layer.draw(s.input);
    expect(s.canvas.dataset.windSource).toBe('to-model');
    for (let i = 0; i < FLOW_FADE_SECONDS / s.input.dt; i++) {
      const sample = s.layer.draw(s.input);
      expect(sample.drawn).toBeGreaterThan(50);
      expect(sample.drawn).toBeLessThanOrEqual(particleCount(400 * 400, false) * 2);
      expect(s.segments().some((segment) => segment.alpha > 0.05)).toBe(true);
    }
    expect(s.canvas.dataset.windSource).toBe('model');
    s.input.chart.state.v10[1] = 0;
    expect(s.layer.draw(s.input).windSource).toBe('to-estimate');
    for (let i = 0; i < 40; i++) s.layer.draw(s.input);
    expect(s.canvas.dataset.windSource).toBe('estimate');
    expect(s.layer.sample().drawn).toBeGreaterThan(50);
  });

  it('does not paint sub-5-kt model wind', () => {
    const s = scene();
    s.input.chart.packed.u10.fill(82); // 2 m/s after the fixture offset
    s.input.chart.packed.v10.fill(80);
    for (let i = 0; i < 40; i++) s.layer.draw(s.input);
    expect(s.layer.sample().drawn).toBe(0);
    expect(s.segments()).toEqual([]);
  });

  it('does not restart the appearance fade when each display frame creates a new sampler', () => {
    const s = scene();
    s.layer.draw(s.input);
    expect(s.segments().every((p) => p.alpha < 12 / 255)).toBe(true);
    for (let i = 0; i < 40; i++) { s.input.minute += 0.01; s.layer.draw(s.input); }
    expect(s.segments().filter((p) => p.alpha > 12 / 255).length).toBeGreaterThan(100);
    expect(s.layer.sample().drawn).toBeGreaterThan(80);
  });

  it('holds reduced-motion streamlines, including after a camera move', () => {
    const s = scene(); s.input.reduced = true;
    const first = s.layer.draw(s.input);
    expect(first.drawn).toBeGreaterThan(80);
    expect(first.travel).toBe(0);
    const ink = s.segments();
    expect(s.layer.draw(s.input)).toEqual(first);
    expect(s.segments()).toEqual(ink);
    s.input.camera.centerX += 0.1;
    const moved = s.layer.draw(s.input);
    expect(moved.lon).toBe(first.lon);
    expect(moved.lat).toBe(first.lat);
    expect(moved.mode).toBe('static');
  });

  it('preserves geographic tracers through a small pan and zoom', () => {
    const s = scene();
    for (let i = 0; i < 40; i++) s.layer.draw(s.input);
    s.input.dt = 0;
    const before = s.layer.draw(s.input);
    s.input.camera.centerX += 0.1;
    s.input.camera.halfHeight *= 1.02; s.input.camera.halfWidth *= 1.02;
    const after = s.layer.draw(s.input);
    expect(after.lon).toBe(before.lon);
    expect(after.lat).toBe(before.lat);
    expect(after.drawn).toBeGreaterThan(before.drawn * 0.9);
  });

  it('updates the rendered velocity smoothly across the forecast boundary', () => {
    const s = scene();
    const cells = s.input.chart.manifest.nx * s.input.chart.manifest.ny;
    s.input.chart.packed.u10.fill(100, cells, 2 * cells); // 20 m/s at +3 h
    s.input.chart.packed.v10.fill(90, cells, 2 * cells); // 10 m/s northward
    s.input.chart.packed.u10.fill(116, 2 * cells); // 36 m/s at +6 h
    s.input.chart.packed.v10.fill(101, 2 * cells);
    s.input.minute = 0;
    for (let i = 0; i < 40; i++) s.layer.draw(s.input);
    s.input.dt = 0.001;
    const initial = s.layer.draw(s.input);
    s.input.minute = 180 - 0.001;
    const before = s.layer.draw(s.input);
    s.input.minute = 180 + 0.001;
    const after = s.layer.draw(s.input);
    expect(before.shift).toBeGreaterThan(initial.shift * 4);
    expect(after.shift).toBeCloseTo(before.shift, 6);
    expect(after.travel).toBeCloseTo(before.travel, 6);
  });

  it('newly visible ink never respawns bright over a complete particle life', () => {
    const s = scene();
    let previous: Segment[] = [];
    let inkFrames = 0;
    for (let frame = 0; frame < 300; frame++) {
      s.layer.draw(s.input);
      const ink = s.segments();
      if (ink.length) inkFrames++;
      // Uniform fixture motion is < 0.15 px/frame. A newly visible segment
      // without a predecessor must enter at the faintest opacity step.
      for (const p of ink) {
        if (!previous.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.5)) expect(p.alpha).toBeLessThanOrEqual(0.025);
      }
      previous = ink;
    }
    expect(inkFrames).toBeGreaterThan(275);
  });

  it('replenishes a zoomed viewport without changing its density budget', () => {
    const s = scene();
    for (let i = 0; i < 60; i++) s.layer.draw(s.input);
    const original = s.layer.sample().drawn;
    s.input.camera.halfWidth *= 2; s.input.camera.halfHeight *= 2;
    for (let i = 0; i < 70; i++) s.layer.draw(s.input);
    const zoomed = s.layer.sample().drawn;
    expect(zoomed).toBeGreaterThan(original * 0.75);
    expect(zoomed).toBeLessThan(original * 1.25);
    const ink = s.segments();
    for (const [left, top] of [[true, true], [true, false], [false, true], [false, false]]) {
      expect(ink.filter((p) => (p.x < 200) === left && (p.y < 200) === top).length).toBeGreaterThan(20);
    }
  });
});
