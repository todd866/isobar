import { describe, expect, it } from 'vitest';
import { bestWindow, DEFAULT_KITE_BAND, kiteBandColor, kiteBandState, nearestCoast, shoreDirection, shownKnots, validKiteBand } from '../../src/lib/coastal';
import type { Coast } from '../../src/lib/coast';
import { withLakes, type Water } from '../../src/lib/water';

const shore: Coast = { rings: [{ lon: new Float32Array([115, 116, 116, 115]), lat: new Float32Array([-32, -32, -33, -33]) }] };

describe('coastal helpers', () => {
  it('finds a coast within 50 km and infers seaward direction independent of winding', () => {
    const spot = nearestCoast(shore, { lat: -32.5, lon: 116.02 });
    expect(spot?.distanceKm).toBeLessThan(3);
    expect(spot?.seawardDeg).toBeCloseTo(90, 0);
    const reversed: Coast = { rings: [{ lon: new Float32Array([115, 116, 116, 115]), lat: new Float32Array([-33, -33, -32, -32]) }] };
    expect(nearestCoast(reversed, { lat: -32.5, lon: 116.02 })?.seawardDeg).toBeCloseTo(90, 0);
    expect(nearestCoast(shore, { lat: -34, lon: 120 })).toBeNull();
  });

  it('unwraps antimeridian rings and retains normals on tiny islands', () => {
    const island: Coast = { rings: [{
      lon: new Float32Array([179.99, -179.99, -179.99, 179.99]),
      lat: new Float32Array([0.01, 0.01, -0.01, -0.01]),
    }] };
    const nearDateLine = nearestCoast(island, { lat: 0, lon: -179.98 }, 50);
    expect(nearDateLine?.distanceKm).toBeLessThan(3);
    expect(nearDateLine?.seawardDeg).toBeCloseTo(90, 0);

    const tiny: Coast = { rings: [{
      lon: new Float32Array([150, 150.001, 150.001, 150]),
      lat: new Float32Array([-20, -20, -20.001, -20.001]),
    }] };
    const tinySpot = nearestCoast(tiny, { lat: -20.0005, lon: 150.002 }, 1);
    expect(tinySpot).not.toBeNull();
    expect(tinySpot?.seawardDeg).toBeCloseTo(90, 0);
  });

  it('points seaward over a lake from the bank', () => {
    const land: Coast = { rings: [{ lon: new Float32Array([-5, 5, 5, -5]), lat: new Float32Array([-5, -5, 5, 5]) }] };
    const water: Water = {
      rivers: [],
      rings: [{ minZoom: 0, lon: new Float32Array([0, 1, 1, 0]), lat: new Float32Array([0, 0, 1, 1]), west: 0, south: 0, east: 1, north: 1 }],
    };
    const spot = nearestCoast(withLakes(land, water), { lat: 0.5, lon: -0.02 });
    expect(spot?.distanceKm).toBeLessThan(5);
    expect(spot?.seawardDeg).toBeCloseTo(90, 0);
  });

  it('classifies shore-relative wind directions', () => {
    expect(shoreDirection(90, 90)).toBe('onshore');
    expect(shoreDirection(45, 90)).toBe('cross-on');
    expect(shoreDirection(0, 90)).toBe('cross');
    expect(shoreDirection(315, 90)).toBe('cross-off');
    expect(shoreDirection(270, 90)).toBe('offshore');
    expect(shoreDirection(null, 90)).toBeNull();
    expect(shoreDirection(90, null)).toBeNull();
    expect(nearestCoast({ rings: [] }, { lat: Number.NaN, lon: 0 })).toBeNull();
  });

  it('validates and colours kite bands', () => {
    expect(validKiteBand(DEFAULT_KITE_BAND)).toBe(true);
    expect(validKiteBand({ min: 25, max: 15 })).toBe(false);
    expect(validKiteBand({ min: 15, max: 101 })).toBe(false);
    expect(kiteBandState(15, DEFAULT_KITE_BAND)).toBe('inside');
    expect(kiteBandState(25, DEFAULT_KITE_BAND)).toBe('inside');
    // Colour follows the printed knot. 25.4 prints as 25, so a gust at the upper limit stays inside.
    expect(shownKnots(25.4)).toBe(25);
    expect(shownKnots(25.5)).toBe(26);
    expect(kiteBandState(25.4, DEFAULT_KITE_BAND)).toBe('inside');
    expect(kiteBandState(25.5, DEFAULT_KITE_BAND)).toBe('above');
    expect(kiteBandState(14.6, DEFAULT_KITE_BAND)).toBe('inside');
    expect(kiteBandState(-1, DEFAULT_KITE_BAND)).toBe('missing');
    expect(kiteBandState(null, DEFAULT_KITE_BAND)).toBe('missing');
    expect(kiteBandState(10, DEFAULT_KITE_BAND)).toBe('below');
    expect(kiteBandState(20, DEFAULT_KITE_BAND)).toBe('inside');
    expect(kiteBandState(30, DEFAULT_KITE_BAND)).toBe('above');
    expect(kiteBandColor('missing')).toBeNull();
  });

  it('selects the longest contiguous observed window and does not bridge gaps', () => {
    const hour = 60 * 60 * 1000;
    expect(bestWindow([
      { time: 0, good: true }, { time: hour, good: true }, { time: 3 * hour, good: true },
      { time: 4 * hour, good: true }, { time: 5 * hour, good: true },
    ], hour)).toEqual({ start: 3 * hour, end: 5 * hour });
    expect(bestWindow([{ time: 0, good: true }, { time: hour, good: true }, { time: 3 * hour, good: true }], hour)).toEqual({ start: 0, end: hour });
    expect(bestWindow([{ time: 0, good: true }], hour)).toBeNull();
    expect(bestWindow([{ time: 0, good: true }, { time: hour, good: false }, { time: hour, good: true }, { time: 2 * hour, good: true }], hour)).toEqual({ start: hour, end: 2 * hour });
    expect(bestWindow([{ time: 0, good: true }, { time: hour, good: true }, { time: 3 * hour, good: true }, { time: 4 * hour, good: true }], hour)).toEqual({ start: 0, end: hour });
  });
});
