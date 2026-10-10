import { profileAt, type Profile, type ProfileLevel } from './sky/physics';
import type { PointModel } from './point/openmeteo';

/** A renderable model level. Values are those available at the selected time. */
export interface AtmosphereLevel {
  heightM: number;
  pressureHpa: number;
  temperatureC: number | null;
  relativeHumidityPct: number | null;
  cloudFractionPct: number | null;
  windKt: number | null;
  windFromDeg: number | null;
  /** Null means that the source did not provide vertical velocity. */
  verticalVelocityMs: number | null;
}

export type AtmosphereSourceKind = 'open-meteo' | 'collector' | 'forecast-profile';

export interface AtmosphereSource {
  kind: AtmosphereSourceKind;
  source: string;
  model: string;
  run: string;
  cycleKnown: boolean;
}

/** A broad, representative cloud envelope; it is not an observed cloud boundary. */
export interface AtmosphereLayer {
  id: string;
  baseM: number;
  topM: number;
  cloudFractionPct: number;
  uncertaintyM: number;
  sourceKind: AtmosphereSourceKind;
  temperatureC: number | null;
  relativeHumidityPct: number | null;
  windKt: number | null;
  windFromDeg: number | null;
}

export interface AtmosphereProfile {
  timeMs: number;
  terrainM: number | null;
  source: AtmosphereSource;
  levels: AtmosphereLevel[];
  layers: AtmosphereLayer[];
}

export interface AtmosphereProfileOptions {
  /** Cloud cover at or above this level contributes to a representative envelope. */
  cloudThresholdPct?: number;
}

const DEFAULT_CLOUD_THRESHOLD = 20;

function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function sourceKind(source: string): AtmosphereSourceKind {
  const normalized = source.toLowerCase();
  if (normalized.includes('open-meteo')) return 'open-meteo';
  if (normalized.includes('ecmwf') || normalized.includes('collector')) return 'collector';
  return 'forecast-profile';
}

function toLevel(level: ProfileLevel): AtmosphereLevel | null {
  const heightM = finite(level.zM);
  if (heightM == null || heightM <= 0 || !Number.isFinite(level.hPa) || level.hPa <= 0) return null;
  return {
    heightM,
    pressureHpa: level.hPa,
    temperatureC: finite(level.tC),
    relativeHumidityPct: finite(level.rh),
    cloudFractionPct: finite(level.cloudPct),
    windKt: finite(level.windKt),
    windFromDeg: finite(level.windFrom),
    verticalVelocityMs: finite(level.wMs),
  };
}

function sourceFor(model: PointModel): AtmosphereSource {
  return {
    kind: sourceKind(model.provenance.source),
    source: model.provenance.source,
    model: model.provenance.model,
    run: model.provenance.run,
    cycleKnown: model.provenance.cycle,
  };
}

interface Candidate {
  level: AtmosphereLevel;
  baseM: number;
  topM: number;
  uncertaintyM: number;
}

function candidates(levels: AtmosphereLevel[], threshold: number, terrainM: number | null): Candidate[] {
  const cloudy = levels.filter((level) => level.cloudFractionPct != null && level.cloudFractionPct >= threshold);
  return cloudy.flatMap((level) => {
    const index = levels.indexOf(level);
    const below = levels[index - 1];
    const above = levels[index + 1];
    const belowGap = below ? Math.max(100, level.heightM - below.heightM) : (above ? Math.max(100, above.heightM - level.heightM) : 500);
    const aboveGap = above ? Math.max(100, above.heightM - level.heightM) : belowGap;
    let baseM = level.heightM - belowGap / 2;
    let topM = level.heightM + aboveGap / 2;
    if (terrainM != null) baseM = Math.max(baseM, terrainM);
    baseM = Math.max(0, baseM);
    topM = Math.max(baseM, topM);
    if (topM <= 0 || topM <= baseM) return [];
    return [{ level, baseM, topM, uncertaintyM: Math.max(belowGap, aboveGap) / 2 }];
  });
}

function mergeLayers(items: Candidate[], kind: AtmosphereSourceKind): AtmosphereLayer[] {
  const merged: AtmosphereLayer[] = [];
  for (const item of items.sort((a, b) => a.baseM - b.baseM)) {
    const last = merged[merged.length - 1];
    if (!last || item.baseM > last.topM) {
      merged.push({
        id: `cloud-${merged.length + 1}`,
        baseM: item.baseM,
        topM: item.topM,
        cloudFractionPct: item.level.cloudFractionPct as number,
        uncertaintyM: item.uncertaintyM,
        sourceKind: kind,
        temperatureC: item.level.temperatureC,
        relativeHumidityPct: item.level.relativeHumidityPct,
        windKt: item.level.windKt,
        windFromDeg: item.level.windFromDeg,
      });
      continue;
    }
    const weight = Math.max(1, last.topM - last.baseM);
    const nextWeight = Math.max(1, item.topM - item.baseM);
    const total = weight + nextWeight;
    last.topM = Math.max(last.topM, item.topM);
    last.cloudFractionPct = (last.cloudFractionPct * weight + (item.level.cloudFractionPct as number) * nextWeight) / total;
    last.uncertaintyM = Math.max(last.uncertaintyM, item.uncertaintyM);
  }
  return merged;
}

/** Build bounded, representative atmosphere geometry for one forecast time. */
export function buildAtmosphereProfile(model: PointModel | null, timeMs: number, options: AtmosphereProfileOptions = {}): AtmosphereProfile | null {
  if (!model || !Number.isFinite(timeMs)) return null;
  const profile: Profile | null = profileAt(model.series, timeMs);
  if (!profile) return null;
  const terrain = finite(model.elevationM);
  const levels = profile.levels.map(toLevel).filter((level): level is AtmosphereLevel => level != null && (terrain == null || level.heightM >= terrain)).sort((a, b) => a.heightM - b.heightM);
  const threshold = Math.min(100, Math.max(0, finite(options.cloudThresholdPct) ?? DEFAULT_CLOUD_THRESHOLD));
  const source = sourceFor(model);
  return {
    timeMs,
    terrainM: terrain,
    source,
    levels,
    layers: mergeLayers(candidates(levels, threshold, terrain), source.kind),
  };
}
