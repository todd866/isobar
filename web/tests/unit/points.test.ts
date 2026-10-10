import { describe, expect, it } from 'vitest';
import { cloudLayers, ceilingFt, distanceBearing, hazards, metarRow } from '../../src/lib/metar-view';
import { compass, daySummaries, rainLabel, readingAt, type PointsFile } from '../../src/lib/points';

const RUN = '2026-10-06T12:00:00Z'; // 8 pm Tue AWST
const hours = Array.from({ length: 17 }, (_, index) => index * 3); // 0..48 h

function points(): PointsFile {
  return {
    run: RUN,
    hours,
    places: {
      perth: {
        t: hours.map((hour) => 15 + 5 * Math.sin(((hour + 12 - 6) / 24) * 2 * Math.PI)),
        wspd: hours.map(() => 10),
        wdir: hours.map((hour) => (hour < 24 ? 350 : 10)),
        tp: hours.map((hour) => (hour <= 12 ? 0 : hour * 0.1)),
        cc: hours.map(() => 80),
      },
    },
  };
}

describe('point readings', () => {
  it('interpolates the wind vector across north, not the angle', () => {
    const at = Date.parse(RUN) + 22.5 * 3_600_000; // between 350 at 21 h and 10 at 24 h
    const reading = readingAt(points(), 'perth', at);
    expect(reading.windKt).toBeCloseTo(10, 5);
    expect(reading.windFrom === 0 || reading.windFrom === 360 || reading.windFrom === 359 || reading.windFrom === 1).toBe(true);
  });

  it('is missing outside the run', () => {
    expect(readingAt(points(), 'perth', Date.parse(RUN) - 3_600_000).tempC).toBeNull();
  });

  it('names the compass point', () => {
    expect(compass(202)).toBe('SSW');
    expect(compass(359)).toBe('N');
  });
});

describe('day tiles', () => {
  it('summarises each local day the run covers', () => {
    const days = daySummaries(points(), 'perth', 'Australia/Perth');
    // Run 20:00 Tue AWST to 20:00 Thu AWST: Tue, Wed, Thu.
    expect(days.map((day) => day.weekday)).toEqual(['Tue', 'Wed', 'Thu']);
    const wed = days[1];
    expect(wed.hi).not.toBeNull();
    expect(wed.lo).not.toBeNull();
    expect((wed.hi as number) >= (wed.lo as number)).toBe(true);
    expect(wed.rain).toBeGreaterThan(0);
    expect(wed.icon).toBe('rain');
  });

  it('shows rain to one decimal under 10 mm and hides a dry day', () => {
    expect(rainLabel(0.1)).toBeNull();
    expect(rainLabel(2.94)).toBe('2.9');
    expect(rainLabel(21.4)).toBe('21');
  });
});

describe('METAR row', () => {
  it('leads with the hazard, then cloud, visibility and wind', () => {
    const row = metarRow('SPECI YPPH 061141Z 12007KT 9999 VCTS FEW035CB SCT069 BKN115 20/17 Q1015 RETS RESHRA');
    expect(row.hazards.map((item) => item.text)).toEqual(['VCTS', 'CB 3,500']);
    expect(row.hazards[0].severe).toBe(true);
    expect(row.clouds).toEqual(['SCT069', 'BKN115']);
    expect(row.visibility).toBe('10+ km');
    expect(row.wind).toBe('120/07');
    expect(row.tempDew).toBe('20/17');
  });

  it('finds the ceiling and reads CAVOK', () => {
    expect(ceilingFt(cloudLayers('SCT012 BKN020 OVC040'))).toBe(2000);
    expect(ceilingFt(cloudLayers('FEW026'))).toBeNull();
    expect(metarRow('METAR YSSY 070300Z 19022KT CAVOK 17/09 Q1026').visibility).toBe('CAVOK');
    expect(hazards('-SHRA BKN025').map((item) => item.text)).toEqual(['-SHRA']);
  });

  it('measures distance and bearing', () => {
    const where = distanceBearing(-31.95, 115.86, -31.94, 115.97);
    expect(where.km).toBeGreaterThan(9);
    expect(where.km).toBeLessThan(12);
    expect(where.bearing).toBe('E');
  });
});
