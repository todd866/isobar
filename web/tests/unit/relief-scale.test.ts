import { describe, expect, it } from 'vitest';
import { MESH_MAX_HALF_HEIGHT_DEG, reliefExaggeration, reliefLabel, terrainReliefScale } from '../../src/lib/terrain/relief-scale';
import { createTiltCamera, forwardProject, inverseAtAltitude } from '../../src/lib/tilt-camera';
import { globalEquirectangular, mapProject } from '../../src/lib/lambert';
import { terrainEye, withTilt } from '../../src/lib/tilt-navigation';

describe('shared relief scale', () => {
  it('is physical up close, rises to regional exaggeration, and flattens into the plate without a step', () => {
    expect(terrainReliefScale(.05)).toBe(1);
    expect(terrainReliefScale(.2)).toBe(1);
    expect(terrainReliefScale(3)).toBeCloseTo(4, 6);
    expect(terrainReliefScale(MESH_MAX_HALF_HEIGHT_DEG)).toBe(0);
    let previous = terrainReliefScale(.01);
    for (let h = .01; h < MESH_MAX_HALF_HEIGHT_DEG; h *= 1.01) {
      const next = terrainReliefScale(h);
      expect(Math.abs(next - previous)).toBeLessThan(.15); // continuous: no step larger than 0.15 per 1% of zoom
      previous = next;
    }
    expect(reliefExaggeration(.5)).toBeGreaterThan(1);
  });

  it('labels only exaggerated scales', () => {
    expect(reliefLabel(1)).toBeNull();
    expect(reliefLabel(.4)).toBeNull();
    expect(reliefLabel(1.73)).toBe('relief ×1.7');
    expect(reliefLabel(3.86)).toBe('relief ×4');
  });

  it('scales every projected height and its inverse by the same factor', () => {
    const base = { lat: -43.6, lon: 170.14, halfHeightDeg: 2, aspect: 1.8, tiltRadians: 1.2, targetElevationM: 1000 };
    const scaled = createTiltCamera({ ...base, reliefScale: 3 });
    const physical = createTiltCamera({ ...base, targetElevationM: 3000 });
    // A 3x scene equals a physical scene whose heights are 3x.
    const a = forwardProject(scaled, -43.4, 170.3, 2000)!, b = forwardProject(physical, -43.4, 170.3, 6000)!;
    expect(a.x).toBeCloseTo(b.x, 10); expect(a.y).toBeCloseTo(b.y, 10);
    const hit = inverseAtAltitude(scaled, a.x, a.y, 2000)!;
    expect(hit.lat).toBeCloseTo(-43.4, 6); expect(hit.lon).toBeCloseTo(170.3, 6);
  });

  it('applies the view-dependent scale through the shared tilted projection and keeps the eye clear', () => {
    const geo = globalEquirectangular();
    const dem = (lon: number) => lon > 170 ? 3000 : 500;
    const camera = withTilt(geo, { centerX: 170.14, centerY: -43.6, halfWidth: 3.6, halfHeight: 2 }, 1.2, dem, true);
    expect(camera.tiltCamera!.reliefScale).toBeCloseTo(terrainReliefScale(2), 10);
    const eye = terrainEye(camera.tiltCamera!);
    expect(eye.heightM).toBeGreaterThan((dem(eye.lon) ?? 0));
    const top = mapProject(geo, camera, -43.4, 170.3, 3000)!, foot = mapProject(geo, camera, -43.4, 170.3, 0)!;
    const flat = withTilt(geo, { centerX: 170.14, centerY: -43.6, halfWidth: .18, halfHeight: .1 }, 1.2, dem, true);
    expect(flat.tiltCamera!.reliefScale).toBe(1);
    expect(Math.hypot(top.x - foot.x, top.y - foot.y)).toBeGreaterThan(0);
  });
});
