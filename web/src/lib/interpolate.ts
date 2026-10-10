/**
 * Time interpolation on an explicit hour ladder.
 * The blend uses the gap between the two adjacent listed hours (3 h or 6 h).
 * A null frame is a missing hour: the sample is missing. The previous hour is not stretched.
 */

export interface FrameBlend {
  i0: number;
  i1: number;
  /** 0 at hours[i0], 1 at hours[i1]. */
  t: number;
}

export function frameBlend(hours: readonly number[], minute: number): FrameBlend | null {
  if (hours.length === 0 || !Number.isFinite(minute)) return null;
  const hour = minute / 60;
  if (hour <= hours[0]) return { i0: 0, i1: 0, t: 0 };
  const last = hours.length - 1;
  if (hour >= hours[last]) return { i0: last, i1: last, t: 0 };
  let index = 0;
  while (index < last - 1 && hours[index + 1] <= hour) index += 1;
  const gap = hours[index + 1] - hours[index];
  if (!(gap > 0)) return null;
  return { i0: index, i1: index + 1, t: (hour - hours[index]) / gap };
}

export function sampleSeries(
  frames: readonly (Float32Array | null)[],
  hours: readonly number[],
  minute: number,
  index: number,
): number {
  const blend = frameBlend(hours, minute);
  if (!blend) return NaN;
  const left = frames[blend.i0];
  const right = frames[blend.i1];
  if (!left || !right) return NaN;
  const a = left[index];
  const b = right[index];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return a + (b - a) * blend.t;
}

/** Index of the listed hour that is exactly `delta` hours earlier, or -1. */
export function hourIndexBefore(hours: readonly number[], index: number, deltaHours: number): number {
  const target = hours[index] - deltaHours;
  return hours.indexOf(target);
}
