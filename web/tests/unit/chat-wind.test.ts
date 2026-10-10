import { describe, expect, it } from 'vitest';
import type { ChartManifest } from '../../src/lib/manifest';
import { sampleField, type PublishedChart } from '../../src/lib/chat/tools';

const manifest = (variables: string[], geometry: Partial<Pick<ChartManifest, 'nx' | 'ny' | 'west' | 'east' | 'north' | 'south' | 'step' | 'wrapsLongitude'>> = {}, forecastHours = [0]): ChartManifest => ({
  schema: 2, contract: 'isobar-web', run: '2026-10-08T00:00:00Z', generated: '',
  forecastHours, uniformStepHours: null, nx: 5, ny: 5,
  west: 110, east: 114, north: -32, south: -36, step: 1,
  wrapsLongitude: false, dtype: 'uint16', ...geometry,
  variables: Object.fromEntries(variables.map((name) => [name, {
    file: null, frames: ['frame'], encoding: 'raw' as const, units: name === 'mslp' ? 'hPa' : 'm/s',
    scale: 1, offset: 0, fill: 65535,
  }])),
  places: [], aviation: 'aviation.json', points: null, attribution: [],
});

function chart(variables: string[], frames: Record<string, Float32Array>, geometry?: Parameters<typeof manifest>[1], forecastHours = [0], framesByIndex?: Record<string, Float32Array[]>): PublishedChart {
  const m = manifest(variables, geometry, forecastHours);
  return {
    manifest: m,
    frame: (variable, index) => framesByIndex?.[variable]?.[index] ?? frames[variable] ?? null,
    points: null, aviation: null, sky: null, places: [], profile: async () => null,
  };
}

describe('chat wind evidence', () => {
  it('prefers model u10/v10 direction when scalar wind is also published', () => {
    const result = sampleField(chart(['mslp', 'wind', 'u10', 'v10'], {
      wind: new Float32Array(25).fill(4), u10: new Float32Array(25).fill(3), v10: new Float32Array(25).fill(-4),
    }), 'wind', -34, 112, '2026-10-08T00:00:00Z');
    expect(result).toMatchObject({ value: 4, from: 323, valueSource: 'published wind speed', directionSource: 'model 10 m wind' });
  });

  it('labels a pressure-derived direction and keeps a calm estimate missing', () => {
    const pressure = new Float32Array(25);
    for (let row = 0; row < 5; row += 1) for (let col = 0; col < 5; col += 1) pressure[row * 5 + col] = 1000 + col * 2 + row;
    const result = sampleField(chart(['mslp', 'wind'], { mslp: pressure, wind: new Float32Array(25).fill(8) }), 'wind', -34, 112, '2026-10-08T00:00:00Z');
    expect(result).toMatchObject({ directionSource: 'estimated from isobars' });
    expect(result.missing).not.toBe(true);
    expect(typeof result.from).toBe('number');

    const calm = sampleField(chart(['mslp', 'wind'], { mslp: new Float32Array(25).fill(1000), wind: new Float32Array(25).fill(0) }), 'wind', -34, 112, '2026-10-08T00:00:00Z');
    expect(calm).toMatchObject({ value: 0, valueSource: 'published wind speed' });
    expect(calm.from).toBeUndefined();
  });

  it('keeps equatorial and incomplete evidence missing', () => {
    const pressure = new Float32Array(25).fill(1000);
    const speed = { mslp: pressure, wind: new Float32Array(25).fill(8) };
    expect(sampleField(chart(['mslp', 'wind'], speed), 'wind', -34, 112, '2026-10-08T03:00:00Z')).toMatchObject({ missing: true });
    expect(sampleField(chart(['mslp', 'wind'], speed, { south: -2, north: 2, step: 1 }), 'wind', 0, 112, '2026-10-08T00:00:00Z')).toMatchObject({ value: 8 });
    expect(sampleField(chart(['mslp', 'wind'], speed), 'wind', -36, 110, '2026-10-08T00:00:00Z')).toMatchObject({ value: 8 });
  });

  it('keeps scalar speed when model direction cells are unavailable', () => {
    const scalar = new Float32Array(25).fill(12);
    const missing = new Float32Array(25).fill(Number.NaN);
    const result = sampleField(chart(['mslp', 'wind', 'u10', 'v10'], { wind: scalar, u10: missing, v10: missing }), 'wind', -34, 112, '2026-10-08T00:00:00Z');
    expect(result).toMatchObject({ value: 12, valueSource: 'published wind speed' });
    expect(result.from).toBeUndefined();
  });

  it('derives speed from components without a scalar field and uses isobars for a partial manifest', () => {
    const result = sampleField(chart(['u10', 'v10'], { u10: new Float32Array(25).fill(3), v10: new Float32Array(25).fill(-4) }), 'wind', -34, 112, '2026-10-08T00:00:00Z');
    expect(result).toMatchObject({ value: 9.7, from: 323, valueSource: 'model 10 m wind', directionSource: 'model 10 m wind' });
    const pressure = Float32Array.from({ length: 25 }, (_, i) => 1000 + i);
    const partial = sampleField(chart(['mslp', 'wind', 'u10'], { mslp: pressure, wind: new Float32Array(25).fill(8), u10: new Float32Array(25).fill(3) }), 'wind', -34, 112, '2026-10-08T00:00:00Z');
    expect(partial).toMatchObject({ value: 8, directionSource: 'estimated from isobars' });
  });

  it('reports calm model wind as zero speed without a direction', () => {
    const calm = sampleField(chart(['mslp', 'wind', 'u10', 'v10'], {
      wind: new Float32Array(25).fill(0), u10: new Float32Array(25).fill(0), v10: new Float32Array(25).fill(0),
    }), 'wind', -34, 112, '2026-10-08T00:00:00Z');
    expect(calm).toMatchObject({ value: 0, valueSource: 'published wind speed' });
    expect(calm.from).toBeUndefined();
  });

  it('samples a wrapped pressure gradient across the longitude seam', () => {
    const pressure = new Float32Array(25);
    for (let row = 0; row < 5; row += 1) for (let col = 0; col < 5; col += 1) pressure[row * 5 + col] = 1000 + col + row;
    const result = sampleField(chart(['mslp', 'wind'], { mslp: pressure, wind: new Float32Array(25).fill(8) }, {
      west: -180, east: -178, north: -32, south: -34, step: 0.5, wrapsLongitude: true,
    }), 'wind', -33, -178, '2026-10-08T00:00:00Z');
    expect(result).toMatchObject({ directionSource: 'estimated from isobars' });
    expect(result.missing).not.toBe(true);
  });

  it('interpolates scalar speed and model direction between published frames', () => {
    const first = new Float32Array(25).fill(6), second = new Float32Array(25).fill(10);
    const u0 = new Float32Array(25).fill(2), u1 = new Float32Array(25).fill(4);
    const v0 = new Float32Array(25).fill(0), v1 = new Float32Array(25).fill(0);
    const result = sampleField(chart(['mslp', 'wind', 'u10', 'v10'], { mslp: new Float32Array(25).fill(1000) }, undefined, [0, 3], {
      wind: [first, second], u10: [u0, u1], v10: [v0, v1], mslp: [new Float32Array(25).fill(1000), new Float32Array(25).fill(1000)],
    }), 'wind', -34, 112, '2026-10-08T01:30:00Z');
    expect(result).toMatchObject({ value: 8, from: 270, directionSource: 'model 10 m wind' });
  });
});
