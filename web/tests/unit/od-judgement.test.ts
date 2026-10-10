import { describe, expect, it } from 'vitest';
import { AERODROMES } from '../../src/lib/od/aerodromes';
import { draftDossier } from '../../src/lib/od/generator';
import { judge, amendDossier } from '../../src/lib/od/judge';
import { alternateCheck, fuelRequired, suitableAlternate } from '../../src/lib/od/checks';
import { applyEvidence } from '../../src/lib/od/learn';
import { scoreShift } from '../../src/lib/od/shifts';
import { priorPerson } from '../../../training/src/ability';
import type { WeatherReport } from '../../src/lib/od/model';
import type { ProfileSeries } from '../../src/lib/sky/physics';

const T0 = Date.parse('2026-10-09T00:00:00Z');
const profile: ProfileSeries = {
  icao: 'YPPH', run: '2026-10-08T00:00:00Z', lat: -31.9, lon: 116, elevationFt: 120, coastKm: null,
  time: [T0, T0 + 3_600_000],
  levels: [
    { hPa: 1000, z: [0, 0], t: [18, 18], rh: [60, 60], ws: [10, 10], wd: [240, 240], cc: [0, 0], w: [0, 0] },
    { hPa: 850, z: [1500, 1500], t: [5, 5], rh: [50, 50], ws: [20, 20], wd: [250, 250], cc: [0, 0], w: [0, 0] },
    { hPa: 700, z: [3000, 3000], t: [-8, -8], rh: [40, 40], ws: [25, 25], wd: [260, 260], cc: [0, 0], w: [0, 0] },
  ],
};
const weather = (station: string): WeatherReport => ({
  station, source: '/data/aviation.json', capturedAt: new Date(T0).toISOString(),
  metar: { raw: `METAR ${station} 090000Z 24010KT CAVOK 18/10 Q1013`, time: new Date(T0).toISOString() },
  taf: { raw: `TAF ${station} 090000Z 0900/1000 24010KT CAVOK`, issue: new Date(T0).toISOString(), from: new Date(T0).toISOString(), to: new Date(T0 + 24 * 3600_000).toISOString() },
  profile: { ...profile, icao: station },
});

function dossier(edition: 'aus' | 'us' = 'aus') {
  const d = draftDossier({ edition, aircraft: 'a727', departure: AERODROMES[0], destination: AERODROMES[1], departureWeather: weather('YPPH'), destinationWeather: weather('YSSY'), arrivalUtc: new Date(T0 + 6 * 3600_000).toISOString(), difficulty: 1, seed: 17, decreeId: 'fuel', shift: 17 });
  const alt = { aerodrome: structuredClone(AERODROMES[0]), weather: weather('YPPH'), distanceNm: 100, runway: { ...AERODROMES[0].runways[0], state: 'dry' as const, contaminationMm: 0, inspected: true }, minima: { ceilingFt: 800, visibilityM: 4000 } };
  d.alternatives = [alt]; d.plan.alternateId = alt.aerodrome.id; d.plan.fuelKg = 10_000;
  return d;
}

describe('operational-decision adversarial judgement', () => {
  it('distinguishes destination assessment, coverage and alternate ETA windows', () => {
    const d = dossier('us'); d.plan.alternateId = null;
    d.destinationWeather.taf!.raw = 'TAF YSSY 090000Z 0900/1000 24010KT CAVOK FM090645 24010KT 1000 BKN001';
    expect(alternateCheck(d, 'aus', false).status).toBe('pass'); // deterioration is 45 min after ETA
    expect(alternateCheck(d, 'us', false).status).toBe('fail');
    d.plan.alternateId = d.alternatives[0].aerodrome.id;
    d.alternatives[0].weather.taf!.raw = 'TAF YPPH 090000Z 0900/1000 24010KT CAVOK FM090700 24010KT 1000 BKN001';
    expect(suitableAlternate(d, 'us')).toBe(true); // clear at diversion ETA 0617
    expect(suitableAlternate(d, 'aus')).toBe(false); // Code buffer includes 0700
    d.destinationWeather = weather('YSSY');
    d.alternatives[0].weather.taf!.raw = 'TAF YPPH 090000Z 0900/1000 24010KT 1000 BKN001';
    expect(alternateCheck(d, 'us', false).status).toBe('fail'); // optional nomination still commits
  });

  it('rebudgets existing surplus and reduces holding for a longer alternate', () => {
    const d = dossier(); d.plan.fuelKg = 15_000;
    d.alternatives.push({ ...structuredClone(d.alternatives[0]), aerodrome: AERODROMES[2], weather: weather('YMML'), distanceNm: 300 });
    const first = amendDossier(d, { stamp: 'AMEND', fuel: 15_000 }, 'aus');
    expect(first.plan.holdingMinutes).toBeCloseTo((15_000 - 9387.5) / 50);
    const next = amendDossier(first, { stamp: 'AMEND', alternate: AERODROMES[2].id, fuel: 15_000 }, 'aus');
    expect(next.plan.holdingMinutes).toBeCloseTo(first.plan.holdingMinutes - 2100 / 50);
    expect(fuelRequired(next, 'aus').totalKg).toBeCloseTo(15_000);
    expect(d.plan.holdingMinutes).toBe(0);
  });

  it('refuses missing alternate and accepts a release after a suitable alternate is supplied', () => {
    const d = dossier(); d.plan.alternateId = null;
    d.destinationWeather.taf = { ...d.destinationWeather.taf!, raw: `TAF YSSY 090000Z 0900/1000 24010KT 2000 BKN005` };
    d.plan.fuelKg = 10_000;
    const refused = judge(d, { stamp: 'REFUSE' }, { edition: 'aus', responseMs: 1200 });
    expect(refused.correct).toBe(true); expect(refused.rules).toContain('destination-alternate');
    const amended = judge(d, { stamp: 'AMEND', alternate: d.alternatives[0].aerodrome.id }, { edition: 'aus', responseMs: 1200 });
    expect(amended.correct).toBe(true); expect(amended.amendedDossier?.plan.alternateId).toBe(d.alternatives[0].aerodrome.id);
  });

  it('re-evaluates an added-fuel amendment and rejects fuel above tank capacity', () => {
    const d = dossier(); d.plan.fuelKg = 1; d.plan.dryOperatingKg = 71_000;
    const bad = judge(d, { stamp: 'REFUSE' }, { edition: 'aus', responseMs: 500 });
    expect(bad.correct).toBe(true); expect(bad.rules).toContain('fuel');
    const fixed = judge(d, { stamp: 'AMEND', fuel: d.plan.fuelKg + 100_000 }, { edition: 'aus', responseMs: 500 });
    expect(fixed.correct).toBe(false); expect(fixed.error).toMatch(/fuel|tank/i);
    const good = dossier(); good.plan.fuelKg = 7_000; good.plan.dryOperatingKg = 65_000; good.plan.alternateId = null;
    const goodFix = judge(good, { stamp: 'AMEND', fuel: 8_200 }, { edition: 'aus', responseMs: 500 });
    expect(goodFix.correct).toBe(true); expect(goodFix.after.every(a => a.result.status === 'pass')).toBe(true);
    const landingMass = dossier(); landingMass.plan.dryOperatingKg = 68_000; landingMass.plan.fuelKg = 12_000;
    const massFailure = judge(landingMass, { stamp: 'RELEASE' }, { edition: 'aus', responseMs: 500 });
    expect(massFailure.correct).toBe(false); expect(massFailure.rules).toContain('landing-distance');
  });

  it('does not let a delay erase duty, stale forecast or a landing/takeoff mass conflict', () => {
    const d = dossier();
    d.operation = 'airline'; d.documents.duty.scheme = 'au-basic'; d.documents.duty.endUtc = new Date(T0 + 12 * 3600_000).toISOString();
    const delayed = judge(d, { stamp: 'AMEND', delay: 300 }, { edition: 'aus', responseMs: 800 });
    expect(delayed.after.some(a => a.decreeId === 'duty' && a.result.status === 'fail')).toBe(true);
    d.plan.arrivalUtc = new Date(T0 + 24 * 3600_000).toISOString();
    expect(judge(d, { stamp: 'RELEASE' }, { edition: 'aus', responseMs: 800 }).correct).toBe(false);
    d.plan.dryOperatingKg = 94_000;
    expect(judge(d, { stamp: 'RELEASE' }, { edition: 'aus', responseMs: 800 }).correct).toBe(false);
  });

  it('rejects invalid response time and stale edition before producing evidence', () => {
    const d = dossier('aus');
    expect(() => judge(d, { stamp: 'RELEASE' }, { edition: 'us', responseMs: 0 })).toThrow(RangeError);
    expect(() => judge(d, { stamp: 'RELEASE' }, { edition: 'aus', responseMs: Number.NaN })).toThrow(RangeError);
    expect(() => amendDossier(d, { stamp: 'AMEND' }, 'aus')).toThrow(RangeError);
  });

  it('keeps AUS and US evidence strands separate and counts only safe on-time quota', () => {
    const person = priorPerson({ level: 'student', goal: 'flying', rules: 'aus', now: T0 });
    const ausDossier = dossier('aus'); ausDossier.documents.crew[0].medical.validUntil = new Date(T0 - 1).toISOString();
    const usDossier = dossier('us'); usDossier.documents.crew[0].medical.validUntil = new Date(T0 - 1).toISOString();
    const aus = judge(ausDossier, { stamp: 'REFUSE' }, { edition: 'aus', responseMs: 1000 });
    const us = judge(usDossier, { stamp: 'REFUSE' }, { edition: 'us', responseMs: 1000 });
    const afterAus = applyEvidence(person, aus.evidence, T0 + 1);
    expect(afterAus.strands['rules-aus'].answers).toBe(person.strands['rules-aus'].answers + 1);
    expect(afterAus.strands['rules-us'].answers).toBe(person.strands['rules-us'].answers);
    const afterUs = applyEvidence(afterAus, us.evidence, T0 + 2);
    expect(afterUs.strands['rules-aus'].answers).toBe(afterAus.strands['rules-aus'].answers);
    expect(afterUs.strands['rules-us'].answers).toBe(person.strands['rules-us'].answers + 1);
    const good = judge(dossier('aus'), { stamp: 'RELEASE' }, { edition: 'aus', responseMs: 1000 });
    const badRelease = judge(ausDossier, { stamp: 'RELEASE' }, { edition: 'aus', responseMs: 1000 });
    const score = scoreShift(17, 'aus', [
      { judgement: good, released: true, delayMinutes: 0 },
      { judgement: badRelease, released: false, delayMinutes: 0 },
      { judgement: aus, released: false, delayMinutes: 0 },
      { judgement: good, released: false, delayMinutes: 0 },
    ]);
    expect(score.correct).toBe(3); expect(score.citations).toBe(1); expect(score.onTime).toBe(1);
    expect(score.quotaMet).toBe(false); expect(score.points).toBe(8);
  });
});
