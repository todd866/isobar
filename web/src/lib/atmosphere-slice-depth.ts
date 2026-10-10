import type { AtmosphereSlice } from './atmosphere-slice';
import { buildTerrainSliceMesh } from './atmosphere-slice';
import type { Camera, SurfaceProjection } from './lambert';

export const SLICE_DEPTH_WIDTH = 48;
export const SLICE_DEPTH_HEIGHT = 32;

export interface AtmosphereSliceDepthGrid {
  readonly width: number;
  readonly height: number;
  /** Rows are top-down, matching CSS/canvas screen coordinates. */
  readonly depth: Float32Array;
}

const cache = new WeakMap<SurfaceProjection, { key: string; grid: AtmosphereSliceDepthGrid }>();

function sliceKey(slice: AtmosphereSlice): string {
  return [slice.lat, slice.lon, slice.bearingRadians, slice.halfWidthM, slice.halfDepthM, slice.baseM].join(':');
}

function rasterizeTriangle(grid: AtmosphereSliceDepthGrid, a: [number, number, number], b: [number, number, number], c: [number, number, number]): void {
  if (![...a, ...b, ...c].every(Number.isFinite) || a[2] <= 0 || b[2] <= 0 || c[2] <= 0) return;
  const minX = Math.max(0, Math.ceil(((Math.min(a[0], b[0], c[0]) + 1) * grid.width - 1) / 2));
  const maxX = Math.min(grid.width - 1, Math.floor(((Math.max(a[0], b[0], c[0]) + 1) * grid.width - 1) / 2));
  const minY = Math.max(0, Math.ceil(((1 - Math.max(a[1], b[1], c[1])) * grid.height - 1) / 2));
  const maxY = Math.min(grid.height - 1, Math.floor(((1 - Math.min(a[1], b[1], c[1])) * grid.height - 1) / 2));
  if (minX > maxX || minY > maxY) return;
  const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(den) < 1e-12) return;
  for (let row = minY; row <= maxY; row += 1) for (let column = minX; column <= maxX; column += 1) {
    const x = -1 + 2 * (column + .5) / grid.width;
    const y = 1 - 2 * (row + .5) / grid.height;
    const wa = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den;
    const wb = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den;
    const wc = 1 - wa - wb;
    if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
    const reciprocal = wa / a[2] + wb / b[2] + wc / c[2];
    if (reciprocal <= 0 || !Number.isFinite(reciprocal)) continue;
    const depth = 1 / reciprocal;
    const index = row * grid.width + column;
    if (depth < grid.depth[index]) grid.depth[index] = depth;
  }
}

/** Rasterize the retained terrain slab; no unprojected outside-slice terrain participates. */
export function buildAtmosphereSliceDepthGrid(camera: Camera, slice: AtmosphereSlice): AtmosphereSliceDepthGrid {
  const grid: AtmosphereSliceDepthGrid = { width: SLICE_DEPTH_WIDTH, height: SLICE_DEPTH_HEIGHT, depth: new Float32Array(SLICE_DEPTH_WIDTH * SLICE_DEPTH_HEIGHT) };
  grid.depth.fill(Infinity);
  const surface = camera.surface;
  if (!surface) return grid;
  const mesh = buildTerrainSliceMesh(slice, SLICE_DEPTH_WIDTH, 8);
  const projected: ([number, number, number] | null)[] = [];
  for (let i = 0; i < mesh.vertices.length; i += 4) {
    const lon = mesh.vertices[i], lat = mesh.vertices[i + 1], bottom = mesh.vertices[i + 2];
    const point = surface.project(lat, lon, bottom ? slice.baseM : undefined);
    projected.push(point && point.visible ? [point.x, point.y, point.depth] : null);
  }
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const a = projected[mesh.indices[i]], b = projected[mesh.indices[i + 1]], c = projected[mesh.indices[i + 2]];
    if (a && b && c) rasterizeTriangle(grid, a, b, c);
  }
  return grid;
}

/** Return the slab depth at normalized clip coordinates. */
export function sampleAtmosphereSliceDepth(grid: AtmosphereSliceDepthGrid, x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -1 || x > 1 || y < -1 || y > 1) return Infinity;
  const column = Math.max(0, Math.min(grid.width - 1, Math.floor((x + 1) * grid.width / 2)));
  const row = Math.max(0, Math.min(grid.height - 1, Math.floor((1 - y) * grid.height / 2)));
  return grid.depth[row * grid.width + column];
}

/** Cache the bounded raster by surface object and slice contents. */
export function cachedAtmosphereSliceDepthGrid(camera: Camera, slice: AtmosphereSlice): AtmosphereSliceDepthGrid {
  const surface = camera.surface;
  if (!surface) return buildAtmosphereSliceDepthGrid(camera, slice);
  const key = sliceKey(slice);
  const prior = cache.get(surface);
  if (prior?.key === key) return prior.grid;
  const grid = buildAtmosphereSliceDepthGrid(camera, slice);
  cache.set(surface, { key, grid });
  return grid;
}
