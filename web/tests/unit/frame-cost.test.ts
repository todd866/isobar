import { describe, expect, it, vi } from 'vitest';
import { float16ToNumber } from '../../src/lib/float16';
import { mosaicElevation } from '../../src/lib/terrain/elevation';
import { createTiltCamera, forwardProject } from '../../src/lib/tilt-camera';

// Reference IEEE binary16 decoding (the arithmetic the lookup table replaces).
function reference(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 0x1f, fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}
const half = (value: number) => { const f = new Float32Array([value]); const u = new Uint32Array(f.buffer)[0];
  const sign = (u >> 16) & 0x8000, e = ((u >> 23) & 0xff) - 112, m = (u >> 13) & 0x3ff; return sign | (e << 10) | m; };

describe('frame-cost hot paths keep their values', () => {
  it('decodes every binary16 pattern exactly as the reference arithmetic', () => {
    for (let bits = 0; bits < 65536; bits += 1) {
      const a = float16ToNumber(bits), b = reference(bits);
      if (Number.isNaN(b)) expect(Number.isNaN(a)).toBe(true); else expect(Object.is(a, b) || a === b).toBe(true);
    }
  });

  it('does not sample the far mosaic inside the near mosaic, and blends at its edge', () => {
    const grid = (w: number, h: number, metres: number) => { const d = new Uint16Array(w * h * 2); for (let i = 0; i < w * h; i++) { d[i * 2] = half(metres); d[i * 2 + 1] = half(1); } return d; };
    let farReads = 0;
    const farMosaic = { z: 3, covered: 1, width: 8, height: 8, data: grid(8, 8, 100), box: { west: 0, east: 8, south: 0, north: 8 } };
    const near = { z: 9, covered: 1, width: 64, height: 64, data: grid(64, 64, 900), box: { west: 2, east: 6, south: 2, north: 6 }, far: farMosaic };
    const realFar = mosaicElevation(farMosaic);
    const sample = mosaicElevation({ ...near, far: { ...farMosaic, data: new Proxy(farMosaic.data, { get(t, k) { if (typeof k === 'string' && /^\d+$/.test(k)) farReads++; return Reflect.get(t, k); } }) } as never });
    expect(sample(4, 4)).toBe(900);
    expect(farReads).toBe(0);
    const edge = sample(2.05, 4)!;
    expect(edge).toBeGreaterThan(realFar(2.05, 4)!);
    expect(edge).toBeLessThan(900);
    expect(farReads).toBeGreaterThan(0);
    expect(sample(7, 7)).toBe(100);
  });

  it('projects exactly as the vector formulation', () => {
    const camera = createTiltCamera({ lat: 27.98, lon: 86.92, halfHeightDeg: .3, aspect: 1.6, tiltRadians: 1.1, bearingRadians: .7, targetElevationM: 5000 });
    const p = forwardProject(camera, 28.05, 86.99, 7000)!;
    // Independent restatement of surface() + perspective() with vectors.
    const DEG = Math.PI / 180, k = camera.geometry.curvature, re = 1 / k, h = 7000 / 6_371_000;
    const phi = k * 28.05 * DEG, phi0 = k * 27.98 * DEG, lambda = k * (86.99 - 86.92) * DEG;
    const n = [Math.cos(phi) * Math.sin(lambda), Math.sin(phi) * Math.cos(phi0) - Math.cos(phi) * Math.cos(lambda) * Math.sin(phi0), Math.cos(phi) * Math.cos(lambda) * Math.cos(phi0) + Math.sin(phi) * Math.sin(phi0)];
    const point = [re * n[0] + n[0] * h, re * n[1] + n[1] * h, re * (n[2] - 1) + n[2] * h], o = camera.geometry.cameraPositionNormalized;
    const r = [point[0] - o[0], point[1] - o[1], point[2] - o[2]], dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const depth = dot(r, camera.geometry.forward);
    expect(p.x).toBeCloseTo(dot(r, camera.geometry.right) / (depth * camera.geometry.tangentHalfHeight * camera.aspect), 12);
    expect(p.y).toBeCloseTo(dot(r, camera.geometry.up) / (depth * camera.geometry.tangentHalfHeight), 12);
    expect(p.depth).toBeCloseTo(depth * 6_371_000, 6);
    expect(p.visible).toBe(true);
  });
});

