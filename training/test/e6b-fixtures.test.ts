import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { signed180, solveHeading, solveWind, wrap360 } from '../src/instruments/e6b/wind.ts';

type Fixture = { schema: number; cases: Array<{ kind: string; input: Record<string, number>; expected: Record<string, number | null> }> };
const fixture = JSON.parse(readFileSync(new URL('../../Tests/fixtures/e6b/wind.json', import.meta.url), 'utf8')) as Fixture;
const close = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) <= 1e-9, `${label}: ${actual} != ${expected}`);

test('shared E6-B wind fixtures are generated from and match the TS solver', () => {
  assert.equal(fixture.schema, 1);
  assert.ok(fixture.cases.length >= 20);
  for (const item of fixture.cases) {
    const actual = item.kind === 'heading'
      ? solveHeading(item.input.tc, item.input.tas, item.input.windFrom, item.input.windKt)
      : solveWind(item.input.th, item.input.tc, item.input.tas, item.input.gs);
    for (const key of Object.keys(item.expected)) {
      const expected = item.expected[key];
      if (expected === null) assert.ok(Number.isNaN(actual[key as keyof typeof actual]), `${item.input}: ${key} should be NaN`);
      else close(actual[key as keyof typeof actual] as number, expected, `${key}`);
    }
  }
});

test('wind angle helpers preserve documented bounds and reject nonfinite input', () => {
  assert.equal(wrap360(0), 0);
  assert.equal(wrap360(360), 0);
  assert.equal(wrap360(-1), 359);
  assert.equal(wrap360(721), 1);
  assert.equal(signed180(180), 180);
  assert.equal(signed180(-180), 180);
  assert.equal(signed180(181), -179);
  assert.equal(signed180(-181), 179);
  assert.ok(Number.isNaN(wrap360(Number.NaN)));
  assert.ok(Number.isNaN(signed180(Number.POSITIVE_INFINITY)));
  assert.ok(Number.isNaN(solveHeading(Number.NaN, 100, 0, 10).gs));
  assert.ok(Number.isNaN(solveWind(0, 0, Number.POSITIVE_INFINITY, 100).kt));
});
