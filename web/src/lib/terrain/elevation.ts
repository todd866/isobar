import { float16ToNumber } from '../float16';
import type { ElevationAt } from '../map-generalise';
import type { TerrainMosaic } from './terrain-layer';

/** Two mosaics at most: retain measured coverage while a new view's tiles arrive.
 * Terrain is static; a missing new tile need not erase a previous measurement. */
export function createElevationCoverage(): (mosaic: TerrainMosaic) => ElevationAt {
  let current: TerrainMosaic | null = null;
  let fallback: ElevationAt | undefined;
  return (mosaic) => {
    if (current && current.covered > 0 && (current.z !== mosaic.z || current.width !== mosaic.width || current.height !== mosaic.height
      || current.box.west !== mosaic.box.west || current.box.east !== mosaic.box.east
      || current.box.south !== mosaic.box.south || current.box.north !== mosaic.box.north)) {
      fallback = mosaicElevation(current);
    }
    current = mosaic;
    const sample = mosaicElevation(mosaic);
    return (lon, lat) => sample(lon, lat) ?? fallback?.(lon, lat) ?? null;
  };
}

/** Same south-first pixel centres as the plate. No extrapolation over missing tiles. */
export function mosaicElevation(mosaic: TerrainMosaic): ElevationAt {
  const { box, width, height, data } = mosaic;
  return (lon, lat) => {
    lon += Math.round(((box.west + box.east) / 2 - lon) / 360) * 360;
    if (lon < box.west || lon > box.east || lat < box.south || lat > box.north) return null;
    const x = Math.max(0, Math.min(width - 1, (lon - box.west) / (box.east - box.west) * width - 0.5));
    const y = Math.max(0, Math.min(height - 1, (lat - box.south) / (box.north - box.south) * height - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    const at = (xx: number, yy: number) => {
      const i = (yy * width + xx) * 2;
      const coverage = float16ToNumber(data[i + 1]);
      return coverage >= 0.99 ? float16ToNumber(data[i]) : NaN;
    };
    const blend = (a: number, b: number, t: number) => t === 0 ? a : t === 1 ? b : a * (1 - t) + b * t;
    const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
    const value = blend(blend(at(x0, y0), at(x1, y0), tx), blend(at(x0, y1), at(x1, y1), tx), ty);
    return Number.isFinite(value) ? value : null;
  };
}
