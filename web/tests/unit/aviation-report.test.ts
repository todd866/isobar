import { describe, expect, it } from 'vitest';
import { parseAerodromeReports } from '../../src/lib/aviation-report';

const metar = [{
  icaoId: 'KSEA',
  rawOb: 'METAR KSEA 091753Z 22008KT 10SM FEW050 14/07 A2992',
  reportTime: '2026-10-09T17:53:00Z',
  obsTime: 1791483360,
  lat: 47.45,
  lon: -122.31,
  name: 'Seattle-Tacoma',
}];

const taf = [{
  icaoId: 'KSEA',
  rawTAF: 'TAF KSEA 091720Z 0918/1024 22008KT P6SM FEW050',
  issueTime: '2026-10-09T17:20:00Z',
  validTimeFrom: 1791487200,
  validTimeTo: 1791573600,
  lat: 47.45,
  lon: -122.31,
  name: 'Seattle-Tacoma',
}];

describe('aerodrome reports', () => {
  it('keeps METAR and TAF, and drops a station with neither', () => {
    const report = parseAerodromeReports('ksea', metar, taf);
    expect(report).toMatchObject({
      icao: 'KSEA',
      name: 'Seattle-Tacoma',
      lat: 47.45,
      lon: -122.31,
      metar: { raw: metar[0].rawOb, time: '2026-10-09T17:53:00Z' },
      taf: { raw: taf[0].rawTAF, issue: '2026-10-09T17:20:00Z' },
    });
    expect(report?.taf?.from).toBe(new Date(1791487200 * 1000).toISOString().replace(/\.000Z$/, 'Z'));
    expect(parseAerodromeReports('KSEA', [], [])).toBeNull();
    expect(parseAerodromeReports('nope', metar, taf)).toBeNull();
  });
});
