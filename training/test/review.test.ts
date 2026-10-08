import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { concepts } from '../src/catalog.ts';
import { laterCard, staticCards } from '../src/deck.ts';
import { modeEnabled, planQueue } from '../src/chrome.ts';
import { keyIntent } from '../src/keys.ts';
import { applyGrade, emptyProgress } from '../src/progress.ts';
import { selectQueue } from '../src/queue.ts';
import { openSession, reduce } from '../src/session.ts';
import { renderShell, type RenderInput } from '../src/view.ts';
import type { Card } from '../src/model.ts';
import type { Snapshot } from '../src/snapshot.ts';

const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');

function keys(phase: 'ask' | 'revealed', key: string, code = '', overlay: 'none' | 'flag' | 'shortcuts' = 'none') {
  const card = staticCards[0];
  return keyIntent({
    key,
    code,
    phase,
    overlay,
    typing: false,
    shift: false,
    optionIds: card.options.map((option) => option.id),
  });
}

test('space reveals, then 1–4 and space grade', () => {
  const card = staticCards[0];
  let session = openSession([card.id], 'all', 1_000);
  assert.deepEqual(keys('ask', '1'), { type: 'choose', optionId: '1' });
  session = reduce(session, { type: 'choose', optionId: '1' }, card).session;
  assert.deepEqual(keys('ask', ' ', 'Space'), { type: 'reveal' });
  const revealed = reduce(session, { type: 'reveal', now: 2_000 }, card);
  assert.equal(revealed.grade, null);
  assert.equal(revealed.session.phase, 'revealed');
  assert.deepEqual(keys('revealed', '4'), { type: 'grade', quality: 4 });
  assert.deepEqual(keys('revealed', ' ', 'Space'), { type: 'grade', quality: 3 });
  const graded = reduce(revealed.session, { type: 'grade', quality: 4, now: 3_000 }, card);
  assert.equal(graded.grade?.quality, 4);
  assert.equal(graded.session.index, 1);
  assert.equal(graded.session.phase, 'ask');
  const progress = applyGrade(emptyProgress(), card.id, {
    quality: graded.grade!.quality,
    at: '2026-10-06T00:00:00.000Z',
    responseTimeMs: graded.grade!.responseTimeMs,
    complexity: card.complexity,
    day: '2026-10-06',
  });
  assert.equal(progress.cards[card.id].correctCount, 1);
});

test('flag, shortcuts and escape follow the open overlay', () => {
  assert.deepEqual(keys('ask', 'f'), { type: 'flag' });
  assert.deepEqual(keys('ask', 'F'), { type: 'flag' });
  assert.deepEqual(keys('ask', '?'), { type: 'shortcuts' });
  assert.deepEqual(keys('ask', 'Escape'), { type: 'close' });
  assert.deepEqual(keys('ask', 'Escape', '', 'flag'), { type: 'dismiss' });
  assert.deepEqual(keys('revealed', '1', '', 'shortcuts'), { type: 'ignore' });
  const typing = keyIntent({
    key: 'f', code: 'KeyF', phase: 'ask', overlay: 'none', typing: true, shift: false, optionIds: ['1'],
  });
  assert.deepEqual(typing, { type: 'ignore' });
});

test('subjects without cards stay disabled, and a worked plan keeps its order', () => {
  const cards = [...staticCards, laterCard];
  assert.equal(modeEnabled('met', cards), true);
  assert.equal(modeEnabled('plan', cards), true);
  assert.equal(modeEnabled('performance', cards), true);
  assert.equal(modeEnabled('nav', cards), false);
  assert.equal(modeEnabled('law', cards), false);
  assert.equal(modeEnabled('human', cards), false);
  assert.equal(modeEnabled('systems', cards), false);
  assert.equal(modeEnabled('aero', cards), false);
  const planned = planQueue([
    { ...staticCards[0], planStep: 2 },
    { ...laterCard, planStep: 1 },
  ]);
  assert.deepEqual(planned, [laterCard.id, staticCards[0].id]);
});

test('an exam queue keeps a card that is not due', () => {
  const card = staticCards[0];
  const progress = applyGrade(emptyProgress(), card.id, {
    quality: 4,
    at: '2026-10-06T00:00:00.000Z',
    responseTimeMs: 1_000,
    complexity: card.complexity,
    day: '2026-10-06',
  });
  const now = '2026-10-06T01:00:00.000Z';
  const input = { cards: [card], concepts, memories: progress.cards, now, filter: 'all' as const };
  assert.deepEqual(selectQueue(input), []);
  assert.deepEqual(selectQueue({ ...input, dueOnly: false }), [card.id]);
});

function has(html: string, needle: string): void {
  assert.ok(html.includes(needle), needle);
}

function shell(patch: Partial<RenderInput> = {}): string {
  const card = staticCards[0];
  const base: RenderInput = {
    page: 'review',
    mode: 'mixed',
    card,
    phase: 'ask',
    selected: null,
    done: 0,
    due: 51,
    profileDue: 51,
    retentionPct: 0,
    streak: 0,
    snapshot: null,
    sources: [],
    cards: [...staticCards, laterCard],
    overlay: 'none',
    flagDraft: '',
    flagged: false,
    shortcuts: [],
  };
  return renderShell({ ...base, ...patch });
}

test('the review shell uses the count pill and reveal bar, not the stats strip', () => {
  const ask = shell();
  has(ask, '0/51');
  has(ask, 'Show answer');
  has(ask, 'Space');
  has(ask, 'Difficulty: Auto');
  has(ask, 'Shortcuts (?)');
  has(ask, 'value="nav" disabled');
  has(ask, 'value="law" disabled');
  assert.equal(ask.includes('retention'), false);
  assert.equal(ask.includes('Again'), false);
  assert.equal(ask.includes('…'), false);
  const revealed = shell({ phase: 'revealed', selected: '1' });
  has(revealed, 'Again');
  has(revealed, 'Hard');
  has(revealed, 'Good');
  has(revealed, 'Easy');
  assert.equal(revealed.includes('Show answer'), false);
  const profile = shell({ page: 'profile', card: null });
  has(profile, 'retention');
  has(profile, 'streak');
  has(profile, '>51<');
});

test('a revealed TAF marks the group and a chart carries the ECMWF credit', () => {
  const card: Card = {
    ...staticCards[0],
    focus: { marks: [{ icao: 'YSSY', needle: 'TEMPO 0612/0618' }], cause: { label: 'TEMPO 12–18Z', value: '3000', datum: 'SHRA', title: 'Tempo' } },
  };
  const snapshot = {
    now: '2026-10-06T10:00:00Z',
    runTime: null,
    runError: null,
    gridSource: null,
    sampleTime: null,
    chartPng: 'abc',
    gradient: null,
    sigmets: [],
    notamCount: 0,
    points: [],
    airports: [{
      icao: 'YSSY',
      name: 'Sydney',
      zone: 'Australia/Sydney',
      lat: -33.9,
      lon: 151.2,
      metar: null,
      sample: null,
      taf: {
        raw: 'TEMPO 0612/0618 3000',
        issue: null,
        from: '2026-10-06T07:00:00Z',
        to: '2026-10-07T12:00:00Z',
        header: 'TAF 6 18:00 → 7 23:00',
        headerUtc: '6 07:00 → 7 12:00 UTC',
        lines: [{ text: 'TEMPO 0612/0618 3000 SHRA', active: false }],
      },
    }],
  } as Snapshot;
  const ask = shell({ card, snapshot, phase: 'ask' });
  assert.equal(ask.includes('<mark>'), false);
  has(ask, 'TEMPO 0612/0618');
  const revealed = shell({ card, snapshot, phase: 'revealed' });
  has(revealed, '<mark>TEMPO 0612/0618 3000 SHRA</mark>');
  has(revealed, 'TEMPO 12–18Z');
  const chart = shell({
    card: { ...staticCards[0], focus: { mapX: 0.4, mapY: 0.6, place: '35°S 148°E' } },
    snapshot: { ...snapshot, chartPng: 'abc' },
    phase: 'ask',
  });
  has(chart, 'ECMWF · CC BY 4.0');
  assert.equal(chart.includes('35°S 148°E'), false);
  const pinned = shell({
    card: { ...staticCards[0], focus: { mapX: 0.4, mapY: 0.6, place: '35°S 148°E', knots: 40 } },
    snapshot: { ...snapshot, chartPng: 'abc' },
    phase: 'revealed',
  });
  has(pinned, '35°S 148°E · 40 kt');
  const live = shell({ page: 'live', card: null, snapshot });
  has(live, 'ECMWF · CC BY 4.0');
  has(live, 'SIGMET');
  has(live, 'NOTAM');
});

test('a convective METAR leads with the base and the age stays whole', () => {
  const snapshot = {
    now: '2026-10-06T12:00:00Z',
    runTime: null,
    runError: null,
    gridSource: null,
    sampleTime: null,
    chartPng: null,
    gradient: null,
    sigmets: [],
    notamCount: 0,
    points: [],
    airports: [{
      icao: 'YPPH',
      name: 'Perth',
      zone: 'Australia/Perth',
      lat: -31.94,
      lon: 115.97,
      sample: null,
      taf: null,
      metar: {
        raw: 'METAR SPECI YPPH 061141Z 12007KT 9999 VCTS FEW035CB SCT069 BKN115 20/17 Q1015 RETS RESHRA',
        time: '2026-10-06T11:41:00Z',
        cloud: 'CB 3,500 · SCT069 · BKN115',
        vis: '10+ km',
        wind: '120/07',
        clock: '19:41',
        age: '12 m',
        aged: false,
        tip: 'Thunderstorm in vicinity',
        hazard: 'VCTS',
        hazardTip: 'Thunderstorm in vicinity · CB base 3,500 ft',
      },
    }],
  } as Snapshot;
  const live = shell({ page: 'live', card: null, snapshot });
  has(live, 'class="tag">VCTS');
  has(live, 'class="keep">CB 3,500');
  has(live, '19:41 · 12 m');
  assert.equal(live.includes('…'), false);
  assert.equal(live.includes('M7 28V15'), false);
  const card: Card = {
    ...staticCards[0],
    figure: {
      title: 'YPPH METAR',
      lines: ['METAR SPECI YPPH 061141Z 9999 VCTS FEW035CB SCT069'],
      highlight: ['FEW035CB'],
    },
  };
  const ask = shell({ card, snapshot, phase: 'ask' });
  has(ask, 'class="keep">CB 3,500');
  assert.equal(ask.includes('<mark>'), false);
  const revealed = shell({ card, snapshot, phase: 'revealed' });
  has(revealed, '<mark>METAR SPECI YPPH 061141Z 9999 VCTS FEW035CB SCT069</mark>');
  assert.equal(revealed.includes('…'), false);
});

test('the review stylesheet does not clip text with an ellipsis', () => {
  assert.equal(css.includes('ellipsis'), false);
  assert.equal(css.includes('text-overflow'), false);
  assert.equal(css.includes('…'), false);
  assert.equal(css.includes('minmax(0, max-content)'), false);
  assert.ok(css.includes('min-width: max-content'));
  assert.ok(css.includes('--md-primary: #1c5888'));
  assert.ok(css.includes('--md-primary: #6e9fcc'));
});
