/**
 * Terrain under a tapped point, offline.
 * The published chart wins when it carries ECMWF surface geopotential
 * (`z`, m²/s²) or orography (`orog`, metres). Otherwise the relief mosaic
 * already loaded for the map is sampled. Neither source invents a height.
 */
import { FRAME_READY, decodeFrame, chartFrame, type LoadedChart } from '../chart-store';
import type { ChartManifest } from '../manifest';
import { FT_PER_M } from '../sky/physics';

/** WMO standard gravity. ECMWF geopotential (m²/s²) ÷ this is metres. */
export const STANDARD_GRAVITY = 9.80665;

/** First match wins. `orog` is already metres; `z` is geopotential. */
const OROGRAPHY_NAMES = ['orog', 'oro', 'z', 'geopotential'];

export function orographyVariable(names: readonly string[]): string | null {
  const byLower = new Map(names.map((name) => [name.toLowerCase(), name]));
  for (const name of OROGRAPHY_NAMES) {
    const found = byLower.get(name);
    if (found) return found;
  }
  return null;
}

/**
 * Model height in metres. Geopotential is converted; a value outside
 * −500…9,000 m is rejected rather than drawn as terrain.
 */
export function metresFromModel(value: number, units: string, name: string): number | null {
  if (!Number.isFinite(value)) return null;
  const text = units.toLowerCase();
  const geopotentialUnits = /m2|m²|m\*\*2|m\^2|s-2|s\*\*-2/.test(text);
  const namedGeopotential = name.toLowerCase() === 'z' || name.toLowerCase() === 'geopotential';
  const metres = geopotentialUnits || (namedGeopotential && !/\bmetre|\bmeter|\bgpm\b|(^|\s)m($|\s)/.test(text))
    ? value / STANDARD_GRAVITY
    : value;
  if (!Number.isFinite(metres) || metres < -500 || metres > 9000) return null;
  return metres;
}

/** Bilinear sample. Missing corners stay missing. Longitude wraps only on a global grid. */
export function sampleFrame(
  frame: Float32Array | null,
  manifest: Pick<ChartManifest, 'nx' | 'ny' | 'west' | 'north' | 'south' | 'step' | 'wrapsLongitude'>,
  lon: number,
  lat: number,
): number | null {
  if (!frame || manifest.nx < 2 || manifest.ny < 2) return null;
  const dlon = manifest.step;
  const dlat = manifest.step;
  if (!(dlon > 0) || !(dlat > 0) || lat < manifest.south || lat > manifest.north) return null;
  let x = (lon - manifest.west) / dlon;
  if (manifest.wrapsLongitude) x = ((x % manifest.nx) + manifest.nx) % manifest.nx;
  else if (x < 0 || x > manifest.nx - 1) return null;
  const y = (manifest.north - lat) / dlat;
  const x0 = manifest.wrapsLongitude ? Math.floor(x) : Math.min(manifest.nx - 2, Math.floor(x));
  const y0 = Math.min(manifest.ny - 2, Math.max(0, Math.floor(y)));
  const tx = x - x0;
  const ty = y - y0;
  const at = (column: number, row: number): number | null => {
    const col = manifest.wrapsLongitude ? ((column % manifest.nx) + manifest.nx) % manifest.nx : column;
    if (col < 0 || col >= manifest.nx || row < 0 || row >= manifest.ny) return null;
    const value = frame[row * manifest.nx + col];
    return Number.isFinite(value) ? value : null;
  };
  const v00 = at(x0, y0);
  const v10 = at(x0 + 1, y0);
  const v01 = at(x0, y0 + 1);
  const v11 = at(x0 + 1, y0 + 1);
  if (v00 == null || v10 == null || v01 == null || v11 == null) return null;
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

/** First ready frame of a named scalar, in the file's own units. Missing stays missing. */
export function chartScalarAt(chart: LoadedChart, name: string, lon: number, lat: number): number | null {
  const spec = chart.manifest.variables[name];
  if (!spec) return null;
  const state = chart.state[name];
  const index = state?.findIndex((cell) => cell === FRAME_READY) ?? -1;
  if (index < 0) return null;
  const cells = chart.manifest.nx * chart.manifest.ny;
  const packed = chartFrame(chart, name, index);
  if (packed.length !== cells) return null;
  const frame = decodeFrame(packed, spec);
  return sampleFrame(frame, chart.manifest, lon, lat);
}

/** Orography at a point, from the first ready frame. Absent field or frame is null. */
export function orographyMetresAt(chart: LoadedChart, lon: number, lat: number): number | null {
  const name = orographyVariable(Object.keys(chart.manifest.variables));
  if (!name) return null;
  const value = chartScalarAt(chart, name, lon, lat);
  return value == null ? null : metresFromModel(value, chart.manifest.variables[name].units, name);
}

/** Export orography, else the DEM sample, else nothing. */
export function resolveGroundM(orographyM: number | null, demM: number | null): number | null {
  if (orographyM != null && Number.isFinite(orographyM)) return orographyM;
  if (demM != null && Number.isFinite(demM)) return demM;
  return null;
}

/** Header pair, metres then feet: `4,520 m / 14,829 ft`. */
export function formatGround(elevationM: number): string {
  if (!Number.isFinite(elevationM)) return '';
  const metres = Math.round(elevationM).toLocaleString('en-AU');
  const feet = Math.round(elevationM * FT_PER_M).toLocaleString('en-AU');
  return `${metres} m / ${feet} ft`;
}
