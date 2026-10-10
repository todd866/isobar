import { describe, expect, it, vi, afterEach } from 'vitest';
import { DECREES } from '../../src/lib/od/decrees';
import { learnCards } from '../../../training/src/learn-cards';
import { loadDeskWeather, nextDossier, utc, windReading, windowWeather } from '../../src/lib/od/desk';
import { priorPerson } from '../../../training/src/ability';
import { weatherFromPublished } from '../../src/lib/od/weather';
import { odDeskFixture } from '../fixtures/od-desk';

afterEach(() => vi.unstubAllGlobals());
describe('desk instruments and published weather', () => {
  it('every Ministry citation has a Learn card in either edition', () => {
    for (const decree of DECREES) for (const edition of ['aus', 'us']) {
      expect(learnCards.some(c => c.conceptIds.includes(decree.conceptId) && (!c.rules || c.rules === 'both' || c.rules === edition)), `${decree.id}/${edition}`).toBe(true);
    }
  });
  it('chooses weather from complete METAR tokens, retaining unknown observations', () => {
    for (const [phenomenon, scene] of [['-RA', 'rain'], ['SHRASN', 'snow'], ['+TSRA', 'storm'], ['FZFG', 'fog'], ['BR', 'fog'], ['CAVOK', 'clear']]) {
      expect(windowWeather(`METAR YPPH 090000Z 27010KT 9999 ${phenomenon} 15/10 Q1013`)).toBe(scene);
    }
    expect(windowWeather(null)).toBe('unknown');
    expect(windowWeather('METAR KTSM 090000Z 27010KT CAVOK 15/10 Q1013')).toBe('clear');
  });
  it('keeps expiry years and midnight dates visible', () => {
    expect(utc('2027-01-01T00:05:00.000Z')).toBe('2027-01-01 00:05Z');
    expect(utc('2026-12-31T23:55:00.000Z')).toBe('2026-12-31 23:55Z');
  });
  it('serves a bounded exercise when Learn warm-up falls below the authored bank', () => {
    const aviation = JSON.parse(odDeskFixture.get('/data/aviation.json')!.body.toString());
    const reports = aviation.airports.map((airport: { icao: string }) => weatherFromPublished({ station: airport.icao, aviation, capturedAt: '2026-10-09T00:00:00Z' })).filter(Boolean);
    const person = priorPerson({ level: 'curious', goal: 'weather', rules: 'aus', now: 0 });
    for (const strand of Object.values(person.strands)) strand.theta = -4;
    const dossier = nextDossier(reports, person, 1, 0, 1);
    expect(dossier).not.toBeNull();
    expect(dossier!.target.difficulty).toBe(-4);
  });
  it('calculates head, tail, crosswind and rejects missing direction', () => {
    expect(windReading(90, 180, 20)?.crosswind).toBeCloseTo(20);
    expect(windReading(90, 180, 20)?.headwind).toBeCloseTo(0);
    expect(windReading(90, 270, 20)?.headwind).toBeCloseTo(-20);
    expect(windReading(350, 10, 20)?.crosswind).toBeCloseTo(6.8404);
    expect(windReading(0, NaN, 20)).toBeNull();
    expect(windReading(0, 0, -5)).toBeNull();
  });
  it('bounds failed weather retrieval to the six stations and never fabricates reports', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetcher);
    expect(await loadDeskWeather(new AbortController().signal)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/aviation?icao='))).toHaveLength(6);
  });
  it('retains exact published report text and provenance', async () => {
    const metar = { raw: 'METAR YPPH 090000Z 27010KT CAVOK 15/10 Q1013', time: '2026-10-09T00:00:00Z' };
    const taf = { raw: 'TAF YPPH 082300Z 0900/1000 27010KT CAVOK', issue: '2026-10-08T23:00:00Z', from: '2026-10-09T00:00:00Z', to: '2026-10-10T00:00:00Z' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: url === '/data/aviation.json', json: async () => ({ airports: [{ icao: 'YPPH', metar, taf }] }) })));
    const reports = await loadDeskWeather(new AbortController().signal);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ station: 'YPPH', source: '/data/aviation.json', metar, taf, profile: null });
  });
});
