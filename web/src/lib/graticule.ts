/**
 * Optional latitude/longitude grid. Off until this browser turns it on.
 * Spacing is one of 10°, 5°, 1°, 0.5°, from the shorter side of the view.
 */

export const GRATICULE_KEY = 'isobar.graticule';

export function readGraticule(storage: { getItem(key: string): string | null } | null): boolean {
  try {
    return storage?.getItem(GRATICULE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeGraticule(storage: { setItem(key: string, value: string): void } | null, on: boolean): void {
  try {
    storage?.setItem(GRATICULE_KEY, on ? '1' : '0');
  } catch { /* private window: the choice still holds for this visit */ }
}

/** Degrees between grid lines for a view `spanDeg` across (the shorter side). */
export function graticuleStep(spanDeg: number): 10 | 5 | 1 | 0.5 {
  if (!(spanDeg > 0) || spanDeg >= 36) return 10;
  if (spanDeg >= 12) return 5;
  if (spanDeg >= 3) return 1;
  return 0.5;
}

/** Edge label: `50°N`, `120°W`, `0.5°S`, `0°`, `180°`. */
export function graticuleText(value: number, axis: 'lat' | 'lon'): string {
  let v = value;
  if (axis === 'lon') {
    v = ((v + 180) % 360 + 360) % 360 - 180;
    if (v <= -180 + 1e-6) v = 180;
  }
  const abs = Math.abs(v);
  if (abs < 1e-6) return '0°';
  const rounded = Math.abs(abs - Math.round(abs)) < 1e-6 ? String(Math.round(abs)) : abs.toFixed(1).replace(/\.0$/, '');
  if (axis === 'lat') return `${rounded}°${v > 0 ? 'N' : 'S'}`;
  if (Math.abs(abs - 180) < 1e-6) return '180°';
  return `${rounded}°${v > 0 ? 'E' : 'W'}`;
}
