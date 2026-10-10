import { describe, expect, it } from 'vitest';
import { detectAxes, gradientAt, teachingFeatures, type TeachingManifest } from '../../src/lib/chart-teaching';

const manifest: TeachingManifest = { nx: 21, ny: 21, west: 110, east: 120, north: -20, south: -30 };
const grid = (fn: (i: number, j: number) => number) => {
  const result = new Float32Array(manifest.nx * manifest.ny);
  for (let j = 0; j < manifest.ny; j += 1) for (let i = 0; i < manifest.nx; i += 1) result[j * manifest.nx + i] = fn(i, j);
  return result;
};

describe('chart teaching features', () => {
  it('converts a pressure gradient to a Southern Hemisphere geostrophic wind', () => {
    const result = gradientAt(grid((i) => 1000 + i), manifest, -25, 115);
    expect(result).not.toBeNull();
    expect(result?.gradientHpaPer100Km).toBeCloseTo(1.98, 1);
    expect(result?.geostrophicKt).toBeGreaterThan(0);
    expect(result?.fromDeg).toBeCloseTo(0, 0);
    expect(gradientAt(grid((_i, j) => 1000 + j), manifest, -23, 116)?.fromDeg).toBeCloseTo(90, 0);
    expect(gradientAt(grid((i) => 1000 + i), manifest, -25, 109)).toBeNull();
    expect(gradientAt(grid((i) => 1000 + i), { ...manifest, north: 1, south: -1 }, 0, 115)?.geostrophicKt).toBeNull();
  });

  it('finds elongated trough and ridge axes from transverse curvature', () => {
    const trough = detectAxes(grid((_i, j) => 1000 + ((j - 10) ** 2) * 0.2), manifest);
    const ridge = detectAxes(grid((_i, j) => 1000 - ((j - 10) ** 2) * 0.2), manifest);
    expect(trough.some((axis) => axis.kind === 'trough')).toBe(true);
    expect(ridge.some((axis) => axis.kind === 'ridge')).toBe(true);
    expect(trough.every((axis) => axis.points.length >= 3)).toBe(true);
    const rotated = detectAxes(grid((i, j) => 1000 + ((j - i * 0.45 - 5) ** 2) * 0.2), manifest);
    expect(rotated.some((axis) => axis.kind === 'trough' && axis.points.length >= 3)).toBe(true);
  });

  it('does not invent a calm or incomplete wind feature', () => {
    const calm = grid(() => 1000);
    const missingWind = new Float32Array(calm.length).fill(NaN);
    const result = teachingFeatures(calm, manifest, [], missingWind);
    expect(result.strongest).toBeNull();
    expect(result.tight).toEqual([]);
    expect(detectAxes(missingWind, manifest)).toEqual([]);
  });

  it('does not infer features through missing cells or at an invalid edge', () => {
    const missing = grid((i, j) => (i === 10 && j === 10 ? NaN : 1000 + ((j - 10) ** 2) * 0.2));
    expect(detectAxes(missing, manifest).some((axis) => axis.lat === -25 && axis.lon === 115)).toBe(false);
    expect(gradientAt(grid((i) => 1000 + i), manifest, -25, 110)).not.toBeNull();
    expect(gradientAt(new Float32Array(3), manifest, -25, 115)).toBeNull();
    const hole = grid((i, j) => (i === 10 && j >= 7 && j <= 13 ? NaN : 1000 + ((j - 10) ** 2) * 0.2));
    expect(detectAxes(hole, manifest).every((axis) => !axis.points.some((point) => point.lon === 115))).toBe(true);
  });

  it('selects strongest pressure gradient, wettest cell and largest centre', () => {
    const pressure = grid((i, j) => 1000 + i * 2 + j * 0.05);
    const rain = grid((i, j) => i === 17 && j === 3 ? 42 : 2);
    const result = teachingFeatures(
      pressure,
      manifest,
      [{ kind: 'H', lat: -25, lon: 115, hpa: 1020, prominence: 8 }, { kind: 'L', lat: -27, lon: 117, hpa: 990, prominence: 16 }],
      grid(() => 18),
      rain,
    );
    expect(result.strongest).not.toBeNull();
    expect(result.wettest?.mm).toBe(42);
    expect(result.biggest?.kind).toBe('L');
    expect(result.tight.length).toBeGreaterThan(0);
    expect(result.tight[0].surfaceKt).toBe(18);
  });
});
