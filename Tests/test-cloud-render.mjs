import assert from 'node:assert/strict';
import test from 'node:test';
import { sceneGeometry, yForFt } from '../tools/clouds/render.mjs';
import { coverageFraction } from '../tools/clouds/rules.mjs';
import { skies } from '../tools/clouds/fixtures.mjs';

test('every style shares one geometry, exact coverage, known bases and tops', () => {
  for (const scene of skies) for (const item of sceneGeometry(scene)) {
    assert.equal(item.kind, 'cloud');
    assert.ok(Math.abs(item.segments.reduce((sum, s) => sum + s.end - s.start, 0) - coverageFraction(item.layer.cover)) < 1e-12);
    assert.ok(yForFt(item.layer.topFt, 236) < yForFt(item.layer.baseFt, 236));
    assert.equal(item.anvil, item.genus === 'cumulonimbus');
    for (const shaft of item.precipitation) assert.ok(shaft.topFt <= item.layer.baseFt);
  }
});

test('missing and invalid altitude or coverage cannot make a cloud or shaft', () => {
  const layer = { baseFt: 3000, topFt: 10000, reportedType: 'CB', cover: 'BKN', precipitating: true };
  const scene = changes => ({ layers: [{ ...layer, ...changes }], profile: null, freezingFt: null });
  for (const baseFt of [null, undefined, NaN, Infinity, '3000', -100]) assert.deepEqual(sceneGeometry(scene({ baseFt })), []);
  for (const topFt of [NaN, Infinity, '10000', 1000, 3000]) assert.deepEqual(sceneGeometry(scene({ topFt })), []);
  for (const cover of [null, undefined, 'XXX']) assert.deepEqual(sceneGeometry(scene({ cover })), []);
  const high = scene({ baseFt: 25000, topFt: 28000, reportedType: null, cover: null });
  assert.deepEqual(sceneGeometry(high), []); // known genus is not known coverage
  for (const ft of [null, undefined, NaN, Infinity, '3000']) assert.equal(yForFt(ft, 236), null);
  assert.equal(yForFt(0, 236), 214);
});

test('a known reported base survives missing tops without an invented volume', () => {
  const layer = { baseFt: 3000, topFt: null, cover: 'BKN', reportedType: 'CB', precipitating: true };
  const [item] = sceneGeometry({ layers: [layer], profile: null, freezingFt: null });
  assert.equal(item.kind, 'reported-base'); assert.equal(item.anvil, false);
  assert.equal(item.layer.topFt, null); assert.equal(item.layer.baseFt, 3000);
  assert.deepEqual(item.precipitation, [{ baseFt: 0, topFt: 3000, phase: 'unknown' }]);
  const [tcu] = sceneGeometry({ layers: [{ ...layer, topFt: 18000, reportedType: 'TCU' }], profile: null, freezingFt: 7000 });
  assert.equal(tcu.anvil, false);
});
