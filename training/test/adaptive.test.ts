/** Adaptive follow-ups: wrong → the same problem in steps → fresh numbers,
 * with the support fading. And the worksheet's live step checks. */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_FOLLOW_UPS,
  SLOW_MS,
  judge,
  nextSupport,
  noteGrade,
  noteMiss,
  retestCard,
  transferCard,
  worksheet,
} from '../src/adaptive.ts';
import { openSession, reduce } from '../src/session.ts';
import { SKILLS, drillCards } from '../src/skills/index.ts';
import { activeStep, markStep, solved } from '../src/worksheet.ts';
import type { Card } from '../src/model.ts';
import type { WorkStep } from '../src/figure.ts';

const bank = drillCards();

function card(id: string): Card {
  const found = bank.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

function fill(steps: WorkStep[]): Record<string, string> {
  return Object.fromEntries(steps.map((step) => [step.id, String(step.value)]));
}

test('a worksheet step is ok inside tolerance, pending while short, bad once full length', () => {
  const step: WorkStep = { id: 'lower', label: 'Read the lower cell', detail: 'FL330 · 70 t', value: 4436, tolerance: 0.5, unit: 'kg/h', decimals: 0 };
  assert.equal(markStep(step, ''), 'empty');
  assert.equal(markStep(step, '44'), 'pending');
  assert.equal(markStep(step, '443'), 'pending');
  assert.equal(markStep(step, '4436'), 'ok');
  assert.equal(markStep(step, '4,436'), 'ok');
  assert.equal(markStep(step, '4437'), 'bad');
  assert.equal(markStep(step, '44', true), 'bad', 'Enter commits a short entry');
  assert.equal(markStep(step, 'x', true), 'bad');
  const fraction: WorkStep = { ...step, id: 'fraction', value: 0.5, tolerance: 0.01, unit: '', decimals: 2 };
  assert.equal(markStep(fraction, '0.5'), 'ok');
  assert.equal(markStep(fraction, '.5'), 'ok');
  assert.equal(markStep(fraction, '0.4'), 'pending');
  assert.equal(markStep(fraction, '0.45'), 'bad');
});

test('the worksheet reports the first step not yet right, and solves on the last', () => {
  const steps = worksheet(card('drill.interpolate.r1'));
  assert.deepEqual(steps.map((step) => step.id), ['lower', 'upper', 'fraction', 'part', 'add']);
  const drafts = fill(steps);
  assert.equal(solved(steps, drafts), true);
  assert.equal(activeStep(steps, drafts), -1);
  assert.equal(activeStep(steps, { ...drafts, fraction: '0.6' }), 2);
  assert.equal(solved(steps, { ...drafts, add: '' }), false);
});

test('every drill worksheet ends on the answer, and its table cells exist', () => {
  for (const item of bank) {
    const spec = item.numeric!;
    const steps = worksheet(item);
    const last = steps.at(-1)!;
    assert.ok(Math.abs(last.value - spec.value) <= Math.max(spec.tolerance, last.tolerance), item.id);
    const table = item.figure?.table;
    if (!table) continue;
    assert.ok(table.used.length > 0, `${item.id} marks no cells`);
    for (const [r, c] of table.used) assert.ok(table.rows[r]?.cells[c] != null, `${item.id} used cell ${r},${c}`);
    for (const span of table.spans ?? []) {
      assert.ok(span.fraction > 0 && span.fraction < 1, item.id);
      assert.ok(Math.abs(span.result - (span.low + span.fraction * (span.high - span.low))) < 1e-9, item.id);
    }
  }
});

test('wrong → the same problem one rung down with the worksheet → new numbers → bare', () => {
  const start = card('drill.interpolate.r2');
  const upper = start.numeric!.diagnoses.find((item) => item.id === 'lower-fl')!;
  const verdict = judge(start, String(upper.value), 5_000);
  assert.equal(verdict.outcome, 'wrong');
  assert.equal(verdict.slip, upper.detail, 'the diagnosed slip is named');
  assert.ok(!verdict.slip.includes(String(Math.round(start.numeric!.value))), 'the slip never gives the answer');

  // 1. Retest: same stem, same numbers, one rung down, every support on.
  const retest = retestCard(start, verdict)!;
  assert.equal(retest.id, `${start.id}~1`);
  assert.equal(retest.stem, start.stem);
  assert.equal(retest.numeric!.value, start.numeric!.value);
  assert.deepEqual(retest.drill, { ...start.drill, rung: 1, support: 2, origin: start.id, stage: 'retest', slip: upper.detail });
  assert.equal(worksheet(retest).length, 5);

  // The session moves straight to it, without revealing the original.
  let session = openSession([start.id, 'next'], 'all', 0);
  session = reduce(session, { type: 'follow', id: retest.id, now: 1 }, start).session;
  assert.deepEqual(session.queue, [start.id, retest.id, 'next']);
  assert.equal(session.index, 1);
  assert.equal(session.phase, 'ask');

  // 2. Solved in steps: a fresh item at the original rung, cells still marked.
  assert.equal(nextSupport(retest, true), 1);
  const transfer = transferCard(retest, 1)!;
  assert.equal(transfer.id, `${start.id}~2`);
  assert.equal(transfer.drill!.stage, 'transfer');
  assert.equal(transfer.drill!.rung, 2, 'back to the original rung');
  assert.equal(transfer.drill!.support, 1);
  assert.equal(transfer.drill!.origin, start.id);
  assert.notEqual(transfer.numeric!.value, start.numeric!.value, 'new numbers');
  assert.notEqual(transfer.stem, start.stem);
  assert.equal(SKILLS.find((skill) => skill.id === transfer.drill!.skill)!.id, 'interpolate');

  // 3. Supports fade: one more bare item, then the loop closes.
  assert.equal(nextSupport(transfer, true), 0);
  const bare = transferCard(transfer, 0)!;
  assert.equal(bare.drill!.support, 0);
  assert.equal(nextSupport(bare, true), null);
  // Giving up anywhere brings the full support back.
  assert.equal(nextSupport(bare, false), 2);
  assert.equal(nextSupport(retest, false), 2);
  // An ordinary card answered right needs nothing more.
  assert.equal(nextSupport(start, true), null);
});

test('the skill state records the miss, the transfers and the closed loop', () => {
  const start = card('drill.interpolate.r1');
  const verdict = judge(start, String(start.numeric!.diagnoses[0]!.value), 1_000);
  let book = noteMiss({}, start, verdict, '2026-10-07T00:00:00Z');
  assert.deepEqual(book.interpolate, { support: 2, retests: 1, transfers: 0, closed: 0, lastSlip: verdict.slip, lastAt: '2026-10-07T00:00:00Z' });
  const retest = retestCard(start, verdict)!;
  book = noteGrade(book, retest, true, '2026-10-07T00:01:00Z');
  assert.equal(book.interpolate!.support, 1);
  const transfer = transferCard(retest, 1)!;
  book = noteGrade(book, transfer, true, '2026-10-07T00:02:00Z');
  assert.equal(book.interpolate!.support, 0);
  assert.equal(book.interpolate!.transfers, 1);
  const bare = transferCard(transfer, 0)!;
  book = noteGrade(book, bare, true, '2026-10-07T00:03:00Z');
  assert.equal(book.interpolate!.closed, 1);
  assert.equal(book.interpolate!.transfers, 2);
});

test('a right but very slow answer is followed up as well', () => {
  const start = card('drill.table-cell.r1');
  const answer = String(start.numeric!.value);
  assert.equal(judge(start, answer, 5_000).outcome, 'correct');
  const slow = judge(start, answer, SLOW_MS[1] + 1_000);
  assert.equal(slow.outcome, 'slow');
  assert.ok(slow.slip.startsWith('Right, but it took 1 min'));
  assert.equal(retestCard(start, slow)!.drill!.stage, 'retest');
});

test('a retest marks the cell the slip read, and the chain is bounded', () => {
  const start = card('drill.table-cell.r1');
  const column = start.numeric!.diagnoses.find((item) => item.id === 'wrong-column')!;
  const retest = retestCard(start, judge(start, String(column.value), 1_000))!;
  const table = retest.figure!.table!;
  assert.ok(table.slip, 'slip cell marked');
  const [r, c] = table.slip;
  assert.equal(table.rows[r]!.cells[c], column.value);
  assert.equal(start.figure!.table!.slip, undefined, 'the original card is untouched');
  let item: Card | null = retest;
  for (let n = 2; n <= MAX_FOLLOW_UPS; n++) item = transferCard(item!, 1);
  assert.ok(item);
  assert.equal(transferCard(item, 1), null);
});

test('every drill completes a checked worksheet and the supported-to-bare follow-up flow', () => {
  for (const start of bank.filter((card) => !['table-cell', 'interpolate'].includes(card.drill!.skill))) {
    const retest = retestCard(start, judge(start, '', 1_000))!;
    const steps = worksheet(retest);
    assert.ok(steps.length >= 2, `${start.id}: single answer fallback`);
    assert.equal(new Set(steps.map((step) => step.id)).size, steps.length, `${start.id}: duplicate step`);
    assert.equal(steps.at(-1)!.value, start.numeric!.value, start.id);
    assert.ok(steps.at(-1)!.tolerance <= start.numeric!.tolerance, `${start.id}: final check disagrees with grade`);
    const drafts = Object.fromEntries(steps.map((step) => [step.id, step.value.toFixed(step.decimals)]));
    assert.equal(solved(steps, drafts), true, `${start.id}: displayed precision rejected`);
    for (const step of steps) {
      assert.equal(markStep(step, ''), 'empty');
      assert.equal(markStep(step, String(step.value + Math.max(1, step.tolerance * 3)), true), 'bad', `${start.id}: ${step.id}`);
    }
    const transfer = transferCard(retest, nextSupport(retest, true)!)!;
    assert.ok(transfer, `${start.id}: no transfer`);
    assert.notEqual(transfer.stem, retest.stem, start.id);
    assert.equal(transfer.drill!.rung, start.drill!.rung);
    assert.equal(transfer.drill!.support, 1);
    assert.ok(worksheet(transfer).length >= 2, start.id);
    const bare = transferCard(transfer, nextSupport(transfer, true)!)!;
    assert.ok(bare, `${start.id}: no bare transfer`);
    assert.equal(bare.drill!.support, 0);
    assert.equal(nextSupport(bare, true), null);
    const missedAgain = retestCard(bare, judge(bare, '', 1_000))!;
    assert.equal(missedAgain.drill!.support, 2);
    assert.deepEqual(worksheet(missedAgain), worksheet(bare));
  }
});
