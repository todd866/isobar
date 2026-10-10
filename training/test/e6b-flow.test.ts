import assert from 'node:assert/strict';
import test from 'node:test';
import { FLOW_ORDER, afterProblem, autoStep, crossCheck, estimateAsk, flowProblem, helpLevel, methodLine, moveLine, num, questionLine, whyLine } from '../src/instruments/e6b/flow.ts';

const lastNumber = (line: string): number => {
  const all = [...line.replace(/(\d),(\d{3})/g, '$1$2').matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  return all[all.length - 1];
};

test('every flow problem has a one-line method from its own numbers that lands near the answer', () => {
  for (let i = 0; i < FLOW_ORDER.length; i++) {
    const p = flowProblem(i);
    const m = methodLine(p);
    assert.ok(m.length > 10 && m.length <= 110, `${p.id}: ${m}`);
    assert.doesNotMatch(m, /undefined|NaN/, p.id);
    // It uses the problem's own numbers.
    const own = Object.values(p.vals).map((v) => num(v));
    assert.ok(own.some((v) => m.includes(v)), `${p.id}: ${m} uses none of ${own.join(', ')}`);
    // A rule of thumb, not the exact answer, but close to it.
    const got = lastNumber(m);
    assert.ok(Math.abs(got - p.estimateValue) <= Math.max(1, Math.abs(p.estimateValue) * 0.12), `${p.id}: ${m} → ${got} vs ${p.estimateValue}`);
    assert.match(questionLine(p), /→/, p.id);
    assert.match(estimateAsk(p), /^Estimate the .+ in your head, in /, p.id);
  }
});

test('every move on the instrument has a what line and a why line, one line each', () => {
  for (let i = 0; i < FLOW_ORDER.length; i++) {
    const p = flowProblem(i);
    p.procedure.forEach((step, k) => {
      const kind = step.physical.kind;
      if (kind === 'estimate' || kind === 'read' || autoStep(step)) return;
      const move = moveLine(p, step), why = whyLine(p, step, k);
      assert.ok(move.length > 8 && move.length <= 70, `${p.id}#${k}: ${move}`);
      assert.ok(why.length > 8 && why.length <= 100, `${p.id}#${k}: ${why}`);
      assert.doesNotMatch(move + why, /undefined|NaN|\s{2}/, `${p.id}#${k}`);
    });
  }
  const t = flowProblem(0);
  assert.equal(moveLine(t, t.procedure[3]), 'Turn the disc: ▲ (60) under 120 on the outer scale');
  assert.equal(whyLine(t, t.procedure[3], 3), '▲ is 60 min: 120 over 60 sets 120 NM per hour on every pair');
  const w = flowProblem(2);
  const plate = w.procedure.findIndex((s) => s.physical.kind === 'plate');
  assert.equal(whyLine(w, w.procedure[plate], plate), 'Set the wind direction under TRUE INDEX: the dot you mark is where the wind comes from');
  const dot = w.procedure.findIndex((s) => s.physical.kind === 'dot');
  assert.equal(moveLine(w, w.procedure[dot]), 'Pencil a dot 15 kt straight up from the grommet');
  assert.equal(whyLine(w, w.procedure[dot], dot), "The dot is the wind's push: direction from TRUE INDEX, length 15 kt");
});

test('the check line sets the instrument against the estimate', () => {
  const t = flowProblem(0);
  assert.equal(crossCheck(t, 30, 30), 'E6-B 30 min · your estimate 30 ✓');
  assert.equal(crossCheck(t, 30, 45), 'E6-B 30 min · your estimate 45 ≈');
  assert.equal(crossCheck(t, 30, 3), 'E6-B 30 min · your estimate 3 ✗ check the decimal');
});

test('help fades after clean solves and comes back after a miss', () => {
  let h = undefined as ReturnType<typeof afterProblem> | undefined;
  assert.equal(helpLevel(h), 0);
  h = afterProblem(h, true); assert.equal(helpLevel(h), 0);
  h = afterProblem(h, true); assert.equal(helpLevel(h), 1, 'two clean: why lines fold away');
  h = afterProblem(h, true); h = afterProblem(h, true); assert.equal(helpLevel(h), 2, 'four clean: glow only on request');
  h = afterProblem(h, false); assert.equal(helpLevel(h), 0, 'a miss brings the help back');
  h = afterProblem(h, true); assert.equal(helpLevel(h), 0);
});
