import { describe, expect, it } from 'vitest';
import { blendCanvasField, sampleCanvasField, type CanvasFrame } from '../../src/lib/canvas-chart';

const view = { west: -180, north: 90, dlon: 90, dlat: -90, nx: 4, ny: 3 };
const frame = (values: number[]): CanvasFrame => ({ data: new Uint16Array(values), scale: 1, offset: 0, fill: 65535 });

describe('Canvas2D field sampling', () => {
  it('wraps longitude without a duplicate dateline column', () => {
    const a = sampleCanvasField(frame([
      10, 20, 30, 40,
      10, 20, 30, 40,
      10, 20, 30, 40,
    ]), 180, 0, view, true);
    const b = sampleCanvasField(frame([
      10, 20, 30, 40,
      10, 20, 30, 40,
      10, 20, 30, 40,
    ]), -180, 0, view, true);
    expect(a).toBeCloseTo(b, 6);
  });

  it('uses an actual valid pole row and preserves a missing pole row', () => {
    const value = sampleCanvasField(frame([
      11, 11, 11, 11,
      10, 20, 30, 40,
      20, 30, 40, 50,
    ]), 0, 90, view, true);
    expect(value).toBeCloseTo(11, 6);
    expect(sampleCanvasField(frame([
      65535, 65535, 65535, 65535,
      10, 20, 30, 40,
      20, 30, 40, 50,
    ]), 0, 90, view, true)).toBeNaN();
  });

  it('returns missing when every contributing sample is missing', () => {
    expect(sampleCanvasField(frame(new Array(12).fill(65535)), 0, 0, view, true)).toBeNaN();
  });

  it('does not fill missing contributing cells or sample outside the grid', () => {
    const values = [10, 65535, 30, 40, 10, 20, 30, 40, 10, 20, 30, 40];
    expect(sampleCanvasField(frame(values), -135, 45, view, true)).toBeNaN();
    expect(sampleCanvasField(frame(values), -180, 90, view, true)).toBe(10);
    expect(sampleCanvasField(frame(values), 0, 90.1, view, true)).toBeNaN();
    expect(sampleCanvasField(frame(values), 90.1, 0, view, false)).toBeNaN();
  });

  it('does not invent a temporal value when one frame is missing', () => {
    const a = sampleCanvasField(frame([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]), 0, 0, view, true);
    const b = sampleCanvasField(frame([65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535]), 0, 0, view, true);
    expect(a).toBe(10);
    expect(b).toBeNaN();
    expect(blendCanvasField(a, b, 0.5)).toBeNaN();
    expect(blendCanvasField(a, b, 0)).toBe(10);
  });
});
