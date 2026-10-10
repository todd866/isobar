/** One learn profile per device, and the same object on the training document. */

import type { Person } from './ability.ts';
import { isLearnGoal, isLearnLevel, isLearnRules, type LearnGoal, type LearnLevel, type LearnRules, type Strand } from './levels.ts';

export const LEARN_KEY = 'isobar.learn.v1';

export interface DeskEvidence {
  conceptId: string;
  strand: Strand;
  difficulty: number;
  correct: boolean;
  responseMs: number;
  rules: LearnRules;
  dossierId: string;
  decreeId: string;
}

/** A compact, append-only receipt from the Operational Decision desk. */
export interface DeskReceipt {
  dossierId: string;
  decreeIds: string[];
  edition: LearnRules;
  stamp: 'RELEASE' | 'REFUSE' | 'AMEND';
  correct: boolean;
  at: string;
  evidence: DeskEvidence[];
}

export interface LearnRecord {
  version: 1;
  started: boolean;
  /** The existing ATPL trainer, with no picker and no level queue. */
  classic?: boolean;
  icon: LearnGoal;
  text: string;
  goal: LearnGoal;
  level: LearnLevel;
  rules: LearnRules | null;
  strands?: Partial<Record<Strand, 'low' | 'typical' | 'high'>>;
  exam?: { name: string; date?: string };
  person?: Person;
  /** Desk receipts are separate from card memory and survive account sync. */
  desk?: { receipts: DeskReceipt[]; seen?: string[] };
  updatedAt: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function receiptsOf(row: Record<string, unknown>): DeskReceipt[] | undefined {
  const desk = record(row.desk);
  const receipts = desk && Array.isArray(desk.receipts) ? desk.receipts.filter((item): item is DeskReceipt => {
    const receipt = record(item);
    return !!receipt && typeof receipt.dossierId === 'string' && Array.isArray(receipt.decreeIds)
      && receipt.decreeIds.every((id) => typeof id === 'string')
      && isLearnRules(String(receipt.edition))
      && (receipt.stamp === 'RELEASE' || receipt.stamp === 'REFUSE' || receipt.stamp === 'AMEND')
      && typeof receipt.correct === 'boolean' && typeof receipt.at === 'string' && Array.isArray(receipt.evidence);
  }) : undefined;
  return receipts;
}

function seenOf(row: Record<string, unknown>): string[] | undefined {
  const value = record(row.desk)?.seen;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 4096) : undefined;
}

export function readLearn(value: unknown): LearnRecord | null {
  const row = record(value);
  if (!row || row.version !== 1) return null;
  if (row.classic === true) {
    return {
      version: 1, started: true, classic: true, icon: 'flying', text: '', goal: 'flying',
      level: 'airline', rules: 'aus', desk: receiptsOf(row) ? { receipts: receiptsOf(row)!, seen: seenOf(row) } : undefined,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    };
  }
  if (row.started !== true) return null;
  if (typeof row.icon !== 'string' || !isLearnGoal(row.icon)) return null;
  if (typeof row.goal !== 'string' || !isLearnGoal(row.goal)) return null;
  if (typeof row.level !== 'string' || !isLearnLevel(row.level)) return null;
  const rules = typeof row.rules === 'string' && isLearnRules(row.rules) ? row.rules : null;
  const person = record(row.person);
  const strands = person ? record(person.strands) : null;
  const core = ['physics', 'charts', 'rules-aus', 'rules-us', 'operations', 'numbers'] as const;
  if (person && (!strands || !core.every((strand) => typeof record(strands[strand])?.theta === 'number'))) return null;
  if (strands) {
    const known = core.map((strand) => record(strands[strand])?.theta).filter((theta): theta is number => typeof theta === 'number').sort((a, b) => a - b);
    const theta = known[Math.floor(known.length / 2)] ?? 0;
    const updatedAt = typeof person?.updatedAt === 'number' ? person.updatedAt : 0;
    for (const strand of ['rules-easa', 'rules-ca'] as const) {
      if (typeof record(strands[strand])?.theta !== 'number') strands[strand] = { theta, sigma: 1.35, updatedAt, answers: 0 };
    }
  }
  const exam = record(row.exam);
  const receipts = receiptsOf(row);
  return {
    version: 1,
    started: true,
    icon: row.icon,
    text: typeof row.text === 'string' ? row.text.slice(0, 300) : '',
    goal: row.goal,
    level: row.level,
    rules,
    person: person as unknown as Person | undefined,
    exam: exam && typeof exam.name === 'string' ? { name: exam.name, date: typeof exam.date === 'string' ? exam.date : undefined } : undefined,
    desk: receipts ? { receipts, seen: seenOf(row) } : undefined,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
  };
}
