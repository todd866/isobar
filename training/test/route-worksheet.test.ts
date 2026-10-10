import assert from 'node:assert/strict';
import test from 'node:test';
import { judge, retestCard, worksheet } from '../src/adaptive.ts';
import { SKILLS, drillCards } from '../src/skills/index.ts';
import { TABLES, airDistance, etpDistanceNm, namAt, reference } from '../src/skills/lib.ts';
import { activeStep, markStep, solved } from '../src/worksheet.ts';
import type { Card } from '../src/model.ts';

const routeIds = new Set(['etp', 'pnr', 'integrated-range']);

function cards(): Card[] {
  return drillCards().filter((item) => routeIds.has(item.drill?.skill ?? ''));
}

test('route drills expose natural checked worksheets at every rung and seed', () => {
  for (const skill of SKILLS.filter((item) => routeIds.has(item.id))) {
    for (const seed of [1, 7, 23, 91]) {
      for (const rung of [1, 2, 3, 4] as const) {
        const drill = skill.generate(seed, rung);
        assert.ok(drill.steps && drill.steps.length >= 2, `${skill.id} r${rung} has no intermediate work`);
        const steps = drill.steps!;
        const last = steps.at(-1)!;
        assert.ok(Math.abs(last.value - drill.answer) <= Math.max(last.tolerance, drill.tolerance), `${skill.id} r${rung} answer`);
        const drafts = Object.fromEntries(steps.map((step) => [step.id, String(step.value)]));
        assert.equal(solved(steps, drafts), true, `${skill.id} r${rung} does not solve`);
        assert.equal(activeStep(steps, { ...drafts, [steps[0]!.id]: String(steps[0]!.value + Math.max(steps[0]!.tolerance * 4, 1)) }), 0);
        assert.equal(markStep(steps[0]!, String(steps[0]!.value)), 'ok');
      }
    }
  }
});

test('route worksheet accepts rounded entries and rejects a wrong intermediate', () => {
  for (const card of cards()) {
    const steps = worksheet(card);
    const rounded = Object.fromEntries(steps.map((item) => [item.id, item.value.toFixed(item.decimals)]));
    assert.equal(solved(steps, rounded), true, card.id);
    const first = steps[0]!;
    const wrong = { ...rounded, [first.id]: String(first.value + Math.max(first.tolerance * 5, 1)) };
    assert.equal(markStep(first, wrong[first.id]!, true), 'bad', `${card.id} wrong intermediate`);
    assert.equal(activeStep(steps, wrong), 0);
  }
});

test('a route miss creates the same supported worksheet and keeps every sub-step', () => {
  for (const card of cards()) {
    const miss = judge(card, '', 1_000);
    const retest = retestCard(card, miss);
    assert.ok(retest, card.id);
    assert.deepEqual(worksheet(retest!), worksheet(card), card.id);
    assert.equal(retest!.numeric!.value, card.numeric!.value, card.id);
    assert.equal(retest!.drill!.stage, 'retest', card.id);
  }
});

test('route answers and intermediate arithmetic are independently recomputed', () => {
  for (const skill of SKILLS.filter((item) => routeIds.has(item.id))) {
    for (const seed of [3, 44, 812]) {
      for (const rung of [1, 2, 3, 4] as const) {
        const drill = skill.generate(seed, rung);
        const values = new Map((drill.steps ?? []).map((item) => [item.id, item.value]));
        const g = drill.given;
        if (skill.id === 'etp') {
          const gsOn = g.gsOnKt ?? g.gsOn1;
          const gsBack = g.gsBackKt ?? g.gsBack1;
          if (g.distNm && gsOn && gsBack) assert.ok(Math.abs(drill.answer - etpDistanceNm(g.distNm, gsOn, gsBack)) < 1e-9);
        } else if (skill.id === 'pnr') {
          if (g.sgrOut && g.sgrBack) assert.ok(Math.abs(drill.answer - g.fuelKg! / (g.sgrOut + g.sgrBack)) < 1e-9);
          if (g.flowOut && g.gsOn && g.flowBack && g.gsBack) {
            const out = g.flowOut / g.gsOn;
            const back = g.flowBack / g.gsBack;
            assert.ok(Math.abs(values.get('sgr-out')! - out) < 1e-9);
            assert.ok(Math.abs(values.get('sgr-back')! - back) < 1e-9);
          }
        } else if (skill.id === 'integrated-range') {
          if (g.startKg && g.endKg && g.fl !== 335) assert.ok(Math.abs(drill.answer - airDistance(g.fl, g.startKg, g.endKg)) < 1e-9);
          if (g.startKg && g.endKg && g.fl === 335) {
            const start = reference(330, g.startKg) + 0.25 * (reference(350, g.startKg) - reference(330, g.startKg));
            const end = reference(330, g.endKg) + 0.25 * (reference(350, g.endKg) - reference(330, g.endKg));
            assert.ok(Math.abs(drill.answer - (start - end)) < 1e-9);
          }
          if (g.startKg && g.airNm && g.fl !== 335) {
            const startR = reference(g.fl, g.startKg);
            const targetR = startR - g.airNm;
            assert.ok(Math.abs(values.get('target-r')! - targetR) < 1e-9);
          }
        }
      }
    }
  }
});

test('every route worksheet step follows the preceding arithmetic', () => {
  for (const skill of SKILLS.filter((item) => routeIds.has(item.id))) {
    for (const seed of [5, 37, 911, 2048]) {
      for (const rung of [1, 2, 3, 4] as const) {
        const drill = skill.generate(seed, rung);
        const v = new Map((drill.steps ?? []).map((item) => [item.id, item.value]));
        const g = drill.given;
        const near = (id: string, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(v.get(id)! - expected) <= tolerance, `${skill.id} r${rung} ${id}`);
        if (skill.id === 'etp') {
          const on = g.gsOnKt ?? (g.tasOn! + g.tail!);
          const back = g.gsBackKt ?? (g.tasBack ?? g.tasOn!) - g.tail!;
          if (g.distNm) {
            near('sum-gs', on + back);
            near('numerator', g.distNm * back, 1e-6);
          } else if (g.d1) {
            const on2 = g.d2! / g.gsOn2!;
            const back1 = g.d1 / g.gsBack1!;
            near('on-zone-2', on2, 1e-8);
            near('back-zone-1', back1, 1e-8);
            if (v.has('on-total')) {
              near('on-total', g.d1 / g.gsOn1! + on2, 1e-8);
              near('zone-distance', (g.d1 / g.gsOn1! + on2) * g.gsOn1! * g.gsBack1! / (g.gsOn1! + g.gsBack1!), 1e-8);
            } else {
              const gap = on2 - back1;
              near('time-gap', gap, 1e-8);
              near('zone-distance', gap * g.gsOn2! * g.gsBack2! / (g.gsOn2! + g.gsBack2!), 1e-8);
            }
          }
        } else if (skill.id === 'pnr') {
          if (g.sgrOut && g.sgrBack) {
            near('sum-sgr', g.sgrOut + g.sgrBack, 1e-8);
          } else if (g.flowOut) {
            const out = g.flowOut / g.gsOn!;
            const back = g.flowBack! / g.gsBack!;
            near('sgr-out', out, 1e-8);
            near('sgr-back', back, 1e-8);
            near('sum-sgr', out + back, 1e-8);
          } else {
            near('zone1-rate', g.sgrOut1! + g.sgrBack1!, 1e-8);
            near('zone1-fuel', (g.sgrOut1! + g.sgrBack1!) * g.d1!, 1e-8);
            near('remaining', g.fuelKg! - (g.sgrOut1! + g.sgrBack1!) * g.d1!, 1e-8);
            near('zone2-rate', g.sgrOut2! + g.sgrBack2!, 1e-8);
            near('zone2-distance', (g.fuelKg! - (g.sgrOut1! + g.sgrBack1!) * g.d1!) / (g.sgrOut2! + g.sgrBack2!), 1e-8);
          }
        } else if (rung === 1) {
          near('start-r', reference(g.fl!, g.startKg!), 1e-8);
          near('end-r', reference(g.fl!, g.endKg!), 1e-8);
        } else if (rung === 2) {
          const startR = reference(g.fl!, g.startKg!);
          const targetR = startR - g.airNm!;
          near('start-r', startR, 1e-8);
          near('target-r', targetR, 1e-8);
          const targetNam = namAt(g.fl!, 50000) - targetR;
          const weights = TABLES.cruise.integratedRange.weightsKg;
          const i = weights.findIndex((weight, index) => index < weights.length - 1 && targetNam <= namAt(g.fl!, weight) && targetNam >= namAt(g.fl!, weights[index + 1]!));
          const low = weights[i]!;
          const high = weights[i + 1]!;
          const fraction = (targetNam - namAt(g.fl!, low)) / (namAt(g.fl!, high) - namAt(g.fl!, low));
          near('end-low-r', reference(g.fl!, low), 1e-8);
          near('end-high-r', reference(g.fl!, high), 1e-8);
          near('end-fraction', fraction, 1e-6);
          near('end-weight', low + fraction * (high - low), 1e-6);
        } else if (rung === 3) {
          const start = reference(330, g.startKg!) + 0.25 * (reference(350, g.startKg!) - reference(330, g.startKg!));
          const end = reference(330, g.endKg!) + 0.25 * (reference(350, g.endKg!) - reference(330, g.endKg!));
          near('quarter', 0.25, 1e-8);
          near('start-r', start, 1e-8);
          near('end-r', end, 1e-8);
        } else if (rung === 4) {
          const endR = reference(g.fl!, g.endKg!);
          const targetR = endR + g.airNm!;
          near('end-r', endR, 1e-8);
          near('start-r', targetR, 1e-8);
        }
        const rounded = Object.fromEntries((drill.steps ?? []).map((item) => [item.id, item.value.toFixed(item.decimals)]));
        for (const item of drill.steps ?? []) assert.equal(markStep(item, rounded[item.id]!), 'ok', `${skill.id} r${rung} rounded ${item.id}`);
      }
    }
  }
});
