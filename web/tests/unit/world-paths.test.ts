import { describe, expect, it } from 'vitest';
import { globalEquirectangular } from '../../src/lib/lambert';
import { projectedPaths } from '../../src/lib/overlay';

const geo = globalEquirectangular();
describe('continuous world paths', () => {
  it('splits a coastline at the camera seam without a full-map chord', () => {
    const paths = projectedPaths(geo, { centerX: 120, centerY: 0, halfWidth: 180, halfHeight: 90 }, 720, 360,
      [-65, -60, -55], [30, 31, 32], false);
    expect(paths).toHaveLength(2);
    for (const { points } of paths) {
      expect(Math.abs(points[1]!.x - points[0]!.x)).toBeCloseTo(10);
      expect(Math.abs(points[2]!.x - points[1]!.x)).toBeCloseTo(10);
    }
    expect(paths.some(({ points }) => points.some((p) => p && p.x >= 0 && p.x < 20))).toBe(true);
    expect(paths.some(({ points }) => points.some((p) => p && p.x > 700 && p.x <= 720))).toBe(true);
  });
  it('keeps an isobar continuous across the geographic dateline', () => {
    const paths = projectedPaths(geo, { centerX: 180, centerY: 0, halfWidth: 30, halfHeight: 15 }, 720, 360,
      [178, 179, -180, -179, -178], [0, 1, 2, 1, 0], false);
    expect(paths).toHaveLength(1);
    for (let i = 1; i < paths[0].points.length; i++)
      expect(Math.abs(paths[0].points[i]!.x - paths[0].points[i - 1]!.x)).toBeCloseTo(12);
  });
  it('does not close a circumpolar contour through the whole world', () => {
    const lon = Array.from({ length: 73 }, (_, i) => -180 + i * 5);
    const paths = projectedPaths(geo, { centerX: 0, centerY: 0, halfWidth: 180, halfHeight: 90 }, 720, 360,
      lon, lon.map(() => -60), true);
    expect(paths.every((path) => !path.closed)).toBe(true);
  });
});
