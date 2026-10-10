import { priorPerson, type Person } from '../../../../training/src/ability.ts';
import { LEARN_KEY, readLearn, type DeskReceipt, type LearnRecord } from '../../../../training/src/learn-profile.ts';
import type { LearnRules } from '../../../../training/src/levels.ts';
import { announce } from '../account/local.ts';
import { trackUsage } from '../usage/browser.ts';
import { applyEvidence } from './learn.ts';
import type { Decision, Dossier } from './model.ts';
import type { Judgement } from './judge.ts';

const TRAINING_KEY = 'isobar.training.v1';
const MAX_RECEIPTS = 256;

function defaultRecord(now = Date.now()): LearnRecord {
  return {
    version: 1, started: true, icon: 'weather', text: '', goal: 'weather', level: 'curious', rules: 'aus',
    person: priorPerson({ level: 'curious', goal: 'weather', rules: 'aus', now }),
    updatedAt: new Date(now).toISOString(),
  };
}

function json(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; }
}

function raw(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storagePresent(): boolean {
  try { return typeof localStorage !== 'undefined' && !!localStorage; } catch { return false; }
}

function newer(a: LearnRecord | null, b: LearnRecord | null): LearnRecord | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.updatedAt) > Date.parse(a.updatedAt) ? b : a;
}

function localRecord(): LearnRecord | null {
  try { return readLearn(json(LEARN_KEY)); } catch { return null; }
}

function trainingRecord(): LearnRecord | null {
  const file = json(TRAINING_KEY);
  if (!file || typeof file !== 'object' || Array.isArray(file)) return null;
  try { return readLearn((file as Record<string, unknown>).learn); } catch { return null; }
}

/** Latest valid profile from either the device mirror or the synced training document. */
export function readDeskLearn(): LearnRecord {
  const value = newer(localRecord(), trainingRecord()) ?? defaultRecord();
  const picked = value.person?.rules ?? value.rules;
  const rules: LearnRules = picked === 'us' || picked === 'easa' || picked === 'ca' || picked === 'aus' ? picked : 'aus';
  const person = value.person
    ? { ...value.person, rules }
    : priorPerson({ level: value.level, goal: value.goal, rules, now: Date.parse(value.updatedAt) || Date.now() });
  return { ...value, rules, person, classic: value.classic === true ? false : value.classic };
}

function writeVerified(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return localStorage.getItem(key) === JSON.stringify(value);
  } catch { return false; }
}

function receiptFor(dossier: Dossier, decision: Decision, judgement: Judgement, at: string): DeskReceipt {
  return {
    dossierId: dossier.id,
    decreeIds: [...new Set(judgement.evidence.map((e) => e.decreeId).concat(judgement.rules))].slice(0, 32),
    edition: dossier.edition,
    stamp: decision.stamp,
    correct: judgement.correct,
    at,
    evidence: judgement.evidence.slice(0, 32).map((e) => ({ ...e })),
  };
}

function usagePayload(receipt: DeskReceipt): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    dossierId: receipt.dossierId, edition: receipt.edition, stamp: receipt.stamp,
    correct: receipt.correct, decreeIds: [...receipt.decreeIds], evidence: receipt.evidence.map((e) => ({ ...e })),
  };
  // Keep the browser event within the server's 2,000-byte payload bound.
  while (JSON.stringify(payload).length > 1_950 && Array.isArray(payload.evidence) && payload.evidence.length) payload.evidence.pop();
  return payload;
}

/** Persist one desk judgement to both Learn mirrors, retaining all training cards. */
export function recordDeskDecision(dossier: Dossier, decision: Decision, judgement: Judgement, now: number): { saved: boolean; duplicate: boolean } {
  if (!Number.isFinite(now)) throw new RangeError('Invalid decision time');
  const current = readDeskLearn();
  const receipts = current.desk?.receipts ?? [];
  const seen = current.desk?.seen ?? receipts.map((receipt) => receipt.dossierId);
  if (seen.includes(dossier.id)) return { saved: false, duplicate: true };
  const person: Person = current.person ?? defaultRecord(now).person!;
  const nextPerson = applyEvidence(person, judgement.evidence, now);
  const at = new Date(now).toISOString();
  const receipt = receiptFor(dossier, decision, judgement, at);
  const next: LearnRecord = {
    ...current, person: nextPerson,
    rules: nextPerson.rules,
    level: current.level,
    updatedAt: at,
    desk: { receipts: [...receipts, receipt].slice(-MAX_RECEIPTS), seen: [...seen, dossier.id].slice(-4096) },
  };
  const oldLocal = raw(LEARN_KEY);
  const oldTraining = raw(TRAINING_KEY);
  if (!storagePresent()) {
    if (typeof window !== 'undefined') trackUsage('od-decision', usagePayload(receipt));
    return { saved: false, duplicate: false };
  }
  let training: Record<string, unknown>;
  const rawTraining = json(TRAINING_KEY);
  training = rawTraining && typeof rawTraining === 'object' && !Array.isArray(rawTraining) ? { ...(rawTraining as Record<string, unknown>) } : { version: 1, cards: {}, streak: { count: 0, lastDay: null } };
  training.learn = next;
  const localOk = writeVerified(LEARN_KEY, next);
  const trainingOk = localOk && writeVerified(TRAINING_KEY, training);
  if (!localOk || !trainingOk) {
    try {
      if (oldLocal == null) localStorage.removeItem(LEARN_KEY); else localStorage.setItem(LEARN_KEY, oldLocal);
      if (oldTraining == null) localStorage.removeItem(TRAINING_KEY); else localStorage.setItem(TRAINING_KEY, oldTraining);
    } catch { /* report the failed write below */ }
    if (typeof window !== 'undefined') trackUsage('od-decision', usagePayload(receipt));
    return { saved: false, duplicate: false };
  }
  announce('training');
  if (typeof window !== 'undefined') trackUsage('od-decision', usagePayload(receipt));
  return { saved: true, duplicate: false };
}
