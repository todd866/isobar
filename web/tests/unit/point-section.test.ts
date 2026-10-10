import { describe, expect, it } from 'vitest';
import fixture from './fixtures/openmeteo-point.json';
import { parseOpenMeteo, pointProfileAt, pointSurfaceAt } from '../../src/lib/point/openmeteo';
import { collectorPointModel, flightLevel, isaTemperature, isInversion, levelLabel, levelTitle, pointName, pointSky } from '../../src/lib/point/section';
import { US_UNITS, metricFlightLevel, pressureAltitudeMetres, resolveUnits } from '../../src/lib/units';
import { FT_PER_M } from '../../src/lib/sky/physics';
import { stateKey } from '../../src/lib/sky/render';

const point = { lat: -31.95, lon: 115.86 };
const time = Date.UTC(2026, 9, 8);

describe('point section readings', () => {
  it('names an exact place, keeps a near dateline name, and uses coordinates when nothing is close', () => {
    expect(pointName(point, [{ ...point, name: 'Perth' }, { lat: -32, lon: 115.9, name: 'South' }])).toBe('Perth');
    expect(pointName({ lat: 40, lon: -106 }, [{ ...point, name: 'Perth' }])).toBe('40.00°N 106.00°W');
    expect(pointName({ lat: 0, lon: -179.99 }, [{ lat: 0, lon: 179.99, name: 'Dateline' }])).toBe('Dateline');
  });

  it('uses pressure altitude for FL and the ISA tropopause for temperature departure', () => {
    expect(flightLevel(500)).toBe(183);
    expect(flightLevel(200)).toBe(387);
    expect(isaTemperature(11000)).toBe(-56.5);
    expect(isaTemperature(14000)).toBe(-56.5);
  });

  it('labels measured heights below the transition in feet, and pressure FL at/above it', () => {
    expect(levelLabel(1000, 153)).toBe('500 ft');
    expect(levelLabel(925, 808)).toBe('2,700 ft');
    expect(levelLabel(850, 1508)).toBe('4,900 ft');
    expect(levelLabel(700, 3018)).toBe('9,900 ft');
    expect(levelLabel(925, 750)).toBe('2,500 ft');
    expect(levelLabel(700, 9999 / FT_PER_M)).toBe('10,000 ft');
    expect(levelLabel(600, 4208)).toBe('FL140');
    expect(levelLabel(500, 5600)).toBe('FL180');
    expect(levelLabel(400, 7200)).toBe('FL240');
    expect(levelLabel(300, 9200)).toBe('FL300');
    expect(levelLabel(250, 10400)).toBe('FL340');
    expect(levelLabel(200, 11800)).toBe('FL390');
    expect(levelLabel(600, 4208, US_UNITS)).toBe('13,800 ft');
    expect(levelLabel(500, 5600, US_UNITS)).toBe('FL180');
    const china = resolveUnits('local', 39.9, 116.4);
    expect(levelLabel(500, 5600, china)).toBe(metricFlightLevel(pressureAltitudeMetres(500))?.code);
    expect(levelTitle(500, 5600, china)).toContain('ft');
    expect(levelLabel(1000, 153, china)).toBe('153 m');
  });

  it('infers clouds from measured RH, includes terrain, and detects inversions', () => {
    const model = parseOpenMeteo(fixture);
    const profile = pointProfileAt(model, time)!;
    for (const level of profile.levels) if (level.hPa >= 700 && level.hPa <= 925) level.rh = 97;
    profile.levels[2].tC = 18;
    expect(isInversion(profile.levels, 2)).toBe(true);
    const state = pointSky(point, profile, pointSurfaceAt(model, time), 27);
    expect(state.layers.length).toBeGreaterThan(0);
    expect(state.elevationFt).toBeCloseTo(27 * FT_PER_M);
    expect(state.freezingFt).toBeGreaterThan(1500 * FT_PER_M);
    const options = { width: 100, height: 320, dpr: 1, dark: false, seed: 'point', coastKm: null };
    expect(stateKey(state, options)).not.toBe(stateKey(state, { ...options, mode: 'column' }));
    expect(stateKey(state, { ...options, mode: 'column' })).not.toBe(stateKey(state, { ...options, mode: 'column', groundKnown: false }));
  });

  it('does not bridge missing temperature or invent freezing ground at an unknown elevation', () => {
    const model = parseOpenMeteo(fixture), profile = pointProfileAt(model, time)!;
    profile.levels[2].tC = null;
    expect(isInversion(profile.levels, 2)).toBe(false);
    expect(pointSky(point, profile, null, null).freezingFt).toBeNull();
    profile.levels.forEach((level) => { level.tC = -10; });
    const state = pointSky(point, profile, null, null);
    expect(state.freezingFt).toBeNull();
    expect(state.surface).toBeNull();
    expect(state.parcel).toBeNull();
  });

  it('suppresses below-terrain levels and preserves absent collector surface fields', () => {
    const model = parseOpenMeteo(fixture), profile = pointProfileAt(model, time)!;
    const state = pointSky(point, profile, null, 2000);
    expect(state.winds.every((wind) => wind.ftAmsl >= 2000 * FT_PER_M)).toBe(true);
    const collected = collectorPointModel({ ...model.series, icao: 'YPPH' });
    expect(pointProfileAt(collected, time)?.levels).toEqual(profile.levels);
    expect(Object.values(pointSurfaceAt(collected, time)!)).toEqual(Array(7).fill(null));
  });
});
