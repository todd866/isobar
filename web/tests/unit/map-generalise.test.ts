import { describe, expect, it, vi, afterEach } from 'vitest';
import { isobarInterval, isobarOpacity, selectPressureCentres, terrainIsobarStyle, type ScreenCentre } from '../../src/lib/map-generalise';
import { createElevationCoverage, mosaicElevation } from '../../src/lib/terrain/elevation';
import { DAY_INK, drawOverlay, pruneOffscreenVertices } from '../../src/lib/overlay';
import { createTerrainLayer } from '../../src/lib/terrain/terrain-layer';
import { globalEquirectangular } from '../../src/lib/lambert';
import { toHalf } from '../../src/lib/terrain/terrarium';

const centre = (prominence: number, x = 100, kind: 'H' | 'L' = 'L'): ScreenCentre => ({
  centre: { kind, hpa: kind === 'L' ? 990 : 1030, prominence, lon: x, lat: 30 }, point: { x, y: 100 },
});

describe('scale-dependent pressure ink', () => {
  it('uses 8/4/2 hPa and fades only the intermediate levels at each transition', () => {
    expect([180, 60, 18].map(isobarInterval)).toEqual([8, 4, 2]);
    for (const span of [180, 100, 86, 72, 24, 21, 18]) expect(isobarOpacity(1008, span)).toBe(1);
    expect(isobarOpacity(1012, 180)).toBe(0);
    expect(isobarOpacity(1012, 86)).toBeCloseTo(0.5);
    expect(isobarOpacity(1012, 72)).toBe(1);
    expect(isobarOpacity(1010, 24)).toBe(0);
    expect(isobarOpacity(1010, 21)).toBeCloseTo(0.5);
    expect(isobarOpacity(1010, 18)).toBe(1);
    for (const boundary of [100, 72, 24, 18]) for (const level of [1008, 1012, 1010]) {
      expect(Math.abs(isobarOpacity(level, boundary - 0.001) - isobarOpacity(level, boundary + 0.001))).toBeLessThan(0.00001);
    }
    expect(isobarOpacity(1011, 10)).toBe(0);
  });

  it('uses measured elevation only, with a strict 1500 m boundary', () => {
    for (const h of [null, NaN, -400, 0, 1500]) expect(terrainIsobarStyle(h)).toEqual({ alpha: 1, dashed: false });
    expect(terrainIsobarStyle(1501)).toEqual({ alpha: 0.24, dashed: true });
  });

  it('filters ring depth even when absolute pressure is extreme, and ranks before spacing', () => {
    const weak = centre(3); weak.centre.hpa = 958;
    const strong = centre(8, 130);
    expect(selectPressureCentres([weak, strong, centre(4, 240)], 180)).toEqual([strong, centre(4, 240)]);
    expect(selectPressureCentres([weak], 60)).toEqual([weak]);
    expect(selectPressureCentres([centre(1.99)], 18)).toEqual([]);
    expect(selectPressureCentres([centre(NaN)], 180)).toEqual([]);
  });

  it('caps at 12 of each kind only at world scale', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => centre(8, i * 100, i % 2 ? 'H' : 'L'));
    const world = selectPressureCentres(candidates, 180);
    expect(world.filter((c) => c.centre.kind === 'H')).toHaveLength(12);
    expect(world.filter((c) => c.centre.kind === 'L')).toHaveLength(12);
    expect(selectPressureCentres(candidates, 60)).toHaveLength(30);
  });

  it('suppresses terrain centres unless very deep, in either hemisphere or kind', () => {
    for (const kind of ['H', 'L'] as const) {
      expect(selectPressureCentres([centre(11.99, 100, kind)], 60, () => 1501)).toEqual([]);
      expect(selectPressureCentres([centre(12, 100, kind)], 180, () => 4500)).toHaveLength(1);
      expect(selectPressureCentres([centre(4, 100, kind)], 180, () => 1500)).toHaveLength(1);
      expect(selectPressureCentres([centre(4, 100, kind)], 180, () => null)).toHaveLength(1);
    }
  });
});

describe('DEM overlay sampling', () => {
  it('retains measured terrain during a view replacement and leaves new missing areas unknown', () => {
    const accept = createElevationCoverage();
    const base = { box: { west: 170, east: 190, south: -10, north: 10 }, width: 2, height: 2, z: 2, covered: 4,
      data: Uint16Array.from([2000, 1, 2000, 1, 2000, 1, 2000, 1].map(toHalf)) };
    expect(accept(base)(180, 0)).toBe(2000);
    const pending = { ...base, box: { ...base.box, west: 175, east: 195 }, data: new Uint16Array(8), covered: 0 };
    expect(accept(pending)(180, 0)).toBe(2000);
    expect(accept(pending)(194, 0)).toBeNull();
    const refined = { ...pending, data: Uint16Array.from([100, 1, 100, 1, 100, 1, 100, 1].map(toHalf)), covered: 4 };
    expect(accept(refined)(180, 0)).toBe(100);
  });
  it('uses south-first pixel centres, wraps longitude and leaves uncovered cells unknown', () => {
    const mosaic = { box: { west: 170, east: 190, south: -10, north: 10 }, width: 2, height: 2, z: 2, covered: 4,
      data: Uint16Array.from([0, 1, 1000, 1, 2000, 1, 4000, 1].map(toHalf)) };
    const sample = mosaicElevation(mosaic);
    expect(sample(175, -5)).toBe(0);
    expect(sample(-175, 5)).toBe(4000);
    expect(sample(180, 0)).toBe(1750);
    expect(sample(175, 11)).toBeNull();
    expect(sample(100, 0)).toBeNull();
    mosaic.data[7] = 0;
    expect(sample(180, 0)).toBeNull();
    expect(sample(175, -5)).toBe(0);
  });

  afterEach(() => vi.unstubAllGlobals());
  it('requests bounded world terrain even without shaded relief, and reuses the clamped plan', () => {
    const messages: unknown[] = [];
    vi.stubGlobal('Worker', class { postMessage(m: unknown) { messages.push(m); } terminate() {} });
    const layer = createTerrainLayer(() => {});
    const camera = { centerX: 0, centerY: 0, halfWidth: 180, halfHeight: 90 };
    expect(layer!.update(globalEquirectangular(), camera, 1280, 1)).toBe(0);
    layer!.update(globalEquirectangular(), camera, 1280, 1);
    expect(messages).toHaveLength(1);
    layer!.destroy();
  });
});

describe('production pressure overlay', () => {
  function render(level: number, span: number, sample?: (lon: number, lat: number) => number | null, lons = [0, 0, 0, 0]) {
    const strokes: { alpha: number; dashed: boolean }[] = [];
    const labels: { text: string; alpha: number }[] = [];
    let dash: number[] = [];
    const ctx = { canvas: { width: 1280, height: 640 }, globalAlpha: 1,
      setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, setLineDash(d: number[]) { dash = d; },
      measureText: (text: string) => ({ width: text.length * 7 }),
      stroke() { strokes.push({ alpha: ctx.globalAlpha, dashed: dash.length > 0 }); }, strokeText() {},
      fillText(text: string) { labels.push({ text, alpha: ctx.globalAlpha }); } };
    drawOverlay(ctx as unknown as CanvasRenderingContext2D, 1280, 640, 1, globalEquirectangular(),
      { centerX: 0, centerY: 0, halfWidth: span, halfHeight: span / 2 }, { rings: [] },
      [{ level, closed: false, lon: Float32Array.from(lons), lat: Float32Array.from([30, 10, -10, -30]) }], [],
      false, undefined, undefined, [], undefined, sample);
    return { strokes, labels };
  }

  it('keeps intermediate labels legible while strokes fade and hides both at world scale', () => {
    expect(render(1012, 180)).toEqual({ strokes: [], labels: [] });
    const middle = render(1012, 86);
    expect(middle.strokes).toEqual([{ alpha: 0.5, dashed: false }]);
    expect(middle.labels).toEqual([{ text: '1012', alpha: 1 }]);
  });

  it('actually strokes terrain segments faint and dashed without adding pressure labels on them', () => {
    const high = render(1008, 180, () => 2000);
    expect(high.strokes).toEqual([{ alpha: 0.24, dashed: true }]);
    expect(high.labels).toEqual([]);
    expect(render(1008, 180, () => null).strokes).toEqual([{ alpha: 1, dashed: false }]);
  });

  it('samples dateline segments near the dateline, never across Greenwich', () => {
    const samples: number[] = [];
    render(1008, 180, (lon) => { samples.push(lon); return 0; }, [179, -179, -178, -177]);
    expect(samples.length).toBeGreaterThan(4);
    expect(samples.every((lon) => Math.abs(lon) >= 177)).toBe(true);
  });
});

describe('isobar offscreen contour pruning', () => {
  const w = 100;
  const h = 100;
  const pt = (x: number, y = 50) => ({ x, y });

  it('nulls interior vertices deep off one padded edge without changing length', () => {
    const input = [pt(-200), pt(-210), pt(-220), pt(-230), pt(-240), pt(-250)];
    const pruned = pruneOffscreenVertices(input, false, w, h);
    expect(pruned).toHaveLength(input.length);
    expect(pruned[2]).toBeNull();
    expect(pruned[3]).toBeNull();
    expect(pruned[0]).toEqual(pt(-200));
    expect(pruned[5]).toEqual(pt(-250));
  });

  it('keeps vertices when any neighbor in the five-point hood is inside', () => {
    const input = [pt(-200), pt(-210), pt(-220), pt(40), pt(50), pt(60)];
    const pruned = pruneOffscreenVertices(input, false, w, h);
    expect(pruned.every((point) => point !== null)).toBe(true);
    expect(pruned[3]).toEqual(pt(40));
  });

  it('preserves existing gaps and does not fill them', () => {
    const input = [pt(-200), null, pt(-220)];
    const pruned = pruneOffscreenVertices(input, false, w, h);
    expect(pruned).toHaveLength(3);
    expect(pruned[1]).toBeNull();
    expect(pruned[0]).toEqual(pt(-200));
  });

  it('wraps neighborhoods on closed paths', () => {
    const input = [pt(50, -200), pt(60, -200), pt(70, -200), pt(80, -200)];
    const pruned = pruneOffscreenVertices(input, true, w, h);
    expect(pruned).toHaveLength(4);
    expect(pruned.every((point) => point === null)).toBe(true);
  });

  it('leaves in-view smoothing inputs unchanged beyond the deep offscreen band', () => {
    const nearEdge = [pt(-120), pt(-110), pt(-105), pt(30), pt(40)];
    const pruned = pruneOffscreenVertices(nearEdge, false, w, h);
    expect(pruned[3]).toEqual(pt(30));
    expect(pruned[4]).toEqual(pt(40));
    expect(pruned.filter((point) => point !== null).length).toBeGreaterThan(2);
  });

  function isobarSegments(lons: number[]) {
    const segments: Array<[number, number, number, number]> = [];
    const ctx = {
      canvas: { width: w, height: h }, globalAlpha: 1,
      setTransform() {}, clearRect() {}, beginPath() {},
      moveTo(x: number, y: number) { this.last = [x, y]; },
      lineTo(x: number, y: number) {
        if (this.last) segments.push([this.last[0], this.last[1], x, y]);
        this.last = [x, y];
      },
      last: undefined as [number, number] | undefined,
      stroke() {}, strokeText() {}, fillText() {}, measureText: (text: string) => ({ width: text.length * 7 }),
      setLineDash() {},
    };
    drawOverlay(ctx as unknown as CanvasRenderingContext2D, w, h, 1, globalEquirectangular(),
      { centerX: 0, centerY: 0, halfWidth: 10, halfHeight: 10 },
      { rings: [] },
      [{ level: 1008, closed: false, lon: Float32Array.from(lons), lat: Float32Array.from(lons.map(() => 0)) }], [],
      false, undefined, DAY_INK);
    return segments;
  }

  it('does not stroke a wholly offscreen isobar run', () => {
    expect(isobarSegments([30, 31, 32])).toEqual([]);
  });

  it('keeps isobar ink crossing into the viewport', () => {
    const segments = isobarSegments([-11, -9]);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0][0]).toBeCloseTo(-5);
    expect(segments[0][2]).toBeCloseTo(5);
  });
});

describe('overlay viewport clipping', () => {
  function coastSegments(lons: number[]) {
    const segments: Array<[number, number, number, number]> = [];
    const ctx = {
      canvas: { width: 100, height: 100 }, globalAlpha: 1,
      setTransform() {}, clearRect() {}, beginPath() {},
      moveTo(x: number, y: number) { this.last = [x, y]; },
      lineTo(x: number, y: number) {
        if (this.last) segments.push([this.last[0], this.last[1], x, y]);
        this.last = [x, y];
      },
      last: undefined as [number, number] | undefined,
      stroke() {}, strokeText() {}, fillText() {}, measureText: (text: string) => ({ width: text.length * 7 }),
      setLineDash() {},
    };
    drawOverlay(ctx as unknown as CanvasRenderingContext2D, 100, 100, 1, globalEquirectangular(),
      { centerX: 0, centerY: 0, halfWidth: 10, halfHeight: 10 },
      { rings: [{ lon: Float32Array.from(lons), lat: Float32Array.from(lons.map(() => 0)) }] },
      [], [], false, undefined, DAY_INK);
    return segments;
  }

  it('drops a run wholly outside one viewport edge', () => {
    expect(coastSegments([30, 31, 32])).toEqual([]);
  });

  it('keeps a segment crossing into the viewport', () => {
    const segments = coastSegments([-11, -9]);
    expect(segments).toHaveLength(2); // the closed ring also crosses on its return edge
    expect(segments[0][0]).toBeCloseTo(-5);
    expect(segments[0][2]).toBeCloseTo(5);
    expect(segments[1][0]).toBeCloseTo(5);
    expect(segments[1][2]).toBeCloseTo(-5);
  });

  it('does not bridge a projected gap', () => {
    expect(coastSegments([0, Number.NaN, 1])).toEqual([]);
  });

  it('resets after an offscreen run instead of drawing a chord through it', () => {
    const segments = coastSegments([-1, 30, 31, 1]);
    expect(segments.some(([fromX, , toX]) => fromX > 190 && toX > 190)).toBe(false);
  });
});
