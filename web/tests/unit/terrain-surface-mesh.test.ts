import { describe, expect, it } from 'vitest';
import { buildSurfaceMesh } from '../../src/lib/terrain/surface-mesh';

const box = { west: 86.10768, south: 27.82160, east: 87.74232, north: 28.49627 };
describe('focus adaptive terrain surface mesh', () => {
  it('keeps exact bounds, includes focus, and has smooth dense near spacing', () => {
    const mesh = buildSurfaceMesh({ box, focus: { lat: 27.9881, lon: 86.925 }, halfHeightDeg: .13 });
    expect(mesh).not.toBeNull();
    expect(mesh!.lons[0]).toBe(box.west); expect(mesh!.lons.at(-1)).toBe(box.east);
    expect(mesh!.lats[0]).toBe(box.south); expect(mesh!.lats.at(-1)).toBe(box.north);
    expect(mesh!.lons.some((x) => Math.abs(x - 86.925) < 1e-9)).toBe(true);
    const ix = mesh!.lons.findIndex((x) => Math.abs(x - 86.925) < 1e-9);
    const step = (mesh!.lons[ix + 1] - mesh!.lons[ix]) * 111320;
    expect(step).toBeGreaterThanOrEqual(29); expect(step).toBeLessThanOrEqual(81);
    expect(mesh!.vertices.length / 4).toBeLessThanOrEqual(385 * 385);
  });
  it('makes a continuous shifted dateline mesh with consistent winding', () => {
    const mesh = buildSurfaceMesh({ box: { west: 179.4, south: -1, east: 181.2, north: 1 }, focus: { lat: 0, lon: 180.1 }, halfHeightDeg: .2 });
    expect(mesh).not.toBeNull(); expect(mesh!.lons).toContain(180.1);
    for (let i = 1; i < mesh!.lons.length; i++) expect(mesh!.lons[i]).toBeGreaterThan(mesh!.lons[i - 1]);
    for (let i = 0; i < mesh!.indices.length; i += 6) {
      expect(mesh!.indices[i + 1] - mesh!.indices[i]).toBe(mesh!.columns);
      expect(mesh!.indices[i + 2]).toBe(mesh!.indices[i] + 1);
    }
  });
  it('rejects invalid geometry and does not depend on irrelevant scale', () => {
    expect(buildSurfaceMesh({ box, focus: { lat: 99, lon: 0 }, halfHeightDeg: .2 })).toBeNull();
    expect(buildSurfaceMesh({ box: { ...box, east: box.west }, focus: { lat: 28, lon: 87 }, halfHeightDeg: .2 })).toBeNull();
    const a = buildSurfaceMesh({ box, focus: { lat: 27.9881, lon: 86.925 }, halfHeightDeg: .13 });
    const b = buildSurfaceMesh({ box, focus: { lat: 27.9881, lon: 86.925 }, halfHeightDeg: .13 });
    expect(Array.from(a!.vertices)).toEqual(Array.from(b!.vertices));
  });
  it('refines near-focus terrain when zooming without exceeding the mesh budget', () => {
    const focus = { lat: 27.9881, lon: 86.925 };
    const wide = buildSurfaceMesh({ box, focus, halfHeightDeg: .13 })!;
    const close = buildSurfaceMesh({ box, focus, halfHeightDeg: .005 })!;
    const spacing = (mesh: typeof wide) => {
      const i = mesh.lons.indexOf(focus.lon);
      return (mesh.lons[i + 1] - mesh.lons[i]) * 111320;
    };
    expect(spacing(close)).toBeLessThanOrEqual(30.01);
    expect(spacing(close)).toBeLessThan(spacing(wide));
    expect(close.vertices.length / 4).toBeLessThanOrEqual(385 * 385);
    for (let i = 4; i < close.columns * 4; i += 4) expect(close.vertices[i]).toBeGreaterThan(close.vertices[i - 4]);
  });
  it('supports off-centre and edge focuses within the vertex budget', () => {
    for (const focus of [{ lat: box.south, lon: box.west }, { lat: box.north, lon: box.east }, { lat: box.south + .01, lon: box.east - .01 }]) {
      const mesh = buildSurfaceMesh({ box, focus, halfHeightDeg: .001 });
      expect(mesh).not.toBeNull();
      expect(mesh!.vertices.length / 4).toBeLessThanOrEqual(385 * 385);
      expect(mesh!.indices.length).toBe((mesh!.columns - 1) * (mesh!.rows - 1) * 6);
    }
    expect(buildSurfaceMesh({ box, focus: { lat: 0, lon: 0 }, halfHeightDeg: Number.MAX_VALUE })).toBeNull();
  });
});
