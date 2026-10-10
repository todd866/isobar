import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyLayer, coverageFraction, coverageSegments, precipitationBands } from '../tools/clouds/rules.mjs';
import { skies } from '../tools/clouds/fixtures.mjs';

test('the four comparison fixtures retain the requested genera', () => {
  assert.deepEqual(skies.map(s => s.layers.map(l => classifyLayer(l, s.profile).genus)), [
    ['nimbostratus'], ['cumulus', 'cumulus'], ['cumulonimbus'], ['stratus', 'cirrus'],
  ]);
});

test('convective rain does not become a stable deck or an unreported thunderstorm', () => {
  const layer = { baseFt: 3000, topFt: 25000, cover: 'BKN', precipitating: true };
  assert.equal(classifyLayer(layer, { capeJkg: 900 }).genus, 'towering-cumulus');
  assert.equal(classifyLayer({ baseFt: 25000, topFt: 22000, cover: 'SCT' }).genus, 'unknown');
  assert.equal(classifyLayer({ baseFt: 25000, topFt: 25000, cover: 'SCT' }).genus, 'unknown');
  for (const baseFt of [null, undefined, NaN, Infinity, '3000']) assert.deepEqual(precipitationBands({ ...layer, baseFt }, 5000), []);
});

test('coverage fractions and deterministic segments are exact', () => {
  assert.equal(coverageFraction('FEW'), 1.5 / 8);
  assert.equal(coverageFraction('sct'), 3.5 / 8);
  assert.equal(coverageFraction('BKN'), 6 / 8);
  assert.equal(coverageFraction('OVC'), 1);
  assert.equal(coverageFraction(null), null);
  for (const cover of ['FEW', 'SCT', 'BKN', 'OVC']) {
    for (const seed of [4, -2, NaN, 99]) {
      const parts = coverageSegments(cover, seed);
      assert.ok(parts.every(({ start, end }) => start >= 0 && end <= 1 && end > start));
      assert.ok(parts.every((part, i) => i === 0 || part.start >= parts[i - 1].end));
      assert.ok(Math.abs(parts.reduce((n, p) => n + p.end - p.start, 0) - coverageFraction(cover)) < 1e-12);
    }
  }
  assert.equal(coverageSegments('BKN', 2).length, 2);
  assert.ok(coverageSegments('BKN', 2)[0].end - coverageSegments('BKN', 2)[0].start > 0.2);
  assert.notDeepEqual(coverageSegments('SCT', 1), coverageSegments('SCT', 2));
  assert.notDeepEqual(coverageSegments('BKN', 1), coverageSegments('BKN', 2));
  assert.deepEqual(coverageSegments('FEW', 4), coverageSegments('FEW', 4));
});

test('reported genera remain authoritative and unknown stays unknown', () => {
  assert.equal(classifyLayer({ baseFt: 3000, topFt: 4000, cover: 'FEW', reportedType: 'CB' }).genus, 'cumulonimbus');
  assert.equal(classifyLayer({ baseFt: 3000, topFt: 4000, cover: 'FEW' }).genus, 'unknown');
  assert.equal(classifyLayer(null).genus, 'unknown');
});

test('stable rain deck, stable sheet, and instability distinguish genera', () => {
  const stable = { levels: [{ heightFt: 6000, tempC: 2 }, { heightFt: 18000, tempC: -4 }] };
  assert.equal(classifyLayer({ baseFt: 5600, topFt: 18900, cover: 'BKN', precipitating: true }, stable).genus, 'nimbostratus');
  assert.equal(classifyLayer({ baseFt: 5600, topFt: 18900, cover: 'OVC', precipitating: true }).genus, 'nimbostratus');
  assert.equal(classifyLayer({ baseFt: 800, topFt: 1800, cover: 'OVC' }, {
    levels: [{ heightFt: 800, tempC: 12 }, { heightFt: 1800, tempC: 11 }],
  }).genus, 'stratus');
  const unstable = { capeJkg: 900, levels: [{ heightFt: 1000, tempC: 18 }, { heightFt: 5000, tempC: 6 }] };
  assert.equal(classifyLayer({ baseFt: 1000, topFt: 5000, cover: 'SCT' }, unstable).genus, 'cumulus');
  assert.equal(classifyLayer({ baseFt: 1000, topFt: 12000, cover: 'SCT' }, unstable).genus, 'towering-cumulus');
  assert.equal(classifyLayer({ baseFt: 1000, topFt: 5000, cover: 'SCT' }, {
    capeJkg: 900, levels: [{ heightFt: 1000, tempC: 18 }, { heightFt: 5000, tempC: 17 }],
  }).genus, 'unknown');
  assert.equal(classifyLayer({ baseFt: 1000, topFt: 5000, cover: 'SCT' }, { capeJkg: 900 }).genus, 'cumulus');
  assert.equal(classifyLayer({ baseFt: 1000, topFt: 5000, cover: 'FEW', reportedType: 'TCU' }).genus, 'towering-cumulus');
});

test('high thin cloud is cirrus and precipitation follows freezing line', () => {
  assert.equal(classifyLayer({ baseFt: 24000, topFt: 28000, cover: 'SCT' }).genus, 'cirrus');
  assert.equal(classifyLayer({ baseFt: 18000, topFt: 38000, cover: 'SCT' }).genus, 'unknown');
  assert.equal(classifyLayer({ baseFt: 24000, topFt: 38000, cover: 'SCT' }).genus, 'unknown');
  assert.deepEqual(precipitationBands({ baseFt: 5600, topFt: 18900, precipitating: true }, 4000, 500), [
    { baseFt: 500, topFt: 4000, phase: 'rain' },
    { baseFt: 4000, topFt: 5600, phase: 'snow' },
  ]);
  assert.deepEqual(precipitationBands({ baseFt: 5600, topFt: 18900, precipitating: true }, null), [
    { baseFt: 0, topFt: 5600, phase: 'unknown' },
  ]);
  assert.deepEqual(precipitationBands({ baseFt: 5600, topFt: 18900, precipitating: false }, 4000), []);
  assert.deepEqual(precipitationBands({ baseFt: 5600, topFt: null, precipitating: true }, 0), [
    { baseFt: 0, topFt: 5600, phase: 'snow' },
  ]);
  assert.deepEqual(precipitationBands({ baseFt: 5600, topFt: 18900, precipitating: true }, 9000), [
    { baseFt: 0, topFt: 5600, phase: 'rain' },
  ]);
  assert.deepEqual(precipitationBands({ baseFt: 5600, topFt: 18900, precipitating: true }, -1), [
    { baseFt: 0, topFt: 5600, phase: 'snow' },
  ]);
  assert.deepEqual(precipitationBands({ baseFt: 5600, topFt: 5500, precipitating: true }, 0), []);
  assert.deepEqual(precipitationBands({ baseFt: 5600, topFt: 18900, precipitating: true }, 0, NaN), []);
});
