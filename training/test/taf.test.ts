import assert from 'node:assert/strict';
import test from 'node:test';
import { alternateDecision, groupsInForce, lineMarked, lowerVisibility, type TafProduct } from '../src/taf.ts';

const minima = { ceilingFt: 1000, visM: 5000 };

const yssy: TafProduct = {
  raw: 'TAF AMD YSSY 060955Z 0609/0712 25018KT CAVOK FM061050 18030G40KT 9999 -SHRA SCT010 BKN020 FM061800 18028G38KT 9999 NSW FEW025 SCT045 FM062100 18022KT 9999 SCT040 FM071000 19015KT 9999 SCT030 TEMPO 0612/0618 18030G40KT 3000 SHRA BKN010',
  issue: '2026-10-06T09:55:00Z',
  from: '2026-10-06T09:00:00Z',
  to: '2026-10-07T12:00:00Z',
};

const ypph: TafProduct = {
  raw: 'TAF YPPH 060846Z 0609/0712 20010KT CAVOK FM061800 20005KT 9999 SCT008 FM062300 20012KT CAVOK FM070400 24014KT CAVOK FM070900 26012KT 9999 -SHRA BKN025',
  issue: '2026-10-06T08:46:00Z',
  from: '2026-10-06T09:00:00Z',
  to: '2026-10-07T12:00:00Z',
};

function brief(taf: TafProduct, at: string): string[] {
  const groups = groupsInForce(taf, at);
  assert.ok(groups, at);
  return groups.map((group) => `${group.role} ${group.kind} ${group.needle} ${group.visM}${group.visAtLeast ? '+' : ''}`);
}

test('at 15Z the YSSY groups in force are the 1050 FM and the 12–18 TEMPO', () => {
  assert.deepEqual(brief(yssy, '2026-10-06T15:00:00Z'), [
    'prevailing FM FM061050 9999+',
    'additional TEMPO TEMPO 0612/0618 3000',
  ]);
});

test('FM and TEMPO boundaries are inclusive at the start and exclusive at the end', () => {
  assert.deepEqual(brief(yssy, '2026-10-06T09:00:00Z'), ['prevailing base 25018KT CAVOK 9999+']);
  assert.deepEqual(brief(yssy, '2026-10-06T10:49:00Z'), ['prevailing base 25018KT CAVOK 9999+']);
  assert.deepEqual(brief(yssy, '2026-10-06T10:50:00Z'), ['prevailing FM FM061050 9999+']);
  assert.deepEqual(brief(yssy, '2026-10-06T11:59:00Z'), ['prevailing FM FM061050 9999+']);
  assert.deepEqual(brief(yssy, '2026-10-06T12:00:00Z'), [
    'prevailing FM FM061050 9999+',
    'additional TEMPO TEMPO 0612/0618 3000',
  ]);
  assert.deepEqual(brief(yssy, '2026-10-06T17:59:00Z'), [
    'prevailing FM FM061050 9999+',
    'additional TEMPO TEMPO 0612/0618 3000',
  ]);
  assert.deepEqual(brief(yssy, '2026-10-06T18:00:00Z'), ['prevailing FM FM061800 9999+']);
  assert.deepEqual(brief(yssy, '2026-10-06T21:00:00Z'), ['prevailing FM FM062100 9999+']);
  assert.deepEqual(brief(yssy, '2026-10-07T09:59:00Z'), ['prevailing FM FM062100 9999+']);
  assert.deepEqual(brief(yssy, '2026-10-07T10:00:00Z'), ['prevailing FM FM071000 9999+']);
  assert.deepEqual(groupsInForce(yssy, '2026-10-06T08:59:00Z'), []);
  assert.deepEqual(groupsInForce(yssy, '2026-10-07T12:00:00Z'), []);
});

test('YPPH at 15Z is still the base group; the 18Z FM replaces it', () => {
  assert.deepEqual(brief(ypph, '2026-10-06T15:00:00Z'), ['prevailing base 20010KT CAVOK 9999+']);
  assert.deepEqual(brief(ypph, '2026-10-06T17:59:00Z'), ['prevailing base 20010KT CAVOK 9999+']);
  assert.deepEqual(brief(ypph, '2026-10-06T18:00:00Z'), ['prevailing FM FM061800 9999+']);
  assert.deepEqual(brief(ypph, '2026-10-07T09:00:00Z'), ['prevailing FM FM070900 9999+']);
});

test('BECMG is a transition until its end, then the new prevailing', () => {
  const taf: TafProduct = {
    raw: 'TAF YPPH 261200Z 2612/2712 9999 SCT030 BECMG 2620/2622 4000 -RA BKN010 FM270400 9999 CAVOK',
    issue: '2026-09-26T12:00:00Z',
    from: '2026-09-26T12:00:00Z',
    to: '2026-09-27T12:00:00Z',
  };
  assert.deepEqual(brief(taf, '2026-09-26T19:59:00Z'), ['prevailing base 9999 SCT030 9999+']);
  assert.deepEqual(brief(taf, '2026-09-26T20:00:00Z'), [
    'prevailing base 9999 SCT030 9999+',
    'transition BECMG BECMG 2620/2622 4000',
  ]);
  assert.deepEqual(brief(taf, '2026-09-26T21:59:00Z'), [
    'prevailing base 9999 SCT030 9999+',
    'transition BECMG BECMG 2620/2622 4000',
  ]);
  assert.deepEqual(brief(taf, '2026-09-26T22:00:00Z'), ['prevailing BECMG BECMG 2620/2622 4000']);
  assert.deepEqual(brief(taf, '2026-09-27T03:59:00Z'), ['prevailing BECMG BECMG 2620/2622 4000']);
  assert.deepEqual(brief(taf, '2026-09-27T04:00:00Z'), ['prevailing FM FM270400 9999+']);
});

test('TEMPO, INTER, PROB30 and PROB40 are additional only inside their periods', () => {
  const taf: TafProduct = {
    raw: 'TAF YSSY 060900Z 0609/0712 25018KT CAVOK TEMPO 0610/0612 5000 RA BKN012 INTER 0611/0612 4000 SHRA BKN010 PROB30 TEMPO 0612/0614 3000 SHRA BKN008 PROB40 INTER 0613/0615 2000 TSRA BKN005',
    issue: '2026-10-06T09:00:00Z',
    from: '2026-10-06T09:00:00Z',
    to: '2026-10-07T12:00:00Z',
  };
  assert.deepEqual(brief(taf, '2026-10-06T09:59:00Z'), ['prevailing base 25018KT CAVOK 9999+']);
  assert.deepEqual(brief(taf, '2026-10-06T10:00:00Z'), [
    'prevailing base 25018KT CAVOK 9999+',
    'additional TEMPO TEMPO 0610/0612 5000',
  ]);
  assert.deepEqual(brief(taf, '2026-10-06T11:00:00Z'), [
    'prevailing base 25018KT CAVOK 9999+',
    'additional TEMPO TEMPO 0610/0612 5000',
    'additional INTER INTER 0611/0612 4000',
  ]);
  assert.deepEqual(brief(taf, '2026-10-06T12:00:00Z'), [
    'prevailing base 25018KT CAVOK 9999+',
    'additional PROB30 PROB30 TEMPO 0612/0614 3000',
  ]);
  assert.deepEqual(brief(taf, '2026-10-06T13:00:00Z'), [
    'prevailing base 25018KT CAVOK 9999+',
    'additional PROB30 PROB30 TEMPO 0612/0614 3000',
    'additional PROB40 PROB40 INTER 0613/0615 2000',
  ]);
  assert.deepEqual(brief(taf, '2026-10-06T14:00:00Z'), [
    'prevailing base 25018KT CAVOK 9999+',
    'additional PROB40 PROB40 INTER 0613/0615 2000',
  ]);
  assert.deepEqual(brief(taf, '2026-10-06T15:00:00Z'), ['prevailing base 25018KT CAVOK 9999+']);
});

test('a TEMPO that crosses midnight stays in force through 00Z and drops at its end', () => {
  const taf: TafProduct = {
    raw: 'TAF YSSY 060900Z 0609/0712 25018KT CAVOK TEMPO 0623/0702 3000 SHRA BKN010',
    issue: '2026-10-06T09:00:00Z',
    from: '2026-10-06T09:00:00Z',
    to: '2026-10-07T12:00:00Z',
  };
  assert.deepEqual(brief(taf, '2026-10-06T22:59:00Z'), ['prevailing base 25018KT CAVOK 9999+']);
  assert.deepEqual(brief(taf, '2026-10-06T23:00:00Z'), [
    'prevailing base 25018KT CAVOK 9999+',
    'additional TEMPO TEMPO 0623/0702 3000',
  ]);
  assert.deepEqual(brief(taf, '2026-10-07T00:00:00Z'), [
    'prevailing base 25018KT CAVOK 9999+',
    'additional TEMPO TEMPO 0623/0702 3000',
  ]);
  assert.deepEqual(brief(taf, '2026-10-07T02:00:00Z'), ['prevailing base 25018KT CAVOK 9999+']);
});

test('an amended TAF supersedes the earlier bulletin', () => {
  const taf: TafProduct = {
    raw: 'TAF YSSY 060500Z 0606/0712 23014KT 9999 FEW040 TEMPO 0612/0618 18030G40KT 3000 SHRA BKN010 TAF AMD YSSY 060955Z 0609/0712 25018KT CAVOK',
    issue: '2026-10-06T09:55:00Z',
    from: '2026-10-06T09:00:00Z',
    to: '2026-10-07T12:00:00Z',
  };
  assert.deepEqual(brief(taf, '2026-10-06T15:00:00Z'), ['prevailing base 25018KT CAVOK 9999+']);
  const decision = alternateDecision(taf, '2026-10-06T15:00:00Z', minima, 0);
  assert.equal(decision?.required, false);
  assert.equal(decision?.reason, 'clear');
});

test('a later amendment supersedes an earlier AMD', () => {
  const taf: TafProduct = {
    raw: 'TAF AMD YSSY 060700Z 0608/0712 18020KT 3000 RA BKN008 TAF AMD YSSY 060955Z 0609/0712 25018KT CAVOK',
    issue: '2026-10-06T09:55:00Z',
    from: '2026-10-06T09:00:00Z',
    to: '2026-10-07T12:00:00Z',
  };
  assert.deepEqual(brief(taf, '2026-10-06T10:00:00Z'), ['prevailing base 25018KT CAVOK 9999+']);
});

test('the lower in-force visibility at 15Z is the YSSY TEMPO', () => {
  const found = lowerVisibility(
    { icao: 'YPPH', taf: ypph },
    { icao: 'YSSY', taf: yssy },
    '2026-10-06T15:00:00Z',
  );
  assert.ok(found);
  assert.equal(found.winner, 'YSSY');
  assert.equal(found.cause.label, 'TEMPO 12–18Z');
  assert.equal(found.cause.value, '3000');
  assert.equal(found.cause.datum, 'SHRA BKN010 → YSSY');
  assert.deepEqual(found.marks.map((mark) => `${mark.icao} ${mark.needle}`), [
    'YPPH 20010KT CAVOK',
    'YSSY FM061050',
    'YSSY TEMPO 0612/0618',
  ]);
});

test('a BECMG in transition can be the lower visibility before it becomes prevailing', () => {
  const becoming: TafProduct = {
    raw: 'TAF YPPH 060900Z 0609/0712 9999 SCT030 BECMG 0614/0616 3000 RA BKN010',
    issue: '2026-10-06T09:00:00Z',
    from: '2026-10-06T09:00:00Z',
    to: '2026-10-07T12:00:00Z',
  };
  const clear: TafProduct = {
    raw: 'TAF YSSY 060900Z 0609/0712 25018KT CAVOK',
    issue: '2026-10-06T09:00:00Z',
    from: '2026-10-06T09:00:00Z',
    to: '2026-10-07T12:00:00Z',
  };
  const during = lowerVisibility(
    { icao: 'YPPH', taf: becoming },
    { icao: 'YSSY', taf: clear },
    '2026-10-06T15:00:00Z',
  );
  assert.equal(during?.winner, 'YPPH');
  assert.equal(during?.cause.label, 'BECMG 14–16Z');
  assert.equal(during?.cause.value, '3000');
  assert.equal(during?.cause.datum, 'RA BKN010 → YPPH');
  const after = lowerVisibility(
    { icao: 'YPPH', taf: becoming },
    { icao: 'YSSY', taf: clear },
    '2026-10-06T16:00:00Z',
  );
  assert.equal(after?.winner, 'YPPH');
  assert.equal(after?.cause.label, 'BECMG 14–16Z');
  assert.deepEqual(after?.marks.map((mark) => mark.needle), ['BECMG 0614/0616', '25018KT CAVOK']);
});

test('NSC is cloud with no ceiling, so the amended YPPH TAF still has groups in force', () => {
  const taf: TafProduct = {
    raw: 'TAF AMD YPPH 061028Z 0610/0712 20010KT CAVOK FM061100 20010KT 9999 -SHRA NSC FM061500 20008KT CAVOK FM061800 20005KT 9999 SCT008 FM062300 20012KT CAVOK FM070400 24014KT CAVOK FM070900 26012KT 9999 -SHRA BKN025 INTER 0611/0614 VRB20G30KT 4000 TSRA SCT100CB',
    issue: '2026-10-06T10:28:00Z',
    from: '2026-10-06T10:00:00Z',
    to: '2026-10-07T12:00:00Z',
  };
  assert.deepEqual(brief(taf, '2026-10-06T10:30:00Z'), ['prevailing base 20010KT CAVOK 9999+']);
  assert.deepEqual(brief(taf, '2026-10-06T11:00:00Z'), [
    'prevailing FM FM061100 9999+',
    'additional INTER INTER 0611/0614 4000',
  ]);
  assert.deepEqual(brief(taf, '2026-10-06T14:00:00Z'), ['prevailing FM FM061100 9999+']);
  assert.deepEqual(brief(taf, '2026-10-06T15:00:00Z'), ['prevailing FM FM061500 9999+']);
});

test('the header line is not marked before the answer, and only in-force lines are marked after', () => {
  const header = 'TAF AMD YSSY 060955Z 0609/0712 25018KT CAVOK';
  const fm = 'FM061050 18030G40KT 9999 -SHRA SCT010 BKN020';
  const tempo = 'TEMPO 0612/0618 18030G40KT 3000 SHRA BKN010';
  const later = 'FM061800 18028G38KT 9999 NSW FEW025 SCT045';
  const needles = ['FM061050', 'TEMPO 0612/0618'];
  assert.equal(lineMarked('ask', needles, header), false);
  assert.equal(lineMarked('ask', needles, fm), false);
  assert.equal(lineMarked('ask', needles, tempo), false);
  assert.equal(lineMarked('revealed', needles, header), false);
  assert.equal(lineMarked('revealed', needles, fm), true);
  assert.equal(lineMarked('revealed', needles, tempo), true);
  assert.equal(lineMarked('revealed', needles, later), false);
  assert.equal(lineMarked('revealed', [], tempo), false);
});

// ---- Alternate decision: TAF3, combined requirements, BECMG (Part 91 MOS 2020 s 8.02 (2), 8.04 (2), (7), (8)) ----

const TAF3_RAW = 'TAF YSSY 060840Z 0609/0712 00000KT 9999 FEW030 PROB30 0610/0611 0500 FG TEMPO 0611/0612 3000 SHRA BKN010 RMK T 14 15 Q 1016 1015 TAF3';

function taf3(raw = TAF3_RAW): TafProduct {
  return { raw, issue: '2026-10-06T08:40:00Z', from: '2026-10-06T09:00:00Z', to: '2026-10-07T12:00:00Z' };
}

test('on a TAF3 a PROB inside the first 3 hours is disregarded; on a plain TAF it is not', () => {
  const decision = alternateDecision(taf3(), '2026-10-06T10:30:00Z', minima, 0);
  assert.equal(decision?.taf3, true);
  assert.equal(decision?.reason, 'clear');
  const plain = alternateDecision(taf3(TAF3_RAW.replace(' TAF3', '')), '2026-10-06T10:30:00Z', minima, 0);
  assert.equal(plain?.taf3, false);
  assert.equal(plain?.reason, 'prob');
});

test('on a TAF3 the window is the ETA itself, so a TEMPO starting 20 min after the ETA does not count', () => {
  // TEMPO 0611/0612: an 10:40Z ETA is outside it on a TAF3, inside ETA ±30 min on a plain TAF.
  assert.equal(alternateDecision(taf3(), '2026-10-06T10:40:00Z', minima, 0)?.reason, 'clear');
  assert.equal(alternateDecision(taf3(), '2026-10-06T11:30:00Z', minima, 0)?.reason, 'tempo');
  assert.equal(alternateDecision(taf3(TAF3_RAW.replace(' TAF3', '')), '2026-10-06T10:40:00Z', minima, 0)?.reason, 'tempo');
});

test('the TAF3 alleviation ends after the first 3 hours and at the end of a limited service', () => {
  const late = taf3('TAF YSSY 060840Z 0609/0712 00000KT 9999 FEW030 PROB30 0613/0614 0500 FG RMK T 14 15 Q 1016 1015 TAF3');
  assert.equal(alternateDecision(late, '2026-10-06T13:30:00Z', minima, 0)?.reason, 'prob');
  const limited = taf3(TAF3_RAW.replace('TAF3', 'TAF3 VALID TL 061000'));
  assert.equal(alternateDecision(limited, '2026-10-06T10:30:00Z', minima, 0)?.taf3, false);
  assert.equal(alternateDecision(limited, '2026-10-06T10:30:00Z', minima, 0)?.reason, 'prob');
});

test('requirements combine: the longest hold wins, whichever group is found first', () => {
  // INTER (30 min) and a PROB ending at 15:00Z: hold to 15:30Z, 150 min after a 13:00Z ETA.
  const interProb: TafProduct = {
    raw: 'TAF YSSY 060900Z 0609/0712 00000KT 9999 FEW030 INTER 0612/0614 3000 SHRA BKN010 PROB30 0612/0615 0500 FG',
    issue: '2026-10-06T09:00:00Z', from: '2026-10-06T09:00:00Z', to: '2026-10-07T12:00:00Z',
  };
  const a = alternateDecision(interProb, '2026-10-06T13:00:00Z', minima, 0);
  assert.equal(a?.reason, 'prob');
  assert.equal(a?.holdMinutes, 150);
  assert.equal(alternateDecision(interProb, '2026-10-06T13:00:00Z', minima, 30)?.required, true);
  // A PROB ending just after the window (hold 35 min) and a TEMPO (60 min): the TEMPO governs.
  const tempoProb: TafProduct = {
    raw: 'TAF YSSY 060900Z 0609/0712 00000KT 9999 FEW030 PROB30 0612/0613 0500 FG TEMPO 0612/0616 3000 SHRA BKN010',
    issue: '2026-10-06T09:00:00Z', from: '2026-10-06T09:00:00Z', to: '2026-10-07T12:00:00Z',
  };
  const b = alternateDecision(tempoProb, '2026-10-06T12:55:00Z', minima, 0);
  assert.equal(b?.reason, 'tempo');
  assert.equal(b?.holdMinutes, 60);
  assert.equal(alternateDecision(tempoProb, '2026-10-06T12:55:00Z', minima, 35)?.required, true);
  // Prevailing conditions that end soon (hold 45 min) do not hide a TEMPO that needs 60.
  const prevailingTempo: TafProduct = {
    raw: 'TAF YSSY 060900Z 0609/0712 00000KT 2000 BR OVC005 FM061300 00000KT 9999 FEW030 TEMPO 0613/0616 3000 SHRA BKN010',
    issue: '2026-10-06T09:00:00Z', from: '2026-10-06T09:00:00Z', to: '2026-10-07T12:00:00Z',
  };
  const c = alternateDecision(prevailingTempo, '2026-10-06T12:45:00Z', minima, 0);
  assert.equal(c?.reason, 'tempo');
  assert.equal(c?.holdMinutes, 60);
});

test('a thunderstorm-only group is flagged as a thunderstorm, not as below the minima', () => {
  const storm: TafProduct = {
    raw: 'TAF YBBN 060900Z 0609/0712 10010KT 9999 SCT040 TEMPO 0612/0616 9999 TSRA SCT040CB',
    issue: '2026-10-06T09:00:00Z', from: '2026-10-06T09:00:00Z', to: '2026-10-07T12:00:00Z',
  };
  const decision = alternateDecision(storm, '2026-10-06T13:00:00Z', minima, 0);
  assert.equal(decision?.reason, 'tempo');
  assert.equal(decision?.thunderstorm, true);
  const rain = alternateDecision(yssy, '2026-10-06T15:00:00Z', minima, 0);
  assert.equal(rain?.thunderstorm, false);
});

test('a BECMG that deteriorates any element applies as a whole group from the start of its period', () => {
  // Visibility improves to 9999 but cloud thickens to BKN040: a deterioration in cloud, so the
  // whole BECMG group (9999 BKN040, above the minima) applies from 12:00Z.
  const mixed: TafProduct = {
    raw: 'TAF YMML 060900Z 0609/0712 00000KT 3000 BR SCT030 BECMG 0612/0614 18010KT 9999 BKN040',
    issue: '2026-10-06T09:00:00Z', from: '2026-10-06T09:00:00Z', to: '2026-10-07T12:00:00Z',
  };
  assert.equal(alternateDecision(mixed, '2026-10-06T13:00:00Z', minima, 0)?.reason, 'clear');
  // Before the BECMG window the 3000 m prevails.
  assert.equal(alternateDecision(mixed, '2026-10-06T10:30:00Z', minima, 0)?.reason, 'prevailing');
  // An improvement in every element applies only from the end of the period.
  const better: TafProduct = {
    raw: 'TAF YMML 060900Z 0609/0712 00000KT 3000 BR BKN008 BECMG 0612/0614 18010KT 9999 SCT040',
    issue: '2026-10-06T09:00:00Z', from: '2026-10-06T09:00:00Z', to: '2026-10-07T12:00:00Z',
  };
  assert.equal(alternateDecision(better, '2026-10-06T13:00:00Z', minima, 0)?.reason, 'prevailing');
  assert.equal(alternateDecision(better, '2026-10-06T15:00:00Z', minima, 0)?.reason, 'clear');
});

test('the remarks are not part of the last forecast group', () => {
  const groups = groupsInForce(taf3(), '2026-10-06T11:30:00Z');
  assert.ok(groups);
  assert.equal(groups.some((group) => group.body.includes('RMK')), false);
});
