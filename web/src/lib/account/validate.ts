/** Validation for the per-user store. Server side (route handlers) and tests.
 * Unknown keys are stripped at the top level of each document; the scheduler's
 * card memory is checked field by field. */
import { z } from 'zod';
import { SPEEDS, type DocKind } from './merge.ts';

/** Bytes of JSON per document. A card memory is about 450 bytes, so training holds ~2000 cards. */
export const DOC_LIMITS: Record<DocKind, number> = { settings: 8_192, training: 1_000_000, e6b: 200_000 };

const iso = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)), 'time');
const isoOrNull = iso.nullable();
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int().min(0).max(1e9);
const finite = z.number().finite();

const settings = z.object({
  values: z.object({
    theme: z.enum(['light', 'dark']).optional(),
    place: id.optional(),
    speed: z.number().refine((value) => (SPEEDS as readonly number[]).includes(value), 'speed').optional(),
    places: z.array(id).max(32).optional(),
    kiteBand: z.object({ min: z.number().finite().min(0), max: z.number().finite().max(100) }).refine((b) => b.min < b.max).optional(),
    units: z.enum(['aus', 'us', 'local']).optional(),
  }).strip(),
  at: z.object({ theme: iso.optional(), place: iso.optional(), speed: iso.optional(), places: iso.optional(), units: iso.optional(), kiteBand: iso.optional() }).strip(),
}).strip();

const memory = z.object({
  stabilityDays: finite,
  nextDueAt: iso,
  lastReview: isoOrNull,
  lastQuality: finite.nullable(),
  totalReviews: count,
  correctCount: count,
  status: z.enum(['learning', 'reviewing', 'mastered', 'retired']),
  consecutiveCorrectFast: count,
  masteredAt: isoOrNull,
  avgResponseTimeMs: finite.nullable(),
  retrievalStrength: finite,
  recentFailCount: count,
  recentFailWindowStart: isoOrNull,
  lastFailedAt: isoOrNull,
  leechSuppressionCount: count,
}).passthrough();

const streak = z.object({ count, lastDay: day.nullable() });
const stage = z.enum(['watch', 'guided', 'solo', 'done']);
const cardKey = z.string().min(1).max(160);

const e6b = z.object({
  version: z.literal(1),
  firstContact: z.boolean().optional(),
  curriculum: z.record(id, z.object({ stage, solved: z.array(z.string().max(80)).max(500) })).optional(),
  memories: z.record(cardKey, memory),
  stages: z.record(id, stage),
  bests: z.record(id, z.number().nonnegative().finite()),
  daily: z.object({ day, set: z.array(id).max(16), done: count, misses: count }).nullable(),
  streak,
}).strip();

const skill = z.object({
  support: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  retests: count,
  transfers: count,
  closed: count,
  lastSlip: z.string().max(400).nullable(),
  lastAt: isoOrNull,
});

const strandState = z.object({ theta: finite, sigma: finite, updatedAt: finite, answers: count });
const person = z.object({
  strands: z.record(z.enum(['physics', 'charts', 'rules-aus', 'rules-us', 'rules-easa', 'rules-ca', 'operations', 'numbers']), strandState),
  goal: z.enum(['weather', 'drones', 'flying', 'defence']), rules: z.enum(['aus', 'us', 'easa', 'ca']).nullable(),
  levelPrior: z.enum(['curious', 'drone', 'student', 'commercial', 'airline', 'defence']),
  history: z.array(z.object({ at: finite, strand: z.enum(['physics', 'charts', 'rules-aus', 'rules-us', 'rules-easa', 'rules-ca', 'operations', 'numbers']), difficulty: finite, correct: z.boolean() })).max(5000),
  concepts: z.record(z.object({ exposure: count, correct: count })), sessionLengths: z.array(count).max(500),
  consecutiveFailures: count, chipAt: finite, updatedAt: finite,
});
const evidence = z.object({
  conceptId: id, strand: z.enum(['physics', 'charts', 'rules-aus', 'rules-us', 'rules-easa', 'rules-ca', 'operations', 'numbers']),
  difficulty: finite, correct: z.boolean(), responseMs: finite.min(0), rules: z.enum(['aus', 'us', 'easa', 'ca']),
  dossierId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/), decreeId: id,
});
const desk = z.object({
  receipts: z.array(z.object({ dossierId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/), decreeIds: z.array(id).max(32), edition: z.enum(['aus', 'us', 'easa', 'ca']),
    stamp: z.enum(['RELEASE', 'REFUSE', 'AMEND']), correct: z.boolean(), at: iso,
    evidence: z.array(evidence).max(32), })).max(256),
  seen: z.array(z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/)).max(4096).optional(),
});
const learnFields = {
  version: z.literal(1), started: z.literal(true), classic: z.boolean().optional(),
  icon: z.enum(['weather', 'drones', 'flying', 'defence']), text: z.string().max(300),
  goal: z.enum(['weather', 'drones', 'flying', 'defence']), level: z.enum(['curious', 'drone', 'student', 'commercial', 'airline', 'defence']),
  rules: z.enum(['aus', 'us', 'easa', 'ca']).nullable(), strands: z.record(z.enum(['low', 'typical', 'high'])).optional(),
  exam: z.object({ name: z.string().max(80), date: z.string().max(40).optional() }).optional(),
  person: person.optional(), desk: desk.optional(), updatedAt: iso,
} as const;
const learn = z.union([
  z.object(learnFields).strip(),
  z.object({ version: z.literal(1), classic: z.literal(true), updatedAt: iso, desk: desk.optional() }).strip(),
]);

const training = z.object({
  version: z.literal(1),
  cards: z.record(cardKey, memory),
  streak,
  flags: z.array(z.object({ cardId: cardKey, note: z.string().max(2000), at: iso })).max(500).optional(),
  e6b: e6b.optional(),
  skills: z.record(cardKey, skill).optional(),
  learn: learn.optional(),
}).strip();

const SCHEMAS = { settings, training, e6b } as const;

export function isDocKind(value: unknown): value is DocKind {
  return value === 'settings' || value === 'training' || value === 'e6b';
}

export type Checked = { ok: true; data: unknown } | { ok: false; error: 'too-large' | 'invalid' };

/** Size first (cheap, bounds the parse), then shape. */
export function checkDoc(kind: DocKind, data: unknown): Checked {
  let size: number;
  try { size = new TextEncoder().encode(JSON.stringify(data) ?? '').length; } catch { return { ok: false, error: 'invalid' }; }
  if (size > DOC_LIMITS[kind]) return { ok: false, error: 'too-large' };
  const parsed = SCHEMAS[kind].safeParse(data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: 'invalid' };
}

const putBody = z.object({
  kind: z.enum(['settings', 'training', 'e6b']),
  /** The rev this write was merged onto; 0 when the account had no document. */
  baseRev: z.number().int().min(0),
  data: z.unknown(),
}).strict();

export function parsePut(body: unknown): { ok: true; kind: DocKind; baseRev: number; data: unknown } | { ok: false } {
  const parsed = putBody.safeParse(body);
  return parsed.success ? { ok: true, kind: parsed.data.kind, baseRev: parsed.data.baseRev, data: parsed.data.data } : { ok: false };
}

/** Request bodies are capped before JSON parsing. */
export const MAX_BODY_BYTES = DOC_LIMITS.training + 4_096;
