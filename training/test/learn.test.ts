import assert from 'node:assert/strict';
import test from 'node:test';
import raw from '../../docs/training/concepts.json' with { type: 'json' };
import {
  answerCard, applyBehaviour, calibratedDifficulty, chooseCard, conceptState, difficultyTarget,
  mulberry32, overridePrior, priorPerson, responds, summaryTheta, type Person, type ServeCard,
} from '../src/ability.ts';
import { learnSources } from '../src/catalog.ts';
import { anchorCard, cardsForLevel, cueFromSnapshot, learnCards } from '../src/learn-cards.ts';
import { bandOf, chipLabel, showsRules } from '../src/levels.ts';
import { scaffoldStep, teachingServe } from '../src/scheduler.ts';
import { paceAfter } from '../src/session.ts';
import { conceptsForLevel, type SyllabusConcept } from '../src/syllabus.ts';
import { lintCard, validateCard } from '../src/validate.ts';
import { learnSnapshot } from './fixtures/learn.ts';
import { renderShell, type RenderInput } from '../src/view.ts';
import type { LearnLevel } from '../src/levels.ts';

const graph = raw.concepts as SyllabusConcept[];

test('a level sees meteorology before the aviation concepts', () => {
  for (const level of ['curious', 'drone', 'student', 'airline', 'defence']) {
    const ids = conceptsForLevel(graph, level).map((concept) => concept.id);
    const firstOther = ids.findIndex((id) => !id.startsWith('met.'));
    const laterMet = ids.findIndex((id, index) => index > firstOther && firstOther >= 0 && id.startsWith('met.'));
    assert.equal(laterMet, -1, `${level} has a met concept after ${ids[firstOther]}`);
    assert.ok(ids.length > 0, level);
  }
  const curious = conceptsForLevel(graph, 'curious').map((concept) => concept.id);
  assert.equal(curious[0], 'met.pressure-systems');
  assert.ok(curious.includes('drone.low-level-wind'));
  assert.equal(curious.includes('def.illumination'), false);
  assert.equal(conceptsForLevel(graph, 'defence').every((concept) => concept.id.startsWith('def.')), true);
});

test('curious and drone cards cover every concept present at that level', () => {
  for (const level of ['curious', 'drone'] as const) {
    for (const concept of conceptsForLevel(graph, level)) {
      assert.ok(
        learnCards.some((card) => card.level === level && card.conceptIds.includes(concept.id)),
        `${level} missing ${concept.id}`,
      );
    }
  }
});

test('level cards meet the question standard and rule cards name a source', () => {
  const errors: string[] = [];
  for (const card of learnCards) {
    errors.push(...lintCard(card), ...validateCard(card, graph.map((concept) => ({
      id: concept.id,
      name: concept.title,
      description: concept.title,
      subject: card.subject === 'plan' ? 'plan' as const : 'met' as const,
      topics: [],
      prerequisiteIds: [],
      examWeight: 1,
    })), learnSources));
  }
  assert.deepEqual(errors, []);
  const bare = { ...learnCards.find((card) => card.claim === 'rule')! };
  bare.explanation = 'The rule is whatever the instructor remembers from a forum.';
  bare.id = 'bare.rule';
  assert.ok(lintCard(bare).some((error) => /names no/.test(error)));
});

test('curious hides rules and defence cards cite public doctrine', () => {
  assert.equal(showsRules('curious'), false);
  assert.equal(showsRules('defence'), false);
  assert.equal(showsRules('defence', true), true);
  assert.equal(chipLabel('student', 'us'), 'Student pilot · US');
  assert.equal(chipLabel('curious', 'aus'), 'Curious');
  for (const card of learnCards.filter((item) => item.level === 'defence')) {
    assert.ok(card.picture);
    assert.equal(card.claim, 'rule');
    assert.match(card.explanation, /JP 3-59|ATP 2-01\.3/);
  }
});

const levels: LearnLevel[] = ['curious', 'drone', 'student', 'commercial', 'airline', 'defence'];
const opener = (snapshot = learnSnapshot(), level: LearnLevel = 'student', rules: 'aus' | 'us' = 'aus') =>
  anchorCard({ level, rules, goal: 'weather', cue: cueFromSnapshot(snapshot) });
const correct = (card: ReturnType<typeof opener>) => card.options.find((option) => option.id === card.correctId)!.text;

test('every pilot level derives its ceiling and options from BKN012, in either rule set', () => {
  for (const level of ['student', 'commercial', 'airline'] as const) for (const rules of ['aus', 'us'] as const) {
    const card = opener(learnSnapshot(), level, rules);
    assert.equal(card.scenario, 'live');
    assert.match(card.stem, /Perth.*FEW006 BKN012 OVC040/);
    assert.match(card.stem, /1:30 pm/); // Observation, not the 2:17 pm UI clock.
    assert.equal(correct(card), '1,200 ft AGL');
    assert.ok(card.options.some((option) => option.text === '600 ft AGL'));
    assert.ok(card.options.some((option) => option.text === '4,000 ft AGL'));
    assert.doesNotMatch(JSON.stringify(card), /FEW010|BKN030|3,000 ft|29\.82/);
    assert.deepEqual(lintCard(card), []);
    if (rules === 'us') assert.match(card.explanation, /FAA/);
  }
  const changed = opener(learnSnapshot('SCT008 OVC022 BKN035'));
  assert.equal(correct(changed), '2,200 ft AGL');
  assert.ok(changed.options.some((option) => option.text === '800 ft AGL'));
});

test('non-ceiling cloud and clear codes do not invent a ceiling or claim a cloud-free sky', () => {
  for (const cloud of ['FEW012 SCT030', 'CAVOK', 'NSC', 'NCD', 'SKC', 'CLR']) {
    const card = opener(learnSnapshot(cloud));
    assert.equal(card.scenario, 'live', cloud);
    assert.equal(correct(card), 'No ceiling reported', cloud);
    assert.match(card.explanation, /does not establish.*cloud-free/);
    assert.deepEqual(lintCard(card), [], cloud);
  }
});

test('unknown or missing cloud never turns into no ceiling; TREND and remarks are not observations', () => {
  for (const cloud of ['', 'BKN///', 'VV003', 'VV///', 'BKN000', 'FEW010 BKN///', 'BKN012 OVC///', 'CAVOK BKN012', 'BKN012XYZ']) {
    assert.equal(opener(learnSnapshot(cloud)).scenario, 'example', cloud);
  }
  for (const tail of ['TEMPO BKN004', 'BECMG BKN004', 'RMK BKN004']) {
    assert.equal(correct(opener(learnSnapshot(`FEW012 ${tail}`))), 'No ceiling reported');
  }
  assert.equal(correct(opener(learnSnapshot('OVC022 BKN012CB'))), '1,200 ft AGL');
});

test('dry weather selects supported Defence weather, never a rain-crossing claim', () => {
  for (const wind of ['24015KT', '00000KT', 'VRB03KT']) {
    const snapshot = learnSnapshot('FEW012', wind);
    const card = opener(snapshot, 'defence');
    assert.equal(card.scenario, 'live');
    assert.doesNotMatch(card.stem, /[Rr]ain|saturat/);
    assert.ok(['def.downwind-hazard', 'def.ceiling-vis'].includes(card.conceptIds[0]!));
    assert.deepEqual(lintCard(card), []);
  }
  assert.equal(correct(opener(learnSnapshot('FEW012', '24015KT'), 'defence')), 'Toward 60° true, downwind');
});

test('Curious and Drone quote actual gusts and do not infer gusts or strengthening from steady wind', () => {
  for (const level of ['curious', 'drone'] as const) {
    const gust = opener(learnSnapshot(), level);
    assert.match(gust.stem, /24015G25KT/);
    assert.equal(correct(gust), 'A brief increase from 15 kt to 25 kt');
    assert.deepEqual(lintCard(gust), []);
    for (const wind of ['24009KT', '00000KT', 'VRB03KT']) {
      const steady = opener(learnSnapshot('FEW012', wind), level);
      assert.equal(steady.scenario, 'live');
      assert.doesNotMatch(steady.stem, /gust|strengthen|packed/);
      assert.match(steady.stem, new RegExp(wind));
      assert.deepEqual(lintCard(steady), []);
    }
    const point = learnSnapshot();
    point.airports[0]!.metar = null;
    point.airports[0]!.sample = { windKt: 7, windFromDeg: 240, mslpHpa: null, t2mC: null, cloudCoverPct: null, mucapeJkg: null };
    assert.match(opener(point, level).stem, /model point.*2:00 pm.*7 kt/);
    point.sampleTime = null;
    assert.equal(opener(point, level).scenario, 'example');
  }
});

test('every unsupported anchor is an explicit example without any live place or clock', () => {
  const snapshot = learnSnapshot();
  snapshot.airports[0]!.metar = null;
  for (const level of levels) for (const rules of ['aus', 'us'] as const) {
    const cue = cueFromSnapshot(snapshot);
    const card = anchorCard({ level, rules, goal: 'weather', cue });
    assert.equal(card.scenario, 'example', `${level}/${rules}`);
    assert.match(card.stem, /Example Field.*fictional aerodrome/);
    assert.equal(JSON.stringify(card).includes(cue.place), false);
    assert.equal(JSON.stringify(card).includes(cue.timeLocal), false);
    assert.deepEqual(lintCard(card), []);
    const html = renderShell({
      page: 'review', mode: 'mixed', card, phase: 'ask', selected: null, done: 0, due: 1,
      profileDue: 1, retentionPct: 0, streak: 0, snapshot, sources: [], cards: [card],
      overlay: 'none', flagDraft: '', flagged: false, shortcuts: [],
    } as RenderInput);
    assert.match(html, /data-example-chip>Example<\/span>/);
  }
});

test('rendered evidence stays attached to the card, and each card surface marks examples', () => {
  const snapshot = learnSnapshot('BKN022');
  for (const page of ['review', 'plan', 'exam'] as const) {
    for (const scenario of ['live', 'example'] as const) {
      const card = scenario === 'live' ? opener(learnSnapshot())
        : anchorCard({ level: 'student', rules: 'aus', goal: 'flying', cue: cueFromSnapshot(null) });
      const html = renderShell({
        page, mode: 'mixed', card, phase: 'ask', selected: null, done: 0, due: 1,
        profileDue: 1, retentionPct: 0, streak: 0, snapshot, sources: [], cards: [card],
        overlay: 'none', flagDraft: '', flagged: false, shortcuts: [],
      } as RenderInput);
      assert.equal(html.includes('data-example-chip'), scenario === 'example');
      assert.doesNotMatch(html, /BKN022/);
      if (scenario === 'live') {
        assert.match(html, /<figcaption>FEW006 BKN012 OVC040<\/figcaption>/);
        assert.match(html, /1:30 pm/);
      }
    }
  }
});

test('automatic and corrected METAR forms retain their real weather', () => {
  for (const start of ['METAR YPPH 090530Z AUTO', 'METAR COR YPPH 090530Z', 'METAR AUTO YPPH 090530Z', 'SPECI YPPH 090530Z', 'YPPH 090530Z']) {
    const snapshot = learnSnapshot();
    snapshot.airports[0]!.metar!.raw = `${start} 24015KT 9999 BKN012`;
    assert.equal(correct(opener(snapshot)), '1,200 ft AGL', start);
  }
});

test('missing, mismatched, or undated reports and unmatched place hints fail to examples', () => {
  for (const mutation of ['station', 'time', 'zone', 'nil'] as const) {
    const snapshot = learnSnapshot();
    const airport = snapshot.airports[0]!;
    if (mutation === 'station') airport.metar!.raw = airport.metar!.raw.replace('YPPH', 'YSSY');
    if (mutation === 'time') airport.metar!.time = null;
    if (mutation === 'zone') airport.zone = 'invalid';
    if (mutation === 'nil') airport.metar!.raw = 'METAR YPPH 090530Z NIL';
    for (const level of levels) assert.equal(opener(snapshot, level).scenario, 'example', `${mutation}/${level}`);
  }
  const snapshot = learnSnapshot();
  const cue = cueFromSnapshot(snapshot, 'Sydney');
  assert.equal(cue.report, null);
  assert.equal(anchorCard({ level: 'student', rules: 'aus', goal: 'flying', cue }).scenario, 'example');
  assert.ok(cueFromSnapshot(snapshot, 'ypph').report);
  assert.equal(anchorCard({ level: 'student', rules: 'aus', goal: 'flying', cue: cueFromSnapshot(null) }).scenario, 'example');
});

function pool(): ServeCard[] {
  const cards: ServeCard[] = [];
  for (const strand of ['physics', 'charts', 'rules-aus', 'rules-us', 'operations', 'numbers'] as const) {
    for (const difficulty of [-3, -2, -1, 0, 1, 2, 3]) {
      cards.push({ id: `${strand}:${difficulty}`, strands: [strand], difficulty, conceptId: strand });
    }
  }
  return cards;
}

function sit(person: Person, truth: Record<string, number>, steps: number, seed = 7): { person: Person; maxFail: number; served: ServeCard[] } {
  const rng = mulberry32(seed);
  const cards = pool();
  let maxFail = 0;
  let fail = 0;
  const served: ServeCard[] = [];
  for (let i = 0; i < steps; i += 1) {
    const pace = { position: i, consecutiveFailures: person.consecutiveFailures, lowCommitment: false };
    const card = chooseCard(person, cards, rng, pace)!;
    served.push(card);
    const strand = card.strands[0]!;
    const correct = (truth[strand] ?? 0) + 0.35 >= card.difficulty;
    if (correct) fail = 0;
    else { fail += 1; maxFail = Math.max(maxFail, fail); }
    person = answerCard(person, card, correct, 12_000, 1_700_000_000_000 + i * 60_000);
  }
  return { person, maxFail, served };
}

test('an airline student who picked curious is found within 15 answers', () => {
  let person = priorPerson({ level: 'curious', goal: 'weather', rules: null, now: 1_700_000_000_000 });
  const truth = { physics: 2, charts: 2, 'rules-aus': 2, 'rules-us': 2, operations: 2, numbers: 2 };
  const done = sit(person, truth, 15, 3);
  assert.equal(bandOf(summaryTheta(done.person)), 'airline');
});

test('a curious student who picked airline is brought down within 10 answers', () => {
  let person = priorPerson({ level: 'airline', goal: 'flying', rules: 'us', now: 1_700_000_000_000 });
  const rng = mulberry32(11);
  const cards = pool();
  let streak = 0;
  let maxFail = 0;
  for (let i = 0; i < 10; i += 1) {
    const card = chooseCard(person, cards, rng, {
      position: i, consecutiveFailures: person.consecutiveFailures, lowCommitment: false,
    })!;
    const correct = responds(-2, card.difficulty, rng);
    streak = correct ? 0 : streak + 1;
    maxFail = Math.max(maxFail, streak);
    person = answerCard(person, card, correct, 12_000, 1_700_000_000_000 + i * 60_000);
  }
  assert.equal(bandOf(summaryTheta(person)), 'curious');
  assert.ok(maxFail <= 3, `failure run ${maxFail}`);
});

test('a steady student stays in band', () => {
  let person = priorPerson({ level: 'student', goal: 'flying', rules: 'aus', now: 1_700_000_000_000 });
  for (const strand of Object.keys(person.strands) as (keyof typeof person.strands)[]) {
    person.strands[strand] = { ...person.strands[strand], sigma: 0.32, answers: 24 };
  }
  const rng = mulberry32(21);
  const cards = pool();
  for (let i = 0; i < 40; i += 1) {
    const card = chooseCard(person, cards, rng, { position: i + 1, consecutiveFailures: 0, lowCommitment: false })!;
    const theta = person.strands[card.strands[0]!]!.theta;
    const correct = card.difficulty < theta - 0.25 ? true : card.difficulty > theta + 0.25 ? false : i % 2 === 0;
    person = answerCard(person, card, correct, 12_000, 1_700_000_000_000 + i * 60_000);
  }
  assert.equal(bandOf(summaryTheta(person)), 'student');
});

test('a drone pilot strong on charts and naive on physics is served that way', () => {
  let person = priorPerson({ level: 'drone', goal: 'drones', rules: 'aus', now: 1 });
  person = {
    ...person,
    strands: {
      ...person.strands,
      charts: { ...person.strands.charts, theta: 1.6, sigma: 0.3 },
      physics: { ...person.strands.physics, theta: -1.6, sigma: 0.3 },
    },
  };
  const rng = mulberry32(4);
  const cards = pool();
  const seen: ServeCard[] = [];
  for (let i = 0; i < 24; i += 1) {
    const card = chooseCard(person, cards, rng, { position: i + 1, consecutiveFailures: 0, lowCommitment: false })!;
    if (card.strands[0] === 'charts' || card.strands[0] === 'physics') seen.push(card);
  }
  const charts = seen.filter((card) => card.strands[0] === 'charts').map((card) => card.difficulty);
  const physics = seen.filter((card) => card.strands[0] === 'physics').map((card) => card.difficulty);
  assert.ok(charts.length > 0 && physics.length > 0);
  const mean = (values: number[]) => values.reduce((sum, n) => sum + n, 0) / values.length;
  assert.ok(mean(charts) > 1, `charts ${mean(charts)}`);
  assert.ok(mean(physics) < -1, `physics ${mean(physics)}`);
});

test('a three-card learner gets a win first and not two failures in a row', () => {
  const person = priorPerson({ level: 'student', goal: 'flying', rules: 'aus', now: 1 });
  person.sessionLengths = [3, 3, 2];
  const opener = difficultyTarget(person, 'charts', mulberry32(1), {
    position: 0, consecutiveFailures: 0, lowCommitment: true,
  });
  assert.ok(opener < person.strands.charts.theta);
  assert.equal(0 + 0.35 >= opener, true);
  const rescue = difficultyTarget(person, 'charts', mulberry32(1), {
    position: 2, consecutiveFailures: 1, lowCommitment: true,
  });
  assert.ok(rescue < opener);
  let pace = paceAfter({ answered: 0, consecutiveFailures: 0 }, false);
  pace = paceAfter(pace, true);
  assert.equal(pace.consecutiveFailures, 0);
});

test('strong learners alone do not make a hard card look easy', () => {
  const observations = Array.from({ length: 20 }, (_, i) => ({ theta: 1.8 + (i % 5) * 0.08, correct: true }));
  assert.equal(calibratedDifficulty(2, observations), 2);
  const mixed = [
    ...Array.from({ length: 8 }, () => ({ theta: 2, correct: true })),
    ...Array.from({ length: 8 }, () => ({ theta: -2, correct: true })),
  ];
  assert.ok(calibratedDifficulty(2, mixed) < 1.5);
});

test('an override resets the prior and keeps the history', () => {
  let person = priorPerson({ level: 'curious', goal: 'weather', rules: null, now: 1 });
  person = answerCard(person, { id: 'a', strands: ['physics'], difficulty: -2, conceptId: 'met.wind' }, true, 4000, 2);
  const history = person.history.length;
  const next = overridePrior(person, 'airline', 'us', 3);
  assert.equal(next.history.length, history);
  assert.equal(next.concepts['met.wind']?.exposure, 1);
  assert.ok(next.strands.physics.theta > 1);
  assert.equal(next.strands.physics.sigma > 1, true);
  const goal = applyBehaviour(next, 'I fly a DJI at the beach');
  assert.equal(goal.goal, 'drones');
  assert.equal(goal.strands.physics.theta, next.strands.physics.theta);
});

test('teaching state decides the picture, the scaffold and the review', () => {
  const fresh = priorPerson({ level: 'student', goal: 'flying', rules: 'aus', now: 1 });
  assert.equal(teachingServe(conceptState(fresh, 'met.ceiling')), 'picture');
  assert.equal(scaffoldStep(1), 'retest');
  assert.equal(scaffoldStep(2), 'prerequisite');
  assert.equal(scaffoldStep(3), 'transfer');
  assert.equal(teachingServe('consolidating'), 'cross-format');
  assert.equal(teachingServe('mastered'), 'review');
  assert.ok(cardsForLevel('airline', 'us').every((card) => card.rules === 'us' || card.rules == null || card.rules === 'both'));
  assert.ok(cardsForLevel('airline', 'us').length >= 4);
});
