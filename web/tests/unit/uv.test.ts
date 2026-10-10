import { describe, expect, it } from 'vitest';
import { forecastDaySummaries, forecastUv, overlayUv, parsePlaceForecast } from '../../src/lib/point/openmeteo';
import { addLocalDays, localMidnight } from '../../src/lib/time-label';
import { sunProtectionLabel, uvAtHour, uvFigure } from '../../src/lib/point/uv';

const ZONE = 'Australia/Perth';

/** Open-Meteo local stamp in Australia/Perth (UTC+8, no daylight saving). */
function perth(local: string): number {
  return Date.parse(`${local}Z`) - 8 * 3_600_000;
}

describe('UV categories', () => {
  it('leaves missing values and indexes under 3 unshown', () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 2, 2.4]) {
      expect(uvFigure(value)).toBeNull();
    }
  });

  it('rounds to an integer and colours it by the WHO bands', () => {
    expect(uvFigure(2.5)).toEqual({ index: 3, category: 'moderate' });
    expect(uvFigure(3)).toEqual({ index: 3, category: 'moderate' });
    expect(uvFigure(5)).toEqual({ index: 5, category: 'moderate' });
    expect(uvFigure(5.4)).toEqual({ index: 5, category: 'moderate' });
    expect(uvFigure(5.5)).toEqual({ index: 6, category: 'high' });
    expect(uvFigure(6)).toEqual({ index: 6, category: 'high' });
    expect(uvFigure(7)).toEqual({ index: 7, category: 'high' });
    expect(uvFigure(7.5)).toEqual({ index: 8, category: 'very-high' });
    expect(uvFigure(8)).toEqual({ index: 8, category: 'very-high' });
    expect(uvFigure(10)).toEqual({ index: 10, category: 'very-high' });
    expect(uvFigure(10.4)).toEqual({ index: 10, category: 'very-high' });
    expect(uvFigure(10.5)).toEqual({ index: 11, category: 'extreme' });
    expect(uvFigure(11)).toEqual({ index: 11, category: 'extreme' });
    expect(uvFigure(12)).toEqual({ index: 12, category: 'extreme' });
    expect(uvFigure(14.2)).toEqual({ index: 14, category: 'extreme' });
  });
});

describe('sun protection times', () => {
  const noon = perth('2026-01-15T12:00:00');
  const dayStart = localMidnight(noon, ZONE);
  const dayEnd = addLocalDays(dayStart, 1, ZONE);
  const hours = (rows: [string, number | null][]) => rows.map(([local, uv]) => ({ time: perth(local), uv }));

  it('names the first and last local hour at or above 3, including a midday dip', () => {
    const label = sunProtectionLabel(hours([
      ['2026-01-15T16:00:00', 4],
      ['2026-01-15T07:00:00', 2],
      ['2026-01-15T08:00:00', 2.6],
      ['2026-01-15T12:00:00', 0],
      ['2026-01-15T17:00:00', 2.4],
    ]), dayStart, dayEnd, ZONE);
    expect(label).toBe('Sun protection 8 am–4 pm');
  });

  it('uses a single clock hour when only one sample qualifies', () => {
    expect(sunProtectionLabel(hours([
      ['2026-01-15T12:00:00', 11],
    ]), dayStart, dayEnd, ZONE)).toBe('Sun protection 12 pm');
  });

  it('stays empty on a winter day', () => {
    expect(sunProtectionLabel(hours([
      ['2026-01-15T11:00:00', 2],
      ['2026-01-15T12:00:00', null],
      ['2026-01-15T13:00:00', 1],
    ]), dayStart, dayEnd, ZONE)).toBeNull();
    expect(sunProtectionLabel([], dayStart, dayEnd, ZONE)).toBeNull();
  });

  it('keeps the next local midnight on the following day', () => {
    expect(sunProtectionLabel(hours([
      ['2026-01-15T16:00:00', 5],
      ['2026-01-16T00:00:00', 12],
    ]), dayStart, dayEnd, ZONE)).toBe('Sun protection 4 pm');
  });

  it('reads the current hour and leaves a gap missing', () => {
    const times = [perth('2026-01-15T12:00:00'), perth('2026-01-15T15:00:00')];
    expect(uvAtHour(times, [12, null], perth('2026-01-15T12:40:00'))).toBe(12);
    expect(uvAtHour(times, [12, 6], perth('2026-01-15T13:10:00'))).toBeNull();
    expect(uvAtHour(times, [12, null], perth('2026-01-15T15:20:00'))).toBeNull();
    expect(uvAtHour(times, [12, 6], perth('2026-01-15T11:00:00'))).toBeNull();
  });
});

describe('place forecast UV', () => {
  const response = {
    latitude: -31.9,
    longitude: 115.9,
    timezone: 'Australia/Perth',
    utc_offset_seconds: 28800,
    model: 'ecmwf_ifs025',
    model_run: '2026-01-15T00:00:00Z',
    hourly: {
      time: ['2026-01-15T07:00', '2026-01-15T08:00', '2026-01-15T12:00', '2026-01-15T16:00', '2026-01-15T17:00', '2026-01-16T12:00'],
      temperature_2m: [18, 22, 31, 29, 24, 11],
      uv_index: [2, 3.2, 11.6, 4, 1, null],
    },
    daily: {
      time: ['2026-01-15', '2026-01-16', '2026-01-17'],
      temperature_2m_max: [34, 21, 19],
      temperature_2m_min: [18, 10, 8],
      uv_index_max: [11.6, null, 2],
    },
  };

  it('keeps a missing daily maximum missing and shows 12 as extreme with protection times', () => {
    const forecast = parsePlaceForecast(response, Date.parse('2026-01-15T00:00:00Z'));
    expect(forecast.uv).toEqual([2, 3.2, 11.6, 4, 1, null]);
    expect(forecast.days.map((day) => day.uvMax)).toEqual([11.6, null, 2]);
    const days = forecastDaySummaries(forecast);
    expect(days[0]).toMatchObject({ key: '2026-01-15', uv: 12, protection: 'Sun protection 8 am–4 pm' });
    expect(days[1].uv).toBeNull();
    expect(days[1].protection).toBeNull();
    expect(days[2].uv).toBeNull();
    const now = forecastUv(forecast, perth('2026-01-15T12:30:00'));
    expect(now).toEqual({ index: 12, category: 'extreme', protection: 'Sun protection 8 am–4 pm' });
    expect(forecastUv(forecast, perth('2026-01-15T07:30:00'))).toBeNull();
    expect(forecastUv(forecast, perth('2026-01-16T12:30:00'))).toBeNull();
  });

  it('overlays UV onto collector days by local date', () => {
    const forecast = parsePlaceForecast(response);
    const stub = (key: string) => ({
      key, weekday: 'Thu', dayStart: 0, dayEnd: 1, hi: 30, lo: 18, rain: 0, icon: 'sun' as const,
    });
    const days = overlayUv([stub('2026-01-15'), stub('2026-01-17'), stub('2026-02-01')], forecast);
    expect(days[0]).toMatchObject({ hi: 30, uv: 12, protection: 'Sun protection 8 am–4 pm' });
    expect(days[1].uv).toBeNull();
    expect(days[2].uv).toBeUndefined();
  });
});
