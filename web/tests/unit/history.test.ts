import { describe, expect, it } from 'vitest';
import { availableDays, availableDaysForWeather, frameAt, normalizeCatalog, normalizeWeather, utcDateLabel } from '../../src/lib/history';

const weather = { schema_version: 1, product: 'isobar-historical-weather', units: { pressure_msl: 'hPa', u: 'knots', v: 'knots' }, grid: { latitudes: [2, 1], longitudes: [10, 11], nx: 2, ny: 2, step_degrees: 1 }, times: ['1944-06-06T00:00Z', '1944-06-06T01:00Z'], frames: [
  { time: '1944-06-06T00:00Z', pressure_msl: [1000, 1001, 1002, 1003], u: [1, 1, 1, 1], v: [2, 2, 2, 2] },
  { time: '1944-06-06T01:00Z', pressure_msl: [1004, 1005, 1006, 1007], u: [3, 3, 3, 3], v: [4, 4, 4, 4] },
] };

describe('historical catalogue contract', () => {
  it('requires complete, real calendar days', () => {
    const catalog = normalizeCatalog({ collections: [{ id: 'dday', title: 'D-Day', manifest: '/history/dday.json', days: [
      { date: '1944-06-07', complete: false }, { date: '1944-06-06', complete: true }, { date: '1944-02-30', complete: true },
    ] }] });
    expect(availableDays(catalog.collections[0]!)).toEqual([{ date: '1944-06-06', complete: true }]);
  });

  it('rejects truncated or non-finite grids and selects nearest UTC frame', () => {
    expect(normalizeWeather({ ...weather, frames: [{ ...weather.frames[0], u: [1] }] })).toBeNull();
    expect(normalizeWeather({ ...weather, frames: [{ ...weather.frames[0], u: [1, 1, 1, Number.NaN] }, weather.frames[1]] })).toBeNull();
    const parsed = normalizeWeather(weather);
    expect(normalizeWeather({ ...weather, schema_version: 2 })).toBeNull();
    expect(normalizeWeather({ ...weather, grid: { ...weather.grid, latitudes: [1, 2] } })).toBeNull();
    expect(normalizeWeather({ ...weather, times: ['1944-06-06T00:30Z', '1944-06-06T01:00Z'] })).toBeNull();
    expect(frameAt(parsed!, '1944-06-06T00:45:00Z')?.pressure_msl[0]).toBe(1004);
  });

  it('cross-checks complete catalogue days against weather frames', () => {
    const catalog = normalizeCatalog({ collections: [{ id: 'dday', title: 'D-Day', manifest: '/history/dday.json', days: [
      { date: '1944-06-06', complete: true }, { date: '1944-06-07', complete: true },
    ] }] });
    expect(availableDaysForWeather(catalog.collections[0]!, normalizeWeather(weather))).toHaveLength(0);
    const times=Array.from({length:24},(_,h)=>`1944-06-06T${String(h).padStart(2,'0')}:00Z`);
    const complete={...weather,times,frames:times.map(time=>({...weather.frames[0],time}))};
    expect(availableDaysForWeather(catalog.collections[0]!,normalizeWeather(complete))).toHaveLength(1);
  });

  it('formats archive dates in UTC', () => expect(utcDateLabel('1944-06-06')).toBe('06 Jun 1944'));
});
