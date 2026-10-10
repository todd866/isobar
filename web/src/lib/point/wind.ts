/** Pilot wind group: direction to the nearest 10° (360 for north), then speed. Calm under 1 kt. */

export function nearestTenDegrees(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  const rounded = Math.round(wrapped / 10) * 10;
  return rounded % 360 === 0 ? 360 : rounded;
}

export function directionGroup(deg: number): string {
  return String(nearestTenDegrees(deg)).padStart(3, '0');
}

/** `230/12`, or `Calm` under 1 kt. Missing speed or (when not calm) missing direction stays missing. */
export function pilotWind(fromDeg: number | null | undefined, kt: number | null | undefined): string | null {
  if (kt == null || !Number.isFinite(kt)) return null;
  if (kt < 1) return 'Calm';
  if (fromDeg == null || !Number.isFinite(fromDeg)) return null;
  return `${directionGroup(fromDeg)}/${Math.round(kt)}`;
}
