/**
 * Observed geostationary infrared from NASA GIBS.
 *
 * Verified against the EPSG:4326 WMTS capabilities document on 8 Oct 2026
 * (https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml):
 * GOES-East, GOES-West and Himawari clean-infrared (ABI/AHI band 13) are
 * PT10M PNG tiles on TileMatrixSet `2km`. That document has no Meteosat layer
 * and no single global IR mosaic, on EPSG:4326 or EPSG:3857. Longitudes more
 * than a disk's width from those three nadirs stay empty.
 *
 * Tile template:
 * …/epsg4326/best/{Layer}/default/{Time}/2km/{TileMatrix}/{TileRow}/{TileCol}.png
 */

export const GIBS_STEP_MS = 10 * 60 * 1000;
/** Scrubbing back shows the last few hours of the timeline, when GIBS has them. */
export const SATELLITE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
/**
 * Forecast times keep the latest observed picture, labelled with its time, and
 * fade it into model cloud across this window. The map always drifts forward
 * from now, so a short window meant the satellite vanished seconds after it
 * was switched on.
 */
export const SATELLITE_FADE_MS = 6 * 60 * 60 * 1000;
/** GIBS near-real-time imagery appears roughly 30–60 minutes after the scan. */
export const GIBS_LATENCY_MS = 50 * 60 * 1000;
/** Degrees from the subsatellite point. Beyond this the disk edge is unused. */
export const SATELLITE_LIMB_DEG = 68;

export const GIBS_LAYERS = [
  { id: 'GOES-West_ABI_Band13_Clean_Infrared', nadir: -137.2, stepMinutes: 10 },
  { id: 'GOES-East_ABI_Band13_Clean_Infrared', nadir: -75.2, stepMinutes: 10 },
  { id: 'Himawari_AHI_Band13_Clean_Infrared', nadir: 140.7, stepMinutes: 10 },
] as const;

/** Matrix sizes from the `2km` TileMatrixSet. Origin is -180, 90. Tiles are 512². */
export const GIBS_MATRIX = [
  { z: 0, cols: 2, rows: 1 },
  { z: 1, cols: 3, rows: 2 },
  { z: 2, cols: 5, rows: 3 },
  { z: 3, cols: 10, rows: 5 },
  { z: 4, cols: 20, rows: 10 },
  { z: 5, cols: 40, rows: 20 },
] as const;

export interface SatellitePicture {
  request: boolean;
  timeIso: string | null;
  satelliteAlpha: number;
  modelAlpha: number;
  /** `model` only when the drawn cloud is the forecast field, never the satellite picture. */
  legend: 'Satellite' | 'model' | null;
  /** When the satellite picture was taken (UTC), for the legend. */
  observedIso: string | null;
}

export function gibsTimeIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function snapGibsTime(ms: number): number {
  return Math.floor(ms / GIBS_STEP_MS) * GIBS_STEP_MS;
}

/**
 * Satellite is observed: on for times up to now, within the lookback.
 * Past now it fades. Model cloud, when the export has it, takes the forecast
 * and is never labelled as a satellite picture.
 */
export function satelliteGate(validMs: number, nowMs: number, hasModelCloud: boolean): SatellitePicture {
  const latest = snapGibsTime(nowMs - GIBS_LATENCY_MS);
  const future = validMs - latest;
  let satelliteAlpha = 0;
  let requestMs: number | null = null;
  if (future <= 0 && latest - validMs <= SATELLITE_LOOKBACK_MS) {
    // A time with a picture: show that picture.
    satelliteAlpha = 1;
    requestMs = snapGibsTime(validMs);
  } else if (future > 0 && future < SATELLITE_FADE_MS) {
    // Ahead of the latest picture: keep it, fading into model cloud.
    const t = future / SATELLITE_FADE_MS;
    satelliteAlpha = 1 - t * t * (3 - 2 * t);
    requestMs = latest;
  }
  if (requestMs == null) satelliteAlpha = 0;
  const modelAlpha = hasModelCloud && future > 0 ? 1 - satelliteAlpha : 0;
  let legend: SatellitePicture['legend'] = null;
  if (modelAlpha > satelliteAlpha && modelAlpha > 0.04) legend = 'model';
  else if (satelliteAlpha > 0.04) legend = 'Satellite';
  return {
    request: requestMs != null && satelliteAlpha > 0.02,
    timeIso: requestMs == null ? null : gibsTimeIso(requestMs),
    satelliteAlpha,
    modelAlpha,
    legend,
    observedIso: requestMs == null ? null : gibsTimeIso(requestMs),
  };
}

export function wrapDelta(lon: number, nadir: number): number {
  let d = lon - nadir;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export function layerForLongitude(lon: number): (typeof GIBS_LAYERS)[number] | null {
  let lonN = lon;
  while (lonN > 180) lonN -= 360;
  while (lonN < -180) lonN += 360;
  let best: (typeof GIBS_LAYERS)[number] | null = null;
  let bestD = SATELLITE_LIMB_DEG;
  for (const layer of GIBS_LAYERS) {
    const d = Math.abs(wrapDelta(lonN, layer.nadir));
    if (d < bestD) {
      best = layer;
      bestD = d;
    }
  }
  return best;
}

export function gibsTileUrl(layerId: string, timeIso: string, z: number, row: number, col: number): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${layerId}/default/${timeIso}/2km/${z}/${row}/${col}.png`;
}

export function chooseMatrixLevel(lonSpan: number, latSpan: number): number {
  const span = Math.max(lonSpan, latSpan);
  if (span > 120) return 2;
  if (span > 70) return 3;
  if (span > 36) return 4;
  return 5;
}

export interface GibsTile {
  layerId: string;
  z: number;
  row: number;
  col: number;
  west: number;
  south: number;
  east: number;
  north: number;
  url: string;
}

/** Split a camera window into ranges inside [-180, 180], including a dateline cross. */
export function longitudeRanges(bounds: { west: number; east: number; south: number; north: number }): { west: number; east: number }[] {
  let west = bounds.west;
  let east = bounds.east;
  if (!(east > west)) return [];
  if (east - west >= 359) return [{ west: -180, east: 180 }];
  while (west < -180) {
    west += 360;
    east += 360;
  }
  while (east > 180) {
    if (west < 180) return [{ west, east: 180 }, { west: -180, east: east - 360 }];
    west -= 360;
    east -= 360;
  }
  return [{ west, east }];
}

export function tilesCovering(
  bounds: { west: number; east: number; south: number; north: number },
  timeIso: string,
): GibsTile[] {
  const ranges = longitudeRanges(bounds);
  let z = chooseMatrixLevel(bounds.east - bounds.west, bounds.north - bounds.south);
  for (;;) {
    const tiles: GibsTile[] = [];
    const seen = new Set<string>();
    for (const range of ranges) {
      const level = GIBS_MATRIX[z];
      const lonSpan = 360 / level.cols;
      const latSpan = 180 / level.rows;
      const col0 = Math.max(0, Math.floor((range.west + 180) / lonSpan));
      const col1 = Math.min(level.cols - 1, Math.floor((range.east + 180 - 1e-6) / lonSpan));
      const row0 = Math.max(0, Math.floor((90 - bounds.north) / latSpan));
      const row1 = Math.min(level.rows - 1, Math.floor((90 - Math.max(bounds.south, -90) - 1e-6) / latSpan));
      for (let row = row0; row <= row1; row += 1) {
        for (let col = col0; col <= col1; col += 1) {
          const key = `${z}:${row}:${col}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const west = -180 + col * lonSpan;
          const north = 90 - row * latSpan;
          const layer = layerForLongitude(west + lonSpan / 2);
          if (!layer) continue;
          tiles.push({
            layerId: layer.id,
            z,
            row,
            col,
            west,
            south: north - latSpan,
            east: west + lonSpan,
            north,
            url: gibsTileUrl(layer.id, timeIso, z, row, col),
          });
        }
      }
    }
    if (tiles.length <= 24 || z === 0) return tiles;
    z -= 1;
  }
}

/** 0–100% model cloud as a translucent cover. Missing stays missing. */
export function modelCloudAlpha(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 5) return 0;
  return Math.min(0.55, ((percent - 5) / 95) * 0.55);
}

export interface CoverageBox {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** Move a tile's longitude span onto the copy nearest the view centre, keeping its width. */
export function shiftInterval(west: number, east: number, mid: number): { west: number; east: number } {
  let left = west;
  let right = east;
  while (left - mid > 180) {
    left -= 360;
    right -= 360;
  }
  while (mid - left > 180) {
    left += 360;
    right += 360;
  }
  return { west: left, east: right };
}

/** Longitude folded onto the texture's copy. A world grid lives in [-180, 180]; a camera atlas is continuous. */
export function unwrapToBox(lon: number, box: CoverageBox): number {
  return shiftInterval(lon, lon, (box.west + box.east) / 2).west;
}

export function textureUv(lon: number, lat: number, box: CoverageBox): { u: number; v: number } {
  const spanX = box.east - box.west;
  const spanY = box.north - box.south;
  if (!(spanX > 0) || !(spanY > 0) || !Number.isFinite(lon) || !Number.isFinite(lat)) return { u: -1, v: -1 };
  return { u: (unwrapToBox(lon, box) - box.west) / spanX, v: (lat - box.south) / spanY };
}

/**
 * Paint tile ids into an equirectangular atlas the way the GPU texture is
 * filled: one shifted copy of each tile, later tiles on top. 0 is empty.
 */
export function compositeAtlas(
  tiles: { west: number; east: number; south: number; north: number; value: number }[],
  box: CoverageBox,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const spanX = box.east - box.west;
  const spanY = box.north - box.south;
  if (!(spanX > 0) || !(spanY > 0) || !(width > 0) || !(height > 0)) return out;
  const mid = (box.west + box.east) / 2;
  for (const tile of tiles) {
    const shifted = shiftInterval(tile.west, tile.east, mid);
    const x0 = Math.floor(((shifted.west - box.west) / spanX) * width);
    const x1 = Math.ceil(((shifted.east - box.west) / spanX) * width);
    const y0 = Math.floor(((box.north - tile.north) / spanY) * height);
    const y1 = Math.ceil(((box.north - tile.south) / spanY) * height);
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) out[y * width + x] = tile.value;
    }
  }
  return out;
}

interface MeshCorner {
  clipX: number;
  clipY: number;
  u: number;
  v: number;
}

const UV_JUMP = 0.5;

/**
 * Clip-space grid for the satellite texture. A cell whose corners fall on
 * opposite sides of the texture's dateline is split, so a triangle never
 * interpolates from u≈1 to u≈0 (the vertical stripes just east of New Zealand).
 */
export function buildCoverageMesh(
  cols: number,
  rows: number,
  pointAt: (clipX: number, clipY: number) => { lon: number; lat: number } | null,
  box: CoverageBox,
): { positions: Float32Array; indices: Uint16Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  const at = (clipX: number, clipY: number): MeshCorner => {
    const point = pointAt(clipX, clipY);
    if (!point) return { clipX, clipY, u: -1, v: -1 };
    const uv = textureUv(point.lon, point.lat, box);
    return { clipX, clipY, u: uv.u, v: uv.v };
  };
  const push = (corner: MeshCorner) => {
    const index = positions.length / 4;
    positions.push(corner.clipX, corner.clipY, corner.u, corner.v);
    return index;
  };
  const quad = (a: MeshCorner, b: MeshCorner, c: MeshCorner, d: MeshCorner) => {
    const ia = push(a);
    const ib = push(b);
    const ic = push(c);
    const id = push(d);
    indices.push(ia, ib, ic, ib, id, ic);
  };
  const jumps = (a: MeshCorner, b: MeshCorner) => a.u >= 0 && b.u >= 0 && Math.abs(a.u - b.u) > UV_JUMP;
  // Last point still on the anchor's side of the texture, or the first point on the other side.
  const edgePoint = (x0: number, x1: number, y: number, anchorU: number, farSide: boolean): MeshCorner => {
    let near = 0;
    let far = 1;
    for (let step = 0; step < 24; step += 1) {
      const t = (near + far) / 2;
      const corner = at(x0 + (x1 - x0) * t, y);
      if (corner.u < 0 || Math.abs(corner.u - anchorU) > UV_JUMP) far = t;
      else near = t;
    }
    const t = farSide ? far : near;
    return at(x0 + (x1 - x0) * t, y);
  };

  for (let y = 0; y < rows; y += 1) {
    const y0 = -1 + (2 * y) / rows;
    const y1 = -1 + (2 * (y + 1)) / rows;
    for (let x = 0; x < cols; x += 1) {
      const x0 = -1 + (2 * x) / cols;
      const x1 = -1 + (2 * (x + 1)) / cols;
      const bl = at(x0, y0);
      const br = at(x1, y0);
      const tl = at(x0, y1);
      const tr = at(x1, y1);
      const topJump = jumps(tl, tr);
      const botJump = jumps(bl, br);
      const vertical = jumps(bl, tl) || jumps(br, tr);
      if (!topJump && !botJump && !vertical) {
        quad(bl, br, tl, tr);
        continue;
      }
      // Equirectangular: the dateline is a vertical line, so it cuts the top and bottom.
      if (topJump && botJump && !vertical) {
        quad(bl, edgePoint(x0, x1, y0, bl.u, false), tl, edgePoint(x0, x1, y1, tl.u, false));
        quad(edgePoint(x0, x1, y0, bl.u, true), br, edgePoint(x0, x1, y1, tl.u, true), tr);
        continue;
      }
      // Any other discontinuity (a Lambert edge): drop microcells that still cross it.
      const n = 8;
      for (let sy = 0; sy < n; sy += 1) {
        for (let sx = 0; sx < n; sx += 1) {
          const xa = x0 + ((x1 - x0) * sx) / n;
          const xb = x0 + ((x1 - x0) * (sx + 1)) / n;
          const ya = y0 + ((y1 - y0) * sy) / n;
          const yb = y0 + ((y1 - y0) * (sy + 1)) / n;
          const a = at(xa, ya);
          const b = at(xb, ya);
          const c = at(xa, yb);
          const d = at(xb, yb);
          if (jumps(a, b) || jumps(c, d) || jumps(a, c) || jumps(b, d)) continue;
          quad(a, b, c, d);
        }
      }
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}
