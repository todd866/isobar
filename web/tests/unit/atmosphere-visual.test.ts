import {describe, expect, it} from 'vitest';
import {syntheticAtmosphereProfile, syntheticAtmosphereVectors, syntheticAtmosphereWind} from '../../src/lib/atmosphere-flow';
import {TiltFraming, atmosphereFramingGain} from '../../src/lib/tilt-navigation';

describe('shared synthetic atmosphere', () => {
  it('is deterministic at historical dates and finite across the globe', () => {
    const time = Date.UTC(1944, 5, 6, 12);
    for (const [lat, lon] of [[-32, 116], [-34, 151], [0, 180], [85, -179]]) {
      const a = syntheticAtmosphereVectors(lat, lon, .5, 1.5, time);
      expect(a).toEqual(syntheticAtmosphereVectors(lat, lon, .5, 1.5, time));
      expect(a.length).toBeGreaterThan(20); expect(a.length).toBeLessThanOrEqual(1800);
      expect(a.every(v => [v.lat, v.lon, v.u, v.v, v.w, v.heightM].every(Number.isFinite))).toBe(true);
      expect(new Set(a.map(v => v.heightM)).size).toBe(5);
      expect(syntheticAtmosphereProfile(lat, lon, time).provenance.source).toBe('Synthetic');
    }
  });
  it('retains all layers across poles at close zoom and samples the equivalent geography', () => {
    const time = Date.UTC(1953, 4, 29, 6);
    for (const [orbit, physical] of [[93,87], [106,74], [-93,-87], [-106,-74]]) {
      expect(syntheticAtmosphereVectors(orbit, 12, .1, 1.5, time)).toEqual(syntheticAtmosphereVectors(physical, -168, .1, 1.5, time));
      expect(syntheticAtmosphereProfile(orbit, 12, time)).toEqual(syntheticAtmosphereProfile(physical, -168, time));
    }
    for (const lat of [89.99,90,90.01,-89.99,-90,-90.01,106,-106]) {
      const vectors = syntheticAtmosphereVectors(lat, 12, .01, 1.5, time);
      expect(vectors.length).toBeGreaterThan(0);
      expect(new Set(vectors.map(v => v.pressure)).size).toBe(5);
      expect(vectors.every(v => v.lat >= -90 && v.lat <= 90)).toBe(true);
    }
  });
  it('has wind shear, rising and sinking branches without jumps at the dateline', () => {
    const t = 0, low = syntheticAtmosphereWind(0, 0, 750, t), high = syntheticAtmosphereWind(0, 0, 9000, t);
    expect(high.u).toBeGreaterThan(low.u);
    expect(syntheticAtmosphereWind(0, 0, 5000, t).w).toBeGreaterThan(0);
    expect(syntheticAtmosphereWind(0, 1/6, 5000, t).w).toBeLessThan(0);
    expect(syntheticAtmosphereWind(0, 180, 5000, t).w).toBeCloseTo(syntheticAtmosphereWind(0, -180, 5000, t).w, 8);
  });
  it('frames regional atmosphere and preserves manual zoom on returning overhead', () => {
    const framing = new TiltFraming(), camera = {centerX: 116, centerY: -32, halfWidth: .9, halfHeight: .6};
    const tilted = framing.apply(camera, 0, 1);
    expect(tilted.halfHeight).toBeLessThan(.3);
    expect(tilted.centerX).toBe(camera.centerX); expect(tilted.centerY).toBe(camera.centerY);
    const pinched = {...tilted, halfWidth: tilted.halfWidth / 2, halfHeight: tilted.halfHeight / 2};
    expect(framing.apply(pinched, 1, 0).halfHeight).toBeCloseTo(.3, 8);
    expect(atmosphereFramingGain(90)).toBeLessThan(1.04);
    expect(atmosphereFramingGain(.05)).toBe(1);
  });
});
