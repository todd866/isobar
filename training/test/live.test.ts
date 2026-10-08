import assert from 'node:assert/strict';
import test from 'node:test';
import { liveCards } from '../src/live.ts';
import type { Snapshot, TafView } from '../src/snapshot.ts';
import { alternateDecision, chooseEta, localClock } from '../src/taf.ts';
import { applyGrade, emptyProgress, markStudyDay, previousDay } from '../src/progress.ts';
import { openSession, reduce } from '../src/session.ts';
import { library, staticCards } from '../src/deck.ts';
import { concepts, sources } from '../src/catalog.ts';
import { lintCard, validateLibrary } from '../src/validate.ts';
import type { Card } from '../src/model.ts';

const minima = { ceilingFt: 1000, visM: 5000 };

function correctText(card: Card): string {
  return card.options.find((option) => option.id === card.correctId)!.text;
}

function find(snapshot: Snapshot, id: string): Card | undefined {
  return liveCards(snapshot).find((card) => card.id === id);
}

// ---- Alternate decision (Part 91 MOS 2020 Chapter 8) ----

test('a TEMPO below the minima needs 60 min of holding or an alternate', () => {
  const taf = view('TAF YSSY 062012Z 0621/0800 18026KT 9999 SCT035 TEMPO 0707/0710 3000 SHRA BKN008', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  const decision = alternateDecision(taf, '2026-10-07T08:00:00Z', minima, 0);
  assert.equal(decision?.reason, 'tempo');
  assert.equal(decision?.holdMinutes, 60);
  assert.equal(decision?.required, true);
  assert.equal(alternateDecision(taf, '2026-10-07T08:00:00Z', minima, 60)?.required, false);
});

test('an INTER below the minima needs 30 min of holding', () => {
  const taf = view('TAF YPPH 062009Z 0621/0800 24012KT 9999 SCT012 BKN020 INTER 0720/0800 3000 SHRA BKN010', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  const decision = alternateDecision(taf, '2026-10-07T22:00:00Z', minima, 0);
  assert.equal(decision?.reason, 'inter');
  assert.equal(decision?.holdMinutes, 30);
  assert.equal(alternateDecision(taf, '2026-10-07T22:00:00Z', minima, 30)?.required, false);
});

test('a PROB30 of fog counts as relevant weather and a bare PROB is not a 30/60 case', () => {
  const taf = view('TAF YSCB 062000Z 0621/0800 00000KT 9999 FEW030 PROB30 0718/0722 0500 FG', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  const decision = alternateDecision(taf, '2026-10-07T20:00:00Z', minima, 0);
  assert.equal(decision?.reason, 'prob');
  // Hold until 22:30Z, 150 min after a 20:00Z ETA.
  assert.equal(decision?.holdMinutes, 150);
  assert.equal(decision?.required, true);
});

test('a thunderstorm is relevant weather even with CAVOK visibility and cloud', () => {
  const taf = view('TAF YBBN 062000Z 0621/0800 10010KT 9999 SCT040 TEMPO 0704/0708 9999 TSRA SCT040', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  const decision = alternateDecision(taf, '2026-10-07T06:00:00Z', minima, 0);
  assert.equal(decision?.reason, 'tempo');
});

test('prevailing conditions below the minima mean holding until 30 min after they end', () => {
  const taf = view('TAF YMML 062000Z 0621/0800 27010KT 9999 SCT030 FM070600 27010KT 2000 BR OVC005 FM071000 27010KT 9999 SCT030', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  const decision = alternateDecision(taf, '2026-10-07T07:00:00Z', minima, 0);
  assert.equal(decision?.reason, 'prevailing');
  // Conditions end at 10:00Z; hold until 10:30Z, 210 min after the ETA.
  assert.equal(decision?.holdMinutes, 210);
  assert.equal(alternateDecision(taf, '2026-10-07T07:00:00Z', minima, 210)?.required, false);
});

test('prevailing conditions below the minima to the end of the TAF cannot be held out', () => {
  const taf = view('TAF YMML 062000Z 0621/0800 27010KT 9999 SCT030 FM071800 27010KT 2000 BR OVC005', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  const decision = alternateDecision(taf, '2026-10-07T19:00:00Z', minima, 0);
  assert.equal(decision?.reason, 'prevailing');
  assert.equal(decision?.holdMinutes, null);
  assert.equal(decision?.required, true);
});

test('the TAF must cover 30 min before to 60 min after the ETA', () => {
  const taf = view('TAF YPAD 062000Z 0621/0800 00000KT CAVOK', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  assert.equal(alternateDecision(taf, '2026-10-07T23:30:00Z', minima, 0)?.reason, 'uncovered');
  assert.equal(alternateDecision(taf, '2026-10-07T23:00:00Z', minima, 0)?.reason, 'clear');
  assert.equal(alternateDecision(taf, '2026-10-06T21:15:00Z', minima, 0)?.reason, 'uncovered');
});

test('a value equal to the minimum is not below it', () => {
  const taf = view('TAF YSSY 062012Z 0621/0800 18026KT 9999 SCT035 INTER 0707/0721 20016G26KT 5000 SHRA BKN013', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  assert.equal(alternateDecision(taf, '2026-10-07T14:00:00Z', minima, 0)?.reason, 'clear');
});

test('the ETA worth asking about is the middle of the first spell that goes below the minima', () => {
  const taf = fixture().airports[0].taf!;
  assert.equal(chooseEta(taf, '2026-10-06T23:20:00Z', minima), '2026-10-07T22:00:00.000Z');
  assert.equal(chooseEta(taf, '2026-10-06T23:20:00Z'), '2026-10-07T18:30:00.000Z');
  // A TEMPO already finished is not asked about.
  assert.ok(chooseEta(taf, '2026-10-06T23:20:00Z') !== '2026-10-06T22:00:00.000Z');
  const plain = view('TAF YPAD 062000Z 0621/0800 00000KT CAVOK', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  assert.equal(chooseEta(plain, '2026-10-06T23:20:00Z'), '2026-10-06T23:20:00.000Z');
  assert.equal(chooseEta(plain, '2026-10-09T00:00:00Z'), null);
});

test('local clocks follow the place: Perth has no daylight saving, Sydney does', () => {
  assert.equal(localClock('2026-10-07T22:00:00Z', 'Australia/Perth'), '06:00');
  assert.equal(localClock('2026-10-07T14:00:00Z', 'Australia/Sydney'), '01:00');
});

// ---- Live templates on fixture data ----

test('every live card passes the question standard and its figure carries the text the answer needs', () => {
  const cards = liveCards(fixture());
  assert.deepEqual(cards.map((card) => card.id), [
    'live.groups.YSSY', 'live.sigmet', 'live.alternate.YSSY', 'live.alternate.YPPH', 'live.wind', 'live.ceiling', 'live.gradient', 'live.gradient.artefact',
  ]);
  for (const card of cards) {
    assert.deepEqual(lintCard(card), [], card.id);
    assert.ok(card.figure, card.id);
    const body = card.figure.lines.join('\n');
    for (const needle of card.figure.highlight) assert.ok(body.includes(needle), `${card.id} figure lacks ${needle}`);
    // The figure holds the product. The question does not paste a whole raw line.
    for (const line of card.figure.lines) {
      const raw = line.trim();
      if (raw.length > 80) assert.equal(card.stem.includes(raw), false, `${card.id} pastes raw text into the question`);
    }
  }
  assert.deepEqual(validateLibrary(library(fixture()), concepts, sources), []);
});

test('the groups card names the FM in force with the INTER laid over it', () => {
  const card = find(fixture(), 'live.groups.YSSY');
  assert.ok(card);
  assert.equal(card.planStep, 1);
  assert.ok(card.stem.includes('arriving 14:00Z (01:00 Sydney time)'));
  assert.equal(correctText(card), 'FM071400 with INTER 0707/0721');
  assert.ok(card.options.some((option) => option.text === 'FM071400 alone'));
  assert.ok(card.options.some((option) => option.text === 'FM070700 with INTER 0707/0721'));
  assert.deepEqual(card.figure?.highlight, ['FM071400', 'INTER 0707/0721']);
});

test('the groups card is dropped when the TAF has too few groups to misread', () => {
  const snapshot = fixture();
  snapshot.airports[1].taf = view('TAF YSSY 062012Z 0621/0800 18026KT 9999 SCT035 BKN045', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  assert.equal(find(snapshot, 'live.groups.YSSY'), undefined);
});

test('the SIGMET card decodes hazard, levels and expiry, and is dropped when none is current', () => {
  const card = find(fixture(), 'live.sigmet');
  assert.ok(card);
  assert.equal(card.planStep, 2);
  assert.ok(card.stem.includes('Brisbane FIR'));
  assert.ok(card.stem.includes('what does it warn of, over which levels, and until when?'));
  assert.equal(card.stem.includes('S5000 E16300'), false);
  assert.ok(card.figure?.lines.join('\n').includes('SEV TURB FCST'));
  assert.equal(correctText(card), 'Severe turbulence from FL120 to FL260, until 23:28Z');
  assert.ok(card.options.some((option) => option.text === 'Moderate turbulence from FL120 to FL260, until 23:28Z'));
  assert.ok(card.options.some((option) => option.text === 'Severe turbulence from FL120 to FL260, until 19:28Z'));
  assert.deepEqual(card.figure?.highlight, ['SEV TURB']);
  const expired = fixture();
  expired.now = '2026-10-07T01:00:00Z';
  assert.equal(find(expired, 'live.sigmet'), undefined);
  const unreadable = fixture();
  unreadable.sigmets![0].raw = unreadable.sigmets![0].raw.replace(' FL120/260', '');
  assert.equal(find(unreadable, 'live.sigmet'), undefined);
  const none = fixture();
  none.sigmets = [];
  assert.equal(find(none, 'live.sigmet'), undefined);
});

test('the SIGMET card keeps the level datum and qualifiers as written', () => {
  const at = (raw: string, base: number | null, top: number | null) => {
    const snapshot = fixture();
    snapshot.sigmets = [{ ...snapshot.sigmets![0], raw: `YBBB SIGMET L02 VALID 061928/062328 YMMC-\nYBBB BRISBANE FIR SEV TURB FCST WI S5000 E16300 - S4030 E15010 ${raw} MOV E 30KT NC=`, base, top }];
    return correctText(find(snapshot, 'live.sigmet')!);
  };
  // Feet stay feet even above 10 000 ft: 12000FT is not FL120.
  assert.equal(at('8000/12000FT', 8000, 12000), 'Severe turbulence from 8 000 ft to 12 000 ft, until 23:28Z');
  assert.equal(at('4000FT/FL250', 4000, 25000), 'Severe turbulence from 4 000 ft to FL250, until 23:28Z');
  assert.equal(at('SFC/FL100', 0, 10000), 'Severe turbulence from the surface to FL100, until 23:28Z');
  assert.equal(at('TOP ABV FL350', null, 35000), 'Severe turbulence with tops above FL350, until 23:28Z');
  assert.equal(at('TOP BLW FL300', null, 30000), 'Severe turbulence with tops below FL300, until 23:28Z');
  assert.equal(at('TOP FL450', null, 45000), 'Severe turbulence with tops at FL450, until 23:28Z');
  assert.equal(at('ABV 9000FT', 9000, null), 'Severe turbulence above 9 000 ft, until 23:28Z');
});

test('the Perth alternate card asks about the INTER that goes below the minima', () => {
  const card = find(fixture(), 'live.alternate.YPPH');
  assert.ok(card);
  assert.ok(card.stem.startsWith('You are planning Sydney to Perth, arriving 22:00Z (06:00 Perth time).'));
  assert.ok(card.stem.includes('INTER 0720/0800 3000 SHRA BKN010'));
  assert.ok(card.stem.includes('ceiling of 1 000 ft and visibility 5 000 m'));
  assert.equal(correctText(card), 'An alternate, or 30 min of holding fuel for the INTER deterioration');
  assert.ok(card.explanation.includes('Part 91 MOS 2020 s 8.02 (1) and 8.04 (6)'));
  assert.deepEqual(card.figure?.highlight, ['FM072000', 'INTER 0720/0800']);
});

test('the Sydney alternate card teaches that 5000 m is not below a 5 000 m minimum', () => {
  const card = find(fixture(), 'live.alternate.YSSY');
  assert.ok(card);
  assert.equal(card.planStep, 3);
  assert.ok(card.stem.includes('INTER 0707/0721 20016G26KT 5000 SHRA BKN013'));
  assert.equal(correctText(card), 'Nothing more, because the forecast at your ETA is at or above the alternate minima');
  assert.ok(card.explanation.includes('equal to the minimum is not below it'));
});

test('a TEMPO, a PROB and an uncovered ETA each produce their own alternate answer', () => {
  const tempo = fixture();
  tempo.airports[1].taf = view('TAF YSSY 062012Z 0621/0800 18026KT 9999 SCT035 TEMPO 0707/0710 3000 SHRA BKN008', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  assert.equal(correctText(find(tempo, 'live.alternate.YSSY')!), 'An alternate, or 60 min of holding fuel for the TEMPO deterioration');

  const prob = fixture();
  prob.airports[1].taf = view('TAF YSSY 062012Z 0621/0800 00000KT 9999 FEW030 PROB30 0718/0722 0500 FG', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  const probCard = find(prob, 'live.alternate.YSSY')!;
  assert.equal(correctText(probCard), 'An alternate, or fuel to hold until 30 min after the deterioration ends');
  assert.ok(probCard.explanation.includes('The 30 and 60 min holding cases apply only to INTER and TEMPO'));
  assert.equal(probCard.explanation.includes('deemed'), false);

  const late = fixture();
  late.now = '2026-10-07T23:30:00Z';
  late.airports[1].taf = view('TAF YSSY 062012Z 0621/0800 18026KT 9999 SCT035 BKN045 FM071400 20010KT 9999 SCT020', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  assert.equal(correctText(find(late, 'live.alternate.YSSY')!), 'An alternate, because the TAF does not cover 30 min before to 60 min after your ETA');
});

test('the alternate card names Part 91, keys an alternate when conditions never end, and says thunderstorm when only the storm counts', () => {
  const card = find(fixture(), 'live.alternate.YSSY')!;
  assert.ok(card.stem.endsWith('Under the Part 91 rules, what does this forecast require of you?'));

  // Prevailing conditions below the minima to the end of the TAF: holding cannot substitute.
  const endless = fixture();
  endless.airports[1].taf = view('TAF YSSY 062012Z 0621/0800 18026KT 9999 SCT035 FM071800 27010KT 2000 BR OVC005 TEMPO 0718/0722 0800 FG', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  const endlessCard = find(endless, 'live.alternate.YSSY')!;
  assert.equal(correctText(endlessCard), 'An alternate, because the deterioration is not forecast to end within the TAF');
  assert.ok(endlessCard.options.some((option) => option.text === 'An alternate, or fuel to hold until 30 min after the deterioration ends'));

  // A TEMPO thunderstorm with cloud and visibility above the minima.
  const storm = fixture();
  storm.airports[1].taf = view('TAF YSSY 062012Z 0621/0800 18026KT 9999 SCT035 TEMPO 0707/0710 9999 TSRA SCT040CB', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  const stormCard = find(storm, 'live.alternate.YSSY')!;
  assert.equal(correctText(stormCard), 'An alternate, or 60 min of holding fuel for the TEMPO deterioration');
  assert.ok(stormCard.explanation.includes('forecasts a thunderstorm'));
  assert.equal(stormCard.explanation.includes('is below a ceiling'), false);
});

test('on a TAF3 the alternate card disregards a PROB in the first 3 hours and drops the PROB distractor', () => {
  const taf3 = fixture();
  taf3.now = '2026-10-06T21:00:00Z';
  taf3.airports[1].taf = view('TAF YSSY 062040Z 0621/0800 00000KT 9999 FEW030 FM071200 18010KT 9999 SCT030 PROB30 0622/0623 0500 FG RMK T 14 15 Q 1016 1015 TAF3', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  const card = find(taf3, 'live.alternate.YSSY')!;
  assert.equal(correctText(card), 'Nothing more, because the forecast at your ETA is at or above the alternate minima');
  assert.ok(card.explanation.includes('PROB groups may be disregarded'));
  assert.ok(card.explanation.includes('8.02 (1) and (2)'));
  assert.equal(card.options.some((option) => option.text.includes('below the planning threshold')), false);
  assert.deepEqual(lintCard(card), []);
});

test('a missing or single-group TAF produces no alternate card', () => {
  const missing = fixture();
  missing.airports[1].taf = null;
  assert.equal(find(missing, 'live.alternate.YSSY'), undefined);
  const plain = fixture();
  plain.airports[1].taf = view('TAF YSSY 062012Z 0621/0800 18026KT CAVOK', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  assert.equal(find(plain, 'live.alternate.YSSY'), undefined);
});

test('the wind card converts the true METAR wind to magnetic before comparing runways', () => {
  // 200°T at Sydney (VAR 13°E) is 187°M: runway 16 gives 14 kt of headwind, runway 25 only 7 kt.
  const sydney = find(fixture(), 'live.wind');
  assert.ok(sydney);
  assert.ok(sydney.stem.includes('magnetic variation is 13°E'));
  assert.equal(correctText(sydney), 'Runway 16');
  assert.ok(sydney.explanation.includes('200°T with 13°E variation is 187°M'));
  // 122°T is 109°M. Read as true, runway 16 looks best (24 kt against 18 kt); in magnetic, runway 07 is (23 kt against 19 kt).
  const swing = fixture();
  swing.airports[1].metar = metar('METAR YSSY 062300Z 12230KT 9999 FEW040 15/08 Q1027');
  assert.equal(correctText(find(swing, 'live.wind')!), 'Runway 07');
  // Perth varies west: 019°T is 021°M, straight down runway 21's reciprocal, so runway 03 heads it.
  const perth = fixture();
  perth.airports[1].metar = metar('METAR YSSY 062300Z 21816KT 9999 FEW040 15/08 Q1027');
  perth.airports[0].metar = metar('METAR YPPH 062300Z 01920KT 9999 FEW013 15/13 Q1016');
  const perthCard = find(perth, 'live.wind')!;
  assert.ok(perthCard.stem.includes('magnetic variation is 2°W'));
  assert.equal(correctText(perthCard), 'Runway 03');
  assert.ok(perthCard.explanation.includes('019°T with 2°W variation is 021°M'));
});

test('the wind card picks the runway most into wind and is dropped when the choice is marginal', () => {
  // 218°T at Sydney is 205°M, 45° from both runway 16 and runway 25. Too close to ask.
  const marginal = fixture();
  marginal.airports[1].metar = metar('METAR YSSY 062300Z 21816KT 9999 FEW040 15/08 Q1027');
  assert.equal(find(marginal, 'live.wind'), undefined);
  const clear = fixture();
  clear.airports[1].metar = metar('METAR YSSY 062300Z 15020KT 9999 FEW040 15/08 Q1027');
  const card = find(clear, 'live.wind');
  assert.ok(card);
  assert.ok(card.stem.includes('wind 15020KT'));
  assert.equal(correctText(card), 'Runway 16');
  assert.deepEqual(card.figure?.highlight, ['15020KT']);
  const light = fixture();
  light.airports[1].metar = metar('METAR YSSY 062300Z 15005KT 9999 FEW040 15/08 Q1027');
  // Perth 19008KT is 192°M: runway 21 gives 7.6 kt and runway 24 5.4 kt, too close to ask.
  light.airports[0].metar = metar('METAR YPPH 062300Z VRB03KT 9999 FEW013 15/13 Q1016');
  assert.equal(find(light, 'live.wind'), undefined);
});

test('the ceiling card reads the lowest BKN or OVC layer, no ceiling for FEW and SCT, and CAVOK', () => {
  const card = find(fixture(), 'live.ceiling');
  assert.ok(card);
  assert.ok(card.stem.includes('FEW040 BKN060'));
  assert.equal(correctText(card), '6 000 ft, the lowest layer that is broken or overcast');
  assert.ok(card.options.some((option) => option.text === '4 000 ft, the lowest layer of any amount'));
  assert.ok(card.options.every((option) => option.id === card.correctId || !option.text.startsWith('6 000 ft')));

  const thin = fixture();
  thin.airports[1].metar = metar('METAR YSSY 062300Z 20016KT 9999 FEW020 SCT045 15/08 Q1027');
  assert.equal(correctText(find(thin, 'live.ceiling')!), 'No ceiling, because no layer covers more than half the sky');

  // A broken layer at or above 20 000 ft is not a ceiling.
  const high = fixture();
  high.airports[1].metar = metar('METAR YSSY 062300Z 20016KT 9999 FEW040 BKN250 15/08 Q1027');
  const highCard = find(high, 'live.ceiling')!;
  assert.equal(correctText(highCard), 'No ceiling, because no layer below 20 000 ft covers more than half the sky');
  assert.ok(highCard.options.some((option) => option.text === '25 000 ft, the lowest layer that is broken or overcast'));
  assert.deepEqual(lintCard(highCard), []);
  const under = fixture();
  under.airports[1].metar = metar('METAR YSSY 062300Z 20016KT 9999 BKN190 OVC250 15/08 Q1027');
  assert.equal(correctText(find(under, 'live.ceiling')!), '19 000 ft, the lowest layer that is broken or overcast');

  const cavok = fixture();
  cavok.airports[1].metar = metar('METAR YSSY 062300Z 20016KT CAVOK 15/08 Q1027');
  const cavokCard = find(cavok, 'live.ceiling')!;
  assert.ok(cavokCard.stem.includes('reports CAVOK'));
  assert.ok(correctText(cavokCard).startsWith('No cloud below 5 000 ft'));

  const none = fixture();
  none.airports[1].metar = null;
  none.airports[0].metar = null;
  assert.equal(find(none, 'live.ceiling'), undefined);
});

test('the gradient card asks why the surface wind is weaker than the geostrophic wind', () => {
  const card = find(fixture(), 'live.gradient');
  assert.ok(card);
  assert.ok(card.stem.includes('42.5°S 125.3°E'));
  assert.ok(card.stem.includes('48 kt'));
  assert.ok(card.stem.endsWith('Why is the surface wind so much weaker than the geostrophic wind?'));
  assert.ok(correctText(card).startsWith('Friction slows the air'));
  assert.equal(card.focus?.place, '42.5°S 125.3°E');
  const noWind = fixture();
  noWind.gradient = { ...noWind.gradient!, windKt: null };
  assert.ok(find(noWind, 'live.gradient')!.stem.endsWith('Why does that spacing imply the strongest wind on the chart?'));
  const bare = fixture();
  bare.gradient = null;
  assert.equal(find(bare, 'live.gradient'), undefined);
});

test('a land-mix spike is the gradient artefact card', () => {
  const card = find(fixture(), 'live.gradient.artefact');
  assert.ok(card);
  assert.ok(card.stem.includes('227 kt'));
  assert.ok(card.stem.includes('36.5°S 148.5°E'));
  assert.ok(correctText(card).startsWith('Station pressure over high terrain is reduced to sea level'));
  assert.equal(card.focus?.artefact, true);
  const clean = fixture();
  clean.artefact = null;
  assert.equal(find(clean, 'live.gradient.artefact'), undefined);
});

test('the CAPE card appears only with large CAPE and no thunderstorm in the TAF', () => {
  assert.equal(find(fixture(), 'live.cape'), undefined);
  const hot = fixture();
  hot.airports[1].sample = { ...hot.airports[1].sample!, mucapeJkg: 1240 };
  const card = find(hot, 'live.cape');
  assert.ok(card);
  assert.ok(card.stem.includes('1240 J/kg'));
  assert.ok(correctText(card).startsWith('CAPE is the energy a parcel would release'));
  assert.deepEqual(card.figure?.highlight, ['1240 J/kg']);
  const stormy = fixture();
  stormy.airports[1].sample = { ...stormy.airports[1].sample!, mucapeJkg: 1240 };
  stormy.airports[1].taf = view('TAF YSSY 062012Z 0621/0800 18026KT 9999 SCT035 TEMPO 0704/0708 9999 TSRA SCT040CB', '2026-10-06T21:00:00Z', '2026-10-08T00:00:00Z');
  assert.equal(find(stormy, 'live.cape'), undefined);
});

test('worked-plan live cards state the route and the ETA in UTC and local time', () => {
  for (const id of ['live.groups.YSSY', 'live.alternate.YSSY']) {
    const card = find(fixture(), id)!;
    assert.ok(/^You are planning Perth to Sydney, arriving \d{2}:\d{2}Z \(\d{2}:\d{2} Sydney time\)\./.test(card.stem), id);
  }
});

// ---- Progress and session ----

test('streak counts consecutive study days', () => {
  assert.equal(previousDay('2026-10-06'), '2026-10-05');
  const once = markStudyDay(emptyProgress(), '2026-10-05');
  assert.equal(once.streak.count, 1);
  const next = markStudyDay(once, '2026-10-06');
  assert.equal(next.streak.count, 2);
  const gap = markStudyDay(next, '2026-10-08');
  assert.equal(gap.streak.count, 1);
});

test('reveal waits, then a grade records the card and moves on', () => {
  const card = staticCards[0];
  let session = openSession([card.id], 'met', 1_000);
  session = reduce(session, { type: 'choose', optionId: card.correctId }, card).session;
  const revealed = reduce(session, { type: 'reveal', now: 2_000 }, card);
  assert.equal(revealed.session.phase, 'revealed');
  assert.equal(revealed.grade, null);
  assert.equal(revealed.session.index, 0);
  const graded = reduce(revealed.session, { type: 'grade', quality: 4, now: 3_000 }, card);
  assert.equal(graded.grade?.quality, 4);
  assert.equal(graded.grade?.responseTimeMs, 2_000);
  const progress = applyGrade(emptyProgress(), card.id, {
    quality: graded.grade!.quality,
    at: '2026-10-06T00:00:00.000Z',
    responseTimeMs: graded.grade!.responseTimeMs,
    complexity: card.complexity,
    day: '2026-10-06',
  });
  assert.equal(progress.cards[card.id].correctCount, 1);
  assert.equal(progress.streak.count, 1);
  assert.equal(graded.session.index, 1);
  assert.equal(graded.session.phase, 'ask');
});

// ---- Fixture: the 6 October 2026 23:20Z picture ----

function view(raw: string, from: string, to: string): TafView {
  const tokens = raw.split(/\s+(?=FM\d{6}\b|BECMG\b|TEMPO\b|INTER\b|PROB[34]0\b)/);
  return {
    raw,
    issue: from,
    from,
    to,
    header: 'TAF',
    headerUtc: `${from.slice(8, 10)} ${from.slice(11, 16)} → ${to.slice(8, 10)} ${to.slice(11, 16)} UTC`,
    lines: tokens.map((text, index) => ({ text, active: index === 0 })),
  };
}

function metar(raw: string) {
  return { raw, time: '2026-10-06T23:00:00Z', cloud: '', vis: '', wind: '', clock: '', age: '20 m', aged: false, tip: raw };
}

function fixture(): Snapshot {
  return {
    now: '2026-10-06T23:20:12Z',
    runTime: '2026-10-06T12:00:00Z',
    runError: null,
    gridSource: 'published',
    sampleTime: '2026-10-07T00:00:00Z',
    chartPng: null,
    gradient: { lat: -42.5, lon: 125.25, hpaPer100km: 3, geostrophicKt: 48, fromDeg: 311, windKt: 25, mapX: 0.3478, mapY: 0.8678 },
    artefact: { lat: -36.5, lon: 148.5, hpaPer100km: 12.4, geostrophicKt: 227, fromDeg: 26, windKt: 5, mapX: 0.6644, mapY: 0.763 },
    sigmets: [{
      fir: 'YBBB',
      hazard: 'TURB',
      qualifier: 'SEV',
      base: 12000,
      top: 26000,
      raw: 'WSAU21 YMMC 061853\nYBBB SIGMET L02 VALID 061928/062328 YMMC-\nYBBB BRISBANE FIR SEV TURB FCST WI S5000 E16300 - S5000 E15820 -\nS4030 E15010 - S3530 E15050 - S3410 E15820 - S4110 E16300 FL120/260\nMOV E 30KT NC=',
      from: '2026-10-06T19:28:00Z',
      to: '2026-10-06T23:28:00Z',
    }],
    notamCount: 0,
    points: [],
    airports: [
      {
        icao: 'YPPH',
        name: 'Perth',
        zone: 'Australia/Perth',
        lat: -31.94,
        lon: 115.97,
        metar: metar('METAR YPPH 062300Z 19008KT 9999 FEW013 15/13 Q1016'),
        taf: view(
          'TAF YPPH 062009Z 0621/0800 20007KT 9999 SCT008 FM062300 20012KT CAVOK FM070400 24014KT CAVOK FM070900 27012KT 9999 -SHRA BKN025 FM072000 24012KT 9999 -SHRA SCT012 BKN020 TEMPO 0621/0623 9999 BKN008 INTER 0717/0720 5000 SHRA SCT012 INTER 0720/0800 3000 SHRA BKN010',
          '2026-10-06T21:00:00Z',
          '2026-10-08T00:00:00Z',
        ),
        sample: { mslpHpa: 1017.4, windFromDeg: 200, windKt: 8, t2mC: 16.1, cloudCoverPct: 89, mucapeJkg: 0 },
      },
      {
        icao: 'YSSY',
        name: 'Sydney',
        zone: 'Australia/Sydney',
        lat: -33.95,
        lon: 151.18,
        metar: metar('METAR YSSY 062300Z 20016KT 9999 FEW040 BKN060 15/08 Q1027'),
        taf: view(
          'TAF YSSY 062012Z 0621/0800 18026KT 9999 SCT035 BKN045 FM070700 19018KT 9999 -SHRA SCT025 BKN035 FM071400 20010KT 9999 -SHRA SCT020 BKN030 INTER 0707/0721 20016G26KT 5000 SHRA BKN013',
          '2026-10-06T21:00:00Z',
          '2026-10-08T00:00:00Z',
        ),
        sample: { mslpHpa: 1027, windFromDeg: 189, windKt: 19, t2mC: 15.7, cloudCoverPct: 22, mucapeJkg: 3 },
      },
    ],
  };
}
