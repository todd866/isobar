import { describe, expect, it } from 'vitest';
import { airportEvidence, buildTour, centreLesson, gradientLesson, type Features } from '../../src/lib/teaching-content';
import type { AviationAirport } from '../../src/lib/chart-store';
import type { PressureCentre } from '../../src/lib/contour';
import type { GradientEstimate } from '../../src/lib/chart-teaching';

const now = Date.parse('2026-10-07T06:00:00Z');
const centre = (kind: PressureCentre['kind'], hpa: number, lon: number): PressureCentre => ({ kind, hpa, lon, lat: -30, prominence: 8 });
const baseFeatures = (overrides: Partial<Features> = {}): Features => ({
  axes: [], tight: [], strongest: null, wettest: { lat: -30, lon: 135, mm: 42 }, biggest: centre('L', 980, 145), ...overrides,
});
const airport = (icao: string, metarRaw: string | null, metarTime: string | null, tafRaw: string | null, tafFrom = '2026-10-07T00:00:00Z', tafTo = '2026-10-08T12:00:00Z'): AviationAirport => ({
  icao, name: icao, zone: 'Australia/Perth', lat: -31.9, lon: 115.9,
  metar: metarRaw ? { raw: metarRaw, time: metarTime } : null,
  taf: tafRaw ? { raw: tafRaw, issue: tafFrom, from: tafFrom, to: tafTo } : null,
});

describe('teaching content', () => {
  it('builds a five-step tour with the biggest system, strongest wind and route endpoint', () => {
    const strongest: GradientEstimate = { lat: -32, lon: 150, gradientHpaPer100Km: 2.2, geostrophicKt: 48, fromDeg: 270, surfaceKt: 35 };
    const tour = buildTour(baseFeatures({ strongest }), [centre('H', 1035, 120), centre('L', 980, 145)], [], now, now);
    expect(tour.length).toBeGreaterThanOrEqual(4);
    expect(tour.length).toBeLessThanOrEqual(6);
    expect(tour[0].lesson.kind).toBe('L');
    expect(tour.some((step) => step.lesson.anchor === strongest && step.field === 'wind')).toBe(true);
    expect(tour.some((step) => step.lesson.id === 'tour-route' && step.lesson.kind === 'route')).toBe(true);
  });

  it('does not turn rain into CB evidence without a valid convective report', () => {
    const tour = buildTour(baseFeatures(), [], [], now, now);
    const rain = tour.find((step) => step.lesson.kind === 'rain')?.lesson;
    expect(rain?.question).toMatch(/prove.*CB/i);
    expect(rain?.detail).toMatch(/No valid aerodrome thunder/i);
    expect(rain?.datum).toMatch(/Wettest model cell/);
  });

  it('answers southern hemisphere low clockwise and high anticlockwise', () => {
    const low = centreLesson(centre('L', 990, 140));
    const high = centreLesson(centre('H', 1030, 120));
    expect(low.correct).toBe(low.choices.indexOf('Clockwise'));
    expect(high.correct).toBe(high.choices.indexOf('Anticlockwise'));
  });

  it('offers a numeric gradient estimate and an easier proportional support question', () => {
    const lesson = gradientLesson({ lat: -30, lon: 140, gradientHpaPer100Km: 1.7, geostrophicKt: 41, fromDeg: 90, surfaceKt: 25 });
    expect(lesson.choices).toContain('40 kt');
    expect(lesson.question).toMatch(/Estimate/);
    expect(lesson.support).toMatch(/Multiply by 1\.7/);
    expect(lesson.easier.correct).toBe(0);
  });

  it('rejects mismatched, stale and missing TAF evidence instead of calling it clear', () => {
    const mismatched = airport('YPPH', 'METAR YSSY 070600Z 18008KT CAVOK 19/11 Q1018', '2026-10-07T06:00:00Z', 'TAF YPPH 0700Z 0700/0812 18010KT CAVOK');
    const stale = airport('YPPH', 'METAR YPPH 070000Z 18008KT CAVOK 19/11 Q1018', '2026-10-07T00:00:00Z', null);
    const expired = airport('YPPH', 'METAR YPPH 070600Z 18008KT CAVOK 19/11 Q1018', '2026-10-07T06:00:00Z', 'TAF YPPH 0600Z 0600/0705 18010KT CAVOK', '2026-10-06T06:00:00Z', '2026-10-07T05:00:00Z');
    const missing = airport('YPPH', null, null, null);
    for (const item of [mismatched, stale, expired, missing]) {
      expect(airportEvidence(item, now, now).headline).not.toMatch(/\bclear\b/i);
    }
    expect(airportEvidence(mismatched, now, now).observation).toMatch(/unavailable/);
    expect(airportEvidence(missing, now, now).forecast).toMatch(/unavailable/);
  });

  it('distinguishes a fresh TS observation from an expired one', () => {
    const fresh = airport('YPPH', 'METAR YPPH 070600Z 32018KT 9999 VCTS FEW025CB SCT040 24/18 Q1008', '2026-10-07T06:00:00Z', null);
    const expired = airport('YPPH', 'METAR YPPH 070000Z 32018KT 9999 VCTS FEW025CB SCT040 24/18 Q1008', '2026-10-07T00:00:00Z', null);
    expect(airportEvidence(fresh, now, now).convective).toBe(true);
    expect(airportEvidence(expired, now, now).convective).toBe(false);
    expect(airportEvidence(expired, now, now).headline).toMatch(/stale/i);
  });
});

it('reports measured backing and veering instead of assuming every model cell backs', () => {
  const base = { lat: -30, lon: 140, gradientHpaPer100Km: 1.7, geostrophicKt: 41, fromDeg: 10, surfaceKt: 25 };
  expect(gradientLesson({ ...base, surfaceFromDeg: 350 }).why).toContain('backs 20°');
  expect(gradientLesson({ ...base, surfaceFromDeg: 40 }).why).toContain('veers 30°');
  expect(gradientLesson(base).why).toContain('direction unavailable');
});

it('has four honest steps when neither a system nor a wind maximum can be inferred', () => {
  const tour = buildTour(baseFeatures({ biggest: null, strongest: null, wettest: null }), [], [], now, now);
  expect(tour).toHaveLength(4);
  expect(tour.map((step) => step.lesson.datum).join(' ')).toContain('No usable wind');
  expect(tour.map((step) => step.lesson.datum).join(' ')).toContain('Rain data unavailable');
});

it('leads with low visibility and rejects a forecast issued in the future', () => {
  const a = airport('YPPH', 'METAR YPPH 070600Z 32018KT 1200 BR SCT040 24/18 Q1008', '2026-10-07T06:00:00Z', 'TAF YPPH 080000Z 0700/0812 32018KT 3000 TSRA BKN020CB');
  a.taf!.issue = '2026-10-08T00:00:00Z';
  const evidence = airportEvidence(a, now, now);
  expect(evidence.headline).toContain('Reduced visibility: 1.2 km');
  expect(evidence.convective).toBe(false);
  expect(evidence.forecast).toContain('unavailable');
});
