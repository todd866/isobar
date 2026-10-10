import type { PointModel } from '../point/openmeteo';
import type { ProfileSeries } from './physics';

export interface SkyAerodrome {
  icao: string;
  lat: number;
  lon: number;
}

/**
 * The collector series for this aerodrome, when it has one. Otherwise the
 * Open-Meteo profile at the aerodrome, labelled with that profile's own cycle.
 */
export function skySeries(collector: ProfileSeries | null, model: PointModel | null, aerodrome: SkyAerodrome): ProfileSeries | null {
  if (collector?.icao === aerodrome.icao) return collector;
  if (!model) return null;
  const elevationFt = Number.isFinite(model.series.elevationFt) ? Math.round(model.series.elevationFt) : model.series.elevationFt;
  return {
    ...model.series,
    icao: aerodrome.icao,
    lat: aerodrome.lat,
    lon: aerodrome.lon,
    elevationFt,
    coastKm: null,
    source: model.provenance.source,
    model: model.provenance.model,
    run: model.provenance.run,
    runKnown: model.provenance.cycle,
  };
}
