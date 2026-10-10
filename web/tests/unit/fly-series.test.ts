import { describe, expect, it } from 'vitest';
import fixture from './fixtures/openmeteo-point.json';
import { openMeteoUrl, parseOpenMeteo, PRESSURE_LEVELS } from '../../src/lib/point/openmeteo';
import { skySeries } from '../../src/lib/sky/series';
import { FT_PER_M, profileAt, skyState, type ProfileSeries } from '../../src/lib/sky/physics';

const T0 = Date.UTC(2026, 9, 8);
const COLLECTOR_RUN = '2026-10-08T18:00:00Z';
const OPEN_RUN = '2026-10-08T00:00:00Z';
const KBFI = { icao: 'KBFI', lat: 47.527, lon: -122.3 };

function cloudyBoeing(levels: Record<string, number> = { cloud_cover_700hPa: 80, cloud_cover_600hPa: 70 }) {
  const response = structuredClone(fixture) as typeof fixture & { model_run: string; hourly: typeof fixture.hourly & Record<string, number[]> };
  response.model_run = OPEN_RUN;
  for (const key of Object.keys(response.hourly)) {
    if (key.startsWith('relative_humidity_')) response.hourly[key] = response.hourly[key].map(() => 30);
  }
  for (const [key, cover] of Object.entries(levels)) response.hourly[key] = [cover, cover, cover, cover];
  return response;
}

describe('Fly series from an Open-Meteo profile', () => {
  it('requests cloud cover on every pressure level', () => {
    const hourly = new URL(openMeteoUrl(KBFI.lat, KBFI.lon, 'ignored', T0)).searchParams.get('hourly')!;
    for (const level of PRESSURE_LEVELS) expect(hourly).toContain(`cloud_cover_${level}hPa`);
  });

  it('keeps the collector series when that aerodrome already has one', () => {
    const model = parseOpenMeteo(cloudyBoeing(), KBFI.lat, KBFI.lon);
    const collector: ProfileSeries = {
      ...model.series, icao: 'YPPH', source: 'ECMWF', model: 'ecmwf_ifs025', run: COLLECTOR_RUN, runKnown: true, coastKm: -19,
    };
    expect(skySeries(collector, model, { icao: 'YPPH', lat: -31.94, lon: 115.97 })).toBe(collector);
    const elsewhere = skySeries(collector, model, KBFI);
    expect(elsewhere?.icao).toBe('KBFI');
    expect(elsewhere?.source).toBe('Open-Meteo');
    expect(elsewhere?.run).toBe(OPEN_RUN);
  });

  it('builds cloud, winds and the freezing level from cloud cover by level, labelled Open-Meteo', () => {
    const model = parseOpenMeteo(cloudyBoeing(), KBFI.lat, KBFI.lon, T0);
    const series = skySeries(null, model, KBFI);
    expect(series?.icao).toBe('KBFI');
    expect(series?.lat).toBe(KBFI.lat);
    expect(series?.lon).toBe(KBFI.lon);
    expect(series?.coastKm).toBeNull();
    expect(series?.source).toBe('Open-Meteo');
    expect(series?.model).toBe('ecmwf_ifs025');
    expect(series?.run).toBe(OPEN_RUN);
    expect(series?.runKnown).toBe(true);
    expect(series?.run).not.toBe(COLLECTOR_RUN);
    expect(series?.elevationFt).toBe(89);
    expect(series?.levels.find((level) => level.hPa === 700)?.cc).toEqual([80, 80, 80, 80]);
    expect(series?.levels.find((level) => level.hPa === 850)?.cc).toEqual([null, null, null, null]);

    const profile = profileAt(series, T0)!;
    expect(profile.levels.find((level) => level.hPa === 700)?.cloudPct).toBe(80);
    expect(profile.levels.find((level) => level.hPa === 700)?.windKt).toBeCloseTo(32, 5);
    const state = skyState({
      icao: 'KBFI', elevationFt: series!.elevationFt, lat: KBFI.lat, lon: KBFI.lon, timeMs: T0, source: 'none', groups: [], profile,
    });
    expect(state.hasProfile).toBe(true);
    expect(state.notes).not.toContain('No model profile at this time');
    expect(state.winds.length).toBeGreaterThan(3);
    expect(state.winds.some((wind) => wind.hPa === 700 && Math.abs(wind.kt - 32) < 0.01)).toBe(true);
    expect(state.freezingFt).toBeGreaterThan(1500 * FT_PER_M);
    expect(state.freezingFt).toBeLessThan(4000 * FT_PER_M);
    const cloud = state.layers.filter((layer) => layer.source === 'model');
    expect(cloud).toHaveLength(1);
    expect(cloud[0].oktas).toBe(6);
    expect(cloud[0].baseFtAmsl).toBeGreaterThan(5000);
    expect(cloud[0].topFtAmsl).toBeGreaterThan(cloud[0].baseFtAmsl!);
  });

  it('keeps high cloud cover above a report, with winds and the freezing level', () => {
    const model = parseOpenMeteo(cloudyBoeing({ cloud_cover_500hPa: 80, cloud_cover_400hPa: 60 }), KBFI.lat, KBFI.lon, T0);
    const series = skySeries(null, model, KBFI)!;
    const profile = profileAt(series, T0)!;
    const state = skyState({
      icao: 'KBFI', elevationFt: series.elevationFt, lat: KBFI.lat, lon: KBFI.lon, timeMs: T0, source: 'METAR',
      groups: [{ body: 'METAR KBFI 080255Z 18008KT 9999 FEW040 12/08 A3012', change: null }], profile,
    });
    const modelCloud = state.layers.filter((layer) => layer.source === 'model');
    expect(modelCloud).toHaveLength(1);
    expect(modelCloud[0].baseFtAmsl).toBeGreaterThan(10000);
    expect(modelCloud[0].oktas).toBe(6);
    expect(state.winds.length).toBeGreaterThan(3);
    expect(state.freezingFt).toBeGreaterThan(1500 * FT_PER_M);
    expect(state.notes).not.toContain('No model profile at this time');
  });

  it('leaves cloud cover missing when the response does not name it', () => {
    const series = skySeries(null, parseOpenMeteo(fixture, KBFI.lat, KBFI.lon), KBFI);
    expect(series?.levels.every((level) => level.cc.every((value) => value == null))).toBe(true);
    expect(series?.source).toBe('Open-Meteo');
  });
});
