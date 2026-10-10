import assert from 'node:assert/strict';
import test from 'node:test';
import { renderShell, type RenderInput } from '../src/view.ts';
import type { Card } from '../src/model.ts';
import { judge, retestCard } from '../src/adaptive.ts';
import { drillCards } from '../src/skills/index.ts';

test('an E6-B support card renders its tool toggle and host', () => {
  const card: Card = {
    id: 'plan.e6b-support',
    conceptIds: [],
    subject: 'plan',
    kind: 'mcq',
    planStep: 1,
    stem: 'Which instrument supports this calculation?',
    options: [{ id: '1', text: 'E6-B' }],
    correctId: '1',
    explanation: 'Use the flight computer.',
    citations: [],
    complexity: 1,
    topics: ['plan'],
    tool: 'e6b',
  };
  const input: RenderInput = {
    page: 'plan',
    mode: 'mixed',
    card,
    phase: 'ask',
    selected: null,
    done: 0,
    due: 1,
    profileDue: 1,
    retentionPct: 0,
    streak: 0,
    snapshot: null,
    sources: [],
    cards: [card],
    overlay: 'none',
    flagDraft: '',
    flagged: false,
    shortcuts: [],
    toolOpen: true,
  };
  const html = renderShell(input);
  assert.match(html, /data-tool/);
  assert.match(html, /data-e6b-host="card"/);

  // The numeric layout retains the worksheet while the tool replaces its figure.
  const drill = drillCards().find((item) => item.id === 'drill.interpolate.r1')!;
  const retest = retestCard(drill, judge(drill, '9999', 1000))!;
  const numeric: Card = { ...retest, tool: 'e6b' };
  const withTool = renderShell({ ...input, card: numeric });
  assert.match(withTool, /aria-label="Worksheet"/);
  assert.match(withTool, /data-e6b-host="card"/);
  assert.doesNotMatch(withTool, /<table/);
  const closed = renderShell({ ...input, card: numeric, toolOpen: false });
  assert.match(closed, /aria-label="Worksheet"/);
  assert.match(closed, /<table/);
  assert.doesNotMatch(closed, /data-e6b-host="card"/);
});
