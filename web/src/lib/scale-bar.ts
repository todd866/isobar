/**
 * Map scale bar. The length is a 1/2/5×10^n distance in the primary unit,
 * measured at the centre latitude (a degree of longitude shrinks toward the poles).
 * AUS and metric LOCAL show kilometres; US and statute-mile LOCAL show miles.
 * Nautical miles are always the second figure.
 */
import { haversineKm } from './place-catalog';
import { mapUnproject, type Camera, type Lambert } from './lambert';

const METRES: Record<'km' | 'mi', number> = { km: 1000, mi: 1609.344 };
const NM = 1852;

export type ScaleUnit = 'km' | 'mi';

/** Ground metres across the camera, using the local scale at its centre. */
export function centreWidthMetres(geo: Lambert, camera: Camera): number | null {
  if (!(camera.halfWidth > 0)) return null;
  const frac = 0.08;
  const centre = mapUnproject(geo, camera, 0, 0);
  const east = mapUnproject(geo, camera, frac, 0);
  if (!centre || !east) return null;
  const km = haversineKm(centre.lat, centre.lon, east.lat, east.lon);
  if (!(km > 0)) return null;
  return km * 1000 * (2 / frac);
}

/** Nearest 1, 2 or 5 × 10^n, in log space. */
export function nice125(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return value;
  const exp = Math.floor(Math.log10(value));
  const base = value / 10 ** exp;
  const marks = [1, 2, 5, 10];
  let best = 1;
  let bestDistance = Infinity;
  for (const mark of marks) {
    const distance = Math.abs(Math.log(base) - Math.log(mark));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = mark;
    }
  }
  return best * 10 ** exp;
}

function step125(nice: number, direction: -1 | 1): number {
  const exp = Math.floor(Math.log10(nice * (direction < 0 ? 0.999 : 1)));
  const base = Math.round(nice / 10 ** exp);
  const order = [1, 2, 5, 10];
  const index = order.indexOf(base);
  const next = (index < 0 ? 0 : index) + direction;
  if (next >= 0 && next < order.length) return order[next] * 10 ** exp;
  return direction > 0 ? 10 ** (exp + 1) : 5 * 10 ** (exp - 1);
}

function formatCount(value: number): string {
  if (value >= 10) return String(Math.round(value));
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export interface ScaleBarModel {
  metres: number;
  px: number;
  primary: string;
  nautical: string;
  label: string;
}

/**
 * A bar about `targetPx` long. The primary number is 1/2/5×10^n; nautical
 * miles are that same ground length.
 */
export function scaleBar(viewMetres: number, widthPx: number, unit: ScaleUnit, targetPx = 100): ScaleBarModel | null {
  if (!(viewMetres > 0) || !(widthPx > 0) || !(targetPx > 0)) return null;
  const per = METRES[unit];
  let nice = nice125((viewMetres * targetPx) / widthPx / per);
  let metres = nice * per;
  let px = (metres / viewMetres) * widthPx;
  for (let i = 0; i < 6 && (px > targetPx * 1.6 || px < targetPx * 0.55); i += 1) {
    nice = step125(nice, px > targetPx ? -1 : 1);
    if (!(nice > 0)) break;
    metres = nice * per;
    px = (metres / viewMetres) * widthPx;
  }
  const primary = `${formatCount(nice)} ${unit}`;
  const nautical = `${formatCount(metres / NM)} nm`;
  return { metres, px, primary, nautical, label: `${primary}, ${nautical}` };
}

/** AUS is kilometres. US is statute miles. LOCAL follows that region's visibility unit. */
export function scaleUnit(units: { mode: string; visibility: string }): ScaleUnit {
  if (units.mode === 'us') return 'mi';
  if (units.mode === 'local' && units.visibility === 'sm') return 'mi';
  return 'km';
}
