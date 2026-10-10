import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMarineCache, loadMarine, marineAt, marineCacheKey, marineUrl, parseMarine } from '../../src/lib/point/marine';

const T0 = Date.UTC(2026, 9, 8);
const body = {
  hourly: {
    time: ['2026-10-08T00:00', '2026-10-08T03:00'],
    sea_surface_temperature: [18, 19],
    ocean_current_velocity: [1.852, null],
    ocean_current_direction: [90, null],
    wave_height: [1, 2],
    swell_wave_height: [null, 1],
    swell_wave_period: [null, 10],
    swell_wave_direction: [null, 180],
  },
};

describe('Open-Meteo marine', () => {
  beforeEach(() => clearMarineCache());
  afterEach(() => { vi.restoreAllMocks(); delete (globalThis as { sessionStorage?: unknown }).sessionStorage; });

  it('requests the marine fields for the UTC day in GMT', () => {
    const url = new URL(marineUrl(-25.04, 75.06, T0 + 3 * 3600_000));
    expect(url.origin + url.pathname).toBe('https://marine-api.open-meteo.com/v1/marine');
    expect(url.searchParams.get('latitude')).toBe('-25.0');
    expect(url.searchParams.get('longitude')).toBe('75.1');
    expect(url.searchParams.get('timezone')).toBe('GMT');
    expect(url.searchParams.get('start_date')).toBe('2026-10-08');
    expect(url.searchParams.get('end_date')).toBe('2026-10-09');
    for (const name of ['sea_surface_temperature', 'ocean_current_velocity', 'ocean_current_direction', 'wave_height', 'swell_wave_height', 'swell_wave_period', 'swell_wave_direction']) {
      expect(url.searchParams.get('hourly')).toContain(name);
    }
  });

  it('keeps nulls null and converts current from km/h to knots', () => {
    const series = parseMarine(body);
    const first = marineAt(series, T0)!;
    expect(first.currentSpeedKt).toBeCloseTo(1, 5);
    expect(first.currentToDeg).toBe(90);
    expect(first.sstC).toBe(18);
    expect(first.swellHeightM).toBeNull();
    const second = marineAt(series, T0 + 3 * 3600_000)!;
    expect(second.currentSpeedKt).toBeNull();
    expect(second.currentToDeg).toBeNull();
    expect(second.waveHeightM).toBe(2);
    expect(marineAt(series, T0 + 90 * 60 * 1000)?.sstC).toBeCloseTo(18.5, 5);
    expect(marineAt(series, T0 + 90 * 60 * 1000)?.currentSpeedKt).toBeNull();
  });

  it('caches a point for the UTC day and does not refetch it', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    await loadMarine(-25.04, 75.06, { mapTimeMs: T0, fetcher });
    await loadMarine(-25.01, 75.09, { mapTimeMs: T0 + 3600_000, fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(marineCacheKey(-25.04, 75.06, T0)).toBe(marineCacheKey(-25.01, 75.09, T0));
    expect(marineCacheKey(-25, 75, T0)).not.toBe(marineCacheKey(-25, 75, T0 + 24 * 3600_000));
  });
});
