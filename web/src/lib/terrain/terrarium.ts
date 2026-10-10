/**
 * Terrain tiles: Mapterhorn terrarium WebP (https://tiles.mapterhorn.com/{z}/{x}/{y}.webp),
 * 512 px Web Mercator tiles, elevation = R·256 + G + B/256 − 32768 metres.
 * Verified 8 Oct 2026: Mt Rainier 4391.5 m (z12; surveyed 4392), Kosciuszko
 * 2226 m (2228), Perth CBD 14 m, sea 0 or −0.5 m, Dead Sea −432 m. All-sea
 * tiles are 404s: missing stays missing (flat tint), never invented relief.
 * z13 tiles exist (Rainier and Perth, 9 Oct 2026); z14 and z15 are 404.
 *
 * Pure: shared by the terrain worker and the unit tests.
 */

export const TERRAIN_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
export const TILE_SIZE = 512;
export const MAX_TERRAIN_ZOOM = 13;
/** Web Mercator's latitude limit. */
export const MERCATOR_LIMIT = 85.0511;

export function terrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export function tileUrl(z: number, x: number, y: number, template = TERRAIN_URL): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** Longitude to fractional tile column at zoom z (any longitude; not wrapped). */
export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat: number, z: number): number {
  const clamped = Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, lat));
  const phi = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * 2 ** z;
}

export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

export function wrapTileX(x: number, z: number): number {
  const n = 2 ** z;
  return ((x % n) + n) % n;
}

/** A geographic box in continuous longitude (west may be < −180, east > 180). */
export interface GeoBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Tile zoom whose texels best match `pxPerDegree` screen pixels per degree of
 * longitude (a 512 px tile spans 360/2^z degrees).
 */
export function terrainZoom(pxPerDegree: number): number {
  if (!(pxPerDegree > 0)) return 0;
  const z = Math.round(Math.log2((pxPerDegree * 360) / TILE_SIZE));
  return Math.max(0, Math.min(MAX_TERRAIN_ZOOM, z));
}

export interface TileKey {
  z: number;
  x: number;
  y: number;
}

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/** Tiles covering `box` at zoom z, nearest the box centre first (fetch priority). */
export function tilesForBox(box: GeoBox, z: number): TileKey[] {
  const n = 2 ** z;
  const x0 = Math.floor(lonToTileX(box.west, z));
  const x1 = Math.floor(lonToTileX(box.east, z) - 1e-9);
  const y0 = Math.max(0, Math.floor(latToTileY(box.north, z)));
  const y1 = Math.min(n - 1, Math.floor(latToTileY(box.south, z) - 1e-9));
  const cx = (lonToTileX(box.west, z) + lonToTileX(box.east, z)) / 2;
  const cy = (latToTileY(box.north, z) + latToTileY(box.south, z)) / 2;
  const seen = new Set<string>();
  const tiles: (TileKey & { d: number })[] = [];
  for (let x = x0; x <= Math.min(x1, x0 + n - 1); x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      const wx = wrapTileX(x, z);
      const key = tileKey(z, wx, y);
      if (seen.has(key)) continue;
      seen.add(key);
      tiles.push({ z, x: wx, y, d: Math.hypot(x + 0.5 - cx, y + 0.5 - cy) });
    }
  }
  tiles.sort((a, b) => a.d - b.d);
  return tiles.map(({ z: tz, x, y }) => ({ z: tz, x, y }));
}

// ---- Half floats ----------------------------------------------------------

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** number → IEEE binary16 bits (round to nearest; overflow to ±Inf). */
export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >> shift;
    if ((mant >> (shift - 1)) & 1) half += 1;
    return sign | half;
  }
  let half = sign | (e << 10) | (mant >> 13);
  if (mant & 0x1000) half += 1;
  return half;
}

let halfTable: Float32Array | null = null;

/** binary16 bits → number via a 64k lookup (fast in the compositor's inner loop). */
export function halfTableLookup(): Float32Array {
  if (halfTable) return halfTable;
  const table = new Float32Array(65536);
  for (let bits = 0; bits < 65536; bits += 1) {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    table[bits] = exponent === 0
      ? sign * 2 ** -14 * (fraction / 1024)
      : exponent === 31 ? (fraction ? NaN : sign * Infinity) : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
  }
  halfTable = table;
  return table;
}

/** Decodes terrarium RGBA pixels to elevation, as binary16 bits (512 kB per tile). */
export function decodeTerrarium(rgba: ArrayLike<number>, out?: Uint16Array): Uint16Array {
  const count = Math.floor(rgba.length / 4);
  const result = out ?? new Uint16Array(count);
  for (let i = 0; i < count; i += 1) {
    result[i] = toHalf(terrariumElevation(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]));
  }
  return result;
}

// ---- Mosaic ---------------------------------------------------------------

/** A decoded tile (binary16 elevation, row-major from the north), `null` when known missing, undefined when not loaded. */
export type TileLookup = (z: number, x: number, y: number) => Uint16Array | null | undefined;

export interface Mosaic {
  box: GeoBox;
  width: number;
  height: number;
  /** RG binary16 per texel, rows from the south: R = elevation (m), G = coverage (1 data, 0 none). */
  data: Uint16Array;
  /** Texels with data. */
  covered: number;
}

const HALF_ONE = 0x3c00;

/**
 * Reprojects Web Mercator tiles into an equirectangular lat/lon texture over
 * `box`. Each texel takes the tile at zoom z, or the nearest loaded ancestor
 * (up to `fallback` levels) while z is still arriving. A tile known to be
 * missing (404, offline) leaves its texels uncovered: flat tint, no relief.
 */
export function compositeMosaic(box: GeoBox, width: number, height: number, z: number, lookup: TileLookup, fallback = 4): Mosaic {
  const table = halfTableLookup();
  const data = new Uint16Array(width * height * 2);
  const n = 2 ** z;
  const colTile = new Int32Array(width);
  const colFrac = new Float32Array(width);
  for (let i = 0; i < width; i += 1) {
    const lon = box.west + ((i + 0.5) / width) * (box.east - box.west);
    const tx = lonToTileX(lon, z);
    const wrapped = ((tx % n) + n) % n;
    colTile[i] = Math.floor(wrapped);
    colFrac[i] = wrapped - Math.floor(wrapped);
  }
  let covered = 0;
  for (let j = 0; j < height; j += 1) {
    const lat = box.south + ((j + 0.5) / height) * (box.north - box.south);
    if (Math.abs(lat) > MERCATOR_LIMIT) continue;
    const ty = latToTileY(lat, z);
    const tileY = Math.min(n - 1, Math.floor(ty));
    const fracY = ty - tileY;
    let row = j * width * 2;
    // Neighbouring texels share a tile: resolve each z tile once per row run.
    let memoX = -1;
    let memoTile: Uint16Array | null | undefined;
    let memoLevel = 0;
    for (let i = 0; i < width; i += 1, row += 2) {
      if (colTile[i] !== memoX) {
        memoX = colTile[i];
        memoTile = undefined;
        memoLevel = 0;
        // Walk up from z until a tile is loaded or known missing.
        let tx = memoX;
        let tyy = tileY;
        for (let level = 0; level <= fallback && z - level >= 0; level += 1) {
          memoTile = lookup(z - level, tx, tyy);
          memoLevel = level;
          if (memoTile !== undefined) break;
          tx >>= 1;
          tyy >>= 1;
        }
      }
      const tile = memoTile;
      if (!tile) continue;
      let fx = colFrac[i];
      let fy = fracY;
      for (let level = 0, tx = colTile[i], tyy = tileY; level < memoLevel; level += 1, tx >>= 1, tyy >>= 1) {
        fx = (fx + (tx & 1)) / 2;
        fy = (fy + (tyy & 1)) / 2;
      }
      const px = fx * TILE_SIZE - 0.5;
      const py = fy * TILE_SIZE - 0.5;
      const x0 = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(px)));
      const y0 = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(py)));
      const x1 = Math.min(TILE_SIZE - 1, x0 + 1);
      const y1 = Math.min(TILE_SIZE - 1, y0 + 1);
      const ax = Math.max(0, Math.min(1, px - x0));
      const ay = Math.max(0, Math.min(1, py - y0));
      const top = table[tile[y0 * TILE_SIZE + x0]] * (1 - ax) + table[tile[y0 * TILE_SIZE + x1]] * ax;
      const bottom = table[tile[y1 * TILE_SIZE + x0]] * (1 - ax) + table[tile[y1 * TILE_SIZE + x1]] * ax;
      data[row] = toHalf(top * (1 - ay) + bottom * ay);
      data[row + 1] = HALF_ONE;
      covered += 1;
    }
  }
  return { box, width, height, data, covered };
}

// ---- View planning --------------------------------------------------------

/** At most this many tiles per view (the worker's LRU holds 64). */
export const MAX_VIEW_TILES = 40;

export interface TerrainPlan {
  z: number;
  box: GeoBox;
  width: number;
  height: number;
}

/**
 * The mosaic for a view: the visible box plus a margin for panning, sampled at
 * about the screen's resolution and no finer than the tiles, within `maxTexels`.
 */
export function planMosaic(view: GeoBox, screenPxPerDegree: number, maxTexels: number, margin = 0.25): TerrainPlan {
  const spanLon = view.east - view.west;
  const spanLat = view.north - view.south;
  const box: GeoBox = {
    west: view.west - spanLon * margin,
    east: view.east + spanLon * margin,
    south: Math.max(-MERCATOR_LIMIT, view.south - spanLat * margin),
    north: Math.min(MERCATOR_LIMIT, view.north + spanLat * margin),
  };
  let z = terrainZoom(screenPxPerDegree);
  // Bounded fetch and memory: a view never needs more than MAX_VIEW_TILES tiles.
  while (z > 0 && tilesForBox(box, z).length > MAX_VIEW_TILES) z -= 1;
  const tilePxPerDegree = (TILE_SIZE * 2 ** z) / 360;
  let density = Math.min(screenPxPerDegree, tilePxPerDegree * 1.25);
  const lonDeg = box.east - box.west;
  const latDeg = Math.max(0.001, box.north - box.south);
  const texels = lonDeg * latDeg * density * density;
  if (texels > maxTexels) density *= Math.sqrt(maxTexels / texels);
  const width = Math.max(2, Math.min(4096, Math.round(lonDeg * density)));
  const height = Math.max(2, Math.min(4096, Math.round(latDeg * density)));
  return { z, box, width, height };
}

/** True when `outer` contains `inner` (continuous longitudes, either world copy). */
export function boxContains(outer: GeoBox, inner: GeoBox): boolean {
  if (inner.south < outer.south - 1e-9 || inner.north > outer.north + 1e-9) return false;
  for (const shift of [0, 360, -360]) {
    if (inner.west + shift >= outer.west - 1e-9 && inner.east + shift <= outer.east + 1e-9) return true;
  }
  return false;
}

/**
 * Relief strength for a view `heightDeg` tall: none at the world view, subtle
 * at synoptic scale (~50°), full in a regional view (≤ 14°).
 */
export function reliefStrength(heightDeg: number): number {
  if (!(heightDeg > 0)) return 0;
  const t = Math.max(0, Math.min(1, (110 - heightDeg) / (110 - 14)));
  return t * t * (3 - 2 * t);
}
