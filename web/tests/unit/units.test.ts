import { describe, expect, it } from 'vitest';
import { captureContext, contextLine, releaseIdentity } from '../../src/lib/chat/context';
import {
  AUS_UNITS,
  US_UNITS,
  cToF,
  dwellRegion,
  feetToMetres,
  formatIsobar,
  formatPressureHpa,
  formatRainMm,
  formatTempC,
  formatVisibilityMetres,
  hPaToInHg,
  metricFlightLevel,
  metresToFeet,
  metresToStatuteMiles,
  mmToInches,
  pressureAltitudeMetres,
  resolveUnits,
  unitsSystemLine,
  unitsTooltip,
} from '../../src/lib/units';
import { regionAt } from '../../src/lib/units-regions';

describe('conversions', () => {
  it('converts hPa to inHg at 0.02953, two decimal places', () => {
    expect(hPaToInHg(1013.25)).toBe(29.92);
    expect(hPaToInHg(1000)).toBe(29.53);
    expect(formatPressureHpa(null, US_UNITS)).toBeNull();
    expect(formatPressureHpa(Number.NaN, US_UNITS)).toBeNull();
    expect(formatIsobar(1013, AUS_UNITS)).toBe('1013');
    expect(formatIsobar(1013, US_UNITS)).toBe('29.91');
    expect(formatPressureHpa(1013, US_UNITS)).toBe('29.91 inHg');
    expect(formatPressureHpa(1013, AUS_UNITS)).toBe('1013');
  });

  it('converts Celsius and Fahrenheit', () => {
    expect(cToF(0)).toBe(32);
    expect(cToF(100)).toBe(212);
    expect(formatTempC(null, US_UNITS)).toBeNull();
    expect(formatTempC(20, AUS_UNITS)).toBe('20°');
    expect(formatTempC(20, US_UNITS)).toBe('68°F');
    expect(formatTempC(19, AUS_UNITS, { signed: true, unit: true })).toBe('+19°C');
    expect(formatTempC(-4, US_UNITS, { signed: true, unit: true })).toBe('+25°F');
  });

  it('converts metres, feet, statute miles and inches', () => {
    expect(metresToFeet(1)).toBeCloseTo(3.280839895, 6);
    expect(feetToMetres(metresToFeet(100))).toBeCloseTo(100, 6);
    expect(metresToStatuteMiles(1609.344)).toBeCloseTo(1, 8);
    expect(mmToInches(25.4)).toBeCloseTo(1, 8);
    expect(formatRainMm(null, US_UNITS)).toBeNull();
    expect(formatRainMm(0.1, AUS_UNITS)).toBeNull();
    expect(formatRainMm(2.94, AUS_UNITS)).toBe('2.9');
    expect(formatRainMm(25.4, US_UNITS)).toBe('1.0');
    expect(formatVisibilityMetres(null, US_UNITS)).toBeNull();
    expect(formatVisibilityMetres(9999, AUS_UNITS)).toBe('10+ km');
    expect(formatVisibilityMetres(9999, US_UNITS)).toBe('6.2+ SM');
    expect(formatVisibilityMetres(8000, AUS_UNITS)).toBe('8 km');
  });

  it('rounds a metric flight level to 10 m and encodes S0920', () => {
    const level = metricFlightLevel(9200);
    expect(level.metres).toBe(9200);
    expect(level.code).toBe('S0920');
    expect(level.feet).toBe(Math.round(9200 * metresToFeet(1)));
    expect(metricFlightLevel(9234).code).toBe('S0923');
    expect(metricFlightLevel(pressureAltitudeMetres(500)).code).toMatch(/^S\d{4}$/);
    expect(metricFlightLevel(Number.NaN)).toBeNull();
  });
});

describe('regions', () => {
  it('follows the country at a point and falls back to ICAO defaults', () => {
    expect(regionAt(39.74, -104.99).id).toBe('us');
    expect(regionAt(39.74, -104.99).pressure).toBe('inHg');
    expect(regionAt(43.65, -79.38).id).toBe('ca');
    expect(regionAt(43.65, -79.38).pressure).toBe('hPa');
    expect(regionAt(43.65, -79.38).visibility).toBe('sm');
    expect(regionAt(39.9, 116.41).id).toBe('cn');
    expect(regionAt(39.9, 116.41).height).toBe('m');
    expect(regionAt(39.9, 116.41).flightLevel).toBe('metric');
    expect(regionAt(39.9, 116.41).uncertain).toBe(false);
    expect(regionAt(39.9, 116.41).transitionUncertain).toBe(true);
    expect(regionAt(51.5, -0.12).id).toBe('gb');
    expect(regionAt(51.5, -0.12).pressure).toBe('hPa');
    expect(regionAt(48.86, 2.35).id).toBe('eu');
    expect(regionAt(-33.87, 151.21).id).toBe('au');
    expect(regionAt(-36.85, 174.76).id).toBe('nz');
    expect(regionAt(-36.85, 174.76).transitionFt).toBe(13000);
    expect(regionAt(0, -150).id).toBe('icao');
    expect(regionAt(0, -150).pressure).toBe('hPa');
    expect(regionAt(55.75, 37.62).uncertain).toBe(true);
    expect(regionAt(47.92, 106.92).uncertain).toBe(true);
    expect(regionAt(39.03, 125.75).uncertain).toBe(true);
    expect(regionAt(55.75, 37.62).flightLevel).toBe('metric');
  });

  it('resolves the three modes without rewriting a stored location', () => {
    expect(resolveUnits('aus', 39.74, -104.99).pressure).toBe('hPa');
    expect(resolveUnits('aus', 39.74, -104.99).temp).toBe('C');
    expect(resolveUnits('us', -33.87, 151.21).pressure).toBe('inHg');
    expect(resolveUnits('us', -33.87, 151.21).temp).toBe('F');
    expect(resolveUnits('us', -33.87, 151.21).transitionFt).toBe(18000);
    expect(resolveUnits('local', 39.74, -104.99).pressure).toBe('inHg');
    expect(resolveUnits('local', 39.9, 116.41).height).toBe('m');
    expect(resolveUnits('local', null, null).id).toBe('icao');
    expect(unitsTooltip(resolveUnits('us', 0, 0))).toBe('inHg · °F · kt · ft · SM · in · FL');
    expect(unitsTooltip(resolveUnits('local', 39.9, 116.41))).toContain('m');
    expect(unitsTooltip(resolveUnits('local', 39.9, 116.41))).toContain('SFL');
  });

  it('holds a new region until it has lasted one second', () => {
    const home = { regionId: 'au', pendingId: null, pendingAt: null };
    const entered = dwellRegion(home, 'us', 1_000);
    expect(entered.regionId).toBe('au');
    expect(dwellRegion(entered, 'us', 1_999).regionId).toBe('au');
    expect(dwellRegion(entered, 'us', 2_000).regionId).toBe('us');
    const back = dwellRegion(entered, 'au', 1_400);
    expect(back).toEqual(home);
    const passed = dwellRegion(dwellRegion(home, 'us', 0), 'cn', 100);
    expect(passed.regionId).toBe('au');
    expect(passed.pendingId).toBe('cn');
    expect(dwellRegion(passed, 'cn', 1_100).regionId).toBe('cn');
  });
});

describe('chat units', () => {
  it('puts the active units in the context line and the system prompt', () => {
    const us = resolveUnits('us', 39.74, -104.99);
    const line = unitsSystemLine(us);
    expect(line).toContain('inHg');
    expect(line).toContain('°F');
    expect(line).toContain('statute miles');
    expect(line).toContain('Missing stays missing');
    const metric = unitsSystemLine(resolveUnits('local', 39.9, 116.41));
    expect(metric).toContain('S0920');
    expect(metric).toContain('metres');
    const release = releaseIdentity({ data_sha256: 'a'.repeat(64), run: 'run-1' }, 'manifest-run');
    const captured = captureContext({
      place: { id: 'denver', name: 'Denver', zone: 'America/Denver' },
      units: {
        mode: 'us', pressure: 'inHg', temp: 'F', wind: 'kt', height: 'ft',
        visibility: 'sm', rain: 'in', flightLevel: 'ft', transitionFt: 18000,
      },
    }, release);
    expect(captured?.units?.pressure).toBe('inHg');
    expect(contextLine(captured!)).toContain('inHg');
    expect(captureContext({ units: { mode: 'metric' } }, release)?.units).toBeNull();
  });
});
