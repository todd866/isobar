/** Day-strip rain in mm: blank is dry; null is unavailable. */
export function dayRainLabel(mm: number | null | undefined): string | null {
  if (mm == null || !Number.isFinite(mm) || mm < 0) return null;
  return mm < 0.1 ? '' : mm.toFixed(1);
}
