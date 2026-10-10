import { describe, expect, it } from 'vitest';
import { frameBlend, hourIndexBefore, sampleSeries } from '../../src/lib/interpolate';
import { sampleBicubic } from '../../src/lib/bicubic';
import { readManifest, SCHEMA1_HOURS } from '../../src/lib/manifest';
import { advancePlayback } from '../../src/lib/playback';
import { downloadHref } from '../../src/lib/release';

const grid = {
  west: 95, east: 170, north: 0, south: -50, step: 0.25, nx: 301, ny: 201, dtype: 'uint16',
};

const variables = {
  mslp: { file: 'mslp.u16', units: 'hPa', scale: 0.1, offset: 850, fill: 65535 },
  rain24: { file: 'rain24.u16', units: 'mm', scale: 0.1, offset: 0, fill: 65535 },
  t2m: { file: 't2m.u16', units: 'C', scale: 0.1, offset: -40, fill: 65535 },
  wind: { file: 'wind.u16', units: 'm/s', scale: 0.1, offset: 0, fill: 65535 },
};

function base(extra: Record<string, unknown>) {
  return {
    contract: 'isobar-web',
    run: '2026-10-06T00:00:00Z',
    generated: '2026-10-07T00:00:00Z',
    grid,
    variables,
    places: [{ id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.95, lon: 151.18, icao: 'YSSY' }],
    aviation: 'aviation.json',
    attribution: [{ source: 'ECMWF Open Data', licence: 'CC BY 4.0' }],
    ...extra,
  };
}

describe('manifest', () => {
  it('reads schema 1 as 33 steps of 3 h when the ladder is omitted', () => {
    const manifest = readManifest(base({ schema: 1 }));
    expect(manifest.forecastHours).toEqual([...SCHEMA1_HOURS]);
    expect(manifest.uniformStepHours).toBe(3);
    expect(manifest.forecastHours).toHaveLength(33);
  });

  it('rejects a schema 1 document that is not the 96 h ladder', () => {
    expect(() => readManifest(base({ schema: 1, forecast_hours: [0, 3, 6] }))).toThrow(/schema 1/);
  });

  it('reads schema 2 hours as written and does not invent a 3 h step', () => {
    const hours = [0, 3, 6, 144, 150, 156, 162, 168];
    const manifest = readManifest(base({ schema: 2, forecast_hours: hours, uniform_step_hours: null }));
    expect(manifest.forecastHours).toEqual(hours);
    expect(manifest.uniformStepHours).toBeNull();
  });
});

describe('time interpolation', () => {
  const hours = [0, 3, 144, 150];

  it('uses the real gap, including the 6 h tail', () => {
    const atThree = frameBlend(hours, 90);
    expect(atThree).toEqual({ i0: 0, i1: 1, t: 0.5 });
    const tail = frameBlend(hours, 147 * 60);
    expect(tail?.i0).toBe(2);
    expect(tail?.i1).toBe(3);
    expect(tail?.t).toBeCloseTo(0.5, 5);
  });

  it('does not stretch a missing hour', () => {
    const frames = [Float32Array.from([1000]), Float32Array.from([1012]), null, Float32Array.from([1024])];
    expect(Number.isNaN(sampleSeries(frames, hours, 147 * 60, 0))).toBe(true);
    expect(sampleSeries(frames, hours, 90, 0)).toBeCloseTo(1006, 5);
  });

  it('finds the frame 24 h earlier by the hour, not by index', () => {
    const ladder = [0, 3, 126, 144, 150];
    expect(hourIndexBefore(ladder, 3, 24)).toBe(-1);
    expect(hourIndexBefore(ladder, 2, 24)).toBe(-1);
    expect(hourIndexBefore([0, 3, 24, 48], 2, 24)).toBe(0);
  });
});

describe('bicubic', () => {
  it('reproduces a linear field', () => {
    const nx = 6;
    const ny = 5;
    const grid = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) grid[y * nx + x] = 2 * x + 3 * y;
    }
    expect(sampleBicubic(grid, nx, ny, 2.25, 1.5)).toBeCloseTo(2 * 2.25 + 3 * 1.5, 5);
  });

  it('returns missing when a neighbour is missing', () => {
    const grid = Float32Array.from([0, 1, 2, 3, 0, NaN, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
    expect(Number.isNaN(sampleBicubic(grid, 4, 4, 1.2, 1.2))).toBe(true);
  });
});

describe('playback', () => {
  it('never plays backwards: the end of the run returns to now', () => {
    const next = advancePlayback({ minute: 99, playing: true, direction: 1 }, 1, 8, 100, 30);
    expect(next.minute).toBe(30);
    expect(next.direction).toBe(1);
  });

  it('recovers a clock left running backwards by an older build', () => {
    const next = advancePlayback({ minute: 50, playing: true, direction: -1 }, 1, 8, 100, 30);
    expect(next.minute).toBe(58);
  });

  it('moves forward monotonically at 256× until the wrap', () => {
    let clock = { minute: 0, playing: true, direction: 1 as const } as { minute: number; playing: boolean; direction: 1 | -1 };
    let wraps = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const next = advancePlayback(clock, 0.05, 256, 10_080, 0);
      if (next.minute < clock.minute) wraps += 1;
      clock = next;
    }
    expect(wraps).toBeGreaterThan(0);
    expect(clock.direction).toBe(1);
  });
});

describe('release', () => {
  it('enables a download only for an https URL', () => {
    expect(downloadHref(null)).toBeNull();
    expect(downloadHref({ status: 'preparing' })).toBeNull();
    expect(downloadHref({ url: 'http://example.com/Isobar.dmg' })).toBeNull();
    expect(downloadHref({ url: 'https://example.com/Isobar.dmg' })).toBe('https://example.com/Isobar.dmg');
  });
});
