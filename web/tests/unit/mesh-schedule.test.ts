import { describe, expect, it } from 'vitest';
import { meshNeedsRebuild } from '../../src/lib/terrain/mesh-schedule';
import { createTiltCamera, terrainViewBounds } from '../../src/lib/tilt-camera';
import { surfaceMeshSpacing } from '../../src/lib/terrain/surface-mesh';

const want = (lat: number, lon: number, halfHeightDeg = .13, bearing = 0, tilt = .8) => {
  const camera = createTiltCamera({ lat, lon, halfHeightDeg, aspect: 1.7, tiltRadians: tilt, bearingRadians: bearing });
  return { box: terrainViewBounds(camera)!, required: terrainViewBounds(camera, 4)!, focus: { lat, lon }, spacing: surfaceMeshSpacing(halfHeightDeg), halfHeightDeg };
};

describe('terrain mesh rebuild schedule', () => {
  it('builds a first mesh, then keeps it through orbit, tilt and a short flight', () => {
    const first = want(-43.595, 170.14);
    expect(meshNeedsRebuild(null, first)).toBe(true);
    const built = { box: first.box, focus: first.focus, spacing: first.spacing };
    expect(meshNeedsRebuild(built, want(-43.595, 170.14, .13, 1.2, 1.1))).toBe(false);
    // 0.02 degrees of flight rebuilt the old mesh on every few frames.
    for (let step = 1; step <= 3; step += 1) expect(meshNeedsRebuild(built, want(-43.595 + step * .02, 170.14))).toBe(false);
  });

  it('rebuilds after the focus drifts half a view from the fine cells, or the spacing bucket changes', () => {
    const first = want(-43.595, 170.14);
    const built = { box: first.box, focus: first.focus, spacing: first.spacing };
    expect(meshNeedsRebuild(built, want(-43.595 + .08, 170.14))).toBe(true);
    expect(meshNeedsRebuild(built, want(-43.595, 170.14, .02))).toBe(true);
  });

  it('rebuilds when the focus leaves the inner half or the visible footprint leaves the mesh', () => {
    const first = want(-43.595, 170.14, 1.5);
    const built = { box: first.box, focus: first.focus, spacing: first.spacing };
    const far = want(-43.595, 170.14 + (first.box.east - first.box.west) * .3, 1.5);
    expect(meshNeedsRebuild({ ...built, focus: far.focus }, far)).toBe(true);
  });

  it('treats longitude continuously across the antimeridian', () => {
    const first = want(-17, 179.99);
    const built = { box: first.box, focus: first.focus, spacing: first.spacing };
    expect(meshNeedsRebuild(built, want(-17, -179.99))).toBe(false);
  });
});
