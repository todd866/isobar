/**
 * Real time advances one second per second; accelerated rates are minutes/sec.
 * The map drifts forward to the end
 * of the run, then returns to now and drifts forward again. It never plays
 * backwards (owner, 8 Oct 2026: it ran the whole forecast in reverse at 256×).
 */

export const LOOP_HOLD_SECONDS = 0.2;
export const LOOP_DISSOLVE_SECONDS = 0.6;
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
  /** Wall seconds into the endpoint hold and return dissolve. */
  wrapSeconds?: number;
}

export function advancePlayback(clock: Playback, dtSeconds: number, speed: number, spanMinutes: number, nowMinute = 0): Playback {
  if (!clock.playing || !(dtSeconds > 0) || !(spanMinutes >= 0)) return clock;
  const start = Number.isFinite(nowMinute) ? Math.min(Math.max(nowMinute, 0), spanMinutes) : 0;
  const rate = speed === REAL_TIME ? 1 / 60 : (isSpeed(speed) ? speed : DEFAULT_SPEED);
  let minute = clock.followNow && speed === REAL_TIME ? start : Math.max(clock.minute, 0) + dtSeconds * rate;
  if (clock.followNow && speed === REAL_TIME) return { ...clock, minute: start, wrapSeconds: undefined, direction: 1 };
  if (start >= spanMinutes) return { ...clock, minute: spanMinutes, wrapSeconds: undefined, direction: 1 };
  let wrapSeconds = clock.wrapSeconds;
  if (wrapSeconds !== undefined) wrapSeconds += dtSeconds;
  else if (minute >= spanMinutes) wrapSeconds = Math.max(0, (minute - spanMinutes) / rate);
  if (wrapSeconds !== undefined) {
    const duration = LOOP_HOLD_SECONDS + LOOP_DISSOLVE_SECONDS;
    if (wrapSeconds + 1e-9 >= duration) {
      minute = Math.min(spanMinutes, start + Math.max(0, wrapSeconds - duration) * rate);
      wrapSeconds = undefined;
    } else minute = wrapSeconds < LOOP_HOLD_SECONDS ? spanMinutes : start;
  }
  return { ...clock, minute, wrapSeconds, playing: true, direction: 1 };
}

export function isSpeed(value: number): value is Speed {
  return (SPEEDS as readonly number[]).includes(value);
}

export function speedLabel(speed: number): string {
  return speed === REAL_TIME ? 'Real time' : `${speed} min/s`;
}
