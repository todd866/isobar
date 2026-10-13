import { describe, expect, it } from 'vitest';
import { smoothGrid } from '../../src/lib/contour';
import { preparePressureTexture } from '../../src/lib/pressure-texture';

function expectedTexture(a: Float32Array, b: Float32Array, nx: number, ny: number, wraps: boolean): number[] {
  const jointA = new Float32Array(nx * ny);
  const jointB = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i += 1) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      jointA[i] = a[i];
      jointB[i] = b[i];
    } else {
      jointA[i] = NaN;
      jointB[i] = NaN;
    }
  }
  const aa = smoothGrid(smoothGrid(jointA, nx, ny, wraps), nx, ny, wraps);
  const bb = smoothGrid(smoothGrid(jointB, nx, ny, wraps), nx, ny, wraps);
  const expected: number[] = [];
  for (let i = 0; i < nx * ny; i += 1) expected.push(aa[i], bb[i]);
  return expected;
}

describe('pressure texture preparation', () => {
  it('interleaves two twice-smoothed endpoints and preserves missing values', () => {
    const nx = 5;
    const ny = 4;
    const a = Float32Array.from([
      1000, NaN, NaN, NaN, 1008,
      1001, NaN, NaN, NaN, 1009,
      1002, NaN, NaN, NaN, 1010,
      1003, 1005, 1006, 1009, 1011,
    ]);
    const b = Float32Array.from(a, (value, i) => Number.isNaN(value) ? value : value + 12 + (i % nx));
    const actual = preparePressureTexture(a, b, nx, ny, false);
    const expected = expectedTexture(a, b, nx, ny, false);
    expect(actual.length).toBe(nx * ny * 2);
    for (let i = 0; i < expected.length; i += 1) {
      if (Number.isNaN(expected[i])) expect(actual[i]).toBeNaN();
      else expect(actual[i]).toBe(expected[i]);
    }
  });

  it('uses wrapped neighbours at the global seam for both channels', () => {
    const nx = 6;
    const ny = 3;
    const a = Float32Array.from([
      0, 10, 20, 30, 40, 50,
      2, 12, 22, 32, 42, 52,
      4, 14, 24, 34, 44, 54,
    ]);
    const b = Float32Array.from(a, (value, i) => value * 2 + (i % nx));
    const actual = preparePressureTexture(a, b, nx, ny, true);
    expect(Array.from(actual)).toEqual(expectedTexture(a, b, nx, ny, true));
    // The first column sees the final column through both smoothing passes.
    const nonWrapped = expectedTexture(a, b, nx, ny, false);
    expect(actual[0]).not.toBe(nonWrapped[0]);
    expect(actual[1]).not.toBe(nonWrapped[1]);
  });

  it.each([
    { name: 'finite local grid', nx: 5, ny: 4, wraps: false },
    { name: 'wrapped global grid', nx: 7, ny: 5, wraps: true },
    { name: 'missing cells', nx: 6, ny: 4, wraps: false },
    { name: 'polar rows', nx: 8, ny: 3, wraps: true },
  ])('matches blend-then-smooth for $name without mutating inputs', ({ name, nx, ny, wraps }) => {
    const size = nx * ny;
    const a = Float32Array.from({ length: size }, (_, i) => 980 + i * 0.73 + Math.sin(i * 0.4) * 2.5);
    const b = Float32Array.from({ length: size }, (_, i) => 1007 + i * 0.51 + Math.cos(i * 0.3) * 3.2);
    if (name === 'missing cells') {
      a[0] = NaN;
      b[nx + 1] = NaN;
      a[(ny - 1) * nx + nx - 1] = NaN;
    }
    if (name === 'polar rows') {
      for (let i = 0; i < nx; i += 1) {
        a[i] += 9;
        b[i] -= 6;
        a[(ny - 1) * nx + i] -= 8;
        b[(ny - 1) * nx + i] += 5;
      }
    }
    const originalA = a.slice();
    const originalB = b.slice();
    const t = 0.37;
    const actual = preparePressureTexture(a, b, nx, ny, wraps);

    const joint = new Float32Array(size);
    for (let i = 0; i < size; i += 1) {
      joint[i] = Number.isFinite(a[i]) && Number.isFinite(b[i])
        ? a[i] * (1 - t) + b[i] * t
        : NaN;
    }
    const expected = smoothGrid(smoothGrid(joint, nx, ny, wraps), nx, ny, wraps);
    for (let i = 0; i < size; i += 1) {
      const blendedPrepared = actual[i * 2] * (1 - t) + actual[i * 2 + 1] * t;
      if (Number.isNaN(expected[i])) expect(blendedPrepared).toBeNaN();
      else expect(Math.abs(blendedPrepared - expected[i])).toBeLessThanOrEqual(0.00025);
    }
    expect(Array.from(a)).toEqual(Array.from(originalA));
    expect(Array.from(b)).toEqual(Array.from(originalB));
  });
});
