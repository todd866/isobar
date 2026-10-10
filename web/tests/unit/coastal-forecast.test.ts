import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCoastalForecastCache, coastalCacheKey, coastalMarineUrl, coastalWindUrl,
  loadCoastalMarine, loadCoastalWind, parseCoastalForecast,
} from '../../src/lib/coastal-forecast';

const NOW = Date.UTC(2026, 9, 9, 7);
const wind = {
  timezone: 'Australia/Perth',
  hourly: {
    time: [Math.floor(NOW / 1000), Math.floor(NOW / 1000) + 3600],
    wind_speed_10m: [18, null], wind_gusts_10m: [24, -1], wind_direction_10m: [270, 361], is_day: [1, 0],
  },
};
const marine = {
  timezone: 'Australia/Perth',
  hourly: {
    time: [Math.floor(NOW / 1000), Math.floor(NOW / 1000) + 3600],
    wave_height: [1.2, null], swell_wave_height: [0.8, 0.7], swell_wave_period: [12, -2], swell_wave_direction: [220, 361],
    secondary_swell_wave_height: [0.3, null], secondary_swell_wave_period: [8, 9], secondary_swell_wave_direction: [180, 180], sea_surface_temperature: [19, null],
  },
};

describe('coastal forecast', () => {
  beforeEach(() => clearCoastalForecastCache());
  afterEach(() => { vi.restoreAllMocks(); delete (globalThis as { sessionStorage?: unknown }).sessionStorage; });

  it('requests 96 forecast hours, local unix timestamps and the correct cells', () => {
    const windUrl = new URL(coastalWindUrl(-31.946, 115.864, NOW));
    expect(windUrl.searchParams.get('latitude')).toBe('-31.95');
    expect(windUrl.searchParams.get('longitude')).toBe('115.86');
    expect(windUrl.searchParams.get('forecast_hours')).toBe('96');
    expect(windUrl.searchParams.get('start_date')).toBeNull();
    expect(windUrl.searchParams.get('end_date')).toBeNull();
    expect(windUrl.searchParams.get('timezone')).toBe('auto');
    expect(windUrl.searchParams.get('timeformat')).toBe('unixtime');
    expect(windUrl.searchParams.get('cell_selection')).toBe('nearest');
    expect(windUrl.searchParams.get('wind_speed_unit')).toBe('kn');
    const marineUrl = new URL(coastalMarineUrl(-31.946, 115.864, NOW));
    expect(marineUrl.searchParams.get('cell_selection')).toBe('sea');
    expect(marineUrl.searchParams.get('hourly')).toContain('secondary_swell_wave_period');
  });

  it('keeps missing and physically invalid values missing', () => {
    const parsed = parseCoastalForecast(wind, 'wind');
    expect(parsed.zone).toBe('Australia/Perth');
    expect(parsed.hours[0]).toMatchObject({ windKt: 18, gustKt: 24, windFrom: 270, daylight: true });
    expect(parsed.hours[1]).toMatchObject({ windKt: null, gustKt: null, windFrom: null, daylight: false });
    const sea = parseCoastalForecast(marine, 'marine');
    expect(sea.hours[0]).toMatchObject({ waveHeightM: 1.2, swellHeightM: 0.8, swellPeriodS: 12, swellFrom: 220, secondaryHeightM: 0.3, seaTempC: 19 });
    expect(sea.hours[1]).toMatchObject({ swellPeriodS: null, swellFrom: null, seaTempC: null });
  });

  it('falls back to UTC for an invalid timezone and rejects supplied unit metadata', () => {
    expect(parseCoastalForecast({ ...wind, timezone: 'not/a-zone' }, 'wind').zone).toBe('UTC');
    expect(() => parseCoastalForecast({ ...wind, hourly_units: { wind_speed_10m: 'km/h' } }, 'wind')).toThrow('Invalid coastal unit');
    expect(() => parseCoastalForecast({ ...marine, hourly_units: { swell_wave_period: 'minutes' } }, 'marine')).toThrow('Invalid coastal unit');
  });

  it('caches wind and marine independently by coordinate and UTC request day', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).includes('/marine') ? marine : wind), { status: 200 }));
    await loadCoastalWind(-31.946, 115.864, { nowMs: NOW, fetcher });
    await loadCoastalWind(-31.946, 115.864, { nowMs: NOW + 3600_000, fetcher });
    await loadCoastalMarine(-31.946, 115.864, { nowMs: NOW, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(coastalCacheKey(-31.946, 115.864, NOW, 'wind')).not.toBe(coastalCacheKey(-31.944, 115.861, NOW, 'wind'));
    expect(coastalCacheKey(-31.946, 115.864, NOW, 'wind')).not.toBe(coastalCacheKey(-31.946, 115.864, NOW, 'marine'));
  });

  it('cancels a zero-subscriber request and does not cache its late response', async () => {
    const controller = new AbortController();
    let release!: (response: Response) => void;
    const fetcher = vi.fn((_url: RequestInfo | URL) => new Promise<Response>((resolve) => {
      release = resolve;
      // Abort the caller before load() can register its subscription.
      controller.abort();
    }));
    await expect(loadCoastalWind(-31, 115, { nowMs: NOW, fetcher, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    release(new Response(JSON.stringify(wind)));
    const retry = vi.fn(async () => new Response(JSON.stringify(wind)));
    await loadCoastalWind(-31, 115, { nowMs: NOW, fetcher: retry });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('deduplicates concurrent loads while allowing one consumer to abort', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const firstController = new AbortController();
    const first = loadCoastalWind(-31, 115, { nowMs: NOW, fetcher, signal: firstController.signal });
    const second = loadCoastalWind(-31, 115, { nowMs: NOW, fetcher });
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    release(new Response(JSON.stringify(wind)));
    await expect(second).resolves.toMatchObject({ zone: 'Australia/Perth' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('aborts the shared fetch when every consumer aborts and does not cache it', async () => {
    let underlyingAborted = false;
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { underlyingAborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    }));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = loadCoastalWind(-31, 115, { nowMs: NOW, fetcher, signal: firstController.signal });
    const second = loadCoastalWind(-31, 115, { nowMs: NOW, fetcher, signal: secondController.signal });
    firstController.abort(); secondController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(underlyingAborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    const retry = vi.fn(async () => new Response(JSON.stringify(wind)));
    await loadCoastalWind(-31, 115, { nowMs: NOW, fetcher: retry });
    expect(retry).toHaveBeenCalledOnce();
  });

  it('expires entries after one hour', async () => {
    let now = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(wind)));
    await loadCoastalWind(-31, 115, { nowMs: NOW, fetcher });
    now += 3_600_000;
    await loadCoastalWind(-31, 115, { nowMs: NOW, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps at most 32 session entries', async () => {
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
      get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key),
    } });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(wind)));
    for (let i = 0; i < 33; i += 1) await loadCoastalWind(-30 - i * 0.01, 115, { nowMs: NOW, fetcher });
    expect([...data.keys()].filter((key) => key.startsWith('isobar.coastal.forecast.v1:'))).toHaveLength(32);
  });

  it('retries a failed marine request independently of wind', async () => {
    let marineAttempts = 0;
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/marine')) {
        marineAttempts += 1;
        return marineAttempts === 1 ? new Response('', { status: 503 }) : new Response(JSON.stringify(marine));
      }
      return new Response(JSON.stringify(wind));
    });
    await loadCoastalWind(-31, 115, { nowMs: NOW, fetcher });
    await expect(loadCoastalMarine(-31, 115, { nowMs: NOW, fetcher })).rejects.toThrow('Coastal request failed');
    await loadCoastalMarine(-31, 115, { nowMs: NOW, fetcher });
    expect(marineAttempts).toBe(2);
  });

  it('clear invalidates a pending request before it can write cache', async () => {
    let release!: (response: Response) => void;
    const slow = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const pending = loadCoastalWind(-31, 115, { nowMs: NOW, fetcher: slow });
    clearCoastalForecastCache();
    release(new Response(JSON.stringify(wind)));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(wind)));
    await loadCoastalWind(-31, 115, { nowMs: NOW, fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
