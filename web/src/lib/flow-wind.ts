import {cycloneAt,cycloneWind} from './historical-cyclone';
import { blendReady, chartFrame, type LoadedChart } from './chart-store';
import { frameBlend } from './interpolate';
import * as flow from './flow';
import { type ScalarGrid } from './flow';

export type WindSource = 'model' | 'estimate';
export type WindDisplaySource = WindSource | 'to-model' | 'to-estimate' | 'unavailable';
export type WindSampler = ((lon: number, lat: number) => { u: number; v: number } | null) & { source: WindSource };

export function flowWindLegend(source: WindDisplaySource): string {
  switch (source) {
    case 'model': return 'Wind streaks: model 10 m wind';
    case 'estimate': return 'Wind streaks: estimated from isobars';
    case 'to-model': return 'Wind streaks: isobar estimate → model 10 m wind';
    case 'to-estimate': return 'Wind streaks: model wind → isobar estimate';
    case 'unavailable': return 'Wind streaks: unavailable';
  }
}

function gridOf(chart: LoadedChart, name: string): ScalarGrid | null {
  const spec = chart.manifest.variables[name];
  const { manifest } = chart;
  if (!spec || manifest.nx < 2 || manifest.ny < 2) return null;
  return {
    nx: manifest.nx,
    ny: manifest.ny,
    west: manifest.west,
    north: manifest.north,
    dlon: (manifest.east - manifest.west) / (manifest.nx - 1),
    dlat: (manifest.north - manifest.south) / (manifest.ny - 1),
    wraps: manifest.wrapsLongitude,
    fill: spec.fill,
    scale: spec.scale,
    offset: spec.offset,
  };
}

/**
 * Build a sampler for the two forecast frames around `minute`.
 * Ready pressure supplies a labelled estimate until both model components
 * are ready. Missing cells inside a ready model blend stay missing.
 *
 * The returned function deliberately captures one blend.  Callers should make
 * a new sampler on each display frame, which keeps interpolation continuous as
 * the forecast clock crosses an hour boundary without mixing stale readiness.
 */
export function createWindSampler(
  chart: LoadedChart,
  minute: number,
): WindSampler | null {
  const { manifest } = chart;
  const blend = frameBlend(manifest.forecastHours, manifest.forecastHours[0] * 60 + minute);
  if (!blend) return null;
  // At an exact forecast instant only that frame contributes. A pending
  // following frame must not blank the valid current vector.
  if (blend.t === 0) blend.i1 = blend.i0;
  const uGrid = gridOf(chart, 'u10');
  const vGrid = gridOf(chart, 'v10');
  if (uGrid && vGrid
      && blendReady(chart, 'u10', blend.i0, blend.i1)
      && blendReady(chart, 'v10', blend.i0, blend.i1)) {
    const u0 = chartFrame(chart, 'u10', blend.i0);
    const u1 = chartFrame(chart, 'u10', blend.i1);
    const v0 = chartFrame(chart, 'v10', blend.i0);
    const v1 = chartFrame(chart, 'v10', blend.i1);
    return Object.assign((lon: number, lat: number) => {
      const u = flow.sampleBlended(u0, u1, blend.t, lon, lat, uGrid);
      const v = flow.sampleBlended(v0, v1, blend.t, lon, lat, vGrid);
      return cycloneWind(cycloneAt(chart.cyclone,Date.parse(manifest.run)+(manifest.forecastHours[0]*60+minute)*60000),lon,lat,u == null || v == null ? null : { u, v });
    }, { source: 'model' as const });
  }

  const pressureGrid = gridOf(chart, 'mslp');
  if (!pressureGrid || !blendReady(chart, 'mslp', blend.i0, blend.i1)) return null;
  const p0 = chartFrame(chart, 'mslp', blend.i0);
  const p1 = chartFrame(chart, 'mslp', blend.i1);
  const pressure = (lon: number, lat: number) => flow.sampleBlended(p0, p1, blend.t, lon, lat, pressureGrid);
  return Object.assign((lon: number, lat: number) => flow.surfaceWindFromPressure(pressure, lon, lat, Math.max(pressureGrid.dlat, 0.5)),
    { source: 'estimate' as const });
}
