import { describe, expect, it } from 'vitest';
import {
  advect,
  FLOW_LIFE_SECONDS,
  FLOW_FADE_SECONDS,
  ageFade,
  circularLowWind,
  particleCount,
  sampleBlended,
  seedParticle,
  stepParticle,
  streakInk,
  surfaceWindFromPressure,
  type Particle,
  type ScalarGrid,
} from '../../src/lib/flow';

function particle(lon: number, lat: number): Particle {
  return { lon, lat, age: 0.2, seedLon: lon, seedLat: lat };
}

describe('flow advection', () => {
  it('moves a westerly streak east', () => {
    const next = advect(115, -32, 10, 0, 3600);
    expect(next.lon).toBeGreaterThan(115.3);
    expect(next.lat).toBeCloseTo(-32, 4);
    const stepped = particle(115, -32);
    stepParticle(stepped, 10, 0, 1, false);
    expect(stepped.lon).toBeGreaterThan(115.3);
    expect(stepped.age).toBeCloseTo(1.2, 5);
  });

  it('advects a southern low clockwise', () => {
    const wind = circularLowWind(116, -32, 115, -32, 12);
    expect(wind.v).toBeLessThan(0);
    expect(Math.abs(wind.u)).toBeLessThan(1);
    const next = advect(116, -32, wind.u, wind.v, 800);
    expect(next.lat).toBeLessThan(-32);
    const stepped = particle(116, -32);
    stepParticle(stepped, wind.u, wind.v, 0.5, false);
    expect(stepped.lat).toBeLessThan(-32);
  });

  it('advects a northern low anticlockwise', () => {
    const wind = circularLowWind(-69, 40, -70, 40, 12);
    expect(wind.v).toBeGreaterThan(0);
    const next = advect(-69, 40, wind.u, wind.v, 800);
    expect(next.lat).toBeGreaterThan(40);
  });

  it('keeps a cross-isobar drift toward the low', () => {
    const tangential = circularLowWind(116, -32, 115, -32, 10);
    const next = advect(116, -32, tangential.u - 8, tangential.v, 600);
    const radius = (lon: number, lat: number) => Math.hypot(lon - 115, lat + 32);
    expect(radius(next.lon, next.lat)).toBeLessThan(radius(116, -32));
  });

  it('holds a static streamline when motion is reduced', () => {
    const stayed = particle(120, -30);
    stepParticle(stayed, 20, 5, 1, true);
    expect(stayed.lon).toBe(120);
    expect(stayed.lat).toBe(-30);
    expect(stayed.age).toBe(0);
  });

  it('samples a westerly grid and moves the streak east', () => {
    const grid: ScalarGrid = {
      nx: 4, ny: 3, west: 110, north: -20, dlon: 2, dlat: 2, wraps: false, fill: 65535, scale: 1, offset: 0,
    };
    const u = new Uint16Array(grid.nx * grid.ny).fill(10);
    const v = new Uint16Array(grid.nx * grid.ny).fill(0);
    const speed = sampleBlended(u, v, 0, 113, -22, grid);
    expect(speed).toBe(10);
    const stepped = particle(113, -22);
    const north = sampleBlended(v, v, 0, 113, -22, grid);
    stepParticle(stepped, speed ?? 0, north ?? 0, 1, false);
    expect(stepped.lon).toBeGreaterThan(113.2);
  });

  it('is fainter when calm and denser on the wind lens', () => {
    expect(streakInk(0, false).alpha).toBe(0);
    expect(streakInk(2.49, false)).toEqual({ alpha: 0, lengthPx: 0 });
    expect(streakInk(2.5, false).alpha).toBeGreaterThan(0);
    expect(streakInk(0.4, false).alpha).toBeLessThan(0.02);
    expect(streakInk(0.4, false).lengthPx).toBeLessThan(1);
    expect(streakInk(18, true).lengthPx).toBeGreaterThan(streakInk(6, false).lengthPx);
    expect(streakInk(18, true).alpha).toBeGreaterThan(streakInk(18, false).alpha);
    expect(particleCount(400 * 500, true)).toBeGreaterThan(particleCount(400 * 500, false));
    expect(ageFade(0)).toBe(0);
    expect(ageFade(2)).toBeGreaterThan(0.5);
    const a = seedParticle(3, 110, -40, 20, 15, 1);
    const b = seedParticle(3, 110, -40, 20, 15, 1);
    expect(a).toEqual(b);
    expect(a.lon).toBeGreaterThanOrEqual(110);
    expect(a.lon).toBeLessThan(130);
  });
});

describe('surface wind from pressure', () => {
  // A circular low of 990 hPa rising 1 hPa per degree outward.
  const low = (cLon: number, cLat: number) => (lon: number, lat: number) => 990 + Math.hypot(lon - cLon, lat - cLat);
  const at = (cLat: number, dLon: number, dLat: number) =>
    surfaceWindFromPressure(low(140, cLat), 140 + dLon, cLat + dLat, 0.5)!;

  it('runs clockwise round a Southern Hemisphere low, turned in toward the centre', () => {
    // East of the low: clockwise in the south means flow toward the south (v < 0),
    // and friction adds a westward (inward) part.
    const w = at(-35, 3, 0);
    expect(w.v).toBeLessThan(0);
    expect(w.u).toBeLessThan(0);
  });

  it('runs anticlockwise round a Northern Hemisphere low, turned in toward the centre', () => {
    const w = at(45, 3, 0);
    expect(w.v).toBeGreaterThan(0);
    expect(w.u).toBeLessThan(0);
  });

  it('gives a sensible surface speed for a 1 hPa per degree gradient at 35°', () => {
    const w = at(-35, 3, 0);
    const speed = Math.hypot(w.u, w.v);
    expect(speed).toBeGreaterThan(4);
    expect(speed).toBeLessThan(15);
  });

  it('returns nothing near the equator, where the balance does not hold', () => {
    expect(surfaceWindFromPressure(low(140, 0), 141, 2, 0.5)).toBeNull();
  });
});


describe('quiet particle lives', () => {
  it('retires after cumulative gradual turns exceed 90 degrees', () => {
    const p = particle(115, -32);
    stepParticle(p, 10, 0, 0.1, false);
    stepParticle(p, Math.cos(Math.PI / 6) * 10, Math.sin(Math.PI / 6) * 10, 0.1, false);
    stepParticle(p, Math.cos(Math.PI / 3) * 10, Math.sin(Math.PI / 3) * 10, 0.1, false);
    stepParticle(p, 0, 10, 0.1, false);
    const retired = stepParticle(p, Math.cos(Math.PI * 2 / 3) * 10, Math.sin(Math.PI * 2 / 3) * 10, 0.1, false);
    expect(retired).toBe(true);
    expect(p.age).toBe(FLOW_LIFE_SECONDS);
  });

  it('lives for 12 seconds and is invisible at the old and new respawn positions', () => {
    const p = particle(115, -32);
    p.age = FLOW_LIFE_SECONDS - 0.01;
    expect(ageFade(p.age)).toBeLessThan(0.001);
    stepParticle(p, 10, -3, 0.01, false);
    expect(p.age).toBe(0);
    expect(ageFade(p.age)).toBe(0);
    expect(p.lon).toBe(p.seedLon);
    expect(p.lat).toBe(p.seedLat);
    expect(FLOW_LIFE_SECONDS).toBeGreaterThanOrEqual(10);
    expect(FLOW_LIFE_SECONDS).toBeLessThanOrEqual(15);
  });

  it('has a continuous fade with a flat slope at birth and death', () => {
    expect(ageFade(-1)).toBe(0);
    expect(ageFade(FLOW_LIFE_SECONDS + 1)).toBe(0);
    expect(ageFade(FLOW_FADE_SECONDS)).toBe(1);
    for (const age of [0.001, 0.02, 0.2, 0.7, 1.4]) {
      expect(ageFade(age)).toBeCloseTo(ageFade(FLOW_LIFE_SECONDS - age), 12);
      expect(ageFade(age)).toBeGreaterThan(ageFade(age / 2));
    }
    expect(ageFade(0.001) / 0.001).toBeLessThan(0.002);
  });

  it('uses length and ink proportional to speed, with a bounded population', () => {
    expect(streakInk(12, false).lengthPx).toBeCloseTo(streakInk(6, false).lengthPx * 2);
    expect(streakInk(12, false).alpha).toBeCloseTo(streakInk(6, false).alpha * 2);
    expect(particleCount(390 * 600, false)).toBeLessThan(300);
    expect(particleCount(1440 * 900, false)).toBeLessThanOrEqual(1000);
    expect(particleCount(4000 * 3000, true)).toBeLessThanOrEqual(1800);
  });
});
