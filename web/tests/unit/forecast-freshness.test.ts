import { describe, expect, it } from 'vitest';
import { forecastFreshness } from '../../src/lib/forecast-freshness';
const run = Date.parse('2026-10-07T00:00:00Z');
const label = (hours: number, zone = 'Australia/Perth') => forecastFreshness(run, run + hours * 3600000, zone);
describe('plain forecast freshness', () => {
  it('preserves the whole-hour stale threshold and hides fresh/future/invalid runs', () => {
    for (const age of [-1, 0, 12, 18, 18.99]) expect(label(age)).toBeNull();
    expect(label(19)).toBe('Forecast 19 h old');
    expect(forecastFreshness(0, run, 'Australia/Perth')).toBeNull();
    expect(forecastFreshness(NaN, run, 'Australia/Perth')).toBeNull();
  });
  it('uses plain hours through 36 hours then a local date', () => {
    expect(label(22)).toBe('Forecast 22 h old');
    expect(label(36)).toBe('Forecast 36 h old');
    expect(label(36.01)).toBe('Forecast from Wed 8 am');
    expect(label(37, 'Australia/Sydney')).toBe('Forecast from Wed 11 am');
    expect(label(37, 'America/Los_Angeles')).toBe('Forecast from Tue 5 pm');
  });
});
