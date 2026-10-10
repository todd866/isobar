import { describePoint } from '../place-name';
import { esWater, FT_PER_M, skyState, type Profile, type ProfileLevel, type ProfileSeries, type SkyState } from '../sky/physics';
import { formatIsobar, metricFlightLevel, pressureAltitudeMetres, type DisplayUnits } from '../units';
import type { PointModel, PointProvenance, PointSurface } from './openmeteo';

export interface MapPoint { lat: number; lon: number }

export function pointName(point: MapPoint, places: readonly (MapPoint & { name: string })[]): string {
  return describePoint(point, {
    places: places.map((place) => ({ name: place.name, lat: place.lat, lon: place.lon, rank: 0, kind: 'town' as const })),
  }).title;
}

/** Flight levels use pressure altitude, not the model's geopotential height. */
export function flightLevel(hPa: number): number {
  const z = hPa >= 226.32 ? 44330.77 * (1 - (hPa / 1013.25) ** 0.190263) : 11000 - 6341.62 * Math.log(hPa / 226.32);
  return Math.round(z * FT_PER_M / 100);
}

/**
 * Axis label: nearest 100 ft below 10,000 ft AMSL, otherwise the pressure
 * flight level to the nearest 10. The unrounded height stays in the row title.
 */
export function levelLabel(hPa: number, heightM: number, units?: DisplayUnits): string {
  const feet = heightM * FT_PER_M;
  const transition = units?.transitionFt ?? 10000;
  const metric = units?.flightLevel === 'metric';
  const metres = units?.height === 'm';
  if (!metric && !metres && transition === 10000) {
    if (feet < 10000) return `${(Math.round(feet / 100) * 100).toLocaleString('en-AU')} ft`;
    const fl = Math.round(flightLevel(hPa) / 10) * 10;
    return `FL${String(fl).padStart(3, '0')}`;
  }
  if (feet < transition) {
    if (metres) return `${Math.round(heightM).toLocaleString('en-AU')} m`;
    return `${(Math.round(feet / 100) * 100).toLocaleString('en-AU')} ft`;
  }
  if (metric) return metricFlightLevel(pressureAltitudeMetres(hPa))?.code ?? '';
  const fl = Math.round(flightLevel(hPa) / 10) * 10;
  return `FL${String(fl).padStart(3, '0')}`;
}

/** Exact geopotential height for the row title, not the rounded axis label. */
export function levelExact(heightM: number, units?: DisplayUnits): string {
  if (units?.height === 'm') return `${Math.round(heightM).toLocaleString('en-AU')} m AMSL`;
  return `${Math.round(heightM * FT_PER_M).toLocaleString('en-AU')} ft AMSL`;
}

/** Pressure and height for the row tooltip. A metric flight level includes its feet. */
export function levelTitle(hPa: number, heightM: number, units?: DisplayUnits): string {
  const pressure = units?.pressure === 'inHg' ? `${formatIsobar(hPa, units)} inHg` : `${hPa} hPa`;
  const feet = heightM * FT_PER_M;
  if (units?.flightLevel === 'metric' && feet >= units.transitionFt) {
    const fl = metricFlightLevel(pressureAltitudeMetres(hPa));
    const feetText = fl ? `${fl.feet.toLocaleString('en-AU')} ft` : levelExact(heightM);
    return `${pressure} · ${fl?.code ?? ''} · ${feetText}`;
  }
  return `${pressure} · ${levelExact(heightM, units)}`;
}

export const isaTemperature = (heightM: number) => 15 - 0.0065 * Math.min(11000, heightM);

/** The collector series already names its own cycle; do not borrow the map's. */
export function seriesProvenance(series: ProfileSeries): PointProvenance {
  return {
    source: series.source ?? 'ECMWF',
    model: series.model ?? 'ecmwf_ifs025',
    run: series.run,
    cycle: series.runKnown !== false,
  };
}

/** Reuse a collector profile at its aerodrome; absent surface fields stay absent. */
export function collectorPointModel(series: ProfileSeries): PointModel {
  return {
    latitude: series.lat, longitude: series.lon,
    elevationM: Number.isFinite(series.elevationFt) ? series.elevationFt / FT_PER_M : null,
    provenance: seriesProvenance(series),
    series,
    surface: series.time.map(() => ({ temperature2mC: null, dewPoint2mC: null, windSpeed10mKt: null, windDirection10m: null, cloudCoverPct: null, precipitationMm: null, surfacePressureHpa: null })),
  };
}

/**
 * Build a model column. Unknown terrain is an absent ground, not sea level.
 * `floorM` hides model levels below the model's own surface. The real DEM
 * elevation still anchors the surface temperature.
 */
export function pointSky(point: MapPoint, profile: Profile, surface: PointSurface | null, elevationM: number | null, floorM?: number | null): SkyState {
  const floor = floorM != null && Number.isFinite(floorM) ? floorM : elevationM;
  const surfaceM = elevationM != null && Number.isFinite(elevationM) ? elevationM : (floorM == null ? floor : null);
  const levels = profile.levels.filter((level) => floor == null || level.zM >= floor);
  const t = surface?.temperature2mC ?? null, td = surface?.dewPoint2mC ?? null;
  // Surface temperatures anchor freezing and lapse rates only with a known height.
  if (surfaceM != null && t != null && surface?.surfacePressureHpa != null) {
    levels.unshift({ hPa: surface.surfacePressureHpa, zM: surfaceM, tC: t, rh: td == null ? null : Math.min(100, 100 * esWater(td) / esWater(t)), windKt: surface.windSpeed10mKt, windFrom: surface.windDirection10m, cloudPct: null, wMs: null });
  }
  // Without terrain the lowest measured height bounds cloud inference. It is
  // not a ground estimate; column mode omits ground and ground-based readings.
  const lowerBound = surfaceM ?? levels[0]?.zM ?? 0;
  const state = skyState({ icao: 'POINT', lat: point.lat, lon: point.lon, timeMs: profile.timeMs, source: 'none', groups: [], profile: { ...profile, levels }, elevationFt: lowerBound * FT_PER_M });
  // Do not bridge a missing temperature or declare the first cold pressure
  // level to be a surface freezing level.
  const freezing: number[] = [];
  if (surfaceM != null && t != null && t <= 0) freezing.push(surfaceM * FT_PER_M);
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1], b = levels[i];
    if (a.tC == null || b.tC == null) continue;
    if (a.tC * b.tC < 0 || (b.tC === 0 && a.tC !== 0)) freezing.push((a.zM + (b.zM - a.zM) * -a.tC / (b.tC - a.tC)) * FT_PER_M);
  }
  state.freezingAllFt = freezing;
  state.freezingFt = freezing[0] ?? null;
  if (surfaceM == null) {
    state.surface = null;
    state.parcel = null;
  }
  return state;
}

/** Temperature inversion across adjacent, measured levels only. */
export function isInversion(levels: { zM: number; tC: number | null }[], index: number): boolean {
  const a = levels[index - 1], b = levels[index];
  return !!a && a.tC != null && b.tC != null && b.zM > a.zM && b.tC > a.tC;
}
