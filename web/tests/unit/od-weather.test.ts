import { describe, expect, it } from 'vitest';
import { forecastGroups, forecastWindow, freezingLevelFt, metarConditions, weatherFromPublished, weatherRequest } from '../../src/lib/od/weather';
import type { WeatherReport } from '../../src/lib/od/model';
import type { ProfileLevel, ProfileSeries } from '../../src/lib/sky/physics';

const CAPTURED = '2026-10-08T03:00:00Z';
const FROM = '2026-10-08T03:00:00Z';
const TO = '2026-10-09T06:00:00Z';
const METAR = 'METAR YPPH 080300Z 24018G30KT 4000 +SHRA BKN020 17/15 Q1011';
const TAF = 'TAF YPPH 080300Z 0803/0906 24010KT P6SM SCT020 BKN040 FM080600 18012KT 3SM SHRA BKN012 BECMG 0808/0810 24010KT P6SM SCT025';

function report(overrides: Partial<WeatherReport> = {}): WeatherReport {
  return { station: 'YPPH', source: '/data/aviation.json', capturedAt: CAPTURED,
    metar: { raw: METAR, time: CAPTURED }, taf: { raw: TAF, issue: CAPTURED, from: FROM, to: TO }, profile: null, ...overrides };
}

function profile(times: number[], temperatures: (number | null)[][]): ProfileSeries {
  const levels: ProfileLevel[] = [
    { hPa: 1000, zM: 0, tC: 10, rh: 70, windKt: 10, windFrom: 240, cloudPct: 0, wMs: 0 },
    { hPa: 850, zM: 1500, tC: -2, rh: 60, windKt: 20, windFrom: 250, cloudPct: 0, wMs: 0 },
    { hPa: 700, zM: 3000, tC: -15, rh: 50, windKt: 30, windFrom: 260, cloudPct: 0, wMs: 0 },
  ];
  return { icao: 'YPPH', run: '2026-10-08T00:00:00Z', lat: -31.94, lon: 115.97, elevationFt: 67, coastKm: null, time: times,
    levels: levels.map((l, i) => ({ hPa: l.hPa, z: times.map((_, ti) => l.zM), t: temperatures[tiSafe(i, temperatures)] ?? times.map(() => l.tC), rh: times.map(() => l.rh), ws: times.map(() => l.windKt), wd: times.map(() => l.windFrom), cc: times.map(() => l.cloudPct), w: times.map(() => l.wMs) })) };
}
function tiSafe(i: number, values: (number | null)[][]): number { return Math.min(i, values.length - 1); }

describe('operational-decision weather adapters', () => {
  it('matches collector stations, preserves raw reports, and clones the matching profile', () => {
    const p = profile([Date.parse(FROM)], [[10], [0], [-15]]);
    const aviation = { airports: [{ icao: 'YPPH', metar: { raw: METAR, time: CAPTURED }, taf: { raw: TAF, issue: CAPTURED, from: FROM, to: TO } }, { icao: 'YSSY' }] };
    const got = weatherFromPublished({ station: 'YPPH', aviation, profile: p, capturedAt: CAPTURED });
    expect(got?.source).toBe('/data/aviation.json'); expect(got?.metar?.raw).toBe(METAR); expect(got?.taf?.raw).toBe(TAF);
    expect(got?.profile).toEqual(p); expect(got?.profile).not.toBe(p);
  });

  it('uses an API report for non-collector stations and rejects station mismatches', () => {
    const api = { icao: 'YSSY', metar: { raw: 'METAR YSSY 080300Z 18010KT 9999 20/12 Q1012', time: CAPTURED }, taf: null };
    const got = weatherFromPublished({ station: 'YSSY', aviation: { airports: [{ icao: 'YPPH' }] }, apiReport: api, capturedAt: CAPTURED });
    expect(got?.source).toBe('/api/aviation'); expect(got?.taf).toBeNull();
    expect(weatherFromPublished({ station: 'YSSY', apiReport: { ...api, metar: { ...api.metar, raw: 'METAR YPPH 080300Z 18010KT 9999 20/12 Q1012' } }, capturedAt: CAPTURED })).toBeNull();
  });

  it('keeps statute-mile source text while converting visibility for forecast groups', () => {
    const r = report({ taf: { raw: 'TAF YPPH 080300Z 0803/0906 24010KT P6SM SCT020', issue: CAPTURED, from: FROM, to: TO } });
    expect(r.taf?.raw).toContain('P6SM');
    const groups = forecastGroups(r); expect(groups).not.toBeNull(); expect(groups?.[0].cond.visM).toBeGreaterThan(9600);
    const three=report({taf:{...r.taf!,raw:r.taf!.raw.replace('P6SM','3SM')}});
    expect(forecastGroups(three)?.[0].cond.visM).toBe(4828.032);
    const fraction=report({taf:{...r.taf!,raw:r.taf!.raw.replace('P6SM','1 1/2SM')}});
    expect(forecastGroups(fraction)?.[0].cond.visM).toBe(2414.016);
    expect(metarConditions(r)).toEqual({ windFromTrueDeg: 240, windKt: 30, temperatureC: 17, qnhHpa: 1011 });
  });

  it('returns prevailing, FM and both sides of a BECMG during its transition', () => {
    const r = report(); const groups = forecastGroups(r)!; expect(groups.map(g => g.kind)).toEqual(['base', 'FM', 'BECMG']);
    const start = Date.parse(FROM); const fm = Date.parse('2026-10-08T06:00:00Z'); const transition = Date.parse('2026-10-08T09:00:00Z');
    const atFm = forecastWindow(r, fm, fm + 10 * 60_000)!; expect(atFm.some(g => g.kind === 'FM')).toBe(true);
    const atTransition = forecastWindow(r, transition, transition + 10 * 60_000)!; expect(atTransition.some(g => g.kind === 'BECMG')).toBe(true); expect(atTransition.some(g => g.kind === 'FM')).toBe(true);
    expect(forecastWindow(r, start - 1, start + 10 * 60_000)).toBeNull(); expect(forecastWindow(r, Date.parse(TO) - 10 * 60_000, Date.parse(TO))).toBeNull();
    expect(forecastWindow(r, start, Number.NaN)).toBeNull();
  });

  it('finds freezing level, keeps missing temperatures unknown, and rejects a time gap', () => {
    const t0 = Date.parse(FROM); const p = profile([t0, t0 + 3_600_000], [[10, 10], [0, null], [-15, -15]]);
    const withProfile = report({ profile: p }); expect(freezingLevelFt(withProfile, t0)).toBeCloseTo(4921, 0);
    expect(freezingLevelFt(report({ profile: profile([t0], [[10], [4], [1]]) }), t0)).toBeNull();
    const far = profile([t0, t0 + 8 * 3_600_000], [[10, 10], [-2, -2], [-15, -15]]);
    expect(freezingLevelFt(report({ profile: far }), t0 + 4 * 3_600_000)).toBeNull();
    expect(freezingLevelFt(report({ profile: { ...p, icao: 'YSSY' } }), t0)).toBeNull();
  });

  it('routes collector/API requests and rejects injection-shaped station values', () => {
    expect(weatherRequest('YPPH', ['YPPH', 'YSSY'])).toBe('/data/aviation.json');
    expect(weatherRequest('YMHB', ['YPPH'])).toBe('/api/aviation?icao=YMHB');
    expect(() => weatherRequest('YPPH%2F..%2Fsecret', ['YPPH'])).toThrow(RangeError);
    expect(() => weatherRequest('ypph', ['YPPH'])).toThrow(RangeError);
  });
});
