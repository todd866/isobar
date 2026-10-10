/**
 * UV index for the selected place. The figure is the nearest integer and is
 * shown at 3 or above; below that, and any missing value, stays off the
 * surface. Colour is the WHO category. The number is always the signal.
 * Sun protection is the Australian window: the first and last local hour in
 * that day whose index rounds to 3 or above.
 */
import { zonedStamp } from '../time-label';

export type UvCategory = 'moderate' | 'high' | 'very-high' | 'extreme';

export interface UvFigure {
  index: number;
  category: UvCategory;
}

const HOUR_MS = 3_600_000;

export function uvCategory(index: number): UvCategory {
  if (index <= 5) return 'moderate';
  if (index <= 7) return 'high';
  if (index <= 10) return 'very-high';
  return 'extreme';
}

/** Nearest integer, or null when there is nothing to show. */
export function uvFigure(value: number | null | undefined): UvFigure | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const index = Math.round(value);
  if (index < 3) return null;
  return { index, category: uvCategory(index) };
}

/**
 * The hourly sample that contains `timeMs`. A gap longer than an hour, or a
 * sample with no value, stays missing. UV is not interpolated.
 */
export function uvAtHour(times: readonly number[], values: readonly (number | null)[], timeMs: number): number | null {
  for (let i = 0; i < times.length; i += 1) {
    const start = times[i];
    const next = i + 1 < times.length ? times[i + 1] : start + HOUR_MS;
    const end = Math.min(next, start + HOUR_MS);
    if (timeMs >= start && timeMs < end) return values[i] ?? null;
  }
  return null;
}

function clockHour(ms: number, zone: string): string {
  const stamp = zonedStamp(ms, zone);
  return `${stamp.hour} ${stamp.dayPeriod}`;
}

/** One line, or null when no hour in the local day reaches 3. */
export function sunProtectionLabel(
  hours: readonly { time: number; uv: number | null }[],
  dayStart: number,
  dayEnd: number,
  zone: string,
): string | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const hour of hours) {
    if (hour.time < dayStart || hour.time >= dayEnd) continue;
    if (!uvFigure(hour.uv)) continue;
    if (first == null || hour.time < first) first = hour.time;
    if (last == null || hour.time > last) last = hour.time;
  }
  if (first == null || last == null) return null;
  const start = clockHour(first, zone);
  const end = clockHour(last, zone);
  return start === end ? `Sun protection ${start}` : `Sun protection ${start}–${end}`;
}
