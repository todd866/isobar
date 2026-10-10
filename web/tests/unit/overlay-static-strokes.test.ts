import { describe, expect, it } from 'vitest';
import { globalEquirectangular, type Camera } from '../../src/lib/lambert';
import {
  classRuns,
  terrainFlags,
  borderRingsInView,
  projectedPaths,
  projectedStrokePaths,
  strokeRingStaticCacheForTest,
  STROKE_CHUNK_VERTICES,
} from '../../src/lib/overlay';

const geo = globalEquirectangular();

interface Point {
  x: number;
  y: number;
}

function strokeSegments(
  points: (Point | null)[],
  closed: boolean,
  width: number,
  height: number,
  pad = 4,
): { a: Point; b: Point }[] {
  const out: { a: Point; b: Point }[] = [];
  const end = closed ? points.length : Math.max(0, points.length - 1);
  for (let i = 0; i < end; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    if ((a.x < -pad && b.x < -pad) || (a.x > width + pad && b.x > width + pad)
      || (a.y < -pad && b.y < -pad) || (a.y > height + pad && b.y > height + pad)) continue;
    out.push({ a, b });
  }
  return out;
}

function segmentSetsMatch(
  ref: { a: Point; b: Point }[],
  opt: { a: Point; b: Point }[],
  eps = 0.02,
): void {
  const near = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y) <= eps;
  const match = (s: { a: Point; b: Point }, t: { a: Point; b: Point }) => (
    (near(s.a, t.a) && near(s.b, t.b)) || (near(s.a, t.b) && near(s.b, t.a))
  );
  expect(opt).toHaveLength(ref.length);
  const used = new Set<number>();
  for (const r of ref) {
    const idx = opt.findIndex((o, i) => !used.has(i) && match(r, o));
    expect(idx).toBeGreaterThanOrEqual(0);
    used.add(idx);
  }
}

function expectStrokeEquivalent(
  camera: Camera,
  width: number,
  height: number,
  lon: ArrayLike<number>,
  lat: ArrayLike<number>,
  closed: boolean,
): void {
  const refPaths = projectedPaths(geo, camera, width, height, lon, lat, closed);
  const optPaths = projectedStrokePaths(geo, camera, width, height, lon, lat, closed);
  expect(optPaths).toHaveLength(refPaths.length);
  for (let p = 0; p < refPaths.length; p += 1) {
    expect(optPaths[p].closed).toBe(refPaths[p].closed);
    expect(optPaths[p].points).toHaveLength(refPaths[p].points.length);
    const refSegs = strokeSegments(refPaths[p].points, refPaths[p].closed, width, height);
    const optSegs = strokeSegments(optPaths[p].points, optPaths[p].closed, width, height);
    segmentSetsMatch(refSegs, optSegs);
  }
}

describe('projectedStrokePaths vs projectedPaths', () => {
  it('matches dateline-spanning open paths', () => {
    expectStrokeEquivalent(
      { centerX: 180, centerY: 0, halfWidth: 30, halfHeight: 15 },
      720,
      360,
      [178, 179, -180, -179, -178],
      [0, 1, 2, 1, 0],
      false,
    );
  });

  it('matches world-copy splits at the camera seam', () => {
    expectStrokeEquivalent(
      { centerX: 120, centerY: 0, halfWidth: 180, halfHeight: 90 },
      720,
      360,
      [-65, -60, -55],
      [30, 31, 32],
      false,
    );
  });

  it('keeps crossing segments that enter the viewport', () => {
    const lon = new Float64Array([-10, -5, 0, 5, 10]);
    const lat = new Float64Array([0, 0, 0, 0, 0]);
    expectStrokeEquivalent(
      { centerX: 0, centerY: 0, halfWidth: 8, halfHeight: 8 },
      400,
      200,
      lon,
      lat,
      false,
    );
  });

  it('respects gaps and does not bridge null breaks', () => {
    const lon = new Float64Array([0, 1, 2, 10, 11, 12]);
    const lat = new Float64Array([0, 0, 0, 0, 0, 0]);
    expectStrokeEquivalent(
      { centerX: 0, centerY: 0, halfWidth: 6, halfHeight: 6 },
      320,
      160,
      lon,
      lat,
      false,
    );
  });

  it('matches closed boundaries including circumpolar rings', () => {
    const lon = Array.from({ length: 73 }, (_, i) => -180 + i * 5);
    const lat = lon.map(() => -60);
    expectStrokeEquivalent(
      { centerX: 0, centerY: -60, halfWidth: 180, halfHeight: 20 },
      720,
      360,
      lon,
      lat,
      true,
    );
  });

  it('matches deep zoom regional coast chunks', () => {
    const lon = new Float64Array(Array.from({ length: 200 }, (_, i) => 115 + i * 0.05));
    const lat = new Float64Array(Array.from({ length: 200 }, (_, i) => -32 + Math.sin(i / 20) * 0.4));
    expectStrokeEquivalent(
      { centerX: 122, centerY: -31.5, halfWidth: 1.2, halfHeight: 0.8 },
      1280,
      640,
      lon,
      lat,
      true,
    );
  });

  it('falls back to projectedPaths on globe surface cameras', () => {
    const lon = new Float64Array([10, 20, 30]);
    const lat = new Float64Array([0, 1, 0]);
    const camera: Camera = { centerX: 0, centerY: 0, halfWidth: 180, halfHeight: 90, surface: { project: (lat, lon) => ({ x: lon / 180, y: lat / 90, visible: true, depth: 1 }), unproject: () => null } };
    const ref = projectedPaths(geo, camera, 720, 360, lon, lat, false);
    const opt = projectedStrokePaths(geo, camera, 720, 360, lon, lat, false);
    expect(opt).toEqual(ref);
  });

  it('does not mutate lon/lat inputs', () => {
    const lon = new Float64Array([150, 151, 152, 153]);
    const lat = new Float64Array([-33, -33.2, -33.4, -33.1]);
    const lonBefore = Array.from(lon);
    const latBefore = Array.from(lat);
    projectedStrokePaths(geo, { centerX: 151, centerY: -33, halfWidth: 2, halfHeight: 2 }, 640, 320, lon, lat, false);
    expect(Array.from(lon)).toEqual(lonBefore);
    expect(Array.from(lat)).toEqual(latBefore);
  });

  it('reuses static cache for repeated paints and rebuilds when lat identity changes', () => {
    const lon = new Float64Array(Array.from({ length: STROKE_CHUNK_VERTICES * 3 + 5 }, (_, i) => 100 + i * 0.01));
    const latA = new Float64Array(lon.length);
    const latB = new Float64Array(lon.length);
    const camera = { centerX: 101, centerY: 0, halfWidth: 3, halfHeight: 3 };
    projectedStrokePaths(geo, camera, 800, 400, lon, latA, false);
    const first = strokeRingStaticCacheForTest(lon);
    expect(first).toBeDefined();
    expect(first!.lat).toBe(latA);
    const unwrapRef = first!.unwrapLon;
    for (let i = 0; i < 64; i += 1) {
      projectedStrokePaths(geo, camera, 800, 400, lon, latA, false);
    }
    expect(strokeRingStaticCacheForTest(lon)?.unwrapLon).toBe(unwrapRef);
    projectedStrokePaths(geo, camera, 800, 400, lon, latB, false);
    expect(strokeRingStaticCacheForTest(lon)?.lat).toBe(latB);
    expect(strokeRingStaticCacheForTest(lon)?.unwrapLon).not.toBe(unwrapRef);
  });
  it('keeps crossing segments between two wholly offscreen chunks', () => {
    const lon = Float64Array.from({ length: 128 }, (_, i) => i < 64 ? -50 : 50);
    const lat = new Float64Array(128);
    expectStrokeEquivalent({ centerX: 0, centerY: 0, halfWidth: 5, halfHeight: 5 }, 400, 300, lon, lat, false);
    expectStrokeEquivalent({ centerX: 0, centerY: 0, halfWidth: 5, halfHeight: 5 }, 400, 300, lon, lat, true);
  });

  it('uses the general gap behavior for invalid coordinates', () => {
    const lon = [0, 1, NaN, 3, 4], lat = [0, 0, 0, 0, 0];
    const camera = { centerX: 0, centerY: 0, halfWidth: 5, halfHeight: 5 };
    expect(projectedStrokePaths(geo, camera, 400, 300, lon, lat, false)).toEqual(projectedPaths(geo, camera, 400, 300, lon, lat, false));
  });

});


describe('regional border candidates', () => {
  const ring = (west: number, east: number, south = -1, north = 1) => ({ lon: new Float32Array([west, east]), lat: new Float32Array([south, north]) });
  const view = (west: number, east: number) => ({ west, east, south: -2, north: 2 });
  it('retains crossing lines and reuses the padded selection during a small pan', () => {
    const crossing = ring(-30, 30), far = ring(90, 100), rings = [crossing, far];
    const selected = borderRingsInView(rings, view(-5, 5));
    expect(selected).toEqual([crossing]);
    expect(borderRingsInView(rings, view(-4, 6))).toBe(selected);
    expect(borderRingsInView(rings, view(92, 98))).toContain(far);
  });
  it('includes dateline and arbitrarily shifted world copies', () => {
    const seam = ring(179, -179), shifted = ring(-174, -170), rings = [seam, shifted];
    expect(borderRingsInView(rings, view(176, 192))).toEqual(rings);
    expect(borderRingsInView(rings, view(896, 912))).toEqual(rings);
  });
  it('refreshes on zoom out and excludes distant latitude', () => {
    const nearby = ring(-2, 2), distant = ring(75, 80), polar = ring(0, 1, 85, 89), rings = [nearby, distant, polar];
    expect(borderRingsInView(rings, view(-5, 5))).toEqual([nearby]);
    expect(borderRingsInView(rings, view(-100, 100))).toEqual([nearby, distant]);
  });
});


describe('visible terrain classification', () => {
  it('samples only visible vertices, caches them, and fills newly visible slots', () => {
    const line = { lon: new Float32Array([0, 1, 2, 3]), lat: new Float32Array([0, 0, 0, 0]), level: 1012, closed: false };
    let calls = 0;
    const sample = () => { calls++; return 0; };
    const a = terrainFlags(line, [null, {x:0,y:0}, null, null], sample);
    expect(calls).toBe(3); expect(a[1]).toBe(false); expect(a[0]).toBeUndefined();
    expect(terrainFlags(line, [null, {x:0,y:0}, null, null], sample)).toBe(a);
    expect(calls).toBe(3);
    terrainFlags(line, [null, {x:0,y:0}, {x:1,y:0}, null], sample);
    expect(calls).toBe(6); expect(a[2]).toBe(false);
    const mountain = terrainFlags(line, [null, {x:0,y:0}, null, null], () => 4000);
    expect(mountain[1]).toBe(true); expect(a[1]).toBe(false);
  });
  it('does not close a clipped contour fragment with a false chord', () => {
    const points = [null, {x:0,y:0}, {x:10,y:10}, {x:20,y:0}, null];
    expect(classRuns(points, true, [false,false,false,false,false], false)).toEqual([
      { points: points.slice(1,4), closed: false },
    ]);
  });
});
