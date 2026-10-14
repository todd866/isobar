import { describe, expect, it } from 'vitest';
import { globalEquirectangular, mapProject } from '../../src/lib/lambert';
import { withTilt } from '../../src/lib/tilt-navigation';
import { createTerrainLineProjector } from '../../src/lib/terrain/line-occlusion';
import { rasterizeTriangle, type AtmosphereSliceDepthGrid } from '../../src/lib/atmosphere-slice-depth';

describe('terrain line occlusion', () => {
  it('keeps ordinary 2D projection unchanged', () => {
    const geo = globalEquirectangular();
    const camera = { centerX: 0, centerY: 0, halfWidth: 20, halfHeight: 10 };
    const projector = createTerrainLineProjector(geo, camera, () => 0, 800, 400);
    const lons = [-4, 0, 4], lats = [1, 0, -1];
    expect(projector(lons, lats, false)).toEqual(lats.map((lat, i) => mapProject(geo, camera, lat, lons[i])));
  });

  it('rasterizes nearest depth and keeps missing cells empty', () => {
    const grid: AtmosphereSliceDepthGrid = { width: 8, height: 8, depth: new Float32Array(64) };
    grid.depth.fill(Infinity);
    rasterizeTriangle(grid, [-.8, -.8, 100], [.8, -.8, 100], [0, .8, 100]);
    rasterizeTriangle(grid, [-.8, -.8, 200], [.8, -.8, 200], [0, .8, 200]);
    expect(Math.min(...grid.depth)).toBe(100);
    expect(grid.depth.some(Number.isFinite)).toBe(true);
  });

  it('subdivides a tilted line, preserves missing elevations, and stays bounded', () => {
    const geo = globalEquirectangular();
    const camera = withTilt(geo, { centerX: 86.925, centerY: 27.988, halfWidth: .12, halfHeight: .06 }, .8, () => 0, true);
    const elevation = (lon: number, lat: number) => lon > 86.96 ? null : (Math.abs(lat - 27.988) < .01 ? 5000 : 0);
    const projector = createTerrainLineProjector(geo, camera, elevation, 1200, 700);
    const result = projector([86.85, 86.99], [27.99, 27.99], false);
    expect(result.length).toBeGreaterThan(2);
    expect(result.length).toBeLessThanOrEqual(20_000);
    expect(result.some(point => point === null)).toBe(true);
  });

  it('samples a regional line near depth-grid resolution, not mesh spacing', () => {
    const geo = globalEquirectangular();
    const camera = withTilt(geo, { centerX: 115.8, centerY: -31.9, halfWidth: 3.2, halfHeight: 1.9 }, .8, () => 0, false);
    const projector = createTerrainLineProjector(geo, camera, () => 10, 1440, 900);
    // A 4 degree coast segment: about 380 km. Mesh spacing (80 m) would need ~4800 samples per frame.
    const line = projector([114.2, 117.4], [-33.2, -31.0], false);
    expect(line.some(Boolean)).toBe(true);
    expect(line.length).toBeLessThan(1200);
  });

  it('reuses depth for a recreated camera and closes subdivided rings', () => {
    const geo=globalEquirectangular();
    const make=()=>withTilt(geo,{centerX:0,centerY:0,halfWidth:.1,halfHeight:.06},.8,()=>0,false);
    let reads=0;const height=()=>{reads++;return 0;};
    const a=createTerrainLineProjector(geo,make(),height,800,600);const built=reads;
    createTerrainLineProjector(geo,make(),height,800,600);expect(reads).toBe(built);
    const ring=a([-.01,.01,0],[-.01,-.01,.01],true);
    expect(ring[0]).toEqual(ring.at(-1));expect(ring.every(Boolean)).toBe(true);
  });

  it('hides a far line behind a ridge and retains foreground lines', () => {
    const geo = globalEquirectangular();
    const camera = withTilt(geo, {centerX: 86.95, centerY: 27.98, halfWidth: .213, halfHeight: .16}, Math.PI * 48 / 180, () => 0, false);
    const ridge = (_lon: number, lat: number) => Math.abs(lat - 28.035) < .012 ? 7600 : 900;
    const projector = createTerrainLineProjector(geo, camera, ridge, 640, 480);
    expect(projector([86.945,86.955], [28.10,28.10], false).every(p => p === null)).toBe(true);
    expect(projector([86.945,86.955], [27.98,27.98], false).every(Boolean)).toBe(true);
    const crossing=projector([86.95,86.95],[27.98,28.10],false);
    expect(crossing.some(Boolean)).toBe(true);expect(crossing.some(p=>p===null)).toBe(true);
  });

  it('does not let terrain outside an atmospheric slice occlude its lines', () => {
    const geo = globalEquirectangular();
    const base = withTilt(geo, {centerX: 86.95, centerY: 27.98, halfWidth: .213, halfHeight: .16}, Math.PI * 48 / 180, () => 0, false);
    const camera = { ...base, slice: {
      lat: 28.10, lon: 86.95, bearingRadians: 0,
      halfWidthM: 1_500, halfDepthM: 1_000, baseM: 0,
    }};
    const ridge = (_lon: number, lat: number) => Math.abs(lat - 28.035) < .012 ? 7600 : 900;
    const projector = createTerrainLineProjector(geo, camera, ridge, 640, 480);
    const line = projector([86.945, 86.955], [28.10, 28.10], false);
    expect(line.length).toBeGreaterThan(0);
    expect(line.every(Boolean)).toBe(true);
  });

  it('uses supplied terrain data for a retained slice ridge', () => {
    const geo = globalEquirectangular();
    const base = withTilt(geo, {centerX: 86.95, centerY: 27.98, halfWidth: .213, halfHeight: .16}, Math.PI * 48 / 180, () => 0, false);
    const camera = { ...base, slice: {
      lat: 28.10, lon: 86.95, bearingRadians: 0,
      halfWidthM: 1_500, halfDepthM: 8_000, baseM: 0,
    }};
    const ridge = (_lon: number, lat: number) => Math.abs(lat - 28.035) < .012 ? 7600 : 900;
    const projector = createTerrainLineProjector(geo, camera, ridge, 640, 480);
    expect(projector([86.945,86.955], [28.10,28.10], false).every(p => p === null)).toBe(true);
  });

  it('does not fabricate a slab across missing terrain', () => {
    const geo = globalEquirectangular();
    const base = withTilt(geo, {centerX: 86.95, centerY: 27.98, halfWidth: .213, halfHeight: .16}, Math.PI * 48 / 180, () => 0, false);
    const camera = { ...base, slice: {
      lat: 28.10, lon: 86.95, bearingRadians: 0,
      halfWidthM: 1_500, halfDepthM: 8_000, baseM: 0,
    }};
    const elevation = (_lon: number, lat: number) => Math.abs(lat - 28.035) < .012 ? null : 900;
    const projector = createTerrainLineProjector(geo, camera, elevation, 640, 480);
    expect(projector([86.945,86.955], [28.10,28.10], false).every(Boolean)).toBe(true);
  });

  it('rebuilds depth when the slice changes on the same surface', () => {
    const geo = globalEquirectangular();
    const base = withTilt(geo, {centerX: 86.95, centerY: 27.98, halfWidth: .213, halfHeight: .16}, Math.PI * 48 / 180, () => 0, false);
    const ridge = (_lon: number, lat: number) => Math.abs(lat - 28.035) < .012 ? 7600 : 900;
    const slice = { lat: 28.10, lon: 86.95, bearingRadians: 0, halfWidthM: 1_500, halfDepthM: 1_000, baseM: 0 };
    const blocked = createTerrainLineProjector(geo, base, ridge, 640, 480);
    expect(blocked([86.945,86.955], [28.10,28.10], false).every(p => p === null)).toBe(true);
    const clear = createTerrainLineProjector(geo, { ...base, slice }, ridge, 640, 480);
    expect(clear([86.945,86.955], [28.10,28.10], false).every(Boolean)).toBe(true);
  });
});
