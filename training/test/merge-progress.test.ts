import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyRecord, recordAttempt } from '../src/instruments/e6b/skills.ts';
import { applyGrade, emptyProgress, type ProgressFile } from '../src/progress.ts';

test('progress round-trip keeps E6-B and adaptive skill state through grading', () => {
  const e6b = recordAttempt(emptyRecord(), 'tas', {
    correct: true,
    helped: false,
    ms: 12_000,
    at: '2026-10-07T00:00:00.000Z',
  });
  const source: ProgressFile = {
    ...emptyProgress(),
    e6b,
    skills: {
      groundspeed: {
        support: 2,
        retests: 1,
        transfers: 0,
        closed: 0,
        lastSlip: 'wind component',
        lastAt: '2026-10-07T00:00:00.000Z',
      },
    },
  };

  const parsed = JSON.parse(JSON.stringify(source)) as ProgressFile;
  assert.deepEqual(parsed.e6b, source.e6b);
  assert.deepEqual(parsed.skills, source.skills);

  const graded = applyGrade(parsed, 'review-card', {
    quality: 4,
    at: '2026-10-07T00:01:00.000Z',
    responseTimeMs: 1_000,
    complexity: 2,
    day: '2026-10-07',
  });
  assert.deepEqual(graded.e6b, source.e6b);
  assert.deepEqual(graded.skills, source.skills);
  assert.equal(graded.cards['review-card']?.correctCount, 1);
});
