/**
 * Inland water. Natural Earth 10m lakes (plus the Europe and North America
 * supplements) and scale-ranked river centerlines, packed by tools/pack-water.py.
 * A lake ring is water: even-odd, so an island ring inside a lake is land.
 * minZoom is the Natural Earth web-map zoom at which the feature appears.
 */

import { ringInPolygon, type Coast, type CoastRing } from './coast';

export interface WaterRing {
  /** Natural Earth min_zoom. Lower values show on wider views. */
  minZoom: number;
  lon: Float32Array;
  lat: Float32Array;
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface RiverLine {
  /** Natural Earth scalerank. 1 is a continental river. */
  rank: number;
  lon: Float32Array;
  lat: Float32Array;
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface Water {
  rings: WaterRing[];
  rivers: RiverLine[];
}

export interface LonLatBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export const EMPTY_WATER: Water = { rings: [], rivers: [] };

/** A view this tall, or shorter, also samples OSM water polygons. ~200 km. */
export const CLOSE_WATER_KM = 220;

const KM_PER_DEG = 111.32;

export function featureZoom(spanDeg: number): number {
  if (!(spanDeg > 0)) return 0;
  return Math.log2(360 / spanDeg) + 1.5;
}

export function lakeVisible(minZoom: number, spanDeg: number): boolean {
  return minZoom <= featureZoom(spanDeg) + 1e-6;
}

/** Rivers are thin centerlines on a regional view, not on the world plate or once area water takes over. */
export function riverVisible(rank: number, spanDeg: number): boolean {
  if (!(spanDeg > 0) || spanDeg > 70 || closeWater(spanDeg)) return false;
  return rank + 1 <= featureZoom(spanDeg) + 1e-6;
}

export function riverWidth(rank: number): number {
  if (rank <= 2) return 1.15;
  if (rank <= 4) return 0.9;
  return 0.65;
}

export function closeWater(spanDeg: number): boolean {
  return spanDeg * KM_PER_DEG <= CLOSE_WATER_KM;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readI32(bytes: Uint8Array, offset: number): number {
  const value = readU32(bytes, offset);
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function boundsOf(lon: Float32Array, lat: Float32Array): { west: number; south: number; east: number; north: number } | null {
  if (!lon.length) return null;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let i = 0; i < lon.length; i += 1) {
    west = Math.min(west, lon[i]);
    east = Math.max(east, lon[i]);
    south = Math.min(south, lat[i]);
    north = Math.max(north, lat[i]);
  }
  return { west, south, east, north };
}

function parseRings(bytes: Uint8Array | null, magic: string, kind: 'lake'): WaterRing[];
function parseRings(bytes: Uint8Array | null, magic: string, kind: 'river'): RiverLine[];
function parseRings(bytes: Uint8Array | null, magic: string, kind: 'lake' | 'river'): WaterRing[] | RiverLine[] {
  if (!bytes || bytes.length < 12) return [];
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== magic) return [];
  const version = readU16(bytes, 4);
  const scale = readU16(bytes, 6);
  const count = readU32(bytes, 8);
  if (version !== 1 || !(scale > 0) || count > 200_000) return [];
  let cursor = 12;
  const out: (WaterRing | RiverLine)[] = [];
  for (let i = 0; i < count; i += 1) {
    if (cursor + 8 > bytes.length) return [];
    const rank = readU16(bytes, cursor);
    const points = readU32(bytes, cursor + 4);
    cursor += 8;
    if (points > 1_000_000 || cursor + points * 8 > bytes.length) return [];
    const lon = new Float32Array(points);
    const lat = new Float32Array(points);
    for (let p = 0; p < points; p += 1) {
      lon[p] = readI32(bytes, cursor) / scale;
      lat[p] = readI32(bytes, cursor + 4) / scale;
      cursor += 8;
    }
    const box = boundsOf(lon, lat);
    if (!box) continue;
    if (kind === 'lake') {
      if (points < 3) continue;
      out.push({ minZoom: rank / 100, lon, lat, ...box });
    } else if (points >= 2) {
      out.push({ rank, lon, lat, ...box });
    }
  }
  if (cursor !== bytes.length) return [];
  return kind === 'lake' ? out as WaterRing[] : out as RiverLine[];
}

export function parseLakes(bytes: Uint8Array | null): WaterRing[] {
  return parseRings(bytes, 'LAKE', 'lake');
}

export function parseRivers(bytes: Uint8Array | null): RiverLine[] {
  return parseRings(bytes, 'RIVR', 'river');
}

export function parseWater(lakes: Uint8Array | null, rivers: Uint8Array | null): Water {
  return { rings: parseLakes(lakes), rivers: parseRivers(rivers) };
}

function lonNear(lon: number, west: number, east: number, pad: number): boolean {
  const mid = (west + east) / 2;
  let x = lon;
  while (x - mid > 180) x -= 360;
  while (x - mid < -180) x += 360;
  return x >= west - pad && x <= east + pad;
}

/** Even-odd across lake rings. An island inside a lake is not water. */
export function lakeContains(water: Water, lon: number, lat: number): boolean {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  let inside = false;
  for (const ring of water.rings) {
    if (lat < ring.south || lat > ring.north || !lonNear(lon, ring.west, ring.east, 0)) continue;
    const mid = (ring.west + ring.east) / 2;
    let x = lon;
    while (x - mid > 180) x -= 360;
    while (x - mid < -180) x += 360;
    if (ringInPolygon(x, lat, ring)) inside = !inside;
  }
  return inside;
}

/** Coastline plus every lake shore, so kite and surf read a lake bank as a shore. */
export function withLakes(coast: Coast, water: Water): Coast {
  if (!water.rings.length) return coast;
  const rings: CoastRing[] = coast.rings.slice();
  for (const ring of water.rings) rings.push({ lon: ring.lon, lat: ring.lat });
  return { rings };
}

export function lakesInView(water: Water, box: LonLatBox, spanDeg: number): WaterRing[] {
  return water.rings.filter((ring) => lakeVisible(ring.minZoom, spanDeg) && overlaps(ring, box));
}

export function riversInView(water: Water, box: LonLatBox, spanDeg: number): RiverLine[] {
  return water.rivers.filter((line) => riverVisible(line.rank, spanDeg) && overlaps(line, box));
}

function overlaps(ring: { west: number; south: number; east: number; north: number }, box: LonLatBox): boolean {
  if (ring.north < box.south || ring.south > box.north) return false;
  if (ring.east - ring.west >= 180 || box.east - box.west >= 360) return true;
  for (const shift of [0, 360, -360]) {
    if (ring.east + shift >= box.west && ring.west + shift <= box.east) return true;
  }
  return false;
}

function unwrap(lon: number, origin: number): number {
  let x = lon;
  while (x - origin > 180) x -= 360;
  while (x - origin < -180) x += 360;
  return x;
}

/**
 * Even-odd water mask. Row 0 is the south edge, matching the plate's land
 * texture: shader v = 0 is south.
 */
export function rasterRings(
  rings: { lon: ArrayLike<number>; lat: ArrayLike<number> }[],
  box: LonLatBox,
  width: number,
  height: number,
): Uint8Array {
  const pixels = new Uint8Array(width * height);
  const lonSpan = box.east - box.west;
  const latSpan = box.north - box.south;
  if (!(lonSpan > 0) || !(latSpan > 0) || width < 2 || height < 2 || !rings.length) return pixels;
  const origin = (box.west + box.east) / 2;
  const rows: number[][] = Array.from({ length: height }, () => []);
  const xOf = (lon: number) => ((unwrap(lon, origin) - box.west) / lonSpan) * width;
  const yOf = (lat: number) => ((lat - box.south) / latSpan) * height;
  for (const ring of rings) {
    const n = ring.lon.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      let x0 = xOf(ring.lon[i]);
      let y0 = yOf(ring.lat[i]);
      let x1 = xOf(ring.lon[j]);
      let y1 = yOf(ring.lat[j]);
      if (y0 === y1) continue;
      if (y0 > y1) {
        const swapX = x0;
        const swapY = y0;
        x0 = x1;
        y0 = y1;
        x1 = swapX;
        y1 = swapY;
      }
      const start = Math.max(0, Math.ceil(y0 - 0.5 - 1e-9));
      const end = Math.min(height, Math.ceil(y1 - 0.5 - 1e-9));
      for (let row = start; row < end; row += 1) {
        const y = row + 0.5;
        if (y < y0 || y >= y1) continue;
        rows[row].push(x0 + ((x1 - x0) * (y - y0)) / (y1 - y0));
      }
    }
  }
  for (let row = 0; row < height; row += 1) {
    const xs = rows[row];
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const base = row * width;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let from = Math.ceil(xs[k] - 1e-6);
      let to = Math.floor(xs[k + 1] - 1e-6);
      if (from < 0) from = 0;
      if (to >= width) to = width - 1;
      for (let x = from; x <= to; x += 1) pixels[base + x] = 255;
    }
  }
  return pixels;
}

/** OR extra water into a mask. Never clears a lake that is already water. */
export function addWater(base: Uint8Array, extra: Uint8Array): void {
  const n = Math.min(base.length, extra.length);
  for (let i = 0; i < n; i += 1) if (extra[i]) base[i] = 255;
}

export function waterRasterSize(box: LonLatBox, cssWidth: number, cssHeight: number): { width: number; height: number } {
  const maxEdge = 1024;
  const lonSpan = Math.max(0.001, box.east - box.west);
  const latSpan = Math.max(0.001, box.north - box.south);
  let width = Math.max(2, Math.round(Math.min(Math.max(2, cssWidth), maxEdge)));
  let height = Math.max(2, Math.round(width * (latSpan / lonSpan)));
  if (height > maxEdge) {
    height = maxEdge;
    width = Math.max(2, Math.round(height * (lonSpan / latSpan)));
  }
  if (cssHeight > 0 && height > cssHeight * 2) {
    height = Math.max(2, Math.round(Math.min(height, cssHeight * 2)));
  }
  return { width, height };
}
