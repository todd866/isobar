import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/openmeteo-point.json';
import placeFixture from './fixtures/openmeteo-place.json';
import {
  clearPointCache, forecastDaySummaries, forecastReading, loadPlaceForecast, loadPointProfile, openMeteoUrl,
  parseOpenMeteo, parsePlaceForecast, placeForecastUrl, pointCacheKey, pointProfileAt,
  pointSurfaceAt, PRESSURE_LEVELS,
} from '../../src/lib/point/openmeteo';
import { forecastRunLabel, forecastRunTitle, readingTitle } from '../../src/lib/point/provenance';
import { seriesProvenance } from '../../src/lib/point/section';

const T0 = Date.UTC(2026, 9, 8);

describe('Open-Meteo point profile', () => {
  beforeEach(() => clearPointCache());
  afterEach(() => { vi.restoreAllMocks(); delete (globalThis as { sessionStorage?: unknown }).sessionStorage; });

  it('requests rounded coordinates, ECMWF pressure levels, knots and GMT', () => {
    const url = openMeteoUrl(-31.946, 115.864, 'chart-run-20261008', T0 + 12 * 3600_000);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('latitude')).toBe('-31.9');
    expect(parsed.searchParams.get('longitude')).toBe('115.9');
    expect(parsed.searchParams.get('models')).toBe('ecmwf_ifs025');
    expect(parsed.searchParams.get('start_date')).toBe('2026-10-08');
    expect(parsed.searchParams.get('end_date')).toBe('2026-10-09');
    expect(parsed.searchParams.get('wind_speed_unit')).toBe('kn');
    expect(parsed.searchParams.get('timezone')).toBe('GMT');
    const hourly = parsed.searchParams.get('hourly')!;
    for (const level of PRESSURE_LEVELS) expect(hourly).toContain(`temperature_${level}hPa`);
    expect(hourly).toContain('temperature_2m');
    expect(hourly).toContain('precipitation');
    expect(hourly.split(',')).not.toContain('uv_index');
  });

  it('parses the response into the shared ProfileSeries and surface values', () => {
    const model = parseOpenMeteo(fixture, -31.95, 115.86);
    expect(model.elevationM).toBe(27);
    expect(model.series.levels).toHaveLength(10);
    expect(model.series.levels[0].hPa).toBe(1000);
    expect(model.series.levels[0].z).toEqual([155, 153, 151, 148]);
    expect(model.surface[1].temperature2mC).toBe(18.7);
    expect(model.surface[3].precipitationMm).toBe(1.4);
    expect(model.series.elevationFt).toBeCloseTo(88.6, 1);
  });

  it('uses profileAt for vector wind and interpolation only across a three-hour gap', () => {
    const model = parseOpenMeteo(fixture);
    const profile = pointProfileAt(model, T0 + 90 * 60 * 1000)!;
    expect(profile.samples).toEqual([T0, T0 + 3 * 3600_000]);
    expect(profile.levels[0].tC).toBeCloseTo(17.85, 4);
    expect(profile.levels[0].windKt).toBeGreaterThan(14);
    expect(pointProfileAt(model, T0 + 9 * 3600_000)?.samples).toEqual([T0 + 6 * 3600_000]);
  });

  it('treats no-zone ISO times as UTC and keys the complete UTC day', () => {
    const model = parseOpenMeteo(fixture);
    expect(model.series.time[0]).toBe(Date.UTC(2026, 9, 8));
    expect(pointCacheKey(-31.9, 115.9, T0 + 1_000)).toBe(pointCacheKey(-31.9, 115.9, T0 + 23 * 3600_000));
    expect(pointCacheKey(-31.9, 115.9, T0)).not.toBe(pointCacheKey(-31.9, 115.9, T0 + 24 * 3600_000));
    // The fourth key is the Open-Meteo model, not a map run.
    expect(pointCacheKey(-31.9, 115.9, T0, 'ecmwf_ifs025')).not.toBe(pointCacheKey(-31.9, 115.9, T0, 'gfs_seamless'));
    expect(() => parseOpenMeteo({ hourly: { time: ['2026-10-08T00:00', '2026-10-07T23:00'] } }, -31, 115)).toThrow();
  });

  it('interpolates complete surface vectors and leaves gapped or incomplete winds missing', () => {
    const model = parseOpenMeteo(fixture);
    expect(pointSurfaceAt(model, T0 + 90 * 60 * 1000)?.temperature2mC).toBeCloseTo(19.05, 4);
    const gapped = { ...model, series: { ...model.series, time: [T0, T0 + 6 * 3600_000] }, surface: [model.surface[0], model.surface[2]] };
    expect(pointSurfaceAt(gapped, T0 + 3 * 3600_000)?.temperature2mC).toBe(19.4);
    const incomplete = { ...model, surface: model.surface.map((s, i) => i === 1 ? { ...s, windDirection10m: null } : s) };
    expect(pointSurfaceAt(incomplete, T0 + 90 * 60 * 1000)?.windSpeed10mKt).toBeNull();
  });

  it('keeps missing values missing instead of coercing them to zero', () => {
    const response = structuredClone(fixture) as typeof fixture;
    (response.hourly.relative_humidity_850hPa as (number | null)[])[1] = null;
    (response.hourly.wind_speed_700hPa as (number | null)[])[1] = null;
    const model = parseOpenMeteo(response);
    const profile = pointProfileAt(model, T0 + 3 * 3600_000)!;
    expect(profile.levels.find((level) => level.hPa === 850)?.rh).toBeNull();
    expect(profile.levels.find((level) => level.hPa === 700)?.windKt).toBeNull();
    const missing = structuredClone(fixture) as Record<string, unknown>;
    missing.elevation = null;
    missing.hourly = { time: fixture.hourly.time, temperature_2m: [null] };
    const empty = parseOpenMeteo(missing);
    expect(empty.elevationM).toBeNull();
    expect(Number.isNaN(empty.series.elevationFt)).toBe(true);
    expect(pointProfileAt(empty, T0)?.levels).toEqual([]);
    expect(Object.values(pointSurfaceAt(empty, T0)!)).toEqual(Array(7).fill(null));
    expect(pointProfileAt(model, T0 + 20 * 3600_000)).toBeNull();
    expect(pointSurfaceAt(model, T0 + 20 * 3600_000)).toBeNull();
  });

  it('caches a rounded point and does not fetch it twice', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } }));
    await loadPointProfile(-31.946, 115.864, { mapTimeMs: T0, fetcher });
    await loadPointProfile(-31.944, 115.861, { mapTimeMs: T0, fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(pointCacheKey(-31.946, 115.864, T0)).toBe(pointCacheKey(-31.944, 115.861, T0));
  });

  it('reuses a serialized session cache after the in-memory cache is cleared', async () => {
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
      get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key), clear: () => data.clear(),
    } });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    await loadPointProfile(-31.95, 115.86, { mapTimeMs: T0, fetcher });
    const key = pointCacheKey(-31.95, 115.86, T0);
    const serialized = (globalThis.sessionStorage as Storage).getItem(key);
    clearPointCache();
    (globalThis.sessionStorage as Storage).setItem(key, serialized!);
    await loadPointProfile(-31.95, 115.86, { mapTimeMs: T0, fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  it('passes AbortSignal through and never stores an aborted request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) { expect(init.signal).toBe(controller.signal); controller.abort(); }
      return new Response(JSON.stringify(fixture), { status: 200 });
    });
    await expect(loadPointProfile(-31.95, 115.86, { mapTimeMs: T0, fetcher, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await loadPointProfile(-31.95, 115.86, { mapTimeMs: T0, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects before fetch for invalid or pre-aborted points', async () => {
    const fetcher = vi.fn();
    const controller = new AbortController(); controller.abort();
    await expect(loadPointProfile(-91, 115, { mapTimeMs: T0, fetcher })).rejects.toThrow('Invalid point coordinates');
    await expect(loadPointProfile(-31, 115, { mapTimeMs: T0, fetcher, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ignores malformed session entries and storage failures', async () => {
    const key = pointCacheKey(-31.95, 115.86, T0);
    const getItem = vi.fn(() => '{bad json');
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { length: 1, key: () => key, getItem, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('locked'); } } });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    await loadPointProfile(-31.95, 115.86, { mapTimeMs: T0, fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  it('expires memory entries and keeps the latest completed request in a race', async () => {
    let now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(fixture)));
    await loadPointProfile(-31, 115, { mapTimeMs: T0, fetcher });
    now += 3_600_000;
    await loadPointProfile(-31, 115, { mapTimeMs: T0, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    clearPointCache();
    let release!: (response: Response) => void;
    const slow = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const old = loadPointProfile(-31, 115, { mapTimeMs: T0, fetcher: slow });
    const newer = structuredClone(fixture); newer.elevation = 100;
    await loadPointProfile(-31, 115, { mapTimeMs: T0, fetcher: async () => new Response(JSON.stringify(newer)) });
    release(new Response(JSON.stringify(fixture)));
    await old;
    expect((await loadPointProfile(-31, 115, { mapTimeMs: T0, fetcher })).elevationM).toBe(100);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('expires session entries, handles blocked reads, and rejects aborted cache hits', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(fixture)));
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
      getItem: () => JSON.stringify({ response: fixture, fetchedAt: Date.now() - 3_600_001 }),
      setItem: () => {}, length: 0,
    } });
    await loadPointProfile(-31, 115, { mapTimeMs: T0, fetcher });
    const controller = new AbortController(); controller.abort();
    await expect(loadPointProfile(-31, 115, { mapTimeMs: T0, fetcher, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => { throw Error('locked'); } } });
    await loadPointProfile(-32, 115, { mapTimeMs: T0, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('records Open-Meteo’s own cycle when the response names one, never the map run', () => {
    const mapRun = '2026-10-07T12:00:00Z';
    const fetched = Date.UTC(2026, 9, 8, 16, 11);
    const named = parseOpenMeteo({ ...fixture, models: { ecmwf_ifs025: { initialization_time: '2026-10-08T18:00:00Z' } } }, -31.9, 115.9, fetched);
    expect(named.provenance).toMatchObject({ source: 'Open-Meteo', model: 'ecmwf_ifs025', cycle: true, run: '2026-10-08T18:00:00Z' });
    expect(named.series.run).toBe('2026-10-08T18:00:00Z');
    expect(named.series.runKnown).toBe(true);
    expect(JSON.stringify(named)).not.toContain(mapRun);
    expect(forecastRunLabel(named.provenance)).toBe('IFS 0.25° · 08 18Z');
    const latest = parseOpenMeteo(fixture, -31.9, 115.9, fetched);
    expect(latest.provenance.cycle).toBe(false);
    expect(latest.series.run).toBe('2026-10-08T16:11:00Z');
    expect(latest.series.run).not.toBe(mapRun);
    expect(forecastRunLabel(latest.provenance)).toBe('IFS 0.25° · latest 08 16:11Z');
    expect(forecastRunTitle(latest.provenance)).toBe('Open-Meteo · latest at fetch');
    expect(forecastRunTitle(latest.provenance).length).toBeLessThanOrEqual(60);
  });

  it('keeps a collector profile on its own run when the map is a different cycle', () => {
    const series = parseOpenMeteo(fixture).series;
    const collected = seriesProvenance({ ...series, icao: 'YPPH', source: 'ECMWF', model: 'ecmwf_ifs025', run: '2026-10-08T18:00:00Z', runKnown: true });
    expect(collected.run).toBe('2026-10-08T18:00:00Z');
    expect(forecastRunLabel(collected)).toBe('IFS 0.25° · 08 18Z');
    expect(forecastRunLabel(collected)).not.toContain('12Z');
  });

  it('does not copy a map run out of an older cache envelope', async () => {
    const mapRun = '2026-10-07T12:00:00Z';
    const fetched = Date.now();
    const key = pointCacheKey(-31.95, 115.86, T0);
    const data = new Map<string, string>([[key, JSON.stringify({ response: fixture, latitude: -31.9, longitude: 115.9, run: mapRun, fetchedAt: fetched })]]);
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
      get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (item: string) => data.get(item) ?? null, setItem: (item: string, value: string) => data.set(item, value),
      removeItem: (item: string) => data.delete(item),
    } });
    const fetcher = vi.fn();
    const model = await loadPointProfile(-31.95, 115.86, { mapTimeMs: T0, fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    expect(model.series.run).not.toBe(mapRun);
    expect(model.provenance.cycle).toBe(false);
    expect(model.provenance.run).toBe(new Date(fetched).toISOString().replace(/\.000Z$/, 'Z'));
    expect(forecastRunLabel(model.provenance)).toContain('latest');
  });

  it('accepts a model-run response header as the cycle', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200, headers: { 'x-open-meteo-model-run': '2026-10-08T00:00:00Z' } }));
    const model = await loadPointProfile(-31.2, 115.2, { mapTimeMs: T0, fetcher });
    expect(model.provenance.cycle).toBe(true);
    expect(model.series.run).toBe('2026-10-08T00:00:00Z');
    expect(forecastRunLabel(model.provenance)).toBe('IFS 0.25° · 08 00Z');
  });
});

describe('Open-Meteo place forecast', () => {
  beforeEach(() => clearPointCache());
  afterEach(() => { vi.restoreAllMocks(); delete (globalThis as { sessionStorage?: unknown }).sessionStorage; });

  it('asks for seven local days and hourly surface, not a sounding', () => {
    const url = new URL(placeForecastUrl(47.572, -122.342));
    expect(url.searchParams.get('timezone')).toBe('auto');
    expect(url.searchParams.get('forecast_days')).toBe('7');
    expect(url.searchParams.get('models')).toBe('ecmwf_ifs025');
    expect(url.searchParams.get('wind_speed_unit')).toBe('kn');
    expect(url.searchParams.get('daily')).toContain('temperature_2m_max');
    expect(url.searchParams.get('daily')).toContain('precipitation_sum');
    expect(url.searchParams.get('hourly')).toContain('temperature_2m');
    expect(url.searchParams.get('hourly')?.split(',')).toContain('uv_index');
    expect(url.searchParams.get('daily')?.split(',')).toContain('uv_index_max');
    expect(url.searchParams.get('hourly')).not.toContain('temperature_1000hPa');
    expect(url.searchParams.has('start_date')).toBe(false);
  });

  it('parses local hours into UTC and leaves a missing day missing', () => {
    const forecast = parsePlaceForecast(placeFixture, Date.parse('2026-10-09T18:00:00Z'));
    expect(forecast.zone).toBe('America/Los_Angeles');
    expect(forecast.times[0]).toBe(Date.parse('2026-10-09T18:00:00Z'));
    expect(forecast.provenance).toMatchObject({ source: 'Open-Meteo', run: '2026-10-09T00:00:00Z', cycle: true });
    expect(forecast.days).toHaveLength(7);
    expect(forecast.days[0]).toMatchObject({ key: '2026-10-09', hi: 18, lo: 10, rain: 1.2, windKt: 12, windFrom: 180, icon: 'rain' });
    expect(forecast.days[1].rain).toBeNull();
    expect(forecast.days[1].icon).toBe('sun');
    expect(forecast.days[0].uvMax).toBeNull();
    expect(forecast.uv).toEqual([null]);
    const days = forecastDaySummaries(forecast);
    expect(days[0].dayStart).toBe(Date.parse('2026-10-09T07:00:00Z'));
    expect(days[0].weekday).toBe('Fri');
    expect(days[0].uv).toBeNull();
    expect(days[0].protection).toBeNull();
    const reading = forecastReading(forecast, Date.parse('2026-10-09T18:00:00Z'));
    expect(reading.reading).toMatchObject({ tempC: 14, windKt: 8, windFrom: 220 });
    expect(reading.valid).toBe('2026-10-09T18:00:00Z');
    const title = readingTitle(forecast.provenance, reading.valid);
    expect(title).toContain('valid');
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it('caches a place by coordinates and model, and clear drops it', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(placeFixture), { status: 200 }));
    const first = await loadPlaceForecast(47.57, -122.34, { fetcher });
    const second = await loadPlaceForecast(47.6, -122.3, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second.days).toEqual(first.days);
    expect(String(fetcher.mock.calls[0][0])).toContain('timezone=auto');
    clearPointCache();
    await loadPlaceForecast(47.6, -122.3, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
