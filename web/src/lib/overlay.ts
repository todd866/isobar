import { visibleTerrainBounds, type TiltCamera } from './tilt-camera';
import { mapProject, mapUnproject } from './lambert';
import { project, unproject, type Camera, type Lambert } from './lambert';
import { INK } from './field-color';
import { graticuleStep, graticuleText } from './graticule';
import type { Borders } from './borders';
import type { Coast } from './coast';
import { formatIsobar, type UnitSpec } from './units';
import type { Polyline, PressureCentre } from './contour';
import { HIGH_TERRAIN_ALPHA, isobarOpacity, latitudeSpan, segmentMidLongitude, selectPressureCentres, terrainIsobarStyle, type ElevationAt } from './map-generalise';
import { viewGeoBox } from './terrain/terrain-layer';
import { lakesInView, riversInView, riverWidth, type Water } from './water';

/** The data grid's geographic box. Isobars fade out inside its edge. */
export interface GridBox {
  west: number;
  east: number;
  north: number;
  south: number;
}

/** Degrees over which isobars fade out at the edge of the data grid. The map camera keeps this band off screen. */
export const EDGE_FADE_DEG = 0.5;

/** Distance in degrees from a point to the nearest edge of the grid (negative outside). */
export function gridEdgeDistance(grid: GridBox, lon: number, lat: number): number {
  return Math.min(lon - grid.west, grid.east - lon, lat - grid.south, grid.north - lat);
}

const terrainCache = new WeakMap<ElevationAt, WeakMap<Polyline, boolean[]>>();
const unknownTerrain: ElevationAt = () => null;

/** Sample only projected vertices; new terrain mosaics must not resample global contours. */
export function terrainFlags(line: Polyline, points: (Point | null)[], elevationAt?: ElevationAt): boolean[] {
  const sampler = elevationAt ?? unknownTerrain;
  let lines = terrainCache.get(sampler);
  if (!lines) { lines = new WeakMap(); terrainCache.set(sampler, lines); }
  let high = lines.get(line);
  if (!high) { high = new Array<boolean>(line.lon.length); lines.set(line, high); }
  for (let i = 0; i < points.length; i += 1) {
    if (!points[i] || high[i] !== undefined) continue;
    const next = !line.closed && i === line.lon.length - 1 ? i : (i + 1) % line.lon.length;
    high[i] = !!elevationAt && (terrainIsobarStyle(elevationAt(line.lon[i], line.lat[i])).dashed
      || terrainIsobarStyle(elevationAt(line.lon[next], line.lat[next])).dashed
      || terrainIsobarStyle(elevationAt(segmentMidLongitude(line.lon[i], line.lon[next]), (line.lat[i] + line.lat[next]) / 2)).dashed);
  }
  return high;
}

let fadeCanvas: HTMLCanvasElement | null = null;
let maskCache: { key: string; canvas: HTMLCanvasElement } | null = null;

/** Chart inks. Day: the Bureau's black on pale plate. Night: cream on deep blue. */
export interface ChartInk {
  line: string;
  coast: string;
  halo: string | null;
  plateSea: string;
  plateLand: string;
}

export const DAY_INK: ChartInk = { line: '#496577', coast: '#688391', halo: 'rgba(247, 250, 248, 0.9)', plateSea: '#e9eff4', plateLand: '#f1ecbb' };
export const NIGHT_INK: ChartInk = { line: '#bed0d7', coast: '#7494a2', halo: 'rgba(19, 34, 44, 0.9)', plateSea: '#232f3e', plateLand: '#665839' };

function layerCanvas(width: number, height: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!fadeCanvas) fadeCanvas = document.createElement('canvas');
  if (fadeCanvas.width !== width) fadeCanvas.width = width;
  if (fadeCanvas.height !== height) fadeCanvas.height = height;
  const ctx = fadeCanvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

/**
 * Keeps what is already drawn on `ctx` only inside the grid, with a linear
 * fade over EDGE_FADE_DEG. Nested inset boxes add their alpha ('lighter'),
 * so the mask needs no blur filter and works in every browser.
 */
function maskToGrid(
  ctx: CanvasRenderingContext2D,
  grid: GridBox,
  screen: (lon: number, lat: number) => Point | null,
) {
  const steps = 10;
  const t = ctx.getTransform();
  const probe = screen(grid.west, grid.north);
  const key = `${ctx.canvas.width}x${ctx.canvas.height}:${t.a}:${probe?.x.toFixed(2)}:${probe?.y.toFixed(2)}:${screen(grid.east, grid.south)?.x.toFixed(2)}`;
  if (maskCache && maskCache.key === key) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskCache.canvas, 0, 0);
    ctx.restore();
    return;
  }
  const mask = maskCache?.canvas ?? document.createElement('canvas');
  mask.width = ctx.canvas.width;
  mask.height = ctx.canvas.height;
  maskCache = { key, canvas: mask };
  const m = mask.getContext('2d');
  if (!m) return;
  m.setTransform(ctx.getTransform());
  m.globalCompositeOperation = 'lighter';
  m.fillStyle = `rgba(0,0,0,${1 / steps})`;
  for (let k = 0; k < steps; k += 1) {
    const inset = (EDGE_FADE_DEG * (k + 0.5)) / steps;
    const west = grid.west + inset;
    const east = grid.east - inset;
    const north = grid.north - inset;
    const south = grid.south + inset;
    if (!(east > west) || !(north > south)) break;
    m.beginPath();
    const ring: [number, number][] = [];
    for (let lon = west; lon < east; lon += 0.5) ring.push([lon, north]);
    for (let lat = north; lat > south; lat -= 0.5) ring.push([east, lat]);
    for (let lon = east; lon > west; lon -= 0.5) ring.push([lon, south]);
    for (let lat = south; lat < north; lat += 0.5) ring.push([west, lat]);
    let started = false;
    for (const [lon, lat] of ring) {
      const point = screen(lon, lat);
      if (!point) continue;
      if (!started) m.moveTo(point.x, point.y);
      else m.lineTo(point.x, point.y);
      started = true;
    }
    m.closePath();
    m.fill();
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
}

export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A placed map label. `x/y/w/h` are CSS pixels of the overlay. */
export interface DrawnLabel extends LabelBox {
  text: string;
}

/** Preserve source indices and the two-neighbour reach of the soften passes.
 * Deep offscreen runs become gaps, so fairing never allocates their subdivisions.
 * The 128px margin keeps these gaps clear of visible contour geometry. */
export function pruneOffscreenVertices(points: (Point | null)[], closed: boolean, width: number, height: number): (Point | null)[] {
  const n = points.length;
  if (n < 3) return points;
  const masks = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = points[i];
    if (p) masks[i] = (p.x < -128 ? 1 : 0) | (p.x > width + 128 ? 2 : 0)
      | (p.y < -128 ? 4 : 0) | (p.y > height + 128 ? 8 : 0);
  }
  const out = points.slice();
  for (let i = closed ? 0 : 2; i < (closed ? n : n - 2); i += 1) {
    if (masks[i] & masks[(i - 2 + n) % n] & masks[(i - 1 + n) % n]
      & masks[(i + 1) % n] & masks[(i + 2) % n]) out[i] = null;
  }
  return out;
}

/** One screen-space pass that takes the staircase out of a 0.5° contour without crossing a break. */
function soften(points: (Point | null)[], closed: boolean): (Point | null)[] {
  const n = points.length;
  if (n < 3) return points;
  // Points are immutable here; only softened vertices need new objects.
  const out = points.slice();
  for (let i = 0; i < n; i += 1) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const a = points[(i - 1 + n) % n];
    const b = points[i];
    const c = points[(i + 1) % n];
    if (!a || !b || !c) continue;
    if (Math.hypot(b.x - a.x, b.y - a.y) > 40 || Math.hypot(c.x - b.x, c.y - b.y) > 40) continue;
    out[i] = { x: a.x * 0.22 + b.x * 0.56 + c.x * 0.22, y: a.y * 0.22 + b.y * 0.56 + c.y * 0.22 };
  }
  return out;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Screen-space corner cutting on an isobar. `soften` only moves segments
 * shorter than 40px, so a close view (a 0.25° cell is hundreds of pixels)
 * stays a staircase. Chaikin cuts stay inside each segment, so the line does
 * not bulge past the marched contour.
 */
export function fairChain(points: (Point | null)[], closed: boolean): (Point | null)[] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (const point of points) {
    if (!point) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(point);
  }
  if (run.length) runs.push(run);
  if (!runs.length) return points;
  const out: (Point | null)[] = [];
  for (const segment of runs) {
    if (out.length) out.push(null);
    const ends = segment.length > 2
      ? Math.hypot(segment[0].x - segment[segment.length - 1].x, segment[0].y - segment[segment.length - 1].y)
      : Infinity;
    out.push(...fairRun(segment, closed && runs.length === 1 && ends > 1.5));
  }
  return out;
}

function chaikin(points: Point[], closed: boolean): Point[] {
  const n = points.length;
  const out: Point[] = [];
  const emit = (point: Point) => {
    const last = out[out.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) out.push(point);
  };
  if (!closed) emit(points[0]);
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % n];
    emit({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
    emit({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
  }
  if (!closed) emit(points[n - 1]);
  return out;
}

function fairRun(points: Point[], closed: boolean): Point[] {
  if (points.length < 3) return points.slice();
  let current = points;
  for (let pass = 0; pass < 4; pass += 1) {
    const n = current.length;
    const count = closed ? n : n - 1;
    let longest = 0;
    for (let i = 0; i < count; i += 1) {
      const a = current[i];
      const b = current[(i + 1) % n];
      longest = Math.max(longest, Math.hypot(b.x - a.x, b.y - a.y));
    }
    if (longest < 18 || longest > 2400) break;
    current = chaikin(current, closed);
  }
  return current;
}

function toScreen(
  lambert: Lambert,
  camera: Camera,
  width: number,
  height: number,
  lon: number,
  lat: number,
): Point | null {
  if (camera.surface) {
    const p = mapProject(lambert, camera, lat, lon);
    return p && { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 };
  }
  const projected = project(lambert, lat, lon);
  if (!projected) return null;
  // Keep vector overlays on the repeated world copy nearest the camera. The
  // field renderer wraps at the dateline, so overlays must follow the same
  // world copy while panning across it.
  if (lambert.projection === 'equirectangular') {
    const worldWidth = 360 * lambert.F;
    projected.x += Math.round((camera.centerX - projected.x) / worldWidth) * worldWidth;
  }
  const clipX = (projected.x - camera.centerX) / camera.halfWidth;
  const clipY = (projected.y - camera.centerY) / camera.halfHeight;
  return { x: (clipX + 1) * 0.5 * width, y: (1 - clipY) * 0.5 * height };
}

/** A surface can still be nearly flat (including rotated overhead). Its
 * longitude wrap is discontinuous even though it has no flat world period.
 * Keep source indices for terrain flags and break only the crossing edge. */
function breakSurfaceSeams(points: (Point | null)[], lon: ArrayLike<number>, geo: Lambert, camera: Camera, closed: boolean): void {
  if (!camera.surface || geo.projection !== 'equirectangular') return;
  const centre=geo.lon0+camera.centerX/geo.F;
  const relative=(value:number)=>((value-centre+180)%360+360)%360-180;
  const broken:number[]=[];
  for(let i=closed?0:1;i<lon.length;i++) {
    const previous=(i+lon.length-1)%lon.length;
    if(points[i]&&points[previous]&&Math.abs(relative(lon[i])-relative(lon[previous]))>180) broken.push(i);
  }
  for(const i of broken)points[i]=null;
}

/** Project a continuous geographic path and repeat only the world copies that
 * intersect this viewport. Wrapping each vertex independently creates a chord
 * through the whole map whenever the camera crosses a coastline or isobar. */
export function projectedPaths(
  geo: Lambert, camera: Camera, width: number, height: number,
  lon: ArrayLike<number>, lat: ArrayLike<number>, closed: boolean,
): { points: (Point | null)[]; closed: boolean }[] {
  const period = !camera.surface && geo.projection === 'equirectangular' ? 360 * geo.F / (2 * camera.halfWidth) * width : 0;
  const points: (Point | null)[] = [];
  let previous: Point | null = null;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < lon.length; i++) {
    const point = toScreen(geo, camera, width, height, lon[i], lat[i]);
    if (!point) { points.push(null); previous = null; continue; }
    if (previous && period) point.x += Math.round((previous.x - point.x) / period) * period;
    points.push(point); previous = point;
    min = Math.min(min, point.x); max = Math.max(max, point.x);
  }
  breakSurfaceSeams(points,lon,geo,camera,closed);
  if (!period || !Number.isFinite(min)) return [{ points, closed }];
  const first = points.find((p) => p !== null);
  let last: Point | undefined;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const point = points[i];
    if (point) { last = point; break; }
  }
  const close = closed && !!first && !!last && Math.abs(last.x - first.x) < period / 2;
  const copies = [];
  // The camera never exceeds one world width; a path can need at most three
  // neighbouring copies, including one touching either viewport edge.
  const lo = Math.ceil(-max / period), hi = Math.floor((width - min) / period);
  for (let shift = lo; shift <= hi && shift < lo + 3; shift++) {
    copies.push({
      // The unshifted copy is already in the correct coordinate space.
      points: shift === 0 ? points : points.map((p) => p && ({ x: p.x + shift * period, y: p.y })),
      closed: close,
    });
  }
  return copies;
}

/** Immutable geographic chunks keep regional strokes from projecting whole continents. */
export const STROKE_CHUNK_VERTICES = 64;
interface StrokeRingCache {
  lat: ArrayLike<number>;
  closed: boolean;
  unwrapLon: Float64Array;
  west: number; east: number;
  chunks: { start: number; end: number; west: number; east: number; south: number; north: number }[];
}
const strokeRingCache = new WeakMap<object, StrokeRingCache>();
const surfaceBoundsCache = new WeakMap<object, { width: number; height: number; padding: number; bounds: { west: number; east: number; south: number; north: number } | null }>();
function strokeRingCacheEntry(lon: ArrayLike<number>, lat: ArrayLike<number>, closed: boolean): StrokeRingCache | null {
  const cached = strokeRingCache.get(lon as object);
  if (cached?.lat === lat && cached.closed === closed) return cached;
  const n = lon.length, unwrapLon = new Float64Array(n);
  let west = Infinity, east = -Infinity;
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(lon[i]) || !Number.isFinite(lat[i]) || Math.abs(lat[i]) > 90) return null;
    let value = lon[i];
    if (i) value += Math.round((unwrapLon[i - 1] - value) / 360) * 360;
    unwrapLon[i] = value;
    west = Math.min(west, value); east = Math.max(east, value);
  }
  const chunks: StrokeRingCache['chunks'] = [];
  for (let start = 0; start < n; start += STROKE_CHUNK_VERTICES) {
    const end = Math.min(start + STROKE_CHUNK_VERTICES, n);
    const box = { start, end, west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
    // Include joining segments in the bounds, even if neither chunk has an
    // interior vertex inside the viewport. Closed rings also include their
    // wraparound neighbour; open paths stop at their actual endpoints.
    for (let k = start - 1; k <= end; k += 1) {
      if (!closed && (k < 0 || k >= n)) continue;
      const i = (k + n) % n;
      box.west = Math.min(box.west, unwrapLon[i]); box.east = Math.max(box.east, unwrapLon[i]);
      box.south = Math.min(box.south, lat[i]); box.north = Math.max(box.north, lat[i]);
    }
    chunks.push(box);
  }
  const entry = { lat, closed, unwrapLon, west, east, chunks };
  strokeRingCache.set(lon as object, entry);
  return entry;
}

/** A surface camera can expose a curved, clipped footprint. Sample its whole
 * viewport boundary; any horizon/pole/longitude ambiguity keeps the safe
 * all-world projection. The returned box is deliberately only a broad reject
 * test, so crossing chunks and source indices remain intact. */
function computeSurfaceStrokeBounds(camera: Camera, width: number, height: number, padding: number): { west: number; east: number; south: number; north: number } | null {
  if (!camera.surface || width <= 0 || height <= 0) return null;
  const tilt=(camera as Camera & {tiltCamera?:TiltCamera}).tiltCamera;
  const fallback=()=>tilt?visibleTerrainBounds(tilt):null;
  const samples: { lat: number; lon: number }[] = [];
  const steps = 32;
  const boundary: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) boundary.push([(i / steps) * 2 - 1, -1]);
  for (let i = 1; i <= steps; i += 1) boundary.push([1, (i / steps) * 2 - 1]);
  for (let i = steps - 1; i >= 0; i -= 1) boundary.push([(i / steps) * 2 - 1, 1]);
  for (let i = steps - 1; i > 0; i -= 1) boundary.push([-1, (i / steps) * 2 - 1]);
  for (const [x, y] of boundary) {
    const point = camera.surface.unproject(x, y);
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) >= 88.5) return fallback();
    samples.push(point);
  }
  if (!samples.length) return null;
  const unwrapped: number[] = [samples[0].lon];
  for (let i = 1; i < samples.length; i += 1) {
    let lon = samples[i].lon;
    lon += Math.round((unwrapped[i - 1] - lon) / 360) * 360;
    unwrapped.push(lon);
  }
  const west = Math.min(...unwrapped), east = Math.max(...unwrapped);
  if (!(east >= west) || east - west >= 180) return fallback();
  const south = Math.min(...samples.map((point) => point.lat));
  const north = Math.max(...samples.map((point) => point.lat));
  const padLon = Math.max(0.25, 2 * padding * camera.halfWidth / width);
  const padLat = Math.max(0.25, 2 * padding * camera.halfHeight / height);
  return { west: west - padLon, east: east + padLon, south: Math.max(-90, south - padLat), north: Math.min(90, north + padLat) };
}

function surfaceStrokeBounds(camera: Camera, width: number, height: number, padding: number): { west: number; east: number; south: number; north: number } | null {
  const surface = camera.surface;
  if (!surface) return null;
  const cached = surfaceBoundsCache.get(surface as object);
  if (cached && cached.width === width && cached.height === height && cached.padding === padding) return cached.bounds;
  const bounds = computeSurfaceStrokeBounds(camera, width, height, padding);
  surfaceBoundsCache.set(surface as object, { width, height, padding, bounds });
  return bounds;
}

/** Project only intersecting coast/border chunks; preserve every source index.
 * Invalid coordinates and non-flat projections retain the general path. */
export function projectedStrokePaths(geo: Lambert, camera: Camera, width: number, height: number,
  lon: ArrayLike<number>, lat: ArrayLike<number>, closed: boolean, padding = 4): { points: (Point | null)[]; closed: boolean }[] {
  if (geo.projection !== 'equirectangular' || !geo.valid || !lon.length || width <= 0 || height <= 0)
    return projectedPaths(geo, camera, width, height, lon, lat, closed);
  const cache = strokeRingCacheEntry(lon, lat, closed);
  if (!cache) return projectedPaths(geo, camera, width, height, lon, lat, closed);
  const surfaceBounds = camera.surface ? surfaceStrokeBounds(camera, width, height, padding) : null;
  if (camera.surface && !surfaceBounds) return projectedPaths(geo, camera, width, height, lon, lat, closed);
  const centre = geo.lon0 + camera.centerX / geo.F;
  const halfLon = camera.halfWidth / geo.F;
  const flatPadLon = 2 * padding * halfLon / width, flatPadLat = 2 * padding * camera.halfHeight / height;
  const west = surfaceBounds?.west ?? centre - halfLon - flatPadLon;
  const east = surfaceBounds?.east ?? centre + halfLon + flatPadLon;
  const south = surfaceBounds?.south ?? camera.centerY - camera.halfHeight - flatPadLat;
  const north = surfaceBounds?.north ?? camera.centerY + camera.halfHeight + flatPadLat;
  const lo = Math.ceil((west - cache.east) / 360), hi = Math.floor((east - cache.west) / 360);
  const copies: { points: (Point | null)[]; closed: boolean }[] = [];
  for (let copy = lo; copy <= hi && copy < lo + 3; copy += 1) {
    const shift = copy * 360;
    let first=0;
    while(first<cache.chunks.length){
      const c=cache.chunks[first];
      if(!(c.east+shift<west||c.west+shift>east||c.north<south||c.south>north))break;
      first++;
    }
    if(first===cache.chunks.length)continue;
    const points: (Point | null)[] = new Array(lon.length).fill(null);
    let visible = false;
    for (let c=first;c<cache.chunks.length;c++) {
      const chunk=cache.chunks[c];
      if(chunk.east+shift<west||chunk.west+shift>east||chunk.north<south||chunk.south>north)continue;
      visible = true;
      for (let k = chunk.start - 1; k <= chunk.end; k += 1) {
        if (!closed && (k < 0 || k >= lon.length)) continue;
        const i = (k + lon.length) % lon.length;
        const projected = camera.surface
          ? toScreen(geo, camera, width, height, cache.unwrapLon[i] + shift, lat[i])
          : { x: ((cache.unwrapLon[i] + shift - centre) / halfLon + 1) * width / 2,
            y: (1 - (lat[i] - camera.centerY) / camera.halfHeight) * height / 2 };
        if (projected) points[i] = projected;
      }
    }
    breakSurfaceSeams(points,lon,geo,camera,closed);
    if (visible) copies.push({ points, closed: closed && Math.abs(cache.unwrapLon[lon.length - 1] - cache.unwrapLon[0]) < 180 });
  }
  return copies;
}
/** Inspect immutable cache identity in regression tests. */
export function strokeRingStaticCacheForTest(lon: ArrayLike<number>): StrokeRingCache | undefined {
  return strokeRingCache.get(lon as object);
}

const ringBoxes = new WeakMap<object, { west: number; east: number; south: number; north: number }>();

/** Whether a coast ring or isobar can touch an equirectangular view (any world copy). Rings are culled by box,
 * so a regional view projects its own coasts, not the whole world's, on every pan. */
function ringInView(lambert: Lambert, camera: Camera, ring: { lon: ArrayLike<number>; lat: ArrayLike<number> }): boolean {
  if (camera.surface || lambert.projection !== 'equirectangular') return true;
  let box = ringBoxes.get(ring);
  if (!box) {
    box = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
    for (let i = 0; i < ring.lon.length; i += 1) {
      box.west = Math.min(box.west, ring.lon[i]);
      box.east = Math.max(box.east, ring.lon[i]);
      box.south = Math.min(box.south, ring.lat[i]);
      box.north = Math.max(box.north, ring.lat[i]);
    }
    ringBoxes.set(ring, box);
  }
  if (box.north < camera.centerY - camera.halfHeight || box.south > camera.centerY + camera.halfHeight) return false;
  const halfLon = camera.halfWidth / lambert.F;
  if (halfLon >= 180 || box.east - box.west >= 180) return true;
  const centre = lambert.lon0 + camera.centerX / lambert.F;
  for (const shift of [-360, 0, 360]) {
    if (box.east + shift >= centre - halfLon && box.west + shift <= centre + halfLon) return true;
  }
  return false;
}

function strokeChain(
  ctx: CanvasRenderingContext2D,
  points: (Point | null)[],
  closed: boolean,
  gaps: LabelBox[],
  width: number,
  height: number,
  terrain?: { high: boolean[]; dashed: boolean },
) {
  if (points.length < 2) return;
  const blocked = (point: Point) => gaps.some((box) => (
    point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h
  ));
  let drawing = false, hasInk = false;
  const pad = 4;
  const end = closed ? points.length : points.length - 1;
  ctx.beginPath();
  for (let i = 0; i < end; i += 1) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (terrain && terrain.high[i] !== terrain.dashed) { drawing = false; continue; }
    if (!a || !b || blocked(a) || blocked(b)) { drawing = false; continue; }
    // Both endpoints beyond one edge cannot contribute a visible pixel.
    // Keep crossing segments so paths entering the viewport remain continuous.
    if ((a.x < -pad && b.x < -pad) || (a.x > width + pad && b.x > width + pad)
      || (a.y < -pad && b.y < -pad) || (a.y > height + pad && b.y > height + pad)) {
      drawing = false;
      continue;
    }
    if (!drawing) { ctx.moveTo(a.x, a.y); drawing = true; }
    ctx.lineTo(b.x, b.y); hasInk = true;
  }
  if (hasInk) ctx.stroke();
}

function viewSpans(lambert: Lambert, camera: Camera): { lon: number; lat: number } | null {
  if (lambert.projection === 'equirectangular') {
    const lon = Math.abs((camera.halfWidth * 2) / lambert.F);
    const lat = Math.abs(camera.halfHeight * 2);
    return lon > 0 && lat > 0 ? { lon, lat } : null;
  }
  const corners: [number, number][] = [
    [camera.centerX - camera.halfWidth, camera.centerY - camera.halfHeight],
    [camera.centerX + camera.halfWidth, camera.centerY - camera.halfHeight],
    [camera.centerX - camera.halfWidth, camera.centerY + camera.halfHeight],
    [camera.centerX + camera.halfWidth, camera.centerY + camera.halfHeight],
  ];
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [x, y] of corners) {
    const geo = unproject(lambert, x, y);
    if (!geo) return null;
    west = Math.min(west, geo.lon);
    east = Math.max(east, geo.lon);
    south = Math.min(south, geo.lat);
    north = Math.max(north, geo.lat);
  }
  if (!(east > west) || !(north > south)) return null;
  return { lon: east - west, lat: north - south };
}

/** Thin lat/long lines and edge labels. Drawn before isobars so the lines sit underneath. */
function drawGraticule(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  lambert: Lambert,
  camera: Camera,
  inkSet: ChartInk,
): DrawnLabel[] {
  // Flat-map edge labels do not describe a curved horizon.
  if (camera.surface) return [];
  const spans = viewSpans(lambert, camera);
  const centre = unproject(lambert, camera.centerX, camera.centerY);
  if (!spans || !centre) return [];
  const step = graticuleStep(Math.min(spans.lon, spans.lat));
  const lat0 = Math.max(-80, centre.lat - spans.lat / 2 - step);
  const lat1 = Math.min(84, centre.lat + spans.lat / 2 + step);
  const lon0 = centre.lon - spans.lon / 2 - step;
  const lon1 = centre.lon + spans.lon / 2 + step;
  const latStart = Math.ceil((lat0 - 1e-9) / step);
  const latEnd = Math.floor((lat1 + 1e-9) / step);
  const lonStart = Math.ceil((lon0 - 1e-9) / step);
  const lonEnd = Math.floor((lon1 + 1e-9) / step);
  if (latEnd - latStart > 120 || lonEnd - lonStart > 120) return [];
  const samples = Math.max(8, Math.ceil(Math.max(spans.lon, spans.lat) / step) + 2);
  const labels: DrawnLabel[] = [];
  const hits = (box: LabelBox) => labels.some((other) => !(
    box.x + box.w < other.x || other.x + other.w < box.x || box.y + box.h < other.y || other.y + other.h < box.y
  ));
  ctx.save();
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = inkSet.line;
  ctx.fillStyle = inkSet.line;
  ctx.font = '500 10px ui-sans-serif, system-ui, sans-serif';
  ctx.globalAlpha = 0.4;
  const strokeGeo = (lons: number[], lats: number[]) => {
    ctx.beginPath();
    for (const path of projectedPaths(lambert, camera, width, height, lons, lats, false)) {
      let started = false;
      for (const point of path.points) {
        if (!point) { started = false; continue; }
        if (!started) { ctx.moveTo(point.x, point.y); started = true; }
        else ctx.lineTo(point.x, point.y);
      }
    }
    ctx.stroke();
  };
  for (let i = latStart; i <= latEnd; i += 1) {
    const lat = i * step;
    const lats = Array.from({ length: samples }, () => lat);
    const lons = Array.from({ length: samples }, (_, k) => lon0 + ((lon1 - lon0) * k) / (samples - 1));
    strokeGeo(lons, lats);
    const at = toScreen(lambert, camera, width, height, centre.lon, lat);
    if (!at || at.y < 14 || at.y > height - 46) continue;
    const text = graticuleText(lat, 'lat');
    const w = ctx.measureText(text).width;
    const box = { x: 4, y: at.y - 7, w: w + 8, h: 14 };
    if (hits(box)) continue;
    ctx.globalAlpha = 0.85;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 6, at.y);
    ctx.globalAlpha = 0.4;
    labels.push({ ...box, text });
  }
  for (let i = lonStart; i <= lonEnd; i += 1) {
    const lon = i * step;
    const lons = Array.from({ length: samples }, () => lon);
    const lats = Array.from({ length: samples }, (_, k) => lat0 + ((lat1 - lat0) * k) / (samples - 1));
    strokeGeo(lons, lats);
    const at = toScreen(lambert, camera, width, height, lon, centre.lat);
    if (!at || at.x < 52 || at.x > width - 72) continue;
    const text = graticuleText(lon, 'lon');
    const w = ctx.measureText(text).width;
    const box = { x: at.x - w / 2 - 2, y: 2, w: w + 4, h: 14 };
    if (hits(box) || box.x < 2 || box.x + box.w > width - 64) continue;
    ctx.globalAlpha = 0.85;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(text, at.x, 3);
    ctx.globalAlpha = 0.4;
    labels.push({ ...box, text });
  }
  ctx.restore();
  return labels;
}

/** Lat/lon window of the camera, padded so a curved Lambert edge still draws. */
function borderWindow(lambert: Lambert, camera: Camera): { south: number; north: number; west: number; east: number } | null {
  if (camera.surface) {
    const tilt=(camera as Camera & {tiltCamera?:TiltCamera}).tiltCamera;
    return (tilt?visibleTerrainBounds(tilt):null) ?? {south:-90,north:90,west:-180,east:180};
  }
  if (lambert.projection === 'equirectangular') {
    const halfLon = camera.halfWidth / lambert.F;
    const centre = lambert.lon0 + camera.centerX / lambert.F;
    return {
      south: camera.centerY - camera.halfHeight,
      north: camera.centerY + camera.halfHeight,
      west: centre - halfLon,
      east: centre + halfLon,
    };
  }
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const x of [camera.centerX - camera.halfWidth, camera.centerX, camera.centerX + camera.halfWidth]) {
    for (const y of [camera.centerY - camera.halfHeight, camera.centerY, camera.centerY + camera.halfHeight]) {
      const point = unproject(lambert, x, y);
      if (!point) continue;
      south = Math.min(south, point.lat);
      north = Math.max(north, point.lat);
      west = Math.min(west, point.lon);
      east = Math.max(east, point.lon);
    }
  }
  if (!Number.isFinite(south)) return null;
  const padLat = Math.max(1, (north - south) * 0.2);
  const padLon = Math.max(1, (east - west) * 0.2);
  return { south: south - padLat, north: north + padLat, west: west - padLon, east: east + padLon };
}

function borderRingBox(ring: { lon: ArrayLike<number>; lat: ArrayLike<number> }): { west: number; east: number; south: number; north: number } {
  let box = ringBoxes.get(ring);
  if (box) return box;
  box = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
  for (let i = 0; i < ring.lon.length; i += 1) {
    box.west = Math.min(box.west, ring.lon[i]);
    box.east = Math.max(box.east, ring.lon[i]);
    box.south = Math.min(box.south, ring.lat[i]);
    box.north = Math.max(box.north, ring.lat[i]);
  }
  ringBoxes.set(ring, box);
  return box;
}

type BorderWindow = { west: number; east: number; south: number; north: number };
const borderCandidates = new WeakMap<Borders['country'], { box: BorderWindow; rings: Borders['country'] }>();
function borderBoxHits(box: BorderWindow, view: BorderWindow): boolean {
  if (box.north < view.south || box.south > view.north) return false;
  if (view.east - view.west >= 360 || box.east - box.west >= 180) return true;
  return Math.ceil((view.west - box.east) / 360) <= Math.floor((view.east - box.west) / 360);
}
/** Keep a padded regional selection while panning; never discard a crossing line. */
export function borderRingsInView(rings: Borders['country'], view: BorderWindow): Borders['country'] {
  let cached = borderCandidates.get(rings);
  if (!cached || view.west < cached.box.west || view.east > cached.box.east
    || view.south < cached.box.south || view.north > cached.box.north) {
    const dx = Math.max(1, (view.east - view.west) / 2), dy = Math.max(1, (view.north - view.south) / 2);
    const box = { west: view.west - dx, east: view.east + dx, south: view.south - dy, north: view.north + dy };
    cached = { box, rings: rings.filter((ring) => borderBoxHits(borderRingBox(ring), box)) };
    borderCandidates.set(rings, cached);
  }
  return cached.rings;
}

/** Country lines a little stronger than states; disputed lines dashed and lighter. Both sit under the isobars. */
function strokeBorders(
  ctx: CanvasRenderingContext2D,
  borders: Borders,
  width: number,
  height: number,
  lambert: Lambert,
  camera: Camera,
  inkSet: ChartInk,
) {
  const view = borderWindow(lambert, camera);
  const paint = (rings: Borders['country'], lineWidth: number, alpha: number, dash: number[]) => {
    ctx.save();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = inkSet.line;
    ctx.globalAlpha = alpha;
    ctx.setLineDash(dash);
    for (const ring of view ? borderRingsInView(rings, view) : []) {
      if (!borderBoxHits(borderRingBox(ring), view!)) continue;
      for (const path of projectedStrokePaths(lambert, camera, width, height, ring.lon, ring.lat, false))
        strokeChain(ctx, path.points, false, [], width, height);
    }
    ctx.restore();
  };
  paint(borders.state, 0.7, 0.34, []);
  paint(borders.country, 1.05, 0.62, []);
  paint(borders.disputed, 0.9, 0.48, [2, 3]);
}

export function classRuns(
  points: (Point | null)[],
  closed: boolean,
  high: boolean[],
  dashed: boolean,
): { points: Point[]; closed: boolean }[] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  const n = points.length;
  const end = closed ? n : Math.max(0, n - 1);
  const flush = () => {
    if (run.length >= 2) runs.push(run);
    run = [];
  };
  for (let i = 0; i < end; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (!a || !b || high[i] !== dashed) {
      flush();
      continue;
    }
    if (!run.length || run[run.length - 1].x !== a.x || run[run.length - 1].y !== a.y) {
      flush();
      run = [a];
    }
    run.push(b);
  }
  flush();
  const whole = closed && points.every((p) => p !== null) && runs.length === 1 && high.slice(0, end).every((flag) => flag === dashed);
  return runs.map((segment) => ({ points: segment, closed: whole }));
}

/** Fair each same-terrain run so a close zoom loses its staircase without bridging a dash change. */
function strokeFaired(
  ctx: CanvasRenderingContext2D,
  points: (Point | null)[],
  closed: boolean,
  gaps: LabelBox[],
  high: boolean[],
  dashed: boolean,
  width: number,
  height: number,
) {
  for (const run of classRuns(points, closed, high, dashed)) {
    strokeChain(ctx, fairChain(run.points, run.closed), run.closed, gaps, width, height);
  }
}

function isobarText(hPa: number, units: UnitSpec | undefined, rounded: boolean): string {
  if (!units || units.pressure !== 'inHg') return rounded ? String(Math.round(hPa)) : String(hPa);
  return formatIsobar(hPa, units);
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
  lambert: Lambert,
  camera: Camera,
  coast: Coast,
  lines: Polyline[],
  centres: PressureCentre[],
  plate = false,
  grid?: GridBox,
  inkSet: ChartInk = DAY_INK,
  avoid: LabelBox[] = [],
  units?: UnitSpec,
  elevationAt?: ElevationAt,
  graticule = false,
  borders: Borders | null = null,
  water?: Water | null,
): DrawnLabel[] {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const screen = (lon: number, lat: number) => toScreen(lambert, camera, width, height, lon, lat);
  const span = latitudeSpan(lambert, camera);
  const coastWindow = camera.surface ? surfaceStrokeBounds(camera,width,height,4) : borderWindow(lambert, camera);
  const coastRings = coastWindow ? borderRingsInView(coast.rings, coastWindow) : coast.rings;
  const waterBox = water ? viewGeoBox(lambert, camera) : null;
  const lakes = water && waterBox ? lakesInView(water, waterBox, span) : [];
  const rivers = water && waterBox ? riversInView(water, waterBox, span) : [];
  const trace = (lon: ArrayLike<number>, lat: ArrayLike<number>, closed: boolean) => {
    for (const path of projectedPaths(lambert, camera, width, height, lon, lat, closed)) {
      let started = false;
      for (const point of path.points) {
        if (!point) continue;
        if (!started) { ctx.moveTo(point.x, point.y); started = true; }
        else ctx.lineTo(point.x, point.y);
      }
      if (closed) ctx.closePath();
    }
  };
  if (plate) {
    ctx.fillStyle = inkSet.plateSea;
    ctx.fillRect(0, 0, width, height);
    ctx.beginPath();
    for (const ring of coastRings) {
      if (!ringInView(lambert, camera, ring)) continue;
      trace(ring.lon, ring.lat, true);
    }
    ctx.fillStyle = inkSet.plateLand;
    ctx.fill('evenodd');
    if (lakes.length) {
      ctx.beginPath();
      for (const ring of lakes) trace(ring.lon, ring.lat, true);
      ctx.fillStyle = inkSet.plateSea;
      ctx.fill('evenodd');
    }
  }
  if (rivers.length) {
    ctx.strokeStyle = inkSet.coast;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const line of rivers) {
      ctx.lineWidth = riverWidth(line.rank);
      ctx.beginPath();
      trace(line.lon, line.lat, false);
      ctx.stroke();
    }
  }
  const graticuleLabels = graticule ? drawGraticule(ctx, width, height, lambert, camera, inkSet) : [];
  if (borders) strokeBorders(ctx, borders, width, height, lambert, camera, inkSet);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Isobars go on their own layer, which is faded to the grid edge. The coast
  // is stroked afterwards so the land edge stays continuous over the lines.
  // A global periodic grid has no finite x edge to fade and its wrapped west
  // and east edges would make the canvas mask self-intersect when the camera
  // is panned across the dateline. The shader already covers this whole grid.
  const periodicWorld = lambert.projection === 'equirectangular' && Boolean(grid);
  const layer = grid && !periodicWorld ? layerCanvas(ctx.canvas.width, ctx.canvas.height) : null;
  const ink = layer ?? ctx;
  ink.setTransform(dpr, 0, 0, dpr, 0, 0);
  ink.lineJoin = 'round';
  ink.lineCap = 'round';

  const labels: { text: string; x: number; y: number; box: LabelBox; alpha: number }[] = [];
  const perLevel = new Map<string, number>();
  ink.font = '600 13px ui-sans-serif, system-ui, sans-serif';
  ink.textAlign = 'center';
  ink.textBaseline = 'middle';

  const shown = lines.filter((line) => isobarOpacity(line.level, span) > 0);
  const projected = shown.filter((line) => ringInView(lambert, camera, line)).flatMap((line) => projectedStrokePaths(lambert, camera, width, height, line.lon, line.lat, line.closed, 128).map((path) => {
    const points = soften(soften(pruneOffscreenVertices(path.points, path.closed, width, height), path.closed), path.closed);
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (a && b) length += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const high = terrainFlags(line, points, elevationAt);
    return { line: { ...line, closed: path.closed }, points, length, high, alpha: isobarOpacity(line.level, span) };
  }));

  const candidates = centres
    .map((centre) => ({ centre, point: screen(centre.lon, centre.lat) }))
    .filter((item): item is { centre: PressureCentre; point: Point } => (
      item.point !== null
      && item.point.x >= 18 && item.point.y >= 24 && item.point.x <= width - 18 && item.point.y <= height - 24
      && (periodicWorld || !grid || gridEdgeDistance(grid, item.centre.lon, item.centre.lat) > EDGE_FADE_DEG + 1.5)
    ));
  // Keep the most prominent centres in view, with room for their letter,
  // cross and pressure. Geographic spacing alone is insufficient at world zoom.
  const hitsBox = (box: LabelBox) => avoid.some((item) => !(
    box.x + box.w < item.x || item.x + item.w < box.x || box.y + box.h < item.y || item.y + item.h < box.y
  ));
  ink.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  const centreWidth = (hpa: number) => Math.max(44, ink.measureText(isobarText(hpa, units, false)).width + 10);
  const placed = selectPressureCentres(candidates.filter((candidate) => {
    const w = centreWidth(candidate.centre.hpa);
    return !hitsBox({ x: candidate.point.x - w / 2, y: candidate.point.y - 26, w, h: 56 });
  }), span, elevationAt);
  const centreBoxes: DrawnLabel[] = placed.map(({ centre, point }) => {
    const text = isobarText(centre.hpa, units, false);
    const w = centreWidth(centre.hpa);
    return { x: point.x - w / 2, y: point.y - 26, w, h: 56, text: `${centre.kind} ${text}` };
  });
  ink.font = '600 13px ui-sans-serif, system-ui, sans-serif';

  const overlaps = (box: LabelBox, other: LabelBox) => !(
    box.x + box.w < other.x || other.x + other.w < box.x
    || box.y + box.h < other.y || other.y + other.h < box.y
  );

  const ranked = projected.filter((item) => item.points.length >= 4 && item.length >= 90)
    .slice()
    .sort((a, b) => b.alpha - a.alpha || b.length - a.length);

  // One label per line, tried at several points along it, longest lines first;
  // at most three labels per level, as on the Bureau chart.
  for (const item of ranked) {
    const text = isobarText(item.line.level, units, true);
    if ((perLevel.get(text) ?? 0) >= 3) continue;
    const boxW = ink.measureText(text).width + 8;
    const boxH = 16;
    const cumulative = [0];
    for (let i = 1; i < item.points.length; i += 1) {
      const a = item.points[i - 1], b = item.points[i];
      cumulative.push(cumulative[i - 1] + (a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0));
    }
    for (const fraction of [0.45, 0.3, 0.6, 0.18, 0.75]) {
      const target = item.length * fraction;
      let i = cumulative.findIndex((value) => value >= target);
      if (i < 0) i = item.points.length - 1;
      const point = item.points[i];
      if (!point) continue;
      if (item.high[i]) continue;
      // Only candidate labels need the grid-edge test, not every global vertex.
      if (!periodicWorld && grid && gridEdgeDistance(grid, item.line.lon[i], item.line.lat[i]) <= EDGE_FADE_DEG + 1) continue;
      if (!(point.x > 14 && point.y > 14 && point.x < width - 14 && point.y < height - 14)) continue;
      const box = { x: point.x - boxW / 2, y: point.y - boxH / 2, w: boxW, h: boxH };
      const hits = hitsBox(box)
        || labels.some((label) => overlaps(box, label.box))
        || centreBoxes.some((centre) => overlaps(box, centre));
      if (hits) continue;
      labels.push({ text, x: point.x, y: point.y, box, alpha: item.alpha });
      perLevel.set(text, (perLevel.get(text) ?? 0) + 1);
      break;
    }
  }

  for (const item of projected) {
    const gaps = [
      ...labels.filter((label) => label.text === isobarText(item.line.level, units, true)).map((label) => label.box),
      ...centreBoxes,
    ];
    ink.lineWidth = item.line.level % 20 === 0 ? 1.35 : 0.85;
    ink.strokeStyle = inkSet.line;
    ink.globalAlpha = item.alpha;
    strokeFaired(ink, item.points, item.line.closed, gaps, item.high, false, width, height);
    ink.globalAlpha = item.alpha * HIGH_TERRAIN_ALPHA;
    ink.setLineDash([3, 4]);
    strokeFaired(ink, item.points, item.line.closed, gaps, item.high, true, width, height);
    ink.setLineDash([]);
    ink.globalAlpha = 1;
  }

  if (layer && grid && !periodicWorld) {
    maskToGrid(layer, grid, screen);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer.canvas, 0, 0);
    ctx.restore();
  }

  // Coast on top of the isobars: a thin dark edge, the land/sea boundary the plate is built around.
  ctx.strokeStyle = inkSet.coast;
  ctx.fillStyle = inkSet.coast;
  ctx.lineWidth = 0.85;
  for (const ring of coastRings) {
    if (!ringInView(lambert, camera, ring)) continue;
    for (const path of projectedStrokePaths(lambert, camera, width, height, ring.lon, ring.lat, true)) {
      // A coarse world coastline must not zigzag across a finer DEM shoreline.
      // Keep its segments only where the close terrain mosaic has no coverage.
      const points = elevationAt && camera.halfHeight < 2 && lambert.projection === 'equirectangular'
        ? path.points.map((p, i) => p && elevationAt(ring.lon[i], ring.lat[i]) != null ? null : p) : path.points;
      strokeChain(ctx, points, path.closed, [], width, height);
    }
  }
  for (const ring of lakes) {
    for (const path of projectedPaths(lambert, camera, width, height, ring.lon, ring.lat, true))
      strokeChain(ctx, path.points, path.closed, [], width, height);
  }

  ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const label of labels) {
    // Contour strokes may fade with scale; their numbers must remain readable.
    ctx.globalAlpha = 1;
    if (inkSet.halo) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = inkSet.halo;
      ctx.strokeText(label.text, label.x, label.y);
    }
    ctx.fillStyle = inkSet.line;
    ctx.fillText(label.text, label.x, label.y);
  }

  ctx.globalAlpha = 1;

  // H/L: letter above a small plus at the centre, value below (Bureau analysis).
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const { centre, point } of placed) {
    ctx.strokeStyle = inkSet.line;
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    ctx.moveTo(point.x - 5, point.y);
    ctx.lineTo(point.x + 5, point.y);
    ctx.moveTo(point.x, point.y - 5);
    ctx.lineTo(point.x, point.y + 5);
    ctx.stroke();
    const text = (value: string, font: string, y: number) => {
      ctx.font = font;
      if (inkSet.halo) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = inkSet.halo;
        ctx.strokeText(value, point.x, y);
      }
      ctx.fillStyle = inkSet.line;
      ctx.fillText(value, point.x, y);
    };
    text(centre.kind, '700 18px ui-sans-serif, system-ui, sans-serif', point.y - 15);
    text(isobarText(centre.hpa, units, false), '600 11px ui-sans-serif, system-ui, sans-serif', point.y + 15);
  }
  // What town names must keep clear of.
  return [...labels.map((label) => ({ ...label.box, text: label.text })), ...centreBoxes, ...graticuleLabels];
}
