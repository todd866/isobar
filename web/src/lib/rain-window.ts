/**
 * Which run supplies the 24 h rain ending at a valid time.
 * ECMWF `tp` is accumulated from each run's start, so the 24 h ending at
 * `validMs` is tp(valid) − tp(valid − 24 h) taken from ONE run. The first
 * eight frames of a run (0–21 h) have no such window in that run; like the
 * macOS app, they come from the newest earlier run that holds both hours.
 * Nothing is stretched: with no run holding both ends, the frame stays missing.
 */

export interface RainRun {
  id: string;
  runMs: number;
  /** True when this run has a tp grid at `hour` (whole hours after runMs). */
  has(hour: number): boolean;
}

export interface RainWindow {
  id: string;
  endHour: number;
  startHour: number;
}

const DAY_MS = 24 * 3_600_000;

/** `runs` newest first. The first run whose window lies inside it wins. */
export function rainWindowSource(validMs: number, runs: readonly RainRun[]): RainWindow | null {
  for (const run of runs) {
    const startMs = validMs - DAY_MS;
    if (startMs < run.runMs) continue;
    const endHour = Math.round((validMs - run.runMs) / 3_600_000);
    const startHour = Math.round((startMs - run.runMs) / 3_600_000);
    if (run.has(endHour) && run.has(startHour)) return { id: run.id, endHour, startHour };
  }
  return null;
}
