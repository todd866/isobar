import assert from 'node:assert/strict';
import test from 'node:test';
import { briefStep, coachHtml, stripHtml } from '../src/instruments/e6b/ui.ts';
import { forInput, INPUT_MAP, TOUCH_INPUT_MAP } from '../src/instruments/e6b/input.ts';
import { FIRST_CONTACT, nextExercise, problemLine } from '../src/instruments/e6b/launch.ts';
import { E6B_PROCEDURES } from '../src/instruments/e6b/procedures.ts';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const base = { variant: 'lab' as const, side: 'computer' as const, exam: false, readout: 'Outer (black) 10.00 · Inner (blue) 10.00 · Time 1:40', practice: null, loupe: false };

test('phone dock is the readings and one labelled Menu; everything else is inside it', () => {
  const learn = { title: 'Time en route', state: 'learning' as const, stage: 'guided' as const, playing: false, step: 1, steps: 7 };
  const closed = stripHtml({ ...base, mode: 'learn', learn, narrow: true });
  assert.match(closed, /class="readout"/);
  assert.equal((closed.match(/<button/g) ?? []).length, 1, 'one control: Menu');
  assert.match(text(closed), /Menu/);
  const open = stripHtml({ ...base, mode: 'learn', learn, narrow: true, moreOpen: true });
  // The teaching flow (8 Oct): two modes, Problems and Free; no Learn/Practice.
  for (const label of ['Problems', 'Free', 'Watch', 'Guided', 'Solo', 'Computer', 'Wind', 'Exercises', 'Upright', 'Auto-turn', 'Loupe', 'Tour', 'Theory'])
    assert.ok(text(open).includes(label), label);
  const flowing = stripHtml({ ...base, mode: 'learn', learn, narrow: true, moreOpen: true, flow: true });
  for (const label of ['Learn', 'Practice', 'Watch', 'Guided', 'Solo', 'Exercises', 'Tour']) assert.ok(!text(flowing).includes(label), `flow: no ${label}`);
  // Labels of two words or fewer; every row carries a visible label, not just a glyph.
  for (const m of open.matchAll(/<span class="l">([^<]+)<\/span>/g)) assert.ok(m[1].split(/\s+/).length <= 2, m[1]);
  // Desktop: the same filter with more room; no glyph-only buttons outside the Menu.
  const desk = stripHtml({ ...base, mode: 'learn', learn });
  assert.match(desk, /data-e6b="more"/);
  assert.doesNotMatch(desk, /[⇆⌕∿ⓘ⌂]/);
});

test('phone coach is one short line with its control; the sentence is one tap away', () => {
  const html = coachHtml({ kind: 'guided', action: 'Turn the blue disc', detail: 'Turn the blue disc until 60 on inner blue sits under 145 on outer black.', ok: false, step: 4, steps: 7, next: null,
    brief: briefStep('Turn the blue disc until 60 on inner blue sits under 145 on outer black.') });
  assert.equal(text(html), '4/7 Blue 60 under black 145');
  assert.match(html, /data-e6b="coach-full"/);
  for (const p of E6B_PROCEDURES) for (const s of p.procedure) assert.ok(briefStep(s.action).length <= 66, briefStep(s.action));
});

test('touch wording: no keys, scroll wheel or Option on a phone', () => {
  const desk = [...FIRST_CONTACT.map(t => t.text), ...E6B_PROCEDURES.flatMap(p => p.procedure.map(s => s.correction))];
  for (const line of desk) assert.doesNotMatch(forInput(line, true), /⌥|Shift|scroll|\[ \/ \]/, line);
  assert.equal(forInput(desk[0], false), desk[0]);
  for (const [k] of TOUCH_INPUT_MAP) assert.doesNotMatch(k, /⌥|⇧|scroll|Ctrl|←/);
  assert.ok(INPUT_MAP.length > TOUCH_INPUT_MAP.length);
});

test('the problem is one line with its numbers', () => {
  assert.equal(problemLine('Busselton coastal navigation exercise: 145 kt, 174 NM. Find elapsed time.'), '145 kt, 174 NM → time');
  assert.equal(problemLine('Australian cross-country leg 1: TC 90°T, TAS 120 kt, wind 270°T/15 kt. Find heading and ground speed.'), 'TC 90°T, TAS 120 kt, W/V 270/15 → heading, GS');
  for (const p of E6B_PROCEDURES) assert.match(problemLine(p.scenario), /\d/, p.scenario);
});

test('first open lands on an exercise, not a start screen', () => {
  const n = nextExercise({ version: 1, memories: {}, stages: {}, bests: {}, daily: null, streak: { count: 0, lastDay: null } } as never);
  assert.ok(E6B_PROCEDURES.some(p => p.id === n.id));
});
