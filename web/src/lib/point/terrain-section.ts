/**
 * East–west terrain under a tapped point, from the same terrarium tiles the
 * relief layer uses. The model surface is export orography when the chart
 * has it, otherwise the height implied by surface pressure against MSLP.
 * Neither source invents a height.
 */
import { pressureAltitudeMetres } from '../units';
import {
  latToTileY, lonToTileX, terrariumElevation, tileUrl, wrapTileX,
} from '../terrain/terrarium';

/** Mean meridional kilometres in one degree of latitude. */
const KM_PER_DEG = 111.195;

export const SECTION_HALF_KM = 25;
export const SECTION_SAMPLES = 101;
/** Zoom whose texels are finer than the ~500 m sample spacing. */
export const SECTION_ZOOM = 12;

export interface TrackPoint {
  lat: number;
  lon: number;
  distanceKm: number;
}

export interface SectionSample {
  distanceKm: number;
  metres: number | null;
}

export interface DecodedTile {
  z: number;
  x: number;
  y: number;
  width: number;
  height?: number;
  rgba: Uint8ClampedArray;
}

export function wrapLon(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/** ±halfKm through the point, east positive. The middle sample is the tap. */
export function sectionTrack(lat: number, lon: number, halfKm = SECTION_HALF_KM, count = SECTION_SAMPLES): TrackPoint[] {
  const mid = (count - 1) / 2;
  const kmPerDeg = Math.max(1e-3, KM_PER_DEG * Math.cos((lat * Math.PI) / 180));
  const points: TrackPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const distanceKm = mid === 0 ? 0 : ((i - mid) / mid) * halfKm;
    points.push({ lat, lon: wrapLon(lon + distanceKm / kmPerDeg), distanceKm });
  }
  return points;
}

/** Horizontal axis of the profile plot. Distance 0 sits in the middle. */
export function sectionX(distanceKm: number, width: number, halfKm = SECTION_HALF_KM): number {
  const span = Math.max(halfKm, 1e-3) * 2;
  const t = (distanceKm + halfKm) / span;
  return 8 + Math.min(1, Math.max(0, t)) * Math.max(0, width - 16);
}

export function elevationsAlong(track: readonly TrackPoint[], sample: (lon: number, lat: number) => number | null): SectionSample[] {
  return track.map((point) => {
    const metres = sample(point.lon, point.lat);
    return { distanceKm: point.distanceKm, metres: metres != null && Number.isFinite(metres) ? metres : null };
  });
}

function pixel(tile: DecodedTile, col: number, row: number): number {
  const height = tile.height ?? tile.width;
  if (col < 0 || row < 0 || col >= tile.width || row >= height) return Number.NaN;
  const i = (row * tile.width + col) * 4;
  return terrariumElevation(tile.rgba[i], tile.rgba[i + 1], tile.rgba[i + 2]);
}

/** Bilinear sample of a decoded terrarium tile. A point outside every tile is null. */
export function sampleTiles(tiles: readonly DecodedTile[], lon: number, lat: number): number | null {
  if (!tiles.length) return null;
  const z = tiles[0].z;
  const fx = lonToTileX(lon, z);
  const fy = latToTileY(lat, z);
  const x = wrapTileX(Math.floor(fx), z);
  const y = Math.floor(fy);
  const tile = tiles.find((item) => item.z === z && item.x === x && item.y === y);
  if (!tile) return null;
  const height = tile.height ?? tile.width;
  const px = (fx - Math.floor(fx)) * tile.width;
  const py = (fy - y) * height;
  const x0 = Math.max(0, Math.min(tile.width - 1, Math.floor(px)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(py)));
  const x1 = Math.min(tile.width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = Math.min(1, Math.max(0, px - x0));
  const ty = Math.min(1, Math.max(0, py - y0));
  const v00 = pixel(tile, x0, y0);
  const v10 = pixel(tile, x1, y0);
  const v01 = pixel(tile, x0, y1);
  const v11 = pixel(tile, x1, y1);
  if (![v00, v10, v01, v11].every(Number.isFinite)) return null;
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

/**
 * Metres between the model's surface pressure and MSLP, on the ISA.
 * A missing or implausible pressure stays missing.
 */
export function modelGroundFromPressure(surfaceHpa: number | null, mslpHpa: number | null): number | null {
  if (surfaceHpa == null || mslpHpa == null) return null;
  if (!(surfaceHpa >= 300 && surfaceHpa <= 1100)) return null;
  if (!(mslpHpa >= 870 && mslpHpa <= 1080)) return null;
  const ground = pressureAltitudeMetres(surfaceHpa) - pressureAltitudeMetres(mslpHpa);
  if (!Number.isFinite(ground) || ground < -500 || ground > 9000) return null;
  return ground;
}

/** Export orography wins. The pressure-derived height is the fallback. */
export function resolveModelGroundM(orographyM: number | null, derivedM: number | null): number | null {
  if (orographyM != null && Number.isFinite(orographyM)) return orographyM;
  if (derivedM != null && Number.isFinite(derivedM)) return derivedM;
  return null;
}

/** Faint annotation on the model surface. Metres, as published. */
export function modelGroundLabel(metres: number): string {
  if (!Number.isFinite(metres)) return '';
  return `model ground ${Math.round(metres).toLocaleString('en-AU')} m`;
}

async function decodeTerrariumImage(blob: Blob): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: image.width, height: image.height, data: image.data };
}

/** Fetch the tiles under the track and sample them. A failed tile stays a gap. */
export async function loadTerrainSection(
  lat: number,
  lon: number,
  options?: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<SectionSample[]> {
  const track = sectionTrack(lat, lon);
  const z = SECTION_ZOOM;
  const wanted = new Map<string, { z: number; x: number; y: number }>();
  const n = 2 ** z;
  for (const point of track) {
    const x = wrapTileX(Math.floor(lonToTileX(point.lon, z)), z);
    const y = Math.floor(latToTileY(point.lat, z));
    if (y < 0 || y >= n) continue;
    wanted.set(`${z}/${x}/${y}`, { z, x, y });
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  const tiles: DecodedTile[] = [];
  await Promise.all([...wanted.values()].map(async (tile) => {
    try {
      const response = await fetchImpl(tileUrl(tile.z, tile.x, tile.y), { signal: options?.signal, cache: 'force-cache' });
      if (!response.ok) return;
      const decoded = await decodeTerrariumImage(await response.blob());
      if (!decoded) return;
      tiles.push({ z: tile.z, x: tile.x, y: tile.y, width: decoded.width, height: decoded.height, rgba: decoded.data });
    } catch {
      /* A failed tile leaves a gap. The next sample still stands. */
    }
  }));
  return elevationsAlong(track, (sampleLon, sampleLat) => sampleTiles(tiles, sampleLon, sampleLat));
}
