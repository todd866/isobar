import { describe, expect, it } from 'vitest';
import { contourPressure, marchIsobars, pressureCentres, smoothGrid } from '../../src/lib/contour';

/**
 * The pre-bucket contour ladder: smooth once, add the global ghost column,
 * then ask the exported marching-squares implementation for every level.
 * Keeping this oracle in the test makes the optimized traversal accountable
 * for both seam handling and the exact segment/stitch ordering.
 */
function legacyLines(
  raw: Float32Array,
  nx: number,
  ny: number,
  west: number,
  north: number,
  dlon: number,
  dlat: number,
  interval = 4,
  smooth = true,
): ReturnType<typeof marchIsobars> {
  const wraps = Math.abs(nx * dlon - 360) < 1e-6;
  const field = smooth ? smoothGrid(smoothGrid(raw, nx, ny, wraps), nx, ny, wraps) : raw;
  const columns = wraps ? nx + 1 : nx;
  const traced = wraps ? new Float32Array(columns * ny) : field;
  if (wraps) for (let j = 0; j < ny; j += 1) {
    traced.set(field.subarray(j * nx, (j + 1) * nx), j * columns);
    traced[j * columns + nx] = field[j * nx];
  }

  let min = Infinity;
  let max = -Infinity;
  for (const value of field) {
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const lines: ReturnType<typeof marchIsobars> = [];
  const step = interval / 2;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return lines;
  const start = Math.ceil(min / step) * step;
  for (let level = start; level <= max; level += step) {
    lines.push(...marchIsobars(traced, columns, ny, level, west, north, dlon, dlat)
      .filter((line) => line.lon.length >= 4));
  }
  return lines;
}

function expectSameLines(actual: ReturnType<typeof marchIsobars>, expected: ReturnType<typeof marchIsobars>) {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(actual[i].level).toBe(expected[i].level);
    expect(actual[i].closed).toBe(expected[i].closed);
    expect(Array.from(actual[i].lon)).toEqual(Array.from(expected[i].lon));
    expect(Array.from(actual[i].lat)).toEqual(Array.from(expected[i].lat));
  }
}

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

describe('optimized contour ladder', () => {
  it('matches the direct marching-squares oracle without smoothing', () => {
    const nx = 5;
    const ny = 5;
    const raw = Float32Array.from([
      1000, 1004, 1000, 1004, 1000,
      1004, 1008, 1004, 1008, 1004,
      1000, 1004, NaN, 1004, 1000,
      1004, 1008, 1004, 1008, 1004,
      1000, 1004, 1000, 1004, 1000,
    ]);
    const actual = contourPressure(raw, nx, ny, 140, 10, 1, -1, 4, null, false).lines;
    const expected = legacyLines(raw, nx, ny, 140, 10, 1, -1, 4, false);
    expectSameLines(actual, expected);
  });

  it('keeps an exact-level plateau edge identical to the direct oracle', () => {
    const nx = 6;
    const ny = 4;
    const raw = Float32Array.from([
      1000, 1000, 1004, 1004, 1008, 1008,
      1000, 1000, 1004, 1004, 1008, 1008,
      1008, 1008, 1004, 1004, 1000, 1000,
      1008, 1008, 1004, 1004, 1000, 1000,
    ]);
    const actual = contourPressure(raw, nx, ny, 0, 10, 1, -1, 4, null, false).lines;
    const expected = legacyLines(raw, nx, ny, 0, 10, 1, -1, 4, false);
    expectSameLines(actual, expected);
  });

  it('matches the legacy oracle for NaNs, exact levels, and saddle cells', () => {
    const nx = 9;
    const ny = 7;
    const raw = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        // A smooth gradient plus alternating ridges creates open contours,
        // closed contours, and several ambiguous saddle cells after smoothing.
        raw[j * nx + i] = 1000 + i * 1.75 + j * 2.25 + ((i * 7 + j * 11) % 5) - 2;
      }
    }
    raw[2 * nx + 3] = NaN;
    raw[3 * nx + 4] = NaN;
    raw[4 * nx + 1] = 1004;
    raw[1 * nx + 7] = 1004;

    const actual = contourPressure(raw, nx, ny, 120, 20, 0.5, -0.5, 4).lines;
    const expected = legacyLines(raw, nx, ny, 120, 20, 0.5, -0.5, 4);
    expectSameLines(actual, expected);
  });

  it('matches the legacy oracle across the wrapped global seam', () => {
    const nx = 24;
    const ny = 11;
    const raw = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const seamDistance = Math.min(i, nx - i);
        const wave = 7 * Math.sin(i * 0.73) + 4 * Math.cos(j * 0.91) + (j - 5) * 1.3;
        raw[j * nx + i] = 1008 + wave - 0.9 * seamDistance;
      }
    }
    // Missing values at both sides of the seam must remain missing rather than
    // acquiring a contour through the ghost column.
    raw[3 * nx] = NaN;
    raw[3 * nx + nx - 1] = NaN;
    raw[8 * nx + 2] = NaN;

    const actual = contourPressure(raw, nx, ny, -180, 45, 15, -9, 3).lines;
    const expected = legacyLines(raw, nx, ny, -180, 45, 15, -9, 3);
    expectSameLines(actual, expected);
  });

  it('matches the legacy oracle for a varied global sized field', () => {
    const nx = 36;
    const ny = 18;
    const raw = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const lon = (i / nx) * Math.PI * 2;
        const lat = (j / (ny - 1) - 0.5) * Math.PI;
        raw[j * nx + i] = 1012
          + 10 * Math.sin(lon * 2.3) * Math.cos(lat)
          + 5 * Math.cos(lon * 4.1 + lat * 1.7)
          + 3 * Math.sin(lat * 3.2);
      }
    }
    const actual = contourPressure(raw, nx, ny, -180, 90, 10, -10, 4).lines;
    const expected = legacyLines(raw, nx, ny, -180, 90, 10, -10, 4);
    expectSameLines(actual, expected);
  });
});
