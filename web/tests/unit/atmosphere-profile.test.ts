import { describe, expect, it } from 'vitest';
import { buildAtmosphereProfile, type AtmosphereProfile } from '../../src/lib/atmosphere-profile';
import type { PointModel } from '../../src/lib/point/openmeteo';

const T0 = Date.UTC(2026, 9, 9, 0);
function model(overrides: Partial<PointModel> = {}): PointModel {
  const base: PointModel = {
    latitude: -31.95, longitude: 115.86, elevationM: 100,
    provenance: { source: 'Open-Meteo', model: 'ecmwf_ifs025', run: '2026-10-09T00:00:00Z', cycle: true },
    surface: [{ temperature2mC: 20, dewPoint2mC: 15, windSpeed10mKt: 12, windDirection10m: 270, cloudCoverPct: 40, precipitationMm: 0, surfacePressureHpa: 1005 }],
    series: {
      icao: 'POINT', run: '2026-10-09T00:00:00Z', source: 'Open-Meteo', model: 'ecmwf_ifs025', runKnown: true,
      lat: -31.95, lon: 115.86, elevationFt: 328.084, coastKm: null, time: [T0],
      levels: [
        { hPa: 950, z: [500], t: [18], rh: [90], ws: [12], wd: [270], cc: [75], w: [null] },
        { hPa: 850, z: [1500], t: [12], rh: [80], ws: [25], wd: [280], cc: [65], w: [null] },
        { hPa: 700, z: [3000], t: [2], rh: [40], ws: [35], wd: [290], cc: [5], w: [null] },
      ],
    },
  };
  return { ...base, ...overrides };
}

describe('buildAtmosphereProfile', () => {
  it('keeps partial measurements missing and exposes source metadata', () => {
    const input = model();
    input.series.levels[0].t[0] = null;
    input.series.levels[0].ws[0] = null;
    const result = buildAtmosphereProfile(input, T0) as AtmosphereProfile;
    expect(result.source).toMatchObject({ kind: 'open-meteo', model: 'ecmwf_ifs025', cycleKnown: true });
    expect(result.levels[0]).toMatchObject({ temperatureC: null, windKt: null, relativeHumidityPct: 90 });
  });

  it('clips representative cloud envelopes to known terrain', () => {
    const result = buildAtmosphereProfile(model(), T0) as AtmosphereProfile;
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].baseM).toBe(100);
    expect(result.layers[0].topM).toBeGreaterThan(result.layers[0].baseM);
    expect(result.layers[0].uncertaintyM).toBeGreaterThan(0);
  });

  it('returns no profile outside the forecast time bound', () => {
    expect(buildAtmosphereProfile(model(), T0 - 3 * 3_600_000 - 1)).toBeNull();
    expect(buildAtmosphereProfile(model(), T0 + 3 * 3_600_000 + 1)).toBeNull();
  });

  it('drops non-positive source heights and never invents vertical velocity', () => {
    const input = model();
    input.series.levels[0].z[0] = 0;
    const result = buildAtmosphereProfile(input, T0) as AtmosphereProfile;
    expect(result.levels.every((level) => level.heightM > 0)).toBe(true);
    expect(result.levels.every((level) => level.verticalVelocityMs === null)).toBe(true);
  });

  it('keeps opposite vertical motions at their own sampled levels and time', () => {
    const input=model();
    input.series.levels[0].w=[2]; input.series.levels[1].w=[-1];
    const profile=buildAtmosphereProfile(input,T0)!;
    expect(profile.timeMs).toBe(T0);
    expect(profile.levels[0]).toMatchObject({heightM:500,verticalVelocityMs:2,windKt:12});
    expect(profile.levels[1]).toMatchObject({heightM:1500,verticalVelocityMs:-1,windKt:25});
    expect(profile.levels[2].verticalVelocityMs).toBeNull();
  });

  it('distinguishes cloudy and clear levels', () => {
    const result = buildAtmosphereProfile(model(), T0) as AtmosphereProfile;
    expect(result.layers[0].cloudFractionPct).toBeGreaterThanOrEqual(20);
    expect(result.layers[0].cloudFractionPct).toBeLessThanOrEqual(75);
    expect(result.layers[0].baseM).toBeLessThan(1500);
    expect(result.layers[0].topM).toBeGreaterThan(1500);
    expect(result.layers[0].topM).toBeLessThan(3000);
  });
});
