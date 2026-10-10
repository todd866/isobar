import { describe, expect, it } from 'vitest';
import { accumulateTracks, assignTrackColors, greatCirclePoints, liveTrafficAtTime, mergeTrackPoints, parseFlightRoute, sampleTrafficAtTime, trafficAtTime, type TrafficTrailPoint } from '../../src/lib/traffic-paths';

const now = 1_800_000_000_000;
const point = (timeMs: number, latitude = -32, longitude = 116, pressureAltitudeFt?: number): TrafficTrailPoint => ({ latitude, longitude, timeMs, pressureAltitudeFt });
const aircraft = (hex: string, time = now - 1_000) => ({ hex, callsign: hex, registration: '', type: 'A320', latitude: -32, longitude: 116, pressureAltitudeFt: 12000, distanceNm: 1, positionTimeMs: time });

describe('traffic paths', () => {
  it('keeps paused or rewound near-now clocks out of live traffic, then restores live on Now', () => {
    expect(liveTrafficAtTime(false, false, now, now)).toBe(false);
    expect(liveTrafficAtTime(true, false, now, now)).toBe(false);
    expect(liveTrafficAtTime(false, true, now, now)).toBe(false);
    expect(liveTrafficAtTime(true, true, now, now)).toBe(true);
    expect(liveTrafficAtTime(true, true, now - 90_000, now)).toBe(false);
  });
  it('merges by timestamp, sorts, and bounds history', () => {
    const result = mergeTrackPoints([point(now - 1_000), point(now - 3_000)], [point(now - 1_000, -31, 117, 18000), point(now - 2_000)], now, 8);
    expect(result.map((p) => p.timeMs)).toEqual([now - 3_000, now - 2_000, now - 1_000]);
    expect(result.at(-1)?.pressureAltitudeFt).toBe(18000);
    expect(mergeTrackPoints([point(now - 5 * 60 * 60_000)], [], now)).toEqual([]);
  });

  it('accumulates observed aircraft and retains a temporarily missing aircraft', () => {
    const first = accumulateTracks(new Map(), [aircraft('abc123')], now);
    const second = accumulateTracks(first, [aircraft('abc123', now)], now + 10_000);
    expect(second.get('abc123')?.points).toHaveLength(2);
    expect(accumulateTracks(second, [], now + 10_001).has('abc123')).toBe(true);
  });

  it('replays one hour of observations, interpolates safely, and does not leak live fields', () => {
    const trail = { aircraft: { ...aircraft('abc123'), groundSpeedKt: 240, trackDegrees: 90, squawk: '1200' }, points: [
      point(now - 60 * 60_000, -32, 179.8, 10000), point(now - 59 * 60_000, -31, -179.8, 12000), point(now, -30, -179, 14000),
    ] };
    const sampled = sampleTrafficAtTime(trail, now - 59.5 * 60_000);
    expect(sampled?.latitude).toBeCloseTo(-31.5);
    expect(Math.abs(sampled?.longitude ?? 0)).toBeCloseTo(180);
    expect(sampled?.pressureAltitudeFt).toBe(11000);
    expect(sampled?.groundSpeedKt).toBeUndefined();
    expect(sampled?.squawk).toBeUndefined();
    expect(sampled?.trackDegrees).toBeDefined();
    expect(trafficAtTime(new Map([['abc123', trail]]), now - 60 * 60_000)).toHaveLength(1);
  });

  it('returns no sample outside captured coverage or across a long gap', () => {
    const trail = { aircraft: aircraft('abc123'), points: [point(now - 3 * 60_000), point(now)] };
    expect(sampleTrafficAtTime(trail, now - 4 * 60_000)).toBeNull();
    expect(sampleTrafficAtTime(trail, now - 90_000)).toBeNull();
    expect(sampleTrafficAtTime(trail, now + 1)).toBeNull();
  });

  it('assigns deterministic distinct colours and caps selection', () => {
    const hexes = Array.from({ length: 10 }, (_, i) => `${i.toString(16).padStart(6, '0')}`);
    const colors = assignTrackColors(hexes);
    expect(colors.size).toBe(8);
    expect(new Set(colors.values()).size).toBe(8);
    expect(assignTrackColors(hexes)).toEqual(colors);
  });

  it('creates a spherical route and validates adsbdb payloads', () => {
    const points = greatCirclePoints({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 90 }, 5);
    expect(points).toHaveLength(5); expect(points[2].longitude).toBeCloseTo(45);
    const route = parseFlightRoute({ response: { flightroute: { origin: { icao: 'YPPH', latitude: -31.94, longitude: 115.97 }, destination: { icao: 'YPAD', latitude: -34.95, longitude: 138.53 } } } }, 'qfa642');
    expect(route?.callsign).toBe('QFA642'); expect(route?.origin.icao).toBe('YPPH');
    expect(parseFlightRoute({ response: {} }, 'QFA642')).toBeNull();
  });
});

describe('selected colours and missing observations', () => {
  it('keeps peer colours after removal and caps at eight', async () => {
    const { toggleTrafficSelection } = await import('../../src/lib/traffic-paths');
    let selected: ReturnType<typeof toggleTrafficSelection> = [];
    for (let i = 0; i < 9; i++) selected = toggleTrafficSelection(selected, `abc00${i}`);
    expect(selected).toHaveLength(8);
    expect(new Set(selected.map((item) => item.colorIndex)).size).toBe(8);
    const before = selected.filter((item) => item.hex !== 'abc003');
    selected = toggleTrafficSelection(selected, 'abc003');
    expect(selected).toEqual(before);
    selected = toggleTrafficSelection(selected, 'abc008');
    expect(selected.slice(0, 7)).toEqual(before);
    expect(new Set(selected.map((item) => item.colorIndex)).size).toBe(8);
  });
  it('does not regress metadata; missing aircraft history persists until age bound', () => {
    const first = accumulateTracks(new Map(), [aircraft('abc123')], now);
    const delayed = accumulateTracks(first, [aircraft('abc123', now - 30_000)], now);
    expect(delayed.get('abc123')?.aircraft.positionTimeMs).toBe(now - 1000);
    const reappeared = accumulateTracks(delayed, [aircraft('abc123', now + 10 * 60_000)], now + 10 * 60_000);
    expect(reappeared.get('abc123')?.points).toHaveLength(3);
    expect(accumulateTracks(reappeared, [], now + 5 * 3600000).size).toBe(0);
  });
  it('rejects malformed trace points and absent route coordinates', () => {
    expect(mergeTrackPoints([], [null, {}, point(now + 20000)] as never, now)).toEqual([]);
    const bad = { icao: 'YPPH', latitude: null, longitude: '' };
    expect(parseFlightRoute({ origin: bad, destination: bad }, 'QFA642')).toBeNull();
  });
  it('retains a selected history when new traffic fills the bounded cache', () => {
    const first = accumulateTracks(new Map(), [aircraft('selected')], now);
    const busy = accumulateTracks(first, Array.from({ length: 520 }, (_, i) => aircraft(`new${i}`)), now, ['selected']);
    expect(busy.size).toBe(512);
    expect(busy.has('selected')).toBe(true);
  });
});
