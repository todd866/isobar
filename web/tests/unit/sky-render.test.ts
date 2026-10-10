import { describe, expect, it } from 'vitest';
import { skyState } from '../../src/lib/sky/physics';
import { ftForY, layerLabel, stateKey, yForFt } from '../../src/lib/sky/render';
import { synthProfile } from '../../src/lib/sky/synthetic';

describe('sky section geometry', () => {
  it('puts heights on a monotone true-altitude axis that inverts exactly', () => {
    const h = 240;
    let last = Infinity;
    for (const ft of [0, 500, 2000, 5000, 10000, 20000, 30000, 45000]) {
      const y = yForFt(ft, h);
      expect(y).toBeLessThan(last);
      last = y;
      expect(ftForY(y, h)).toBeCloseTo(ft, 6);
    }
    expect(yForFt(0, h)).toBe(h - 16);
    expect(yForFt(45000, h)).toBeCloseTo(4, 6);
  });
  it('labels the METAR base at its AMSL height and keys the state by what is visible', () => {
    const state = skyState({
      icao: 'YPPH', elevationFt: 67, lat: -31.94, lon: 115.97, timeMs: Date.UTC(2026, 9, 8, 4), source: 'METAR',
      groups: [{ body: 'METAR YPPH 080400Z 25019KT 9999 BKN042 18/09 Q1011', change: null }],
      profile: synthProfile({ surfaceT: 18, rh: (z) => (z > 1200 && z < 2300 ? 92 : 45) }),
    });
    expect(layerLabel(state.layers[0])).toMatch(/^BKN 4,300/);
    const options = { width: 366, height: 232, dpr: 3, dark: false, seed: 'YPPH|run', coastKm: -19 };
    expect(stateKey(state, options)).toBe(stateKey({ ...state, timeMs: state.timeMs + 60_000 }, options));
    expect(stateKey(state, options)).not.toBe(stateKey(state, { ...options, dark: true }));
  });
});
