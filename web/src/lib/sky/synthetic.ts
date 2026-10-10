/**
 * Synthetic profiles for tests and the preview gallery. Never used for real
 * weather: missing data stays missing in the app.
 */
import type { Profile, ProfileLevel } from './physics';

/** ISA heights of the 13 ECMWF pressure levels, m. */
export const ISA_LEVELS: [number, number][] = [
  [1000, 111], [925, 762], [850, 1457], [700, 3012], [600, 4206], [500, 5574], [400, 7185],
  [300, 9164], [250, 10363], [200, 11784], [150, 13608], [100, 16180], [50, 20576],
];

export interface SynthOptions {
  surfaceT: number;
  /** Lapse rate, °C per km (default 6.5). */
  lapse?: number;
  /** Height up to which `lapse` applies, m; 6.5 °C/km above it. */
  lapseTop?: number;
  rh: (zM: number) => number;
  cloud?: (zM: number) => number;
  wind?: (zM: number) => [number, number];
  timeMs?: number;
}

export function synthProfile(options: SynthOptions): Profile {
  const lapse = options.lapse ?? 6.5;
  const top = options.lapseTop ?? Infinity;
  const levels: ProfileLevel[] = ISA_LEVELS.map(([hPa, z]) => {
    const raw = z <= top ? options.surfaceT - (lapse * z) / 1000 : options.surfaceT - (lapse * top) / 1000 - (6.5 * (z - top)) / 1000;
    const t = Math.max(-58, raw);
    const [kt, from] = options.wind ? options.wind(z) : [10 + z / 400, 270];
    return { hPa, zM: z, tC: t, rh: options.rh(z), windKt: kt, windFrom: from, cloudPct: options.cloud ? options.cloud(z) : null, wMs: 0 };
  });
  return { timeMs: options.timeMs ?? 0, samples: [options.timeMs ?? 0], levels };
}
