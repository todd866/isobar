import assert from 'node:assert/strict';
import test from 'node:test';
import { profileAt, type ProfileSeries } from '../src/sky/physics.ts';
import { reportAt, sceneFor, type SkyAirport } from '../src/sky/scene.ts';
import { sceneForFeed, type SkyFeed } from '../src/sky/feed.ts';

const HOUR = 3_600_000;
const metarAt = Date.UTC(2026, 8, 26, 12, 0);
const ypph: SkyAirport = {
  icao: 'YPPH', lat: -31.94, lon: 115.97,
  metar: { raw: 'METAR YPPH 261200Z 14012KT 9999 SCT034 BKN073 18/12 Q1015', time: '2026-09-26T12:00:00Z' },
  taf: { raw: 'TAF YPPH 261200Z 2612/2712 14012KT 9999 SCT030', issue: '2026-09-26T12:00:00Z', from: '2026-09-26T12:00:00Z', to: '2026-09-27T12:00:00Z' },
};

function series(first: number, count: number): ProfileSeries {
  const time = Array.from({ length: count }, (_, i) => first + i * 3 * HOUR);
  const level = (hPa: number, z: number, t: number, rh: number) => ({
    hPa, z: time.map(() => z), t: time.map(() => t), rh: time.map(() => rh), ws: time.map(() => 20), wd: time.map(() => 270), cc: time.map(() => 0), w: time.map(() => 0),
  });
  return { icao: 'YPPH', run: 'test', lat: -31.94, lon: 115.97, elevationFt: 67, coastKm: -19, time,
    levels: [level(1000, 111, 18, 70), level(850, 1457, 8, 75), level(700, 3012, -2, 60), level(500, 5574, -18, 40), level(300, 9164, -42, 30)] };
}

test('a METAR base sits at its AGL height plus the aerodrome elevation', () => {
  const scene = sceneFor(ypph, series(metarAt - 3 * HOUR, 8), metarAt, metarAt);
  assert.equal(scene.source, 'METAR');
  const bases = scene.layers.filter((l) => l.source !== 'model').map((l) => Math.round(l.baseFtAmsl));
  assert.deepEqual(bases.slice(0, 2), [3467, 7367]);
});

test('later times use the TAF group in force', () => {
  const t = metarAt + 6 * HOUR;
  assert.equal(reportAt(ypph, t, metarAt).source, 'TAF');
});

test('the nearest profile within 3 h is used before the first sample; none beyond', () => {
  const s = series(metarAt + 2 * HOUR, 4);
  assert.ok(profileAt(s, metarAt));
  assert.equal(profileAt(s, metarAt - 2 * HOUR), null);
  assert.deepEqual(sceneFor(ypph, s, metarAt - 2 * HOUR, metarAt - 2 * HOUR).notes, ['No model profile at this time']);
});

test('native feeds preserve unknown ground without placing AGL reports at sea level', () => {
  const feed: SkyFeed = { lat: ypph.lat, lon: ypph.lon, name: 'YPPH', elevationFt: null, coastKm: null,
    profile: { ...series(metarAt, 2), elevationFt: null }, report: ypph, nowMs: metarAt };
  const unknown = sceneForFeed(feed, metarAt);
  assert.equal(unknown.groundKnown, false);
  assert.equal(unknown.state.elevationFt, 111 * 3.28084, 'inference stops at the lowest measured level');
  assert.equal(unknown.state.surface, null);
  assert.equal(unknown.state.parcel, null);
  assert.ok(unknown.state.layers.every(layer => layer.source === 'model'));
  assert.equal(sceneForFeed({ ...feed, profile: null }, metarAt).state.layers.length, 0);
  const known = sceneForFeed({ ...feed, elevationFt: 67 }, metarAt);
  assert.equal(known.groundKnown, true);
  assert.equal(known.state.source, 'METAR');
  assert.equal(known.state.layers[0].baseFtAmsl, 3467);
});
