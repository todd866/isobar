import { previewCases } from './schedule';
import { DECREES } from '../decrees';
import { isStrand } from '../../../../../training/src/levels';
import { storyShift } from './shifts';
import { STORY_STORAGE_KEY, type StoryCase, type StoryPayload } from './types';

const MAX_CASE_TEXT = 512;
const MAX_CASES = 32;
const MIN_THETA = -4;
const MAX_THETA = 4;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validText(value: unknown, max = MAX_CASE_TEXT): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function normalizeStrandSnapshot(value: unknown): Partial<Record<StoryCase['strand'], number>> {
  if (!record(value)) return {};
  const normalized: Partial<Record<StoryCase['strand'], number>> = {};
  for (const [strand, theta] of Object.entries(value)) {
    if (isStrand(strand) && typeof theta === 'number' && Number.isFinite(theta)
      && theta >= MIN_THETA && theta <= MAX_THETA) normalized[strand] = theta;
  }
  return normalized;
}

function normalizeStrands(value: unknown): StoryPayload['strands'] {
  if (!record(value)) return {};
  const normalized: StoryPayload['strands'] = {};
  for (const [shift, snapshots] of Object.entries(value)) {
    if (!record(snapshots)) continue;
    normalized[shift] = {
      before: normalizeStrandSnapshot(snapshots.before),
      after: normalizeStrandSnapshot(snapshots.after),
    };
  }
  return normalized;
}

function validCase(value: unknown, shift: number): value is StoryCase {
  if (!record(value)
    || !validText(value.id, 128)
    || !validText(value.decreeId, 128)
    || !validText(value.route, 128)
    || !validText(value.clock, 64)
    || !validText(value.fact)
    || typeof value.strand !== 'string'
    || !isStrand(value.strand)
    || typeof value.difficulty !== 'number'
    || !Number.isFinite(value.difficulty)
    || value.difficulty < -4
    || value.difficulty > 4
    || typeof value.failing !== 'boolean'
    || typeof value.weatherBad !== 'boolean'
    || (value.weatherBad && !value.failing)) return false;

  const rule = DECREES.find(item => item.id === value.decreeId);
  return !!rule && rule.shiftIntroduced <= shift;
}

function previewFor(payload: StoryPayload, shift: number): StoryCase[] {
  if (!Number.isInteger(shift) || shift < 1) return [];
  try {
    const seed = Number.isSafeInteger(payload.seed) ? payload.seed : 1;
    return previewCases(shift, seed + shift);
  } catch {
    return [];
  }
}

export function readStoryPayload(raw: string | null): StoryPayload {
  const empty: StoryPayload = { seed: 1, shifts: {}, strands: {} };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<StoryPayload> | null;
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      seed: Number.isSafeInteger(parsed.seed) ? parsed.seed! : 1,
      shifts: record(parsed.shifts) ? parsed.shifts as StoryPayload['shifts'] : {},
      strands: normalizeStrands(parsed.strands),
    };
  } catch {
    return empty;
  }
}

export function casesFor(payload: StoryPayload, shift: number): StoryCase[] {
  const given = record(payload.shifts) ? payload.shifts[String(shift)] : undefined;
  let expected = 0;
  try { expected = storyShift(shift).dossierCount; } catch { return previewFor(payload, shift); }
  if (!Array.isArray(given) || given.length === 0 || given.length > MAX_CASES || given.length !== expected
    || !given.every(item => validCase(item, shift))) return previewFor(payload, shift);
  return given;
}

export { STORY_STORAGE_KEY };
