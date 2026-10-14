import { mapProject, unproject, type Camera, type Lambert } from '../lambert';
import { atmosphereSliceKey, atmosphereSliceWeight, buildTerrainSliceMesh, sliceSegmentRange } from '../atmosphere-slice';
import { rasterizeTriangle, type AtmosphereSliceDepthGrid } from '../atmosphere-slice-depth';
import { terrainViewBounds, type TiltCamera } from '../tilt-camera';
import { surfaceMeshAxes, surfaceMeshSpacing } from './surface-mesh';

export interface ProjectedTerrainLinePoint { x: number; y: number; }
export type TerrainLineProjector = (lons: ArrayLike<number>, lats: ArrayLike<number>, closed: boolean) => Array<ProjectedTerrainLinePoint | null>;

const DEPTH_WIDTH = 128;
const DEPTH_HEIGHT = 96;
const DEPTH_TOLERANCE_M = 100;
/** Vertices per axis of the occluding surface; ~2 depth cells per quad. */
const GRID_AXIS = 72;
const LINE_LIFT_M = 8;
const MAX_LINE_SAMPLES = 20_000;
const LINE_SAMPLES_PER_VIEW = 600;
const LINE_SAMPLE_PX = 4;
type ElevationLookup = (lon: number, lat: number) => number | null;
type Bounds = { west: number; east: number; south: number; north: number };
const depthCache = new WeakMap<ElevationLookup, { key: string; grid: AtmosphereSliceDepthGrid | null }>();

function coarseAxis(values: readonly number[]): number[] {
  if (values.length <= GRID_AXIS) return [...values];
  const stride = Math.ceil((values.length - 1) / (GRID_AXIS - 1));
  const result: number[] = [];
  for (let i = 0; i < values.length; i += stride) result.push(values[i]);
  if (result.at(-1) !== values.at(-1)) result.push(values.at(-1)!);
  return result;
}

function metresBetween(lat0: number, lon0: number, lat1: number, lon1: number): number {
  const dLat = (lat1 - lat0) * Math.PI / 180;
  const dLon = ((((lon1 - lon0) + 540) % 360) - 180) * Math.PI / 180;
  const mean = (lat0 + lat1) * Math.PI / 360;
  return 6_371_000 * Math.hypot(dLat, Math.cos(mean) * dLon);
}

function interpolateLongitude(start: number, end: number, fraction: number): number {
  const delta = ((((end - start) + 540) % 360) - 180);
  return start + delta * fraction;
}

function gridDepth(grid: AtmosphereSliceDepthGrid, x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -1 || x > 1 || y < -1 || y > 1) return Infinity;
  const column = Math.max(0, Math.min(grid.width - 1, Math.floor((x + 1) * grid.width / 2)));
  const row = Math.max(0, Math.min(grid.height - 1, Math.floor((1 - y) * grid.height / 2)));
  let furthest = 0;
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
    const xx = Math.max(0, Math.min(grid.width - 1, column + dx));
    const yy = Math.max(0, Math.min(grid.height - 1, row + dy));
    furthest = Math.max(furthest, grid.depth[yy * grid.width + xx]);
  }
  return furthest;
}

function intersectBounds(a: Bounds, b: Bounds | null | undefined): Bounds {
  return b ? { west: Math.max(a.west, b.west), east: Math.min(a.east, b.east), south: Math.max(a.south, b.south), north: Math.min(a.north, b.north) } : a;
}

function buildDepthGrid(
  geo: Lambert,
  camera: Camera,
  tilt: TiltCamera,
  elevation: ElevationLookup,
  visible: Bounds | null | undefined,
): AtmosphereSliceDepthGrid | null {
  if (camera.slice) {
    const mesh = buildTerrainSliceMesh(camera.slice, DEPTH_WIDTH, 8);
    const grid: AtmosphereSliceDepthGrid = { width: DEPTH_WIDTH, height: DEPTH_HEIGHT, depth: new Float32Array(DEPTH_WIDTH * DEPTH_HEIGHT) };
    grid.depth.fill(Infinity);
    if (!camera.surface) return grid;
    const projected: ([number, number, number] | null)[] = [];
    for (let i = 0; i < mesh.vertices.length; i += 4) {
      const lon = mesh.vertices[i], lat = mesh.vertices[i + 1], bottom = mesh.vertices[i + 2];
      const height = elevation(lon, lat);
      if (height == null || !Number.isFinite(height)) { projected.push(null); continue; }
      const point = camera.surface.project(lat, lon, bottom ? camera.slice.baseM : height);
      projected.push(point && point.visible && Number.isFinite(point.depth) ? [point.x, point.y, point.depth] : null);
    }
    for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
      const a = projected[mesh.indices[i]], b = projected[mesh.indices[i + 1]], c = projected[mesh.indices[i + 2]];
      if (a && b && c) rasterizeTriangle(grid, a, b, c);
    }
    return grid;
  }
  // Only on-screen terrain can occlude an on-screen line, so the grid's
  // samples are spent on the visible footprint, not the 6x mesh margin.
  const terrainBounds = terrainViewBounds(tilt);
  const focus = unproject(geo, camera.centerX, camera.centerY);
  if (!terrainBounds || !focus) return null;
  const bounds = intersectBounds(terrainBounds, visible);
  if (!(bounds.east > bounds.west && bounds.north > bounds.south)) return null;
  focus.lat = Math.max(bounds.south, Math.min(bounds.north, focus.lat));
  focus.lon = Math.max(bounds.west, Math.min(bounds.east, focus.lon + Math.round(((bounds.west + bounds.east) / 2 - focus.lon) / 360) * 360));
  const mesh = surfaceMeshAxes({ box: bounds, focus, halfHeightDeg: tilt.halfHeightDeg });
  if (!mesh) return null;
  const lons = coarseAxis(mesh.lons), lats = coarseAxis(mesh.lats);
  const grid: AtmosphereSliceDepthGrid = { width: DEPTH_WIDTH, height: DEPTH_HEIGHT, depth: new Float32Array(DEPTH_WIDTH * DEPTH_HEIGHT) };
  grid.depth.fill(Infinity);
  const projected: ([number, number, number] | null)[] = [];
  for (const lat of lats) for (const lon of lons) {
    const height = elevation(lon, lat);
    if (height == null) { projected.push(null); continue; }
    const point = camera.surface?.project(lat, lon, height);
    projected.push(point && point.visible && Number.isFinite(point.depth) ? [point.x, point.y, point.depth] : null);
  }
  for (let y = 0; y + 1 < lats.length; y += 1) for (let x = 0; x + 1 < lons.length; x += 1) {
    const i = y * lons.length + x;
    const a = projected[i], b = projected[i + 1], c = projected[i + lons.length], d = projected[i + lons.length + 1];
    if (a && c && b) rasterizeTriangle(grid, a, c, b);
    if (b && c && d) rasterizeTriangle(grid, b, c, d);
  }
  return grid;
}

const RELIEF_SAMPLES = 24;
/** Relief below this share of the view's ground height cannot hide a line. */
const OCCLUDING_RELIEF = .02;
const reliefCache = new WeakMap<ElevationLookup, { key: string; relief: number }>();

/** Cheap gate: occlusion is only worth its per-frame cost where the visible
 * terrain has relief comparable to the view (mountains, not a coastal plain). */
export function terrainCanOcclude(camera: Camera, elevation: ElevationLookup, visible: Bounds | null | undefined, exaggeration = 1): boolean {
  const tilt = (camera as Camera & { tiltCamera?: TiltCamera }).tiltCamera;
  if (!tilt || !camera.surface || tilt.geometry.curvature <= .05) return false;
  const terrainBounds = terrainViewBounds(tilt);
  if (!terrainBounds) return false;
  const bounds = intersectBounds(terrainBounds, visible);
  if (!(bounds.east > bounds.west && bounds.north > bounds.south)) return false;
  // Quantised so a drag does not resample every frame.
  const q = Math.max(1e-4, (bounds.north - bounds.south) / 16);
  const key = [bounds.west, bounds.east, bounds.south, bounds.north].map(v => Math.round(v / q)).join(':') + ':' + q.toPrecision(3);
  let relief = reliefCache.get(elevation)?.key === key ? reliefCache.get(elevation)!.relief : NaN;
  if (!Number.isFinite(relief)) {
    let low = Infinity, high = -Infinity;
    for (let y = 0; y < RELIEF_SAMPLES; y += 1) for (let x = 0; x < RELIEF_SAMPLES; x += 1) {
      const h = elevation(bounds.west + (x + .5) / RELIEF_SAMPLES * (bounds.east - bounds.west), bounds.south + (y + .5) / RELIEF_SAMPLES * (bounds.north - bounds.south));
      if (h == null || !Number.isFinite(h)) continue;
      low = Math.min(low, h); high = Math.max(high, h);
    }
    relief = high > low ? high - low : 0;
    reliefCache.set(elevation, { key, relief });
  }
  return relief * exaggeration >= OCCLUDING_RELIEF * tilt.halfHeightDeg * 2 * 111_320;
}

/** Project an overlay line while breaking it at missing or terrain-occluded samples. */
export function createTerrainLineProjector(
  geo: Lambert,
  camera: Camera,
  elevation: ElevationLookup,
  width: number,
  height: number,
  /** Geographic footprint actually on screen; lines outside it are not sampled. */
  visible?: { west: number; east: number; south: number; north: number } | null,
): TerrainLineProjector {
  const tilt = (camera as Camera & { tiltCamera?: TiltCamera }).tiltCamera;
  let grid: AtmosphereSliceDepthGrid | null = null;
  if (camera.surface && tilt && tilt.geometry.curvature > .05) {
    const key = [tilt.lat, tilt.lon, tilt.halfHeightDeg, tilt.aspect, tilt.tiltRadians, tilt.bearingRadians ?? 0, tilt.targetElevationM ?? 0, camera.slice ? atmosphereSliceKey(camera.slice) : '',
      visible ? [visible.west, visible.east, visible.south, visible.north].join(',') : ''].join(':');
    const prior = depthCache.get(elevation);
    if (prior?.key === key) grid = prior.grid;
    else {
      grid = buildDepthGrid(geo, camera, tilt, elevation, visible);
      depthCache.set(elevation, { key, grid });
    }
  }
  // Sample lines at about the depth grid's resolution, never finer than the
  // mesh: occlusion cannot resolve more, and a regional coast at mesh spacing
  // exhausts the sample budget on every frame of a drag.
  const spacing = tilt ? Math.max(surfaceMeshSpacing(tilt.halfHeightDeg), tilt.halfHeightDeg * 111_320 * 2 / LINE_SAMPLES_PER_VIEW) : 80;
  return (lons, lats, closed) => {
    const count = Math.min(lons.length, lats.length);
    if (count === 0) return [];
    if (!grid || !camera.surface || !tilt || tilt.geometry.curvature <= .05) {
      return Array.from({ length: count }, (_, i) => mapProject(geo, camera, lats[i], lons[i]));
    }
    const terrainBounds = terrainViewBounds(tilt);
    if (!terrainBounds) return [];
    const bounds = intersectBounds(terrainBounds, visible);
    if (!(bounds.east > bounds.west && bounds.north > bounds.south)) return [];
    const segmentCount = closed ? count : count - 1;
    const result: Array<ProjectedTerrainLinePoint | null> = [];
    const sample = (lat: number, lon: number) => {
      const height = elevation(lon, lat);
      if (height == null) return null;
      const point = camera.surface!.project(lat, lon, height + LINE_LIFT_M);
      if (!point.visible || !Number.isFinite(point.x + point.y + point.depth)) return null;
      if (camera.slice && atmosphereSliceWeight(camera.slice, lat, lon) <= 0) return null;
      const terrainDepth = gridDepth(grid, point.x, point.y);
      return Number.isFinite(terrainDepth) && point.depth > terrainDepth + DEPTH_TOLERANCE_M ? null : { x: point.x, y: point.y };
    };
    let joined = false;
    for (let i = 0; i < segmentCount; i += 1) {
      const j = (i + 1) % count;
      const lon0 = lons[i] + Math.round((tilt.lon - lons[i]) / 360) * 360;
      const lon1 = interpolateLongitude(lon0, lons[j], 1);
      const dx = lon1 - lon0, dy = lats[j] - lats[i];
      // Clip before subdividing: a continent-long ring must not consume the
      // local mesh-spacing budget or join across an omitted section.
      // Most of a continental ring lies outside the view: reject it with plain
      // comparisons before any clipping arithmetic or allocation.
      if ((lon0 < bounds.west && lon1 < bounds.west) || (lon0 > bounds.east && lon1 > bounds.east)
        || (lats[i] < bounds.south && lats[j] < bounds.south) || (lats[i] > bounds.north && lats[j] > bounds.north)) {
        if (result.length && result[result.length - 1] !== null) result.push(null);
        joined = false;
        continue;
      }
      let enter = 0, leave = 1;
      const clip = (p: number, q: number) => {
        if (p === 0) { if (q < 0) leave = -1; return; }
        const t = q / p;
        if (p < 0) enter = Math.max(enter, t); else leave = Math.min(leave, t);
      };
      clip(-dx, lon0 - bounds.west); clip(dx, bounds.east - lon0); clip(-dy, lats[i] - bounds.south); clip(dy, bounds.north - lats[i]);
      const sliceRange = sliceSegmentRange(camera.slice, { lat: lats[i], lon: lon0 }, { lat: lats[j], lon: lon1 });
      if (!sliceRange) { if (result.at(-1) !== null) result.push(null); joined = false; continue; }
      enter = Math.max(enter, sliceRange[0]);
      leave = Math.min(leave, sliceRange[1]);
      if (leave < enter) { if (result.at(-1) !== null) result.push(null); joined = false; continue; }
      if (enter > 0 && result.at(-1) !== null) result.push(null);
      const length = metresBetween(lats[i] + dy * enter, lon0 + dx * enter, lats[i] + dy * leave, lon0 + dx * leave);
      let steps = Math.max(1, Math.ceil(length / spacing));
      // Perspective: a far segment spans few pixels. Subdivide to the screen's
      // resolution (the depth grid cannot resolve finer), never past the metric limit.
      if (steps > 1) {
        const a = camera.surface.project(lats[i] + dy * enter, lon0 + dx * enter, 0), b = camera.surface.project(lats[i] + dy * leave, lon0 + dx * leave, 0);
        if (a.visible && b.visible && Number.isFinite(a.x + a.y + b.x + b.y)) {
          const pixels = Math.hypot((b.x - a.x) * width / 2, (b.y - a.y) * height / 2);
          steps = Math.max(1, Math.min(steps, Math.ceil(pixels / LINE_SAMPLE_PX)));
        }
      }
      // The previous segment already sampled this shared vertex.
      for (let step = joined && enter === 0 ? 1 : 0; step <= steps; step += 1) {
        if (result.length >= MAX_LINE_SAMPLES - 1) { result.push(null); return result; }
        const t = enter + (leave - enter) * step / steps;
        result.push(sample(lats[i] + dy * t, lon0 + dx * t));
      }
      joined = leave === 1;
      if (leave < 1) result.push(null);
    }
    return result;
  };
}
