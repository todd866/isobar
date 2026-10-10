import { describe, expect, it } from 'vitest';
import { priorPerson } from '../../../training/src/ability';
import { AERODROMES } from '../../src/lib/od/aerodromes';
import { DECREES } from '../../src/lib/od/decrees';
import { draftDossier } from '../../src/lib/od/generator';
import type { WeatherReport } from '../../src/lib/od/model';
import { ACCIDENTS, epilogueLine, rebelCallback, rebelOutcome } from '../../src/lib/od/story/lines';
import { act, caseFromDossier, openShift, sceneView, type Sitting } from '../../src/lib/od/story/play';
import { inspectorSlots, scheduleShift } from '../../src/lib/od/story/schedule';
import { storyShift, STORY_SHIFTS } from '../../src/lib/od/story/shifts';
import { quotaLedger, shiftMeters } from '../../src/lib/od/story/summary';
import type { StoryCase } from '../../src/lib/od/story/types';

const T0 = Date.parse('2026-10-09T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const weather = (station: 'YPPH' | 'YSSY'): WeatherReport => ({
  station, source: '/data/aviation.json', capturedAt: iso(T0),
  metar: { raw: `METAR ${station} 090000Z 24010KT CAVOK 18/10 Q1013`, time: iso(T0) },
  taf: { raw: `TAF ${station} 090000Z 0900/1000 24010KT CAVOK`, issue: iso(T0), from: iso(T0), to: iso(T0 + 24 * 3600_000) },
  profile: null,
});

function cases(shift: number, failing: number[] = [], weatherBad: number[] = failing): StoryCase[] {
  const script = storyShift(shift);
  return Array.from({ length: script.dossierCount }, (_, index) => ({
    id: `s${shift}-${index}`,
    decreeId: script.decreeId,
    strand: 'charts',
    difficulty: 0,
    failing: failing.includes(index),
    weatherBad: weatherBad.includes(index),
    route: 'KES–ORL',
    clock: '1840Z',
    fact: `Sheet ${index}`,
  }));
}

function atCaptain(shift: number, failing: number[], weatherBad = failing): Sitting {
  let sitting = openShift({ shift, cases: cases(shift, failing, weatherBad), seed: 1, strandBefore: { charts: 0 }, strandAfter: { charts: 0.4 } });
  const captain = storyShift(shift).beats.find(b => b.role === 'captain')!.at;
  let guard = 0;
  while (sitting.index < captain && guard++ < 40) {
    const view = sceneView(sitting);
    if (sitting.phase === 'choice') {
      const id = view.choices[0]!.id;
      sitting = id === 'listen' || id === 'dismiss'
        ? act(sitting, { type: 'listen' })
        : act(sitting, { type: 'rebel', choice: 'refuse' });
    } else if (sitting.phase === 'stamp') sitting = act(sitting, { type: 'stamp', stamp: 'RELEASE' });
    else sitting = act(sitting, { type: 'continue' });
  }
  return sitting;
}

describe('story shifts', () => {
  it('scripts twelve shifts inside the Code, with five to nine dossiers', () => {
    expect(STORY_SHIFTS).toHaveLength(12);
    const accidents = STORY_SHIFTS.map(s => s.accidentAfter).filter(Boolean);
    expect(accidents).toEqual(['authority-gradient', 'plan-continuation', 'get-there-itis']);
    for (const script of STORY_SHIFTS) {
      expect(script.decreeId).toBe(DECREES[script.number - 1]!.id);
      expect(script.dossierCount).toBeGreaterThanOrEqual(5);
      expect(script.dossierCount).toBeLessThanOrEqual(9);
      const indexes = script.beats.map(b => b.at);
      expect(new Set(indexes).size).toBe(indexes.length);
      const fo = script.beats.find(b => b.role === 'first-officer')!;
      const captain = script.beats.find(b => b.role === 'captain')!;
      const aftermath = script.beats.find(b => b.role === 'aftermath')!;
      expect(fo.at).toBeLessThan(captain.at);
      expect(captain.at).toBeLessThan(aftermath.at);
      expect(aftermath.at).toBeLessThan(script.dossierCount);
    }
    expect(STORY_SHIFTS[11]!.epilogue).toBe(true);
  });

  it('lets the scheduler choose later dossiers from the shift rule set', () => {
    const fresh = priorPerson({ level: 'airline', goal: 'flying', rules: 'aus', now: 1 });
    fresh.sessionLengths = [8];
    fresh.strands.charts.theta = 2;
    const first = scheduleShift(fresh, 1, 7);
    expect(first).toHaveLength(5);
    expect(first.every(slot => slot.decreeId === 'forecast-coverage')).toBe(true);
    expect(first[0]!.difficulty).toBeCloseTo(1.55);
    expect(scheduleShift(fresh, 1, 7)).toEqual(first);

    const weak = priorPerson({ level: 'airline', goal: 'flying', rules: 'aus', now: 1 });
    weak.sessionLengths = [8];
    for (const id of ['met.taf-groups', 'law.alternate', 'fpl.wind-component']) weak.concepts[id] = { exposure: 10, correct: 10 };
    const icing = scheduleShift(weak, 5, 3);
    expect(icing[0]!.decreeId).toBe('icing');
    expect(icing.slice(1).every(slot => slot.decreeId === 'icing')).toBe(true);
    expect(icing.every(slot => DECREES.slice(0, 5).some(d => d.id === slot.decreeId))).toBe(true);

    const active = ['forecast-coverage', 'destination-alternate', 'forecast-groups', 'crosswind'];
    const spread = [1, 2, 3, 4, 5].map(seed => scheduleShift(fresh, 4, seed).map(slot => slot.decreeId));
    expect(spread.every(row => row[0] === 'crosswind' && row.every(id => active.includes(id)))).toBe(true);
    expect(spread.some(row => new Set(row).size > 1)).toBe(true);
  });
});

describe('scene triggers', () => {
  it('files a diversion after a bad-weather release and keeps the dossier', () => {
    const queue = cases(1, [1, 2]);
    const frozen = JSON.stringify(queue);
    let sitting = openShift({ shift: 1, cases: queue, seed: 4, strandBefore: { charts: 0 }, strandAfter: { charts: 0.5 } });
    expect(sceneView(sitting).role).toBe('desk');
    sitting = act(sitting, { type: 'stamp', stamp: 'RELEASE' });
    sitting = act(sitting, { type: 'continue' });
    expect(sceneView(sitting).role).toBe('first-officer');
    sitting = act(sitting, { type: 'listen' });
    expect(sceneView(sitting).lines.map(line => line.text)).toContain('The TAF ends before the ETA.');
    sitting = act(sitting, { type: 'stamp', stamp: 'REFUSE' });
    sitting = act(sitting, { type: 'continue' });
    const captain = sceneView(sitting);
    expect(captain.role).toBe('captain');
    expect(captain.lines[0]!.text).toBe('Sign it before the minute turns.');
    expect(captain.lines[1]).toMatchObject({ symbol: 'O', text: 'The TAF ends before the ETA.' });
    sitting = act(sitting, { type: 'stamp', stamp: 'RELEASE' });
    expect(sitting.pendingReport).toEqual({ kind: 'diversion', listened: true });
    expect(sitting.phase).toBe('result');
    sitting = act(sitting, { type: 'continue' });
    sitting = act(sitting, { type: 'stamp', stamp: 'RELEASE' });
    sitting = act(sitting, { type: 'continue' });
    const report = sceneView(sitting);
    expect(report.role).toBe('report');
    expect(report.lines[0]!.text).toContain('Diversion report');
    expect(report.lines[1]).toMatchObject({ symbol: 'O', text: 'The first officer had the TAF open.' });
    expect(queue.map(item => item.fact)).toEqual(['Sheet 0', 'Sheet 1', 'Sheet 2', 'Sheet 3', 'Sheet 4']);
    expect(JSON.stringify(queue)).toBe(frozen);
  });

  it('writes a hard-landing report for a wind release and stays quiet when the weather was fine', () => {
    let hard = atCaptain(4, [2]);
    expect(sceneView(hard).role).toBe('captain');
    hard = act(hard, { type: 'stamp', stamp: 'RELEASE' });
    expect(hard.pendingReport?.kind).toBe('hard-landing');

    let clean = atCaptain(1, []);
    clean = act(clean, { type: 'stamp', stamp: 'RELEASE' });
    expect(clean.pendingReport).toBeNull();
    expect(clean.outcomes.at(-1)?.heldBad).toBe(false);
  });

  it('charges quota when the line is held in bad weather', () => {
    let held = atCaptain(1, [2]);
    held = act(held, { type: 'stamp', stamp: 'REFUSE' });
    expect(held.pendingReport).toBeNull();
    expect(held.outcomes.at(-1)).toMatchObject({ correct: true, onTime: false, heldBad: true });

    let caved = atCaptain(1, [2]);
    caved = act(caved, { type: 'stamp', stamp: 'RELEASE' });
    expect(caved.pendingReport?.kind).toBe('diversion');
    expect(caved.outcomes.at(-1)?.heldBad).toBe(false);
    expect(quotaLedger(held.outcomes, 2).score).toBe(quotaLedger(caved.outcomes, 2).score - 1);
  });

  it('ignores a dismissed first officer and keeps the decree', () => {
    let sitting = openShift({ shift: 1, cases: cases(1, [1, 2]), seed: 1, strandBefore: {}, strandAfter: {} });
    sitting = act(sitting, { type: 'stamp', stamp: 'RELEASE' });
    sitting = act(sitting, { type: 'continue' });
    sitting = act(sitting, { type: 'dismiss' });
    expect(sceneView(sitting).lines.map(line => line.text)).not.toContain('The TAF ends before the ETA.');
    sitting = act(sitting, { type: 'stamp', stamp: 'REFUSE' });
    sitting = act(sitting, { type: 'continue' });
    expect(sceneView(sitting).lines.map(line => line.text)).toEqual(['Sign it before the minute turns.']);
    expect(sitting.cases[1]!.decreeId).toBe('forecast-coverage');
  });

  it('cites a mistaken stamp only on the inspector’s audit', () => {
    const slots = inspectorSlots(1, 5, 9);
    expect(slots).toHaveLength(1);
    expect(inspectorSlots(1, 5, 9)).toEqual(slots);
    expect(inspectorSlots(6, 7, 9)).toHaveLength(2);
    expect(slots[0]).toBeGreaterThanOrEqual(0);
    let differed = false;
    for (let seed = 1; seed < 12; seed += 1) if (inspectorSlots(1, 5, seed)[0] !== slots[0]) differed = true;
    expect(differed).toBe(true);

    let sitting = openShift({ shift: 1, cases: cases(1, [slots[0]!]), seed: 9, strandBefore: {}, strandAfter: {} });
    while (sitting.index < slots[0]! || sitting.phase === 'choice') {
      if (sitting.phase === 'choice') sitting = act(sitting, { type: 'dismiss' });
      else if (sitting.phase === 'stamp') sitting = act(sitting, { type: 'stamp', stamp: 'RELEASE' });
      else sitting = act(sitting, { type: 'continue' });
    }
    sitting = act(sitting, { type: 'stamp', stamp: 'RELEASE' });
    expect(sceneView(sitting).role).toBe('inspector');
    expect(sceneView(sitting).lines[0]!.text).toContain('Citation. §1');

    let clean = openShift({ shift: 1, cases: cases(1), seed: 9, strandBefore: {}, strandAfter: {} });
    while (clean.index < slots[0]! || clean.phase === 'choice') {
      if (clean.phase === 'choice') clean = act(clean, { type: 'dismiss' });
      else if (clean.phase === 'stamp') clean = act(clean, { type: 'stamp', stamp: 'RELEASE' });
      else clean = act(clean, { type: 'continue' });
    }
    clean = act(clean, { type: 'stamp', stamp: 'RELEASE' });
    expect(sceneView(clean).lines[0]!.text).toBe('Stamp in order.');
  });
});

describe('rebel subplot', () => {
  it('changes the note, the callback and the epilogue without touching the case', () => {
    const queue = cases(2);
    const before = JSON.stringify(queue);
    let sitting = openShift({ shift: 2, cases: queue, seed: 2, strandBefore: {}, strandAfter: {} });
    sitting = act(sitting, { type: 'dismiss' });
    sitting = act(sitting, { type: 'stamp', stamp: 'RELEASE' });
    sitting = act(sitting, { type: 'continue' });
    expect(sceneView(sitting).lines[0]!.text).toContain('count is one short');
    for (const choice of ['help', 'refuse', 'report'] as const) {
      const next = act(sitting, { type: 'rebel', choice });
      expect(sceneView(next).lines[0]!.text).toBe(rebelOutcome('manifest-note', choice));
      expect(next.cases).toBe(queue);
    }
    sitting = act(sitting, { type: 'rebel', choice: 'report' });
    expect(JSON.stringify(queue)).toBe(before);
    const callback = openShift({ shift: 3, cases: cases(3), seed: 2, rebel: sitting.rebel, strandBefore: {}, strandAfter: {} });
    expect(sceneView(callback).lines[0]!.text).toBe(rebelCallback('manifest-note', 'report'));
    expect(epilogueLine(sitting.rebel)).toBe('The manifest is in the Ministry file.');
    const both = epilogueLine([...sitting.rebel, { hook: 'border-diversion', choice: 'help', shift: 5 }]);
    expect(both).not.toBe(epilogueLine([{ hook: 'border-diversion', choice: 'report', shift: 5 }]));
    expect(scheduleShift(priorPerson({ level: 'curious', goal: 'weather', rules: 'aus', now: 1 }), 2, 2).map(slot => slot.decreeId))
      .toEqual(scheduleShift(priorPerson({ level: 'curious', goal: 'weather', rules: 'aus', now: 1 }), 2, 2).map(slot => slot.decreeId));
  });
});

describe('accident reports and the shift ledger', () => {
  it('ends three fictional circulars with a sourced lesson', () => {
    expect(ACCIDENTS).toHaveLength(3);
    for (const paper of ACCIDENTS) {
      expect(paper.lines.join(' ')).not.toMatch(/NTSB|Korean|American|Florida|Guam|Little Rock/);
      expect(paper.lesson).not.toMatch(/\n/);
      expect(paper.source).toMatch(/^NTSB AAR-/);
    }
    let sitting = openShift({ shift: 4, cases: cases(4), seed: 1, strandBefore: { charts: 0 }, strandAfter: { charts: 0 } });
    let guard = 0;
    while (sitting.phase !== 'summary' && guard++ < 80) {
      if (sitting.phase === 'choice') sitting = act(sitting, { type: 'dismiss' });
      else if (sitting.phase === 'stamp') sitting = act(sitting, { type: 'stamp', stamp: 'RELEASE' });
      else sitting = act(sitting, { type: 'continue' });
    }
    sitting = act(sitting, { type: 'continue' });
    const view = sceneView(sitting);
    expect(view.role).toBe('accident');
    expect(view.lines.map(line => line.text)).toContain(ACCIDENTS[0]!.lesson);
    expect(view.lines.at(-1)!.text).toBe(ACCIDENTS[0]!.source);
  });

  it('reads the shift as five instruments', () => {
    let sitting = act(atCaptain(1, [2]), { type: 'stamp', stamp: 'REFUSE' });
    let guard = 0;
    while (sitting.phase !== 'summary' && guard++ < 40) {
      if (sitting.phase === 'choice') sitting = act(sitting, { type: 'dismiss' });
      else if (sitting.phase === 'stamp') sitting = act(sitting, { type: 'stamp', stamp: sitting.cases[sitting.index]!.failing ? 'REFUSE' : 'RELEASE' });
      else sitting = act(sitting, { type: 'continue' });
    }
    const meters = shiftMeters(sitting);
    expect(meters.map(m => m.id)).toEqual(['dossiers', 'correct', 'citations', 'quota', 'strands']);
    expect(meters[0]).toMatchObject({ value: '5', datum: 'filed' });
    expect(meters[3]!.datum).toContain('held 1');
    expect(meters[3]!.datum).toContain('of 2 on time');
    expect(meters[3]!.value).toBe(String(quotaLedger(sitting.outcomes, 2).score));
    expect(meters[4]).toMatchObject({ value: '1', datum: 'charts up' });
  });

  it('reads a real dossier without rewriting its forecast', () => {
    const dossier = draftDossier({
      edition: 'aus', aircraft: 'a727', departure: AERODROMES[0]!, destination: AERODROMES[1]!,
      departureWeather: weather('YPPH'), destinationWeather: weather('YSSY'),
      arrivalUtc: iso(T0 + 6 * 3600_000), difficulty: 0, seed: 4, decreeId: 'forecast-coverage', shift: 1,
    });
    const raw = dossier.destinationWeather.taf!.raw;
    const sound = caseFromDossier(dossier);
    expect(sound.failing).toBe(false);
    expect(sound.weatherBad).toBe(false);
    dossier.destinationWeather.taf!.to = iso(T0 + 60 * 60_000);
    const bad = caseFromDossier(dossier);
    expect(bad.failing).toBe(true);
    expect(bad.weatherBad).toBe(true);
    expect(bad.decreeId).toBe('forecast-coverage');
    expect(dossier.destinationWeather.taf!.raw).toBe(raw);
  });
});
