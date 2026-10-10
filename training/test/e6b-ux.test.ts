import assert from 'node:assert/strict';
import test from 'node:test';
import { TOL, aids, autoSteps, goalMet, graduationAngles, nextGraduation, plain, readoutLine, snapCursor, stepGoals, stepMet, tags, type Pose } from '../src/instruments/e6b/coach.ts';
import { machDemo, manualDemos, tsdDemo, windDemos } from '../src/instruments/e6b/demos.ts';
import { checkText, decimalAlarm, diagnose, estimateText, gradeEstimate, hmmTenths } from '../src/instruments/e6b/feedback.ts';
import { gestureApply, pinchFactor, wheelPixels, wheelSpin, wheelTurn } from '../src/instruments/e6b/input.ts';
import { MISSIONS, carry, missionProblem } from '../src/instruments/e6b/missions.ts';
import { SHAPES, check, makeProblem, rng, type Problem } from '../src/instruments/e6b/practice.ts';
import { route } from '../src/instruments/e6b/routes.ts';
import { dailySet, emptyRecord, finishDaily, nextAction, recordAttempt, skillState } from '../src/instruments/e6b/skills.ts';
import { angleOf, norm, rotationFor } from '../src/instruments/e6b/slide.ts';
import { readoutHtml, stripHtml, taskHtml } from '../src/instruments/e6b/ui.ts';
import { solveHeading } from '../src/instruments/e6b/wind.ts';

const pose = (theta: number, cursor = 0, wind: Pose['wind'] = { plate: 0, gs: 150, dot: null }): Pose => ({ theta, cursor, wind });

test('alignment: each guided step asks for what changed, and is met within a third of a graduation', () => {
  const tsd = manualDemos()[0];
  const [set, find, read] = [0, 1, 2].map((i) => stepGoals(tsd.steps, i));
  const theta = rotationFor(150, 60);
  assert.deepEqual(set.map((g) => g.kind), ['disc']);
  assert.deepEqual(find.map((g) => g.kind), ['cursor']);
  assert.deepEqual(read, [], 'reading the answer needs no setting');
  assert.ok(stepMet(set, pose(theta + 0.5)), 'within 0.6°');
  assert.ok(!stepMet(set, pose(theta + 0.8)), 'outside 0.6°');
  assert.ok(stepMet(set, pose(theta - 0.4 + 360)), 'wraps at 360');
  assert.ok(goalMet(find[0], pose(theta, angleOf(245) + 0.3)));
  assert.ok(!goalMet(find[0], pose(theta, angleOf(250))));
  assert.ok(stepMet(read, pose(0)));
  // The Mach index only has to show in the window first; the next step sets it exactly.
  const mach = machDemo({ oat: 15, mach: 1 });
  const [loose, exact] = [stepGoals(mach.steps, 0), stepGoals(mach.steps, 1)];
  assert.equal(loose[0].tol, TOL.loose);
  assert.equal(exact.find((g) => g.kind === 'disc')?.tol, TOL.disc);
  // Wind side: plate, then the pencil dot, then the slide.
  const wind = windDemos()[0];
  assert.deepEqual(wind.steps.map((_, i) => stepGoals(wind.steps, i).map((g) => g.kind).join('+')), ['plate', 'dot', 'plate', 'slide', '', '']);
  const dotGoal = stepGoals(wind.steps, 1)[0];
  assert.ok(dotGoal.kind === 'dot');
  const at = wind.steps[1].wind!.dot!;
  assert.ok(goalMet(dotGoal, pose(0, 0, { plate: 230, gs: 125, dot: [at[0] + 20, at[1]] })));
  assert.ok(!goalMet(dotGoal, pose(0, 0, { plate: 230, gs: 125, dot: null })));
});

test('step progression: fading leaves the last move to the learner, then all of them', () => {
  for (const demo of [...manualDemos(), ...windDemos()]) {
    const round0 = autoSteps(demo.steps, 0);
    const lastGoal = Math.max(...demo.steps.map((_, i) => (stepGoals(demo.steps, i).length ? i : -1)));
    assert.ok(lastGoal >= 0, demo.id);
    assert.equal(round0.filter((auto) => !auto).length, demo.steps.length - lastGoal, `${demo.id}: learner does the last setting and the readings`);
    assert.ok(round0.slice(0, lastGoal).every(Boolean));
    assert.ok(autoSteps(demo.steps, 1).every((auto) => !auto), `${demo.id}: round 1 is all the learner's`);
    // A learner who does exactly what each step shows satisfies every step in turn.
    let p = pose(0, angleOf(10), { plate: 0, gs: demo.steps[0].wind?.gs ?? 150, dot: null });
    demo.steps.forEach((step, i) => {
      p = step.wind ? { ...p, wind: { ...step.wind } } : { ...p, theta: step.theta, cursor: step.cursor ?? p.cursor };
      assert.ok(stepMet(stepGoals(demo.steps, i), p), `${demo.id} step ${i}`);
    });
  }
});

test('the hairline snaps lightly to graduations on either scale and steps by graduation', () => {
  const grads = graduationAngles();
  const g = angleOf(24);
  assert.equal(snapCursor(g + 0.2, 0, grads), norm(g));
  const between = (angleOf(24.4) + angleOf(24.6)) / 2;
  assert.equal(snapCursor(between, 0.01, { outer: grads.outer, inner: [] }), between, 'mid-gap stays free');
  // Inner-scale graduations move with the disc.
  const theta = 7.3;
  assert.equal(snapCursor(norm(angleOf(50) + theta + 0.1), theta, { outer: [], inner: grads.inner }), norm(angleOf(50) + theta));
  const up = nextGraduation(angleOf(20), 1, grads);
  assert.ok(Math.abs(up - angleOf(20.2)) < 1e-6, 'next graduation above 20 is 20.2');
  assert.ok(Math.abs(nextGraduation(up, -1, grads) - angleOf(20)) < 1e-6);
});

test('readout and tags use plain, colour-matched words, never "middle"', () => {
  const p = pose(rotationFor(42, 60), angleOf(42));
  const line = readoutLine(p, 'computer');
  assert.equal(line, 'Outer (black) 42.0 · Inner (blue) 60.0 · Time 1:00');
  assert.ok(!/middle/i.test(line));
  assert.deepEqual(tags(p), { outer: '42.0', inner: '60.0', time: '1:00' });
  assert.ok(readoutHtml(line).includes('class="ro ink"') && readoutHtml(line).includes('class="ro blue"'));
  assert.equal(plain('Read the time on the middle scale.'), 'Read the time on the inner (blue) scale.');
  assert.match(readoutLine(pose(0, 0, { plate: 90, gs: 138, dot: null }), 'wind'), /^Index 090° · Ground speed 138 kt · Dot: none$/);
});

test('exam mode hides the readout, tags and coach marks but never the hairline', () => {
  assert.deepEqual(aids('practice', true), { hairline: true, tags: false, readout: false, coach: false, timer: true });
  assert.deepEqual(aids('practice', false), { hairline: true, tags: true, readout: true, coach: false, timer: true });
  assert.deepEqual(aids('learn', true), { hairline: true, tags: true, readout: true, coach: true, timer: false }, 'exam applies to Practice only');
  assert.equal(aids('free', false).hairline, true);
  const strip = (exam: boolean) => stripHtml({ variant: 'lab', mode: 'practice', side: 'computer', exam, readout: exam ? null : 'Outer (black) 10.00 · Inner (blue) 10.00 · Time 1:40',
    learn: null, practice: { label: 'Mixed', timer: '0:12' }, loupe: true });
  assert.ok(!strip(true).includes('class="ro'), 'no readout values in exam mode');
  assert.ok(stripHtml({ variant: 'lab', mode: 'practice', side: 'computer', exam: true, readout: null, learn: null, practice: { label: 'Mixed', timer: '0:12' }, loupe: true, moreOpen: true }).includes('data-e6b="exam" checked'), 'Exam is in the Menu');
  assert.ok(strip(false).replace(/<[^>]+>/g, '').includes('Outer (black)'));
  assert.ok(strip(true).includes('⏱ 0:12'), 'the clock runs in exam mode');
});

function tsdProblem(gs: number, dist: number): Problem {
  const demo = tsdDemo({ gs, dist });
  return { shape: 'tsd', easy: false, stem: 'x.', givens: [], unit: 'min or h:mm', demo, key: demo.results[0], time: true, slips: [] };
}

test('practice checking text is honest about the reading precision', () => {
  const p = tsdProblem(98, 245); // exactly 150 min
  assert.equal(checkText(p, check(p, '2:31')), "Your reading 2:31 · exact 2:30.0 · within the scale's reading precision (± 2 min)");
  assert.equal(checkText(p, check(p, '2:40')), "Your reading 2:40 · exact 2:30.0 · outside the scale's reading precision (± 2 min)");
  assert.equal(checkText(p, check(p, '')), 'Type your reading in minutes or h:mm.');
  assert.equal(hmmTenths(98.04), '1:38.0');
  assert.equal(hmmTenths(457.14), '7:37.1');
});

test('a wrong answer is named: decimal place, wrong index, inverted ratio, hours, reciprocal wind', () => {
  const p = makeProblem('tsd', rng(3));
  const exact = p.key.exact;
  assert.equal(diagnose(p, exact), null);
  assert.equal(diagnose(p, exact * 10)?.id, 'decimal');
  assert.equal(diagnose(p, exact / 6)?.id, 'index');
  assert.equal(diagnose(p, p.slips.find((s) => s.id === 'inverted')!.value)?.id, 'inverted');
  assert.equal(diagnose(p, exact / 60)?.id, 'hours');
  const wind = makeProblem('windfind', rng(5));
  assert.equal(diagnose(wind, (wind.key.exact + 180) % 360)?.id, 'reciprocal');
  const conv = makeProblem('convert', rng(9));
  assert.equal(diagnose(conv, conv.slips[0].value)?.id, 'inverted');
  assert.equal(diagnose(conv, conv.key.exact * 1.5), null, 'an unexplained miss is not given a false name');
});

test('estimation first: graded against the answer, and a tenfold reading is caught', () => {
  assert.equal(gradeEstimate(140, 150), 'close');
  assert.equal(gradeEstimate(100, 150), 'ballpark');
  assert.equal(gradeEstimate(15, 150), 'off');
  assert.equal(decimalAlarm(150, 1500), true);
  assert.equal(decimalAlarm(150, 15.2), true);
  assert.equal(decimalAlarm(150, 160), false);
  const p = tsdProblem(98, 245);
  assert.equal(estimateText(p, 140, 15), 'Estimate 2:20: close. Your reading is about ten times away from it: check the decimal place.');
  assert.equal(estimateText(p, 140, 151), 'Estimate 2:20: close.');
  // The task card asks for the estimate before the reading.
  const card = (locked: boolean) => taskHtml({ kicker: 'k', stem: 's', givens: [], estimate: { value: locked ? '140' : '', locked }, answer: { value: '', unit: 'min', enabled: locked, done: false },
    verdict: null, decision: null, replay: false, next: null });
  assert.ok(card(false).indexOf('data-e6b="estimate"') < card(false).indexOf('data-e6b="reading"'));
  assert.match(card(false), /data-e6b="reading"[^>]*disabled/);
  assert.doesNotMatch(card(true), /data-e6b="reading"[^>]*disabled/);
});

test('missions chain: each answer feeds the next link, and a wrong one is replaced by the exact value', () => {
  const ga = MISSIONS.find((m) => m.id === 'ga-canberra')!;
  const tasLink = missionProblem(ga, 0, []);
  // 150 kt is outside the reading precision of 140.4, so the exact value carries; 141 kt is accepted and carries.
  const wrong = carry(tasLink, check(tasLink, '150'));
  assert.equal(wrong.own, false);
  assert.ok(Math.abs(wrong.value - tasLink.key.exact) < 1e-9);
  const right = carry(tasLink, check(tasLink, '141'));
  assert.deepEqual(right, { value: 141, own: true });
  const gsLink = missionProblem(ga, 1, [right.value]);
  assert.match(gsLink.stem, /TAS of 141 kt/);
  const leg = route('YSBK', 'YSCB');
  assert.ok(Math.abs(gsLink.key.exact - solveHeading(Math.round(leg.track), 141, 270, 25).gs) < 1e-9, 'GS uses the carried TAS');
  const timeLink = missionProblem(ga, 2, [141, 118]);
  assert.match(timeLink.stem, /ground speed of 118 kt/);
  assert.ok(Math.abs(timeLink.key.exact - (Math.round(leg.nm) / 118) * 60) < 1e-9);
  const fuelLink = missionProblem(ga, 3, [141, 118, 62]);
  assert.ok(Math.abs(fuelLink.key.exact - (55 * 62) / 60) < 1e-9);
  const decision = ga.decision([141, 118, 62, 56.8]);
  assert.equal(decision.answer, 190 - 5 - 56.8 >= 41.25 + 0.15 * 56.8);
  assert.throws(() => missionProblem(ga, 2, [141]));
  // The jet mission's decision turns on the carried burn.
  const jet = MISSIONS.find((m) => m.id === 'jet-sydney')!;
  assert.equal(jet.decision([470, 210, 15000]).answer, true);
  assert.equal(jet.decision([470, 230, 16500]).answer, false);
});

test('practice problems are pilot situations on real Australian routes', () => {
  assert.ok(Math.abs(route('YPPH', 'YSSY').nm - 1770) < 10, 'Perth to Sydney is about 1,770 NM');
  const rand = rng(11);
  for (const shape of SHAPES) {
    const p = makeProblem(shape, rand);
    assert.ok(p.givens.length >= 1, shape);
    assert.ok(p.stem.length > 30, p.stem);
  }
  const fuel = makeProblem('fuel', rng(4));
  assert.match(fuel.stem, /^Y[A-Z]{3}→Y[A-Z]{3} in the B727/);
  assert.ok(fuel.decision);
  const burn = fuel.key.exact;
  const fob = Number(/with ([\d,]+) kg on board/.exec(fuel.stem)![1].replace(/,/g, ''));
  assert.ok(fob - burn > 0);
  const live = makeProblem('windhdg', rng(2), false, undefined, { airports: ['YSCB', 'YSDU', 'YSWG', 'YMAY', 'YPKG', 'YCFS', 'YBCS'].map((icao) => ({ icao, windFrom: 300, windKt: 22, tempC: 14 })) });
  assert.match(live.stem, /today's model wind/);
});

test('skills: scheduler-backed state, interleaved daily set, personal bests and streak', () => {
  const at = '2026-10-07T01:00:00.000Z';
  let record = emptyRecord();
  assert.equal(skillState(record, 'tsd'), 'new');
  assert.deepEqual(nextAction(record, at, '2026-10-07'), { kind: 'learn', shape: 'tsd' });
  record = recordAttempt(record, 'tsd', { correct: true, helped: false, ms: 30_000, at });
  assert.equal(skillState(record, 'tsd'), 'learning');
  assert.equal(record.bests.tsd, 30_000);
  record = recordAttempt(record, 'tsd', { correct: true, helped: false, ms: 50_000, at });
  assert.equal(record.bests.tsd, 30_000, 'a slower answer is not a best');
  for (let i = 0; i < 5; i++) record = recordAttempt(record, 'tsd', { correct: true, helped: false, ms: 20_000, at: `2026-10-${10 + i * 3}T01:00:00.000Z` });
  assert.equal(skillState(record, 'tsd'), 'fluent');
  for (const seed of [1, 2, 3]) {
    const set = dailySet(record, at, rng(seed));
    assert.ok(set.length >= 5 && set.length <= 8);
    for (let i = 1; i < set.length; i++) assert.notEqual(set[i], set[i - 1], 'interleaved: no skill twice in a row');
    assert.ok(new Set(set).size >= 3, 'mixed operations');
  }
  // Learned skills that are due come first.
  let three = emptyRecord();
  for (const shape of ['fuel', 'convert', 'tas'] as const) three = recordAttempt(three, shape, { correct: shape !== 'tas', helped: false, ms: 40_000, at });
  const later = '2026-10-20T01:00:00.000Z';
  const set = dailySet(three, later, rng(1));
  assert.ok(set.every((shape) => ['fuel', 'convert', 'tas'].includes(shape)), 'only learned skills once three are learned');
  assert.equal(set[0], 'tas', 'the missed skill is due soonest');
  record = finishDaily(record, '2026-10-07', true);
  record = finishDaily(record, '2026-10-08', true);
  assert.equal(record.streak.count, 2);
  assert.equal(finishDaily(record, '2026-10-10', false).streak.count, 2, 'a day with misses does not extend it');
  assert.equal(finishDaily(record, '2026-10-10', true).streak.count, 1, 'a gap restarts it');
});

test('trackpad: scroll follows the fingers round the centre; pinch zooms; Safari rotation is 1:1', () => {
  // Natural scrolling: fingers moving right give a negative deltaX. At the top of the dial that turns it clockwise.
  assert.ok(wheelTurn(-10, 0, 0, -300) > 0);
  assert.ok(wheelTurn(10, 0, 0, -300) < 0);
  // On the right side, fingers moving down (negative deltaY) also turn it clockwise.
  assert.ok(wheelTurn(0, -10, 300, 0) > 0);
  // A fingertip on the rim drags the rim: arc length over radius.
  assert.ok(Math.abs(wheelTurn(-300 * Math.PI / 180, 0, 0, -300) - 1) < 1e-9, 'one degree of rim per degree of arc');
  // Radial scrolling does not turn it.
  assert.equal(wheelTurn(0, -10, 0, -300), 0);
  assert.deepEqual(wheelPixels(1, 2, 1), [16, 32]);
  assert.ok(pinchFactor(-10) < 1 && pinchFactor(10) > 1);
  assert.deepEqual(gestureApply({ theta: 350, w: 3000 }, 2, 20, 420, 3160), { theta: 10, w: 1500 });
  assert.deepEqual(gestureApply({ theta: 0, w: 1000 }, 0.1, -30, 420, 3160), { theta: 330, w: 3160 });
});

test('every guided procedure step reads as one action, with what the number is', async () => {
  const { E6B_PROCEDURES } = await import('../src/instruments/e6b/procedures.ts');
  const { stepLine } = await import('../src/instruments/e6b/ui.ts');
  const time1 = E6B_PROCEDURES.find((p) => p.id === 'time-1')!;
  const lines = time1.procedure.map((s) => stepLine(time1.operation, s.physical.kind, s.action, s.result?.unit ?? time1.answer.unit));
  assert.equal(lines[0], 'Estimate the time in minutes, then Check');
  assert.equal(lines[3], 'Turn the disc: inner blue 60 under outer black 120');
  assert.equal(lines[6], 'Read minutes on inner blue, then Check');
  for (const p of E6B_PROCEDURES) for (const s of p.procedure) {
    const line = stepLine(p.operation, s.physical.kind, s.action, s.result?.unit ?? p.answer.unit);
    assert.match(line, /^[A-Z][a-z]+ /, `${p.id}: ${line}`);
    assert.doesNotMatch(line, /[a-z0-9]\.$|undefined/, `${p.id}: ${line}`);
    if (s.physical.kind === 'estimate' || s.physical.kind === 'read') assert.match(line, /, then Check$/, `${p.id}: ${line}`);
  }
});

test('a plain scroll turns the whole computer: both axes, down or right clockwise, proportional', () => {
  assert.equal(wheelSpin(0, 40), 10);
  assert.equal(wheelSpin(40, 0), 10);
  assert.equal(wheelSpin(0, -40), -10);
  assert.equal(wheelSpin(20, 20), wheelSpin(0, 40));
});
