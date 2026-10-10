import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeFloat16, float16ToNumber } from '../../src/lib/float16';
import { decodeUint16, encodeUint16, quantise } from '../../src/lib/quantise';
import { coastContains, parseCoast, simplifyRing } from '../../src/lib/coast';

describe('float16', () => {
  it('decodes the well-known patterns', () => {
    expect(float16ToNumber(0x0000)).toBe(0);
    expect(float16ToNumber(0x3c00)).toBe(1);
    expect(float16ToNumber(0xc000)).toBe(-2);
    expect(float16ToNumber(0x7c00)).toBe(Infinity);
    expect(float16ToNumber(0xfc00)).toBe(-Infinity);
    expect(Number.isNaN(float16ToNumber(0x7e00))).toBe(true);
  });

  it('decodes a little-endian buffer and keeps the fill missing', () => {
    const bytes = new Uint8Array(6);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0x3c00, true);
    view.setUint16(2, 0xcc00, true);
    view.setUint16(4, 0xf800, true);
    const values = decodeFloat16(bytes);
    expect(values[0]).toBe(1);
    expect(values[1]).toBeCloseTo(-16, 5);
    expect(Number.isNaN(values[2])).toBe(true);
  });
});

describe('uint16 quantisation', () => {
  const scale = { scale: 0.1, offset: 850, fill: 65535 };

  it('round-trips a pressure and preserves missing', () => {
    expect(quantise(1004, scale)).toBe(1540);
    expect(decodeUint16(encodeUint16([1004, NaN, 1032.04], scale), scale)).toEqual(
      Float32Array.from([1004, NaN, 1032]),
    );
  });
});

describe('coastline', () => {
  it('ships a bounded, fully parseable worldwide coast with land and sea on several continents', () => {
    const bytes = new Uint8Array(readFileSync(new URL('../../public/coast/world.bin', import.meta.url)));
    expect(bytes.byteLength).toBeLessThanOrEqual(1024 * 1024);
    const coast = parseCoast(bytes);
    expect(coast.rings.length).toBeGreaterThan(7000);
    for (const [lon, lat] of [[116, -32], [151, -33], [-0.12, 51.5], [13, 22], [-100, 40], [100, 35]]) {
      expect(coastContains(coast, lon, lat), `${lon},${lat} is land`).toBe(true);
    }
    for (const [lon, lat] of [[110, -35], [-140, 0], [-30, 0], [0, 89]]) {
      expect(coastContains(coast, lon, lat), `${lon},${lat} is sea`).toBe(false);
    }
  });

  it('parses the bundled OCST crop and treats Sydney as land', () => {
    const coast = parseCoast(new Uint8Array(readFileSync(new URL('../../../Resources/ownchart-coast.bin', import.meta.url))));
    expect(coast.rings.length).toBeGreaterThan(10);
    expect(coastContains(coast, 151.2, -33.87)).toBe(true);
    expect(coastContains(coast, 110, -40)).toBe(false);
  });

  it('simplifies a ring without dropping the ends', () => {
    const lon = Float32Array.from([0, 1, 2, 3, 4]);
    const lat = Float32Array.from([0, 0.01, 0, 0.01, 0]);
    const simple = simplifyRing({ lon, lat }, 0.5);
    expect(simple.lon[0]).toBe(0);
    expect(simple.lon[simple.lon.length - 1]).toBe(4);
    expect(simple.lon.length).toBeLessThan(lon.length);
  });
});
