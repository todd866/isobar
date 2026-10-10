import { describe, expect, it } from 'vitest';
import { contourPressure, marchIsobars, pressureCentres, smoothGrid } from '../../src/lib/contour';

describe('marching squares', () => {
  it('draws a vertical isobar through a linear east-west ramp', () => {
    const nx = 4;
    const ny = 3;
    const grid = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) grid[j * nx + i] = i;
    }
    const lines = marchIsobars(grid, nx, ny, 1.5, 100, 0, 1, -1);
    expect(lines.length).toBe(1);
    const line = lines[0];
    for (let i = 0; i < line.lon.length; i += 1) expect(line.lon[i]).toBeCloseTo(101.5, 5);
    const lats = Array.from(line.lat);
    expect(Math.min(...lats)).toBeCloseTo(-2, 5);
    expect(Math.max(...lats)).toBeCloseTo(0, 5);
  });

  it('does not invent a contour across a missing cell', () => {
    const grid = Float32Array.from([
      0, 0, 0,
      0, NaN, 10,
      0, 0, 0,
    ]);
    const lines = marchIsobars(grid, 3, 3, 5, 0, 0, 1, -1);
    expect(lines.every((line) => line.lon.length === 0) || lines.length === 0).toBe(true);
  });
});

describe('pressure centres', () => {
  // 81 x 81 cells at 0.25 degrees: a 20 degree box, room for the 4 degree ring.
  const nx = 81;
  const ny = 81;
  function field(fn: (i: number, j: number) => number): Float32Array {
    const raw = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) raw[j * nx + i] = fn(i, j);
    return raw;
  }
  const bump = (i: number, j: number, ci: number, cj: number, depth: number, width: number) => {
    const d = Math.hypot(i - ci, j - cj);
    return depth * Math.exp(-(d * d) / (width * width));
  };

  it('marks a closed high and a closed low with their value', () => {
    const raw = field((i, j) => 1012 + bump(i, j, 25, 25, 14, 12) - bump(i, j, 56, 56, 14, 12));
    const result = contourPressure(raw, nx, ny, 130, -20, 0.25, -0.25, 4);
    const high = result.centres.find((centre) => centre.kind === 'H');
    const low = result.centres.find((centre) => centre.kind === 'L');
    expect(high).toBeDefined();
    expect(low).toBeDefined();
    expect(high?.hpa).toBe(1026);
    expect(low?.hpa).toBe(998);
    expect(high?.lon).toBeCloseTo(130 + 25 * 0.25, 5);
    expect(result.lines.some((line) => line.closed)).toBe(true);
  });

  it('ignores a bump smaller than its surroundings can carry', () => {
    const raw = field((i, j) => 1016 + bump(i, j, 40, 40, 1.2, 6));
    const smooth = smoothGrid(raw, nx, ny);
    expect(pressureCentres(raw, smooth, nx, ny, 130, -30, 0.25, -0.25)).toEqual([]);
  });

  it('marks nothing on the edge of the grid', () => {
    // The low sits 1.5 degrees from the west edge: its ring leaves the grid.
    const raw = field((i, j) => 1012 - bump(i, j, 6, 40, 16, 10));
    const result = contourPressure(raw, nx, ny, 130, -20, 0.25, -0.25, 4);
    expect(result.centres).toEqual([]);
  });

  it('returns actual ring depth and rejects a weak enclosed thermal low', () => {
    const weak = field((i, j) => 1013 - bump(i, j, 40, 40, 1.5, 4));
    expect(contourPressure(weak, nx, ny, 130, -20, 0.25, -0.25).centres).toEqual([]);
    const raw = field((i, j) => 1013 - bump(i, j, 40, 40, 6, 8));
    const result = contourPressure(raw, nx, ny, 130, -20, 0.25, -0.25);
    expect(result.centres).toHaveLength(1);
    expect(result.centres[0].prominence).toBeGreaterThan(5);
    expect(result.centres[0].prominence).toBeLessThan(6);
  });
});

describe('periodic global pressure', () => {
  it('smooths through the longitude seam and traces its final cell', () => {
    const nx = 360, ny = 41;
    const raw = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const dx = Math.min(x, nx - x), dy = y - 20;
      raw[y * nx + x] = 990 + 40 * (1 - Math.exp(-(dx * dx + dy * dy) / 16));
    }
    const smooth = smoothGrid(raw, nx, ny, true);
    expect(smooth[20 * nx + 1]).toBeCloseTo(smooth[20 * nx + nx - 1], 5);
    const result = contourPressure(raw, nx, ny, -180, 20, 1, -1);
    const lows = result.centres.filter((c) => c.kind === 'L');
    expect(lows).toHaveLength(1);
    expect(lows[0].lon).toBe(-180);
    expect(result.lines.some((line) => Array.from(line.lon).some((lon) => lon === 180))).toBe(true);
  });
});
