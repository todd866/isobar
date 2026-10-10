/**
 * Model point series at each configured place (points.json): the header's
 * "now" reading and the day tiles. Hours follow the manifest; a null value is
 * a missing hour and stays missing.
 */

import { addLocalDays, localDayKey, localMidnight, weekdayShort } from './time-label';

export interface PointSeries {
  /** 2 m temperature, °C. */
  t: (number | null)[];
  /** 10 m wind speed, kt. */
  wspd: (number | null)[];
  /** 10 m wind direction it blows FROM, degrees true. */
  wdir: (number | null)[];
  /** Total precipitation accumulated from the run start, mm. */
  tp: (number | null)[];
  /** Total cloud cover, %. */
  cc: (number | null)[];
}

export interface PointsFile {
  run: string;
  hours: number[];
  places: Record<string, PointSeries>;
}

export function readPoints(json: unknown): PointsFile | null {
  if (!json || typeof json !== 'object') return null;
  const value = json as Record<string, unknown>;
  if (typeof value.run !== 'string' || !Array.isArray(value.hours) || !value.places || typeof value.places !== 'object') return null;
  return value as unknown as PointsFile;
}

const H = 3_600_000;

/** Linear in time between the listed hours; null outside the run or across a missing hour. */
export function seriesAt(values: readonly (number | null)[], hours: readonly number[], runMs: number, ms: number): number | null {
  const hour = (ms - runMs) / H;
  if (!(hour >= hours[0] && hour <= hours[hours.length - 1])) return null;
  let i = 0;
  while (i < hours.length - 2 && hours[i + 1] <= hour) i += 1;
  const a = values[i];
  const b = values[i + 1];
  if (hours.length === 1 || hour === hours[i]) return a;
  if (a == null || b == null) return null;
  const t = (hour - hours[i]) / (hours[i + 1] - hours[i]);
  return a + (b - a) * t;
}

export interface NowReading {
  tempC: number | null;
  windKt: number | null;
  /** Degrees true the wind blows from. */
  windFrom: number | null;
}

export function readingAt(points: PointsFile, placeId: string, ms: number): NowReading {
  const series = points.places[placeId];
  const runMs = Date.parse(points.run);
  if (!series) return { tempC: null, windKt: null, windFrom: null };
  const hour = (ms - runMs) / H;
  // Direction: interpolate the wind vector, not the angle.
  let windFrom: number | null = null;
  const hours = points.hours;
  if (hour >= hours[0] && hour <= hours[hours.length - 1]) {
    let i = 0;
    while (i < hours.length - 2 && hours[i + 1] <= hour) i += 1;
    const t = hours.length > 1 ? Math.min(1, Math.max(0, (hour - hours[i]) / (hours[i + 1] - hours[i]))) : 0;
    const pick = (k: number) => {
      const d = series.wdir[k];
      const s = series.wspd[k];
      if (d == null || s == null) return null;
      const r = (d * Math.PI) / 180;
      return { x: Math.sin(r) * s, y: Math.cos(r) * s };
    };
    const a = pick(i);
    const b = pick(Math.min(hours.length - 1, i + 1));
    if (a && b) {
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const deg = (Math.atan2(x, y) * 180) / Math.PI;
      windFrom = Math.round(deg < 0 ? deg + 360 : deg) % 360;
    }
  }
  return {
    tempC: seriesAt(series.t, hours, runMs, ms),
    windKt: seriesAt(series.wspd, hours, runMs, ms),
    windFrom,
  };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export type SkyIcon = 'sun' | 'partly' | 'cloud' | 'drizzle' | 'rain';

export interface DaySummary {
  event?: {title: string; detail: string; source: string};
  historical?: boolean;
  key: string;
  weekday: string;
  dayStart: number;
  dayEnd: number;
  hi: number | null;
  lo: number | null;
  /** Model rain in the part of the day the run covers, mm. */
  rain: number | null;
  icon: SkyIcon | null;
  /** Daily wind, kt. Set for an Open-Meteo place; absent on collector days. */
  windKt?: number | null;
  /** Degrees the wind blows from. */
  windFrom?: number | null;
  /** Rounded daily maximum UV index, shown when it is at least 3. */
  uv?: number | null;
  /** Sun-protection window for this local day, one line. */
  protection?: string | null;
}

/** Local days that overlap the run, each summarised from the 3-hourly point series. */
export function daySummaries(points: PointsFile, placeId: string, zone: string): DaySummary[] {
  const series = points.places[placeId];
  if (!series) return [];
  const runMs = Date.parse(points.run);
  const hours = points.hours;
  const first = runMs + hours[0] * H;
  const last = runMs + hours[hours.length - 1] * H;
  const days: DaySummary[] = [];
  for (let dayStart = localMidnight(first, zone); dayStart < last; dayStart = addLocalDays(dayStart, 1, zone)) {
    const dayEnd = addLocalDays(dayStart, 1, zone);
    const temps: number[] = [];
    const cover: number[] = [];
    hours.forEach((hour, index) => {
      const at = runMs + hour * H;
      if (at < dayStart || at >= dayEnd) return;
      const t = series.t[index];
      if (t != null) temps.push(t);
      const localHour = (at - dayStart) / H;
      const c = series.cc[index];
      if (c != null && localHour >= 6 && localHour <= 18) cover.push(c);
    });
    const from = Math.max(dayStart, first);
    const to = Math.min(dayEnd, last);
    const tpEnd = seriesAt(series.tp, hours, runMs, to);
    const tpStart = seriesAt(series.tp, hours, runMs, from);
    const rain = tpEnd != null && tpStart != null ? Math.max(0, tpEnd - tpStart) : null;
    const meanCover = cover.length ? cover.reduce((sum, value) => sum + value, 0) / cover.length : null;
    let icon: SkyIcon | null = null;
    if (rain != null && rain >= 1) icon = 'rain';
    else if (rain != null && rain >= 0.2) icon = 'drizzle';
    else if (meanCover != null) icon = meanCover >= 70 ? 'cloud' : meanCover >= 30 ? 'partly' : 'sun';
    days.push({
      key: localDayKey(dayStart, zone),
      weekday: weekdayShort(dayStart + 12 * H, zone),
      dayStart,
      dayEnd,
      hi: temps.length >= 2 ? Math.round(Math.max(...temps)) : null,
      lo: temps.length >= 2 ? Math.round(Math.min(...temps)) : null,
      rain,
      icon,
    });
  }
  return days;
}

/** "21", "2.9", "0.4": one decimal under 10 mm, none above; null when dry (< 0.2 mm). */
export function rainLabel(mm: number | null): string | null {
  if (mm == null || mm < 0.2) return null;
  return mm >= 10 ? String(Math.round(mm)) : mm.toFixed(1);
}
