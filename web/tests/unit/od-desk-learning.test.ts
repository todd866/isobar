import { describe, expect, it, beforeEach } from 'vitest';
import { readDeskLearn, recordDeskDecision } from '../../src/lib/od/desk-learning';
import { checkDoc } from '../../src/lib/account/validate';
import type { Dossier } from '../../src/lib/od/model';
import type { Judgement } from '../../src/lib/od/judge';
import { emptyMemory } from '../../../training/src/scheduler';
import { generateDossier } from '../../src/lib/od/generator';
import { judge } from '../../src/lib/od/judge';
import { AERODROMES } from '../../src/lib/od/aerodromes';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const storage = new MemoryStorage();
const dossier = (id: string): Dossier => ({ id, edition: 'aus', shift: 1, question: '', target: { decreeIds: ['forecast-coverage'], strand: 'charts', difficulty: 0 }, aircraft: 'a727', operation: 'airline', departure: {} as Dossier['departure'], destination: {} as Dossier['destination'], departureWeather: {} as Dossier['departureWeather'], destinationWeather: {} as Dossier['destinationWeather'], alternatives: [], plan: {} as Dossier['plan'], documents: {} as Dossier['documents'], pressure: { kind: 'none', line: '', rebelHook: null } });
const judgement = (correct = true): Judgement => ({ assessable: true, correct, rules: ['forecast-coverage'], citations: [], before: [], after: [], amendedDossier: null, error: null, evidence: [{ conceptId: 'weather.forecast-coverage', strand: 'charts', difficulty: 0, correct, responseMs: 500, rules: 'aus', dossierId: 'shift-1', decreeId: 'forecast-coverage' }] });
const generatedWeather = { station: 'YPPH', source: '/data/aviation.json' as const, capturedAt: '2026-10-09T00:00:00Z',
  metar: { raw: 'METAR YPPH 090000Z 24010KT 9999 SCT030 18/10 Q1013', time: '2026-10-09T00:00:00Z' },
  taf: { raw: 'TAF YPPH 090000Z 0900/1000 24010KT 9999 SCT030', issue: '2026-10-09T00:00:00Z', from: '2026-10-09T00:00:00Z', to: '2026-10-10T00:00:00Z' }, profile: null };

describe('desk learning persistence', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = storage;
    storage.removeItem('isobar.learn.v1'); storage.removeItem('isobar.training.v1');
  });

  it('starts with a curious AUS desk and deduplicates a dossier', () => {
    const generatedId = `od-aus-${'1234567890'.repeat(9)}-forecast-coverage`;
    const first = recordDeskDecision(dossier(generatedId), { stamp: 'RELEASE' }, judgement(), Date.parse('2026-10-09T00:00:00Z'));
    expect(first).toEqual({ saved: true, duplicate: false });
    expect(recordDeskDecision(dossier(generatedId), { stamp: 'RELEASE' }, judgement(), Date.now())).toEqual({ saved: false, duplicate: true });
    expect(readDeskLearn().desk?.receipts).toHaveLength(1);
    expect(readDeskLearn().person?.strands.charts.answers).toBe(1);
    expect(checkDoc('training', JSON.parse(storage.getItem('isobar.training.v1')!)).ok).toBe(true);
  });

  it('preserves existing cards and validates the mirrored training document', () => {
    storage.setItem('isobar.training.v1', JSON.stringify({ version: 1, cards: { keep: emptyMemory('2026-10-09T00:00:00Z') }, streak: { count: 0, lastDay: null } }));
    recordDeskDecision(dossier('shift-2'), { stamp: 'REFUSE' }, judgement(false), Date.parse('2026-10-09T00:00:00Z'));
    const training = JSON.parse(storage.getItem('isobar.training.v1')!);
    expect(training.cards.keep).toBeDefined();
    expect(training.learn.desk.receipts[0].correct).toBe(false);
    expect(checkDoc('training', training).ok).toBe(true);
  });

  it('normalizes a legacy null-rules profile to AUS and preserves an explicit US profile', () => {
    storage.setItem('isobar.learn.v1', JSON.stringify({ version: 1, started: true, icon: 'flying', text: '', goal: 'flying', level: 'student', rules: null, updatedAt: '2026-10-09T00:00:00Z' }));
    expect(readDeskLearn().rules).toBe('aus');
    expect(readDeskLearn().person?.goal).toBe('flying');
    storage.setItem('isobar.learn.v1', JSON.stringify({ version: 1, started: true, icon: 'flying', text: '', goal: 'flying', level: 'student', rules: 'us', updatedAt: '2026-10-09T00:00:01Z' }));
    expect(readDeskLearn().rules).toBe('us');
    expect(readDeskLearn().person?.rules).toBe('us');
  });

  it('keeps receipts from a classic profile and reports denied storage honestly', () => {
    const classic = { version: 1, classic: true, updatedAt: '2026-10-09T00:00:00Z', desk: { receipts: [{ dossierId: 'old', decreeIds: [], edition: 'aus', stamp: 'REFUSE', correct: true, at: '2026-10-09T00:00:00Z', evidence: [] }] } };
    storage.setItem('isobar.learn.v1', JSON.stringify(classic));
    expect(readDeskLearn().desk?.receipts[0]?.dossierId).toBe('old');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied'); } });
    try { expect(recordDeskDecision(dossier('denied'), { stamp: 'RELEASE' }, judgement(), Date.now())).toEqual({ saved: false, duplicate: false }); }
    finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); }
  });

  it('does not create phantom evidence when a mirror write fails', () => {
    const denied = { getItem: () => null, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
    (globalThis as unknown as { localStorage: unknown }).localStorage = denied;
    expect(recordDeskDecision(dossier('failed'), { stamp: 'RELEASE' }, judgement(), Date.now())).toEqual({ saved: false, duplicate: false });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
    expect(readDeskLearn().desk?.receipts ?? []).toHaveLength(0);
  });

  it('round-trips a real generated dossier judgement with its generated ID', () => {
    const generated = generateDossier({ seed: 9, edition: 'aus', difficulty: 0, strand: 'charts', decreeId: 'forecast-coverage', polarity: 'pass', reports: AERODROMES.map(a => ({ ...generatedWeather, station: a.station, metar: { ...generatedWeather.metar, raw: generatedWeather.metar.raw.replace('YPPH', a.station) }, taf: { ...generatedWeather.taf, raw: generatedWeather.taf.raw.replace('YPPH', a.station) } })) });
    expect(generated.kind).toBe('ready');
    if (generated.kind !== 'ready') return;
    const result = judge(generated.dossier, generated.intent.decision, { edition: 'aus', responseMs: 900 });
    expect(recordDeskDecision(generated.dossier, generated.intent.decision, result, Date.now()).saved).toBe(true);
    expect(checkDoc('training', JSON.parse(storage.getItem('isobar.training.v1')!)).ok).toBe(true);
  });
});
