import { describe, expect, it } from 'vitest';
import { globalEquirectangular, type Camera } from '../../src/lib/lambert';
import { withTilt } from '../../src/lib/tilt-navigation';
import { projectedPaths, projectedStrokePaths } from '../../src/lib/overlay';

const geo = globalEquirectangular();

function surface(unproject: (x: number, y: number) => { lat: number; lon: number } | null) {
  return {
    project(lat: number, lon: number) { return { x: lon / 10, y: lat / 10, visible: true, depth: 1 }; },
    unproject,
  };
}

function camera(s: Camera['surface']): Camera {
  return { centerX: 0, centerY: 0, halfWidth: 10, halfHeight: 10, surface: s };
}

describe('3D stroke chunk culling', () => {
  it('projects only chunks intersecting the conservative surface footprint', () => {
    const lon = Float64Array.from(Array.from({ length: 257 }, (_, i) => i < 64 || i >= 193 ? 0 : 120));
    const lat = new Float64Array(lon.length);
    const result = projectedStrokePaths(geo, camera(surface((x, y) => ({ lat: y * 5, lon: x * 5 }))), 400, 200, lon, lat, false);
    expect(result).toHaveLength(1);
    expect(result[0].points[2]).not.toBeNull();
    expect(result[0].points[150]).toBeNull();
    expect(result[0].points[193]).not.toBeNull();
  });

  it('falls back when the surface has a horizon or unavailable unprojection', () => {
    const lon = Float64Array.from([-120, -119, 0, 1, 120]);
    const lat = new Float64Array(lon.length);
    const s = surface((x, y) => (x > 0.9 && y < 0 ? null : { lat: y * 5, lon: x * 5 }));
    expect(projectedStrokePaths(geo, camera(s), 400, 200, lon, lat, false)).toEqual(projectedPaths(geo, camera(s), 400, 200, lon, lat, false));
  });

  it('falls back for polar footprints where a latitude box is unsafe', () => {
    const lon = Float64Array.from([-10, 0, 10]);
    const lat = new Float64Array([88.9, 89, 88.9]);
    const s = surface((x, y) => ({ lat: 89 + y * 0.1, lon: x * 5 }));
    expect(projectedStrokePaths(geo, camera(s), 400, 200, lon, lat, false)).toEqual(projectedPaths(geo, camera(s), 400, 200, lon, lat, false));
  });

  it('matches real tilted projection coordinates for retained vertices', () => {
    const lon = Float64Array.from(Array.from({ length: 257 }, (_, i) => -40 + i * 80 / 256));
    const lat = Float64Array.from(lon, () => 0);
    const tilted = withTilt(geo, { centerX: 0, centerY: 0, halfWidth: 20, halfHeight: 10 }, 15 * Math.PI / 180);
    const full = projectedPaths(geo, tilted, 800, 400, lon, lat, false);
    const culled = projectedStrokePaths(geo, tilted, 800, 400, lon, lat, false);
    expect(culled).toHaveLength(full.length);
    for (let i = 0; i < lon.length; i += 1) {
      const actual = culled[0].points[i], expected = full[0].points[i];
      if (actual && expected) {
        expect(actual.x).toBeCloseTo(expected.x, 8);
        expect(actual.y).toBeCloseTo(expected.y, 8);
      }
    }
  });

  it('rejects remote coastlines even when a real close camera sees the horizon', () => {
    const tilted=withTilt(geo,{centerX:116,centerY:-32,halfWidth:.2,halfHeight:.1,bearingRadians:1},1.2);
    const lon=Float64Array.from({length:257},(_,i)=>i/100),lat=new Float64Array(257);
    expect(projectedStrokePaths(geo,tilted,1200,800,lon,lat,false)).toHaveLength(0);
  });

  it('caches the expensive surface footprint by projection and viewport', () => {
    let calls = 0;
    const s = surface((x, y) => { calls += 1; return { lat: y * 5, lon: x * 5 }; });
    const c = camera(s);
    const lon = Float64Array.from(Array.from({ length: 128 }, (_, i) => -1 + i / 64));
    const lat = new Float64Array(lon.length);
    projectedStrokePaths(geo, c, 400, 200, lon, lat, false);
    const first = calls;
    projectedStrokePaths(geo, c, 400, 200, lon, lat, false);
    expect(calls).toBe(first);
  });
  it('retains every on-screen vertex at regional tilt and across the dateline', () => {
    for (const centre of [116, 179, -179]) for (const pitch of [.3, .785, 1.2]) {
      const tilted = withTilt(geo, {centerX: centre, centerY: -32, halfWidth: 3, halfHeight: 2}, pitch);
      for (const latitude of [-36, -34, -32, -30, -28]) {
        const lon = Float64Array.from({length: 1201}, (_, i) => centre - 30 + i * .05);
        const lat = Float64Array.from(lon, () => latitude);
        const full = projectedPaths(geo, tilted, 1200, 800, lon, lat, false)[0];
        const culled = projectedStrokePaths(geo, tilted, 1200, 800, lon, lat, false);
        full.points.forEach((point, index) => {
          if (point && point.x >= 0 && point.x <= 1200 && point.y >= 0 && point.y <= 800) {
            const actual = culled.flatMap(path => [path.points[index]]).find(p => p && Math.abs(p.x-point.x) < 1e-6 && Math.abs(p.y-point.y) < 1e-6);
            expect(actual).toBeTruthy();
          }
        });
      }
    }
  });

});
