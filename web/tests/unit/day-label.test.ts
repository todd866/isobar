import { expect, it } from 'vitest';
import { dayRainLabel } from '../../src/lib/day-label';

it('rounds day rain to one decimal without visible units', () => {
  expect([3.77, 0.456666666666, 0.1, 12.34].map(dayRainLabel)).toEqual(['3.8', '0.5', '0.1', '12.3']);
});

it('suppresses dry amounts before rounding and preserves missing rain', () => {
  expect([0, 0.010000000001, 0.0999].map(dayRainLabel)).toEqual(['', '', '']);
  expect([null, undefined, NaN, Infinity, -1].map(dayRainLabel)).toEqual([null, null, null, null, null]);
});
