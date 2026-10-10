import { describe, expect, it } from 'vitest';
import { cachedAtmosphereSliceDepthGrid, sampleAtmosphereSliceDepth, buildAtmosphereSliceDepthGrid } from '../../src/lib/atmosphere-slice-depth';
import type { AtmosphereSlice } from '../../src/lib/atmosphere-slice';
import type { Camera } from '../../src/lib/lambert';

const slice: AtmosphereSlice = { lat: 0, lon: 0, bearingRadians: 0, halfWidthM: 10_000, halfDepthM: 10_000, baseM: 100 };
function camera(surface: Camera['surface']): Camera {
  return { centerX: 0, centerY: 0, halfWidth: 1, halfHeight: 1, surface };
}

describe('atmosphere slice depth raster', () => {
  it('rasterizes the retained slab instead of an unrelated unprojected foreground hit', () => {
    const surface = {
      project(lat: number, lon: number, height = 0) {
        return { x: lon / 0.1, y: lat / 0.1, visible: true, depth: height ? 20 : 10 };
      },
      unproject() { return { lat: 70, lon: 70 }; },
    };
    const grid = buildAtmosphereSliceDepthGrid(camera(surface), slice);
    expect(sampleAtmosphereSliceDepth(grid, 0, 0)).toBeCloseTo(10, 5);
  });

  it('shares the cached raster for the same surface and slice content', () => {
    const surface = {
      project() { return { x: 0, y: 0, visible: true, depth: 10 }; },
      unproject() { return null; },
    };
    const view = camera(surface);
    const first = cachedAtmosphereSliceDepthGrid(view, slice);
    expect(first).toBe(cachedAtmosphereSliceDepthGrid(view, { ...slice }));
    const changed = cachedAtmosphereSliceDepthGrid(view, { ...slice, baseM: 101 });
    expect(changed).not.toBe(first);
  });
});
