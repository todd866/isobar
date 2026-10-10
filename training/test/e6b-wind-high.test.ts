import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HIGH_SPEED_SLIDE,
  SLIDE,
  U,
  computeHeading,
  readDot,
  solveHeading,
  windDot,
} from '../src/instruments/e6b/wind.ts';
import { renderWind, renderWindSlides } from '../src/instruments/e6b/windrender.ts';

const near = (actual: number, expected: number, tolerance: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);

test('high-speed accessory keeps the ASA-documented 10-knot reading convention', () => {
  assert.equal(HIGH_SPEED_SLIDE.id, 'high');
  assert.equal(HIGH_SPEED_SLIDE.arcStepKt, 10);
  assert.equal(HIGH_SPEED_SLIDE.driftStepDeg, 1);
  // The local ASA manual names the accessory and 1/10-kt marks, but does not
  // publish its end marks. Keep the provisional range explicit and testable.
  assert.deepEqual(
    { min: HIGH_SPEED_SLIDE.minKt, max: HIGH_SPEED_SLIDE.maxKt },
    { min: 100, max: 1000 },
  );
  assert.equal(SLIDE.minKt, 30);
  assert.equal(SLIDE.maxKt, 260);
});

test('B727-speed wind triangle reads through the high-speed slide', () => {
  const exact = solveHeading(270, 450, 210, 80);
  const set = computeHeading(270, 450, 210, 80, HIGH_SPEED_SLIDE);
  near(set.gs, exact.gs, 1e-9, 'ground speed');
  near(set.wca, exact.wca, 1e-9, 'wind correction angle');
  const reading = readDot(set.state, HIGH_SPEED_SLIDE)!;
  near(reading.tas, 450, 1e-9, 'TAS arc');
  assert.ok(set.gs >= HIGH_SPEED_SLIDE.minKt && set.gs <= HIGH_SPEED_SLIDE.maxKt);
  assert.ok(set.state.dot);
  // The measured low-speed scale remains 17 units/kt; the high insert uses its
  // explicitly documented normalized schematic scale.
  near(Math.hypot(...windDot(210, 80)), 80 * U, 1e-9, 'low wind dot scale');
  near(Math.hypot(...windDot(210, 100, HIGH_SPEED_SLIDE)), 340, 1e-9, 'high wind dot scale');
  assert.equal(set.state.slide, 'high');
});

test('high and standard renderers expose separate printed slide surfaces', () => {
  const low = renderWind('wind-low', SLIDE).slide;
  const high = renderWind('wind-high', HIGH_SPEED_SLIDE).slide;
  assert.match(low, /STANDARD: each printed arc = 2 knots/);
  assert.match(high, /HIGH SPEED: each printed arc = 10 knots/);
  assert.match(high, />500</);
  assert.match(high, /class="slide-card"/, 'slide surface retains a CSS-addressable card');
  assert.ok(!/NaN|Infinity|undefined/.test(high));
  const both = renderWindSlides('wind');
  assert.notEqual(both.low.slide, both.high.slide);
});
