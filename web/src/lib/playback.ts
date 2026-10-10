/**
 * Real time advances one second per second; accelerated rates are minutes/sec.
 * The map drifts forward to the end
 * of the run, then returns to now and drifts forward again. It never plays
 * backwards (owner, 8 Oct 2026: it ran the whole forecast in reverse at 256×).
 */

export const REAL_TIME = 0;
export const SPEEDS = [REAL_TIME, 1, 2, 4, 8, 16, 32, 64, 128, 256] as const;
export type Speed = (typeof SPEEDS)[number];
export const DEFAULT_SPEED: Speed = 8;

export interface Playback {
  minute: number;
  playing: boolean;
  direction: 1 | -1;
  /** Only Now follows wall time. Rewinding at Real time keeps its historical offset. */
  followNow?: boolean;
}

export function advancePlayback(clock: Playback, dtSeconds: number, speed: number, spanMinutes: number, nowMinute = 0): Playback {
  if (!clock.playing || !(dtSeconds > 0) || !(spanMinutes >= 0)) return clock;
  const start = Number.isFinite(nowMinute) ? Math.min(Math.max(nowMinute, 0), spanMinutes) : 0;
  const rate = speed === REAL_TIME ? 1 / 60 : (isSpeed(speed) ? speed : DEFAULT_SPEED);
  let minute = clock.followNow && speed === REAL_TIME ? start : Math.max(clock.minute, 0) + dtSeconds * rate;
  if (minute >= spanMinutes) minute = start;
  return { ...clock, minute, playing: true, direction: 1 };
}

export function isSpeed(value: number): value is Speed {
  return (SPEEDS as readonly number[]).includes(value);
}

export function speedLabel(speed: number): string {
  return speed === REAL_TIME ? 'Real time' : `${speed} min/s`;
}
