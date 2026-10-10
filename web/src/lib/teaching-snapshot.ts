import { blendFrame, blendReady, chartFrame, type LoadedChart } from './chart-store';
import { frameBlend } from './interpolate';
import type { ChartManifest } from './manifest';
import { contourPressure } from './contour';
import { teachingFeatures } from './chart-teaching';
import { buildLessons, buildTour } from './teaching-content';

/** Southern-hemisphere lessons apply on the Australian chart, not the whole globe. */
export const TEACHING_AU = { west: 105, east: 168, south: -48, north: 0 };

export function boxesOverlap(
  a: { west: number; east: number; south: number; north: number },
  b: { west: number; east: number; south: number; north: number },
): boolean {
  return a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;
}

/** Crop a world grid to the Australian window the lessons were written for. */
export function cropTeachingInput(input: TeachingInput): TeachingInput {
  const m = input.manifest;
  const dlon = (m.east - m.west) / (m.nx - 1);
  const dlat = (m.north - m.south) / (m.ny - 1);
  if (!(dlon > 0) || !(dlat > 0)) return input;
  const coversMore = m.west < TEACHING_AU.west - 1e-6 || m.east > TEACHING_AU.east + 1e-6
    || m.south < TEACHING_AU.south - 1e-6 || m.north > TEACHING_AU.north + 1e-6;
  if (!coversMore) return input;
  const i0 = Math.max(0, Math.ceil((TEACHING_AU.west - m.west) / dlon - 1e-6));
  const i1 = Math.min(m.nx - 1, Math.floor((TEACHING_AU.east - m.west) / dlon + 1e-6));
  const j0 = Math.max(0, Math.ceil((m.north - TEACHING_AU.north) / dlat - 1e-6));
  const j1 = Math.min(m.ny - 1, Math.floor((m.north - TEACHING_AU.south) / dlat + 1e-6));
  const nx = i1 - i0 + 1;
  const ny = j1 - j0 + 1;
  if (nx < 3 || ny < 3) return input;
  const crop = (src: Float32Array | null) => {
    if (!src) return null;
    const out = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j += 1) out.set(src.subarray((j0 + j) * m.nx + i0, (j0 + j) * m.nx + i1 + 1), j * nx);
    return out;
  };
  const west = m.west + i0 * dlon;
  const east = m.west + i1 * dlon;
  const north = m.north - j0 * dlat;
  const south = m.north - j1 * dlat;
  return {
    ...input,
    manifest: { ...m, nx, ny, west, east, north, south, wrapsLongitude: false },
    mslp: crop(input.mslp) ?? input.mslp,
    wind: crop(input.wind),
    rain: crop(input.rain),
    u: crop(input.u),
    v: crop(input.v),
    airports: input.airports.filter((airport) => airport.lon >= west && airport.lon <= east && airport.lat <= north && airport.lat >= south),
  };
}

export interface TeachingInput {
  manifest: ChartManifest;
  mslp: Float32Array;
  wind: Float32Array | null;
  rain: Float32Array | null;
  u: Float32Array | null;
  v: Float32Array | null;
  airports: NonNullable<LoadedChart['aviation']>['airports'];
  minute: number;
  nowMs: number;
}
export function teachingInput(chart: LoadedChart, minute: number): TeachingInput | null {
  const m = chart.manifest;
  const blend = frameBlend(m.forecastHours, m.forecastHours[0] * 60 + minute);
  const read = (name: string) => blend && m.variables[name] && blendReady(chart, name, blend.i0, blend.i1)
    ? blendFrame(chartFrame(chart, name, blend.i0), chartFrame(chart, name, blend.i1), blend.t, m.variables[name]) : null;
  const mslp = read('mslp');
  return mslp ? { manifest: m, mslp, wind: read('wind'), rain: read('rain24'), u: read('u10'), v: read('v10'), airports: chart.aviation?.airports ?? [], minute, nowMs: Date.now() } : null;
}

/** Runs in a worker. No DOM, requests, clocks or randomness. */
export function computeTeachingSnapshot(input: TeachingInput) {
  const { manifest: m, mslp, wind, rain, u, v, airports, minute, nowMs } = cropTeachingInput(input);
  const centres = contourPressure(mslp, m.nx, m.ny, m.west, m.north, (m.east - m.west) / (m.nx - 1), (m.south - m.north) / (m.ny - 1)).centres;
  const features = teachingFeatures(mslp, m, centres, wind, rain);
  for (const g of [...features.tight, ...(features.strongest ? [features.strongest] : [])]) {
    const i = Math.round((g.lon - m.west) / (m.east - m.west) * (m.nx - 1));
    const j = Math.round((m.north - g.lat) / (m.north - m.south) * (m.ny - 1));
    const uu = u?.[j * m.nx + i], vv = v?.[j * m.nx + i];
    g.surfaceFromDeg = uu == null || vv == null || !Number.isFinite(uu + vv) || Math.hypot(uu, vv) < .1 ? null : (Math.atan2(-uu, -vv) * 180 / Math.PI + 360) % 360;
  }
  const validMs = Date.parse(m.run) + (m.forecastHours[0] * 60 + minute) * 60_000;
  return { lessons: buildLessons(features, centres, airports, validMs, nowMs), tour: buildTour(features, centres, airports, validMs, nowMs), validMs };
}
export type TeachingSnapshot = ReturnType<typeof computeTeachingSnapshot>;
