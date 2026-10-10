import assert from 'node:assert/strict';
import test from 'node:test';
import { supportDiagram } from '../src/diagrams.ts';
import { judge, retestCard, transferCard } from '../src/adaptive.ts';
import { drillCards } from '../src/skills/index.ts';

const bank = drillCards();

test('route support hides the computed position until solved, then places it to scale', () => {
  for (const card of bank.filter((item) => ['etp', 'pnr'].includes(item.drill!.skill))) {
    const diagram = card.figure!.diagram!;
    assert.equal(diagram.kind, 'route');
    if (diagram.kind !== 'route') continue;
    assert.equal(diagram.distance, card.numeric!.value);
    assert.ok(diagram.end > diagram.distance);
    const ask = supportDiagram(diagram, { revealed: false, solved: () => false, answerSolved: false });
    assert.equal(ask.includes('class="point"'), false);
    assert.ok(ask.includes('? nm'));
    const done = supportDiagram(diagram, { revealed: false, solved: () => false, answerSolved: true });
    assert.ok(done.includes(`cx="${24 + diagram.distance / diagram.end * 272}"`));
    assert.equal(done.includes('? nm'), false);
    const retest = retestCard(card, judge(card, '', 1))!;
    assert.deepEqual(retest.figure!.diagram, diagram);
    const transfer = transferCard(retest, 1)!;
    assert.ok(transfer.figure!.diagram);
    if (transfer.figure!.diagram!.kind === 'route') assert.equal(transfer.figure!.diagram!.distance, transfer.numeric!.value);
  }
});

test('wind diagrams carry true bearings and reveal calculated labels one step at a time', () => {
  for (const card of bank.filter((item) => ['wind-component', 'groundspeed'].includes(item.drill!.skill))) {
    const diagram = card.figure!.diagram!;
    assert.equal(diagram.kind, 'wind');
    const ask = supportDiagram(diagram, { revealed: false, solved: () => false, answerSolved: false });
    assert.ok(ask.includes('Cross ? kt'));
    assert.ok(ask.includes('Tail ? kt'));
    assert.ok(ask.includes('arrows point downwind'));
    const cross = supportDiagram(diagram, { revealed: false, solved: (id) => id === 'cross', answerSolved: false });
    assert.equal(cross.includes('Cross ? kt'), false);
    assert.ok(cross.includes('Tail ? kt'));
    const done = supportDiagram(diagram, { revealed: true, solved: () => false, answerSolved: false });
    assert.equal(done.includes('? kt'), false);
  }
});
