import assert from 'node:assert/strict';
import test from 'node:test';
import raw from '../../docs/training/concepts.json' with { type: 'json' };
import { concepts, sources } from '../src/catalog.ts';
import { australianConcepts, type SyllabusConcept } from '../src/syllabus.ts';
import { laterCard, library, staticCards } from '../src/deck.ts';
import { selectQueue } from '../src/queue.ts';
import { emptyMemory, reviewCard } from '../src/scheduler.ts';
import { lintCard, validateCard, validateLibrary } from '../src/validate.ts';

test('the served syllabus is the Australian concept graph', () => {
  const served = australianConcepts(raw.concepts as SyllabusConcept[]);
  assert.equal(served.length, 41);
  assert.equal(JSON.stringify(served).includes('FAA'), false);
  assert.equal(JSON.stringify(served).includes('ACS'), false);
  assert.equal(served.some((concept) => concept.id === 'met.gradient-wind'), true);
  assert.equal(sources.some((source) => source.id.startsWith('faa')), false);
  assert.equal(raw.concepts.length, served.length);
});

test('the static deck cites real sections and has no cycles', () => {
  const errors = validateLibrary([...staticCards, laterCard], concepts, sources);
  assert.deepEqual(errors, []);
});

test('every static card meets the question standard', () => {
  for (const card of [...staticCards, laterCard]) assert.deepEqual(lintCard(card), [], card.id);
  assert.ok(staticCards.filter((card) => card.subject === 'met').length >= 40);
  assert.ok(staticCards.filter((card) => card.subject === 'plan').length >= 25);
  for (const card of staticCards) {
    assert.equal(card.options.length, 4, card.id);
    assert.ok(/^[A-Z]/.test(card.stem), card.id);
  }
});

test('the lint rejects fragments, feed talk, unparallel options and unsourced rules', () => {
  const base = staticCards.find((card) => card.id === 'fp.hold.inter')!;
  const broken = (patch: Partial<typeof base>) => lintCard({ ...base, ...patch });
  assert.ok(broken({ stem: 'Lower prevailing visibility, YPPH–YSSY' }).some((error) => /question mark/.test(error)));
  assert.ok(broken({ stem: 'Which group applies at your ETA?' }).some((error) => /8 words/.test(error)));
  assert.ok(broken({ stem: `${base.stem.slice(0, -1)} on this run?` }).some((error) => /banned word “run”/.test(error)));
  assert.ok(broken({ explanation: 'The snapshot shows the product in the 3000 m bucket.' }).some((error) => /banned word/.test(error)));
  assert.ok(broken({ explanation: 'Thirty minutes of holding covers an INTER.' }).some((error) => /names no Australian source/.test(error)));
  assert.ok(broken({ options: [{ id: '1', text: 'Yes' }, { id: '2', text: 'No' }, { id: '3', text: 'An alternate, or fuel to hold until 30 min after the deterioration ends, whichever the operator prefers' }] })
    .some((error) => /not parallel/.test(error)));
  assert.ok(broken({ options: [{ id: '1', text: 'Thirty minutes' }, { id: '2', text: 'Sixty minutes' }, { id: '3', text: 'All of the above' }] })
    .some((error) => /all\/none of the above/.test(error)));
  assert.ok(broken({ options: [{ id: '1', text: 'Thirty minutes' }, { id: '2', text: 'thirty minutes' }, { id: '3', text: 'Sixty minutes' }] })
    .some((error) => /repeat/.test(error)));
  assert.ok(broken({ options: [{ id: '1', text: 'Thirty minutes.' }, { id: '2', text: 'Sixty minutes' }, { id: '3', text: 'Ninety minutes' }] })
    .some((error) => /punctuation/.test(error)));
  assert.ok(broken({ options: [{ id: '1', text: 'Thirty minutes' }, { id: '2', text: 'Sixty minutes' }] }).some((error) => /3–4 options/.test(error)));
  const live = { ...base, subject: 'live' as const, figure: { title: 'TAF', lines: ['TAF YSSY 062012Z 0621/0800 18026KT 9999'], highlight: ['INTER 0707/0721'] } };
  assert.ok(lintCard(live).some((error) => /figure does not contain/.test(error)));
  assert.ok(lintCard({ ...base, subject: 'live' as const }).some((error) => /no figure/.test(error)));
});

test('a second correct answer is rejected', () => {
  const card = {
    ...staticCards[0],
    id: 'bad',
    options: [
      { id: '1', text: 'One' },
      { id: '1', text: 'One' },
    ],
  };
  assert.ok(validateCard(card, concepts, sources).length > 0);
});

test('a dependent concept stays out of the queue until its prerequisite is answered', () => {
  const now = '2026-10-06T00:00:00.000Z';
  const blocked = selectQueue({
    cards: staticCards,
    concepts,
    memories: {},
    now,
    filter: 'met',
  });
  assert.ok(blocked.includes('met.lapse.dalr'));
  assert.equal(blocked.includes('met.stab.abs'), false);
  const memory = reviewCard(emptyMemory(now), {
    quality: 4,
    at: now,
    responseTimeMs: 2000,
    complexity: 2,
    reviewsOnStudyDay: 1,
  });
  const open = selectQueue({
    cards: staticCards,
    concepts,
    memories: { 'met.lapse.dalr': memory },
    now,
    filter: 'met',
  });
  assert.equal(open.includes('met.lapse.dalr'), false);
  assert.ok(open.includes('met.stab.abs'));
});

test('the worked plan leads the all-subject queue', () => {
  const queue = selectQueue({
    cards: library(null),
    concepts,
    memories: {},
    now: '2026-10-06T00:00:00.000Z',
    filter: 'all',
  });
  assert.equal(queue[0], 'fp.fuel.list');
  assert.ok(queue.includes('fp.b727.later'));
  assert.ok(queue.indexOf('fp.fuel.list') < queue.indexOf('fp.b727.later'));
});
