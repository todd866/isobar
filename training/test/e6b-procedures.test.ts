import assert from 'node:assert/strict';
import test from 'node:test';
import { E6B_PROCEDURES, PROCEDURES_BY_OPERATION, applyProcedureAction, executeProcedure, initialProcedurePose, validateProcedureStep, exercisesFor, type ProcedureExercise } from '../src/instruments/e6b/procedures.ts';

const byLevel = (items: ProcedureExercise[]) => items.map((item) => item.level);

test('curriculum has three distinct, ordered exercises for every operation', () => {
  assert.equal(PROCEDURES_BY_OPERATION.size, 17);
  assert.equal(E6B_PROCEDURES.length, 51);
  for (const [operation, items] of PROCEDURES_BY_OPERATION) {
    assert.equal(items.length, 3, operation);
    assert.deepEqual(byLevel(items), ['easy', 'intermediate', 'exam']);
    assert.equal(new Set(items.map((item) => item.id)).size, 3, operation);
    assert.ok(items.every((item) => item.scenario.length > 20 && item.estimate.length > 0), operation);
  }
});

test('every procedure executes physical actions and reads the resulting pose', () => {
  for (const item of E6B_PROCEDURES) {
    const result = executeProcedure(item);
    assert.equal(result.ok, true, `${item.id}: ${result.reason ?? 'failed'}`);
    assert.equal(result.readings.length, item.procedure.filter((step) => step.physical.kind === 'read').length, item.id);
    assert.ok(result.readings.every(Number.isFinite), item.id);
    assert.ok(item.procedure.every((step) => step.action.length > 10 && step.success.length > 10 && step.wrongMove.length > 10 && step.correction.length > 10), item.id);
  }
});

test('a physically wrong disc, cursor, or wind dot fails the recorded step goal', () => {
  for (const item of E6B_PROCEDURES) {
    const index = item.procedure.findIndex((step) => ['disc', 'cursor', 'dot'].includes(step.physical.kind));
    if (index < 0) continue;
    let pose = initialProcedurePose();
    for (let i = 0; i < index; i++) pose = applyProcedureAction(pose, item.procedure[i].physical);
    const step = item.procedure[index];
    const wrong = step.physical.kind === 'disc' ? { kind: 'disc' as const, theta: step.physical.theta + 17 } : step.physical.kind === 'cursor' ? { kind: 'cursor' as const, angle: step.physical.angle + 17 } : { kind: 'dot' as const, dot: [999, 999] as [number, number] };
    const wrongPose = applyProcedureAction(pose, wrong);
    assert.equal(validateProcedureStep(item, index, wrongPose), false, item.id);
  }
});

test('bad estimate and bad reading are rejected', () => {
  const item = exercisesFor('time')[0];
  const first = item.procedure.findIndex((step) => step.physical.kind === 'estimate');
  assert.ok(first >= 0);
  assert.equal(validateProcedureStep(item, first, initialProcedurePose(), item.estimateValue * 100), false);
  const readIndex = item.procedure.findIndex((step) => step.physical.kind === 'read');
  let pose = initialProcedurePose();
  for (let i = 0; i < readIndex; i++) pose = applyProcedureAction(pose, item.procedure[i].physical);
  const read = item.procedure[readIndex].result!;
  assert.equal(validateProcedureStep(item, readIndex, pose, read.exact + read.tolerance * 10), false);
});

test('tampering with legacy demo reads cannot change execution', () => {
  for (const original of E6B_PROCEDURES) {
    const item = { ...original, demo: { ...original.demo, results: original.demo.results.map((result) => ({ ...result, read: result.exact + 999999 })) } };
    const result = executeProcedure(item);
    assert.equal(result.ok, true, original.id);
    assert.notEqual(result.readings[0], item.demo.results[0].read, original.id);
  }
});

test('a high-speed answer cannot pass while the low-speed slide is selected',()=>{
  const item=exercisesFor('jet')[2],result=executeProcedure(item),index=item.procedure.length-1;
  assert.equal(validateProcedureStep(item,index,result.pose,result.readings.at(-1)),true);
  assert.equal(validateProcedureStep(item,index,{...result.pose,wind:{...result.pose.wind,slide:'low'}},result.readings.at(-1)),false);
});
