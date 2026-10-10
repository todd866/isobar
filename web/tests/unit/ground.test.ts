import { describe, expect, it } from 'vitest';
import { FRAME_READY, type LoadedChart } from '../../src/lib/chart-store';
import {
  formatGround, metresFromModel, orographyMetresAt, orographyVariable, resolveGroundM, sampleFrame, STANDARD_GRAVITY,
} from '../../src/lib/point/ground';
import type { ChartManifest } from '../../src/lib/manifest';

const grid = {
  nx: 2, ny: 2, west: 99, east: 100, north: 33, south: 32, step: 1, wrapsLongitude: false,
};

describe('point ground elevation', () => {
  it('converts ECMWF surface geopotential and keeps orography in metres', () => {
    expect(metresFromModel(4520 * STANDARD_GRAVITY, 'm**2 s**-2', 'z')).toBeCloseTo(4520, 4);
    expect(metresFromModel(4520 * STANDARD_GRAVITY, 'm2 s-2', 'z')).toBeCloseTo(4520, 4);
    expect(metresFromModel(4520, 'm', 'orog')).toBe(4520);
    expect(metresFromModel(100, 'm', 'z')).toBe(100);
    expect(metresFromModel(-430, 'm', 'orog')).toBe(-430);
    expect(metresFromModel(20000, 'm', 'orog')).toBeNull();
    expect(metresFromModel(Number.NaN, 'm', 'orog')).toBeNull();
  });

  it('prefers published orography, then the DEM, and does not invent a height', () => {
    expect(orographyVariable(['mslp', 't2m', 'z'])).toBe('z');
    expect(orographyVariable(['wind', 'orog', 'z'])).toBe('orog');
    expect(orographyVariable(['mslp', 'rain24'])).toBeNull();
    expect(resolveGroundM(4520, 100)).toBe(4520);
    expect(resolveGroundM(null, 4480)).toBe(4480);
    expect(resolveGroundM(null, 0)).toBe(0);
    expect(resolveGroundM(null, null)).toBeNull();
    expect(formatGround(4520)).toBe('4,520 m / 14,829 ft');
  });

  it('samples a surface-geopotential frame at the point', () => {
    const metres = [4400, 4500, 4600, 4700];
    const packed = new Uint16Array(metres.map((value) => Math.round(value * STANDARD_GRAVITY)));
    const manifest = {
      ...grid,
      variables: {
        z: { file: null, frames: ['z.bin'], encoding: 'raw', units: 'm**2 s**-2', scale: 1, offset: 0, fill: 65535 },
      },
    } as unknown as ChartManifest;
    const chart = {
      manifest,
      packed: { z: packed },
      state: { z: Uint8Array.of(FRAME_READY) },
    } as unknown as LoadedChart;
    expect(sampleFrame(Float32Array.from(metres), grid, 99.5, 32.5)).toBeCloseTo(4550, 4);
    expect(orographyMetresAt(chart, 99.5, 32.5)).toBeCloseTo(4550, 0);
    expect(orographyMetresAt(chart, 10, 10)).toBeNull();
    const missing = { ...chart, state: { z: Uint8Array.of(0) } } as unknown as LoadedChart;
    expect(orographyMetresAt(missing, 99.5, 32.5)).toBeNull();
  });
});
