/** Screen-scale generalisation. Pressure geometry remains on the 2 hPa ladder. */
import type { PressureCentre } from './contour';
import { unproject, type Camera, type Lambert } from './lambert';

export const WORLD_SPAN_DEG = 100;
export const REGIONAL_SPAN_DEG = 72;
export const CLOSE_SPAN_DEG = 24;
export const HIGH_TERRAIN_M = 1500;
export const HIGH_TERRAIN_ALPHA = 0.24;
/** Ring depth, not an absolute pressure: retain only exceptional terrain centres. */
export const DEEP_TERRAIN_HPA = 12;
export type ElevationAt = (lon: number, lat: number) => number | null;

const fade = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

export function latitudeSpan(geo: Lambert, camera: Camera): number {
  if (geo.projection === 'equirectangular') return camera.halfHeight * 2;
  const north = unproject(geo, camera.centerX, camera.centerY + camera.halfHeight);
  const south = unproject(geo, camera.centerX, camera.centerY - camera.halfHeight);
  return north && south ? Math.abs(north.lat - south.lat) : REGIONAL_SPAN_DEG;
}

/** Nominal interval; new intermediate lines and their labels fade together. */
export function isobarInterval(span: number): 2 | 4 | 8 {
  return span >= WORLD_SPAN_DEG ? 8 : span >= CLOSE_SPAN_DEG ? 4 : 2;
}

export function isobarOpacity(level: number, span: number): number {
  const multiple = (step: number) => Math.abs(level / step - Math.round(level / step)) < 1e-6;
  if (!multiple(2)) return 0;
  if (multiple(8)) return 1;
  if (multiple(4)) return fade((WORLD_SPAN_DEG - span) / (WORLD_SPAN_DEG - REGIONAL_SPAN_DEG));
  return fade((CLOSE_SPAN_DEG - span) / 6);
}

/** Missing elevation is unknown, never treated as measured low ground. */
export function terrainIsobarStyle(elevation: number | null): { alpha: number; dashed: boolean } {
  return elevation !== null && Number.isFinite(elevation) && elevation > HIGH_TERRAIN_M
    ? { alpha: HIGH_TERRAIN_ALPHA, dashed: true } : { alpha: 1, dashed: false };
}

/** Midpoint of the short geographic segment, including either dateline copy. */
export function segmentMidLongitude(a: number, b: number): number {
  return a + (((b - a + 540) % 360) - 180) / 2;
}

export interface ScreenCentre { centre: PressureCentre; point: { x: number; y: number } }

/** Call with visible, unobstructed candidates so offscreen centres never consume the cap. */
export function selectPressureCentres<T extends ScreenCentre>(candidates: T[], span: number, elevationAt?: ElevationAt): T[] {
  const worldWeight = fade((span - REGIONAL_SPAN_DEG) / (WORLD_SPAN_DEG - REGIONAL_SPAN_DEG));
  const threshold = 2 + 2 * worldWeight;
  const spacing = 64 + 26 * worldWeight;
  const cap = span >= WORLD_SPAN_DEG ? 12 : Infinity;
  const counts = { H: 0, L: 0 };
  const selected: T[] = [];
  const ranked = candidates.filter(({ centre }) => Number.isFinite(centre.prominence) && centre.prominence >= threshold)
    .slice().sort((a, b) => b.centre.prominence - a.centre.prominence || a.centre.lon - b.centre.lon || a.centre.lat - b.centre.lat);
  for (const item of ranked) {
    const { centre, point } = item;
    if (counts[centre.kind] >= cap) continue;
    if (terrainIsobarStyle(elevationAt?.(centre.lon, centre.lat) ?? null).dashed && centre.prominence < DEEP_TERRAIN_HPA) continue;
    if (selected.some((other) => Math.hypot(point.x - other.point.x, point.y - other.point.y) < spacing)) continue;
    selected.push(item);
    counts[centre.kind]++;
  }
  return selected;
}
