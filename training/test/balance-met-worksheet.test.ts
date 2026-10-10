import assert from 'node:assert/strict';
import test from 'node:test';
import { judge, retestCard, worksheet } from '../src/adaptive.ts';
import { TABLES, RSWT_LEVELS } from '../src/b727/engine.ts';
import { cgShift } from '../src/skills/moment.ts';
import { metLevel } from '../src/skills/met-level.ts';
import { activeStep, markStep, solved } from '../src/worksheet.ts';
import type { Drill } from '../src/skills/types.ts';
import type { Card } from '../src/model.ts';
import { drillCards } from '../src/skills/index.ts';

function drafts(drill: Drill): Record<string, string> {
  return Object.fromEntries((drill.steps ?? []).map((item) => [item.id, String(item.value)]));
}

function roundedDrafts(drill: Drill): Record<string, string> {
  return Object.fromEntries((drill.steps ?? []).map((item) => [item.id, item.value.toFixed(item.decimals)]));
}

function expectedCg(drill: Drill): Record<string, number> {
  const g = drill.given;
  const b = TABLES.balance;
  if (drill.rung === 1) {
    const offset = g.armM! - b.indexUnit.referenceArmM;
    const moment = g.weightKg! * offset;
    return { 'offset-arm': offset, 'offset-moment': moment, answer: moment / b.indexUnit.divisor };
  }
  const baseArm = drill.rung === 4
    ? b.indexUnit.referenceArmM + ((g.basicIndex! - b.indexUnit.offset) * b.indexUnit.divisor) / g.basicKg!
    : b.mac.lemacM + (g.mac! / 100) * b.mac.macM;
  const rows = drill.rung === 2
    ? [{ weight: g.weightKg!, arm: baseArm }, { weight: g.addKg!, arm: b.compartments[String(g.compartment!) as '1']!.armM }]
    : drill.rung === 3
      ? [{ weight: g.weightKg!, arm: baseArm }, { weight: -g.moveKg!, arm: g.fromArm! }, { weight: g.moveKg!, arm: g.toArm! }]
      : [{ weight: g.basicKg!, arm: baseArm }, { weight: g.people!, arm: g.peopleArm! }, { weight: g.freightKg!, arm: g.freightArm! }];
  const moments = rows.map((row) => row.weight * row.arm);
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  const totalMoment = moments.reduce((sum, value) => sum + value, 0);
  const meanArm = totalMoment / totalWeight;
  const answer = ((meanArm - b.mac.lemacM) / b.mac.macM) * 100;
  const result: Record<string, number> = { [drill.rung === 4 ? 'basic-arm' : 'base-arm']: baseArm, 'total-weight': totalWeight, 'total-moment': totalMoment, 'mean-arm': meanArm, answer };
  rows.forEach((row, i) => { result[`moment-${i}`] = moments[i]!; });
  if (drill.rung === 4) result['people-weight'] = g.people!;
  return result;
}

function nearestLevel(level: number): number {
  if (level <= RSWT_LEVELS[0]!) return RSWT_LEVELS[0]!;
  return RSWT_LEVELS.reduce((best, current) => Math.abs(current - level) <= Math.abs(best - level) ? current : best, RSWT_LEVELS[0]!);
}

function roundedWind(dir: number, kt: number): { dir: number; kt: number } {
  let next = Math.round(dir / 10) * 10;
  next %= 360;
  if (next === 0) next = 360;
  return { dir: next, kt: Math.round(kt / 5) * 5 };
}

function expectedMet(drill: Drill): Record<string, number> {
  const fl = drill.given.cruiseFl!;
  const fraction = drill.rung === 1 || drill.rung === 3 ? (2 / 3) * fl : fl / 2;
  const level = nearestLevel(fraction);
  const expected: Record<string, number> = { fraction, level };
  if (drill.rung < 3) return expected;
  const rawDir = drill.given[`d${level}`]!;
  const rawSpeed = drill.given[`k${level}`]!;
  const wind = roundedWind(rawDir, rawSpeed);
  const angle = ((wind.dir - drill.given.trackDeg!) % 360 + 360) % 360;
  const cosine = Math.cos((angle * Math.PI) / 180);
  return { ...expected, 'raw-direction': rawDir, direction: wind.dir, 'raw-speed': rawSpeed, speed: wind.kt, angle, cos: cosine, answer: -wind.kt * cosine };
}

function assertSteps(drill: Drill, expected: Record<string, number>): void {
  const steps = drill.steps!;
  assert.deepEqual(new Set(steps.map((item) => item.id)), new Set(Object.keys(expected).filter((key) => key !== 'answer' || steps.some((item) => item.id === 'answer'))), `${drill.skill} r${drill.rung} step map`);
  for (const item of steps) {
    const value = expected[item.id];
    assert.notEqual(value, undefined, `${drill.skill} r${drill.rung} missing expectation ${item.id}`);
    assert.ok(Math.abs(item.value - value!) <= item.tolerance + 1e-8, `${drill.skill} r${drill.rung} ${item.id}`);
  }
  assert.equal(solved(steps, roundedDrafts(drill)), true, `${drill.skill} r${drill.rung} rounded entries`);
}

test('CG worksheets expose absolute moment arithmetic and hide computed table cells', () => {
  assert.equal(TABLES.balance.indexUnit.referenceArmM, 21.89875);
  for (const seed of [1, 7, 23, 91]) {
    for (const rung of [1, 2, 3, 4] as const) {
      const drill = cgShift.generate(seed, rung);
      // The tightly checked arm conversion must be possible from displayed inputs.
      const source = rung === 1 ? drill.given.armM! : rung === 4 ? drill.given.basicIndex! : drill.given.mac!;
      assert.equal(Number(source.toFixed(rung === 1 || rung === 4 ? 1 : 0)), source);
      assert.ok(drill.steps && drill.steps.length >= 3, `CG r${rung} steps`);
      assert.equal(Math.abs(drill.steps!.at(-1)!.value - drill.answer) <= drill.tolerance, true, `CG r${rung} answer`);
      const table = drill.figure.table!;
      assert.deepEqual(table.columns, rung === 1 ? ['kg', 'Offset m', 'Offset kg·m'] : ['kg', 'm', 'kg·m']);
      assert.equal(table.rows.at(-1)!.label, 'Total');
      assert.ok(table.computed && table.computed.length >= table.rows.length - 1);
      for (const row of table.rows.slice(0, -1)) {
        assert.ok(Math.abs((row.cells[0]! * row.cells[1]!) - row.cells[2]!) < 0.01, `CG r${rung} item moment`);
      }
      const total = table.rows.at(-1)!;
      const itemWeight = table.rows.slice(0, -1).reduce((sum, row) => sum + row.cells[0]!, 0);
      const itemMoment = table.rows.slice(0, -1).reduce((sum, row) => sum + row.cells[2]!, 0);
      assert.ok(Math.abs(total.cells[0]! - itemWeight) < 0.01, `CG r${rung} weight sum`);
      assert.ok(Math.abs(total.cells[2]! - itemMoment) < 0.01, `CG r${rung} moment sum`);
      assert.equal(solved(drill.steps!, drafts(drill)), true);
      assertSteps(drill, expectedCg(drill));
      const first = drill.steps![0]!;
      assert.equal(markStep(first, String(first.value + Math.max(first.tolerance * 5, 1)), true), 'bad');
      assert.equal(activeStep(drill.steps!, { ...drafts(drill), [first.id]: String(first.value + Math.max(first.tolerance * 5, 1)) }), 0);
    }
  }
});

test('met worksheets select the fraction, forecast level, rounded wind and component', () => {
  for (const seed of [1, 7, 23, 91]) {
    for (const rung of [1, 2, 3, 4] as const) {
      const drill = metLevel.generate(seed, rung);
      const steps = drill.steps!;
      assert.ok(steps.length >= 2, `MET r${rung} steps`);
      assert.equal(solved(steps, drafts(drill)), true);
      assertSteps(drill, expectedMet(drill));
      assert.equal(steps.at(-1)!.value, drill.answer);
      const table = drill.figure.table!;
      assert.deepEqual(table.columns, ['From °T', 'Speed kt']);
      assert.equal(table.group, 'Wind');
      assert.equal(table.rows.length, RSWT_LEVELS.length);
      assert.equal(table.used.length, 2);
      if (rung >= 3) {
        assert.ok(steps.some((step) => step.id === 'direction') && steps.some((step) => step.id === 'speed'));
        const angle = steps.find((step) => step.id === 'angle')!.value;
        const speed = steps.find((step) => step.id === 'speed')!.value;
        assert.ok(Math.abs((-speed * Math.cos((angle * Math.PI) / 180)) - drill.answer) < 0.51, `MET r${rung} component`);
      }
    }
  }
});

test('CG and met misses preserve every worksheet step in the supported retest', () => {
  const bank = drillCards().filter((card) => card.drill?.skill === 'cg-shift' || card.drill?.skill === 'met-level');
  for (const card of bank) {
    const retest = retestCard(card, judge(card, '', 1_000));
    assert.ok(retest, card.id);
    assert.deepEqual(worksheet(retest!), worksheet(card), card.id);
    assert.equal(retest!.numeric!.value, card.numeric!.value, card.id);
  }
});
