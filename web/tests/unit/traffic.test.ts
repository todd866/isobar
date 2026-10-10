import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { globalEquirectangular, project } from '../../src/lib/lambert';
import {
  ADSB_USER_AGENT,
  TRAFFIC_CACHE_MS,
  TRAFFIC_KICK_MS,
  TRAFFIC_MAX_GLYPHS,
  TRAFFIC_POLL_MS,
  adsbPointUrl,
  bindTrafficPoll,
  cacheGet,
  cacheSet,
  fetchAdsbSnapshot,
  flightLevelLabel,
  layoutTraffic,
  parseTraffic,
  trafficCardLine,
  trafficCardOrigin,
  trafficOpacity,
  trafficTile,
  updateTrails,
  type TrafficAircraft,
  type TrafficTrail,
} from '../../src/lib/traffic';

const NOW = 1_790_500_000_000;
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/adsb-lol.json', import.meta.url), 'utf8')) as {
  now: number;
  ac: Record<string, unknown>[];
};

function payload(rows: Record<string, unknown>[], now = NOW) {
  return { now, ac: rows };
}

function aircraft(overrides: Record<string, unknown> = {}) {
  return { ...FIXTURE.ac[0], ...overrides };
}

function row(overrides: Partial<TrafficAircraft> = {}): TrafficAircraft {
  return {
    hex: '7c1234',
    callsign: 'TEST123',
    registration: 'VH-TEST',
    type: 'BE20',
    latitude: -31.9,
    longitude: 115.9,
    pressureAltitudeFt: 18000,
    distanceNm: 4,
    positionTimeMs: NOW - 2000,
    groundSpeedKt: 240,
    trackDegrees: 350,
    ...overrides,
  };
}

describe('parseTraffic', () => {
  it('reads the ADSB.lol fixture as pressure altitude in feet, not geometric height', () => {
    const snapshot = parseTraffic(FIXTURE, NOW, -31.94, 115.967);
    expect(snapshot?.aircraft).toHaveLength(1);
    const kept = snapshot!.aircraft[0];
    expect(kept.callsign).toBe('TEST123');
    expect(kept.pressureAltitudeFt).toBe(18000);
    expect(kept.pressureAltitudeFt).not.toBe(18640);
    expect(kept.groundSpeedKt).toBe(240);
    expect(kept.trackDegrees).toBe(350);
    expect(kept.type).toBe('BE20');
    expect(flightLevelLabel(kept.pressureAltitudeFt)).toBe('FL180');
    expect(flightLevelLabel(NaN)).toBe('—');
    expect(snapshot?.source).toBe('ADSB.lol');
  });

  it('drops stale responses and reports that are ground, unknown, old or out of range', () => {
    expect(trafficOpacity(89)).toBeGreaterThan(0);
    expect(trafficOpacity(90)).toBe(0);
    expect(parseTraffic(payload(FIXTURE.ac, NOW - 91_000), NOW, -31.94, 115.967)).toBeNull();
    expect(parseTraffic(payload(FIXTURE.ac, NOW + 16_000), NOW, -31.94, 115.967)).toBeNull();
    for (const bad of [
      { alt_baro: 'ground' },
      { alt_baro: null },
      { alt_baro: 0 },
      { alt_baro: true },
      { lat: null },
      { lon: 300 },
      { seen_pos: 91 },
      { seen_pos: -1 },
      { lat: -20 },
      { hex: '' },
      { alt_baro: undefined, alt_geom: 18640 },
    ]) {
      const filtered = parseTraffic(payload([aircraft(bad)]), NOW, -31.94, 115.967);
      expect(filtered?.aircraft).toEqual([]);
    }
  });

  it('keeps the newer duplicate and leaves missing speed, track and callsign unknown', () => {
    const duplicate = parseTraffic(payload([aircraft({ seen_pos: 20 }), aircraft({ seen_pos: 1 })]), NOW, -31.94, 115.967);
    expect(duplicate?.aircraft).toHaveLength(1);
    expect(NOW - duplicate!.aircraft[0].positionTimeMs).toBe(1000);
    const missing = parseTraffic(payload([aircraft({ gs: null, track: -1, flight: '@@@@@@' })]), NOW, -31.94, 115.967)?.aircraft[0];
    expect(missing?.groundSpeedKt).toBeUndefined();
    expect(missing?.trackDegrees).toBeUndefined();
    expect(missing?.callsign).toBe('VH-TEST');
    expect(parseTraffic({}, NOW, -31.94, 115.967)).toBeNull();
    expect(parseTraffic(payload([]), NOW, Number.NaN, 115.967)).toBeNull();
  });
});

describe('visibility and fade', () => {
  it('holds full opacity until 60 s, fades, and is gone after 90 s', () => {
    expect(trafficOpacity(-15)).toBe(1);
    expect(trafficOpacity(-16)).toBe(0);
    expect(trafficOpacity(2)).toBe(1);
    expect(trafficOpacity(60)).toBe(1);
    expect(trafficOpacity(75)).toBeCloseTo(0.5);
    expect(trafficOpacity(90)).toBe(0);
    expect(trafficOpacity(91)).toBe(0);
  });

  it('fades a drawn glyph and drops it once the position is older than 90 s', () => {
    const geo = globalEquirectangular(115.9, -31.9);
    const origin = project(geo, -31.9, 115.9)!;
    const camera = { centerX: origin.x, centerY: origin.y, halfWidth: 4, halfHeight: 4 };
    const fading = layoutTraffic({
      aircraft: [row({ positionTimeMs: NOW - 75_000 })],
      trails: new Map(),
      nowMs: NOW,
      geo,
      camera,
      width: 400,
      height: 400,
    });
    expect(fading).toHaveLength(1);
    expect(fading[0].opacity).toBeCloseTo(0.5);
    const gone = layoutTraffic({
      aircraft: [row({ positionTimeMs: NOW - 90_000 })],
      trails: new Map(),
      nowMs: NOW,
      geo,
      camera,
      width: 400,
      height: 400,
    });
    expect(gone).toEqual([]);
  });

  it('retains observations for paths and derives missing track without a duplicate short tail', () => {
    const first = row({ trackDegrees: undefined, positionTimeMs: NOW - 10_000 });
    let trails = updateTrails(new Map(), [first], NOW - 10_000);
    const moved = row({ trackDegrees: undefined, longitude: 116.4, positionTimeMs: NOW });
    trails = updateTrails(trails, [moved], NOW);
    expect(trails.get('7c1234')?.points).toHaveLength(2);
    const geo = globalEquirectangular(116, -32);
    const origin = project(geo, -31.9, 116.4)!;
    const camera = { centerX: origin.x, centerY: origin.y, halfWidth: 3, halfHeight: 3 };
    const [glyph] = layoutTraffic({
      aircraft: [moved],
      trails,
      nowMs: NOW,
      geo,
      camera,
      width: 600,
      height: 400,
    });
    expect(glyph.trackDeg).toBeGreaterThan(80);
    expect(glyph.trackDeg).toBeLessThan(100);
    expect(glyph.tail).toEqual([]);
    expect(glyph.vector).not.toBeNull();
    const stale = updateTrails(trails, [], NOW + 200_000);
    expect(stale.size).toBe(0);
  });

  it('uses small density dots at world scale, coalesces airport piles, and restores regional glyphs', () => {
    const geo = globalEquirectangular();
    const aircraft = Array.from({ length: 100 }, (_, i) => row({ hex: `plane${i}`, latitude: 47.5 + i * 0.0001, longitude: -122.3 }));
    const base = { aircraft, trails: new Map(), nowMs: NOW, geo, width: 1280, height: 720 };
    const world = layoutTraffic({ ...base, camera: { centerX: 0, centerY: 0, halfWidth: 180, halfHeight: 90 }, selectedHex: 'plane20' });
    expect(world).toHaveLength(1);
    expect(world[0].densityDot).toBe(true);
    expect(world[0].hex).toBe('plane20');
    expect(world[0].tail).toEqual([]);
    expect(world[0].label).toBe('TEST123 180 240');
    const regional = layoutTraffic({ ...base, camera: { centerX: -122.3, centerY: 47.5, halfWidth: 50, halfHeight: 36 } });
    expect(regional).toHaveLength(100);
    expect(regional.every((g) => !g.densityDot)).toBe(true);
  });

  it('draws at most the glyph budget, nearest the centre, and labels only when zoomed in', () => {
    expect(TRAFFIC_MAX_GLYPHS).toBeLessThanOrEqual(160);
    const geo = globalEquirectangular(115.9, -31.9);
    const origin = project(geo, -31.9, 115.9)!;
    const many: TrafficAircraft[] = [row({ hex: 'center', latitude: -31.9, longitude: 115.9 })];
    for (let i = 0; i < 180; i += 1) {
      many.push(row({ hex: `a${i}`, latitude: -31.9 + (i + 1) * 0.002, longitude: 115.9 }));
    }
    const close = { centerX: origin.x, centerY: origin.y, halfWidth: 2, halfHeight: 2 };
    const labelled = layoutTraffic({
      aircraft: many,
      trails: new Map<string, TrafficTrail>(),
      nowMs: NOW,
      geo,
      camera: close,
      width: 400,
      height: 400,
    });
    expect(labelled).toHaveLength(TRAFFIC_MAX_GLYPHS);
    expect(labelled.some((glyph) => glyph.hex === 'center')).toBe(true);
    expect(labelled.filter((glyph) => glyph.label).length).toBeGreaterThan(0);
    expect(labelled.find((glyph) => glyph.hex === 'center')?.label).toBe('TEST123 180 240');
    const selected = layoutTraffic({
      aircraft: many,
      trails: new Map(),
      nowMs: NOW,
      geo,
      camera: close,
      width: 400,
      height: 400,
      selectedHex: 'center',
      avoid: [{ x: 0, y: 0, w: 80, h: 80 }],
    });
    expect(selected.find((glyph) => glyph.hex === 'center')?.label).toBe('TEST123 180 240');
    const blocked = layoutTraffic({
      aircraft: [row()],
      trails: new Map(),
      nowMs: NOW,
      geo,
      camera: close,
      width: 400,
      height: 400,
      avoid: [{ x: 180, y: 150, w: 160, h: 80 }],
    });
    expect(blocked[0]?.label).toBeNull();
    const beside = layoutTraffic({
      aircraft: [row({ hex: 'center' }), row({ hex: 'other', callsign: 'QFA2' })],
      trails: new Map(),
      nowMs: NOW,
      geo,
      camera: close,
      width: 400,
      height: 400,
      selectedHex: 'center',
    });
    expect(beside.find((glyph) => glyph.hex === 'center')?.label).toBe('TEST123 180 240');
    expect(beside.find((glyph) => glyph.hex === 'other')?.labelOrigin).not.toEqual(beside.find((glyph) => glyph.hex === 'center')?.labelOrigin);
    const wide = layoutTraffic({
      aircraft: [row()],
      trails: new Map(),
      nowMs: NOW,
      geo,
      camera: { ...close, halfWidth: 30, halfHeight: 30 },
      width: 400,
      height: 400,
    });
    expect(wide[0]?.label).toBeNull();
  });
});

describe('tile cache, card and poll', () => {
  it('rounds nearby queries onto one tile and talks to ADSB.lol only from the server helper', async () => {
    const a = trafficTile(-31.94, 115.967, 80);
    const b = trafficTile(-31.8, 115.9, 90);
    expect(a?.key).toBe(b?.key);
    expect(a?.radiusNm).toBeLessThanOrEqual(250);
    expect(trafficTile(-31.7, 115.9, 80)?.key).not.toBe(a?.key);
    expect(trafficTile(91, 115, 80)).toBeNull();
    expect(adsbPointUrl(-32, 116, 125)).toBe('https://api.adsb.lol/v2/point/-32.0000/116.0000/125');
    let called = '';
    let agent = '';
    const snapshot = await fetchAdsbSnapshot(-31.94, 115.967, 80, NOW, async (url, init) => {
      called = String(url);
      agent = new Headers(init?.headers).get('user-agent') ?? '';
      return new Response(JSON.stringify(FIXTURE), { status: 200 });
    });
    expect(called).toBe(adsbPointUrl(a!.lat, a!.lon, a!.radiusNm));
    expect(agent).toBe(ADSB_USER_AGENT);
    expect(snapshot?.aircraft[0].pressureAltitudeFt).toBe(18000);
    const limited = await fetchAdsbSnapshot(-31.94, 115.967, 80, NOW, async () => new Response('no', { status: 429 }));
    expect(limited).toBeNull();
  });

  it('expires a tile after 5 s and bounds the cache', () => {
    const map = new Map();
    cacheSet(map, 'a', 1, 0, 2);
    cacheSet(map, 'b', 2, 1, 2);
    expect(cacheGet(map, 'a', TRAFFIC_CACHE_MS - 1)).toBe(1);
    expect(cacheGet(map, 'a', TRAFFIC_CACHE_MS)).toBeUndefined();
    cacheSet(map, 'c', 3, 2, 2);
    expect(map.size).toBe(2);
    expect(map.has('a')).toBe(false);
  });

  it('formats the card and keeps it inside the map', () => {
    expect(trafficCardLine(row(), NOW)).toBe('TEST123 · BE20 · FL180 · 240 kt · 2 s');
    expect(trafficCardLine(row({ type: '', groundSpeedKt: undefined, positionTimeMs: NOW - 4100 }), NOW)).toBe('TEST123 · — · FL180 · — · 4 s');
    const origin = trafficCardOrigin(380, 10, 200, 24, 400, 300);
    expect(origin.left).toBe(168);
    expect(origin.top).toBe(22);
    expect(origin.left + 200).toBeLessThanOrEqual(392);
    const tools = { x: 300, y: 0, w: 52, h: 200 };
    const clear = trafficCardOrigin(220, 40, 160, 24, 360, 400, [tools]);
    expect(clear.left + 160).toBeLessThanOrEqual(tools.x);
    expect(clear.top).toBeGreaterThanOrEqual(8);
  });

  it('polls every 10 s only while visible and does not kick twice inside 5 s', async () => {
    let visible = true;
    let pulls = 0;
    let clock = 0;
    const pending: { fn: () => void; ms: number; dead: boolean }[] = [];
    const poll = bindTrafficPoll({
      visible: () => visible,
      pull: async () => { pulls += 1; },
      now: () => clock,
      schedule: (fn, ms) => {
        const handle = { fn, ms, dead: false };
        pending.push(handle);
        return handle;
      },
      cancel: (handle) => { (handle as { dead: boolean }).dead = true; },
    });
    poll.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(pulls).toBe(1);
    expect(pending.at(-1)?.ms).toBe(TRAFFIC_POLL_MS);
    clock = TRAFFIC_KICK_MS - 1;
    poll.kick();
    await Promise.resolve();
    expect(pulls).toBe(1);
    clock = TRAFFIC_KICK_MS;
    poll.kick();
    await Promise.resolve();
    await Promise.resolve();
    expect(pulls).toBe(2);
    visible = false;
    poll.onVisibility();
    expect(pending.at(-1)?.dead).toBe(true);
    pending.at(-1)?.fn();
    await Promise.resolve();
    expect(pulls).toBe(2);
    visible = true;
    poll.onVisibility();
    await Promise.resolve();
    await Promise.resolve();
    expect(pulls).toBe(3);
    poll.stop();
    poll.kick();
    await Promise.resolve();
    expect(pulls).toBe(3);
  });
});
