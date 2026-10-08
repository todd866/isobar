import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTeachingState,
  emptyMemory,
  prereqEdges,
  reviewCard,
  targetStrengthFor,
} from '../src/scheduler.ts';

test('quality ladder matches the integer rungs and the midpoint', () => {
  assert.equal(targetStrengthFor(1), 0.3);
  assert.equal(targetStrengthFor(2), 0.5);
  assert.equal(targetStrengthFor(3), 0.8);
  assert.equal(targetStrengthFor(4), 0.9);
  assert.equal(targetStrengthFor(5), 1);
  assert.equal(targetStrengthFor(2.5), 0.65);
});

test('a fast correct answer lengthens stability and sets a due date', () => {
  const next = reviewCard(emptyMemory('2026-10-06T00:00:00.000Z'), {
    quality: 5,
    at: '2026-10-06T00:00:00.000Z',
    responseTimeMs: 1000,
    complexity: 2,
    reviewsOnStudyDay: 1,
  });
  assert.equal(next.stabilityDays, 4.8);
  assert.equal(next.retrievalStrength, 0.9);
  assert.equal(next.totalReviews, 1);
  assert.equal(next.status, 'learning');
  assert.equal(next.consecutiveCorrectFast, 1);
  assert.equal(next.nextDueAt, '2026-10-25T12:00:00.000Z');
});

test('a miss is not due again until the next study day', () => {
  const next = reviewCard(emptyMemory('2026-10-06T12:00:00.000Z'), {
    quality: 1,
    at: '2026-10-06T12:00:00.000Z',
    responseTimeMs: 4000,
    complexity: 2,
    reviewsOnStudyDay: 1,
  });
  assert.ok(Math.abs(next.stabilityDays - 2.4) < 1e-9);
  assert.ok(Math.abs(next.retrievalStrength - 0.27) < 1e-9);
  assert.equal(next.correctCount, 0);
  assert.equal(next.nextDueAt, '2026-10-07T00:00:00.000Z');
});

test('liking a card shortens the interval by 0.7', () => {
  const next = reviewCard(emptyMemory('2026-10-06T00:00:00.000Z'), {
    quality: 5,
    at: '2026-10-06T00:00:00.000Z',
    responseTimeMs: 1000,
    complexity: 2,
    reviewsOnStudyDay: 1,
    liked: true,
  });
  assert.equal(next.nextDueAt, '2026-10-19T15:36:00.000Z');
});

test('teaching state stays naive until there is an exposure', () => {
  assert.equal(classifyTeachingState({ exposureCount: 0, recallOnExamDay: 0.99, confidence: 0.99 }), 'naive');
  assert.equal(classifyTeachingState({ exposureCount: 3, recallOnExamDay: 0.4, confidence: 0.9 }), 'learning');
  assert.equal(classifyTeachingState({ exposureCount: 4, recallOnExamDay: 0.9, confidence: 0.4 }), 'consolidating');
  assert.equal(classifyTeachingState({ exposureCount: 6, recallOnExamDay: 0.9, confidence: 0.8 }), 'mastered');
});

test('prerequisite edges point from the earlier concept', () => {
  const edges = prereqEdges([
    { id: 'met.lapse', prerequisiteIds: [] },
    { id: 'met.stability', prerequisiteIds: ['met.lapse'] },
    { id: 'met.stability', prerequisiteIds: ['missing'] },
  ]);
  assert.deepEqual(edges, [{ source: 'met.lapse', target: 'met.stability', kind: 'prereq', weight: 1 }]);
});
