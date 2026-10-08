/**
 * Card memory projection, ported from Cohort (MIT).
 * Copyright (c) 2025–2026 MD3 Contributors.
 *
 * Sources (read-only, ~/Projects/cohort):
 *   src/lib/review/memory-projector.ts  — stability, retrieval, due date, mastery, struggle
 *   src/lib/review/grade-strength.ts    — quality → target strength
 *   src/lib/scheduler/concept-teaching-state.ts
 *   src/lib/map/concept-edges.ts        — prerequisite edges only
 *
 * Not ported: Anki baselines, streaming replay, embeddings, leech exile
 * (Cohort's V1 suppression hours are already 0). See training/NOTICE.md.
 */

export const MEMORY_PROJECTOR_VERSION = 1 as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const V1 = Object.freeze({
  initialStabilityDays: 3,
  minimumStabilityDays: 0.5,
  failureStabilityMultiplier: 0.8,
  dueThreshold: 0.4,
  fastThresholdMs: 3_000,
  responseTimeEmaAlpha: 0.3,
  struggleWindowHours: 24,
  leechMinimumReviews: 5,
  leechBaseSuppressionHours: 0,
  leechMaximumSuppressionHours: 0,
  likedIntervalMultiplier: 0.7,
  reviewsPerStudyDayBeforeDueFloor: 2,
  masteredIntervalsDays: { 1: 180, 2: 90, 3: 60 } as Readonly<Record<number, number>>,
});

export const COHORT_MEMORY_POLICY_V1 = Object.freeze({
  version: MEMORY_PROJECTOR_VERSION,
  maximumStabilityDays: 60,
  studyDayBoundaryOffsetMinutes: 0,
});

export type CardMemoryStatus = 'learning' | 'reviewing' | 'mastered' | 'retired';

export interface CardMemory {
  stabilityDays: number;
  nextDueAt: string;
  lastReview: string | null;
  lastQuality: number | null;
  totalReviews: number;
  correctCount: number;
  status: CardMemoryStatus;
  consecutiveCorrectFast: number;
  masteredAt: string | null;
  avgResponseTimeMs: number | null;
  retrievalStrength: number;
  recentFailCount: number;
  recentFailWindowStart: string | null;
  lastFailedAt: string | null;
  leechSuppressionCount: number;
}

export interface ReviewInput {
  quality: number;
  at: string;
  responseTimeMs: number | null;
  complexity: number;
  liked?: boolean;
  maximumStabilityDays?: number;
  studyDayBoundaryOffsetMinutes?: number;
  /** Reviews already counted on this study day, including this one. */
  reviewsOnStudyDay: number;
}

const RUNGS: ReadonlyArray<readonly [number, number]> = [
  [1, 0.3],
  [2, 0.5],
  [3, 0.8],
  [4, 0.9],
  [5, 1.0],
];

/** Piecewise-linear ladder. Integer qualities match Cohort's original rungs. */
export function targetStrengthFor(quality: number): number {
  if (!Number.isFinite(quality) || quality <= RUNGS[0][0]) return RUNGS[0][1];
  const last = RUNGS[RUNGS.length - 1];
  if (quality >= last[0]) return last[1];
  for (let i = 1; i < RUNGS.length; i += 1) {
    const [q1, s1] = RUNGS[i];
    if (quality <= q1) {
      const [q0, s0] = RUNGS[i - 1];
      if (quality === q1) return s1;
      return s0 + ((quality - q0) / (q1 - q0)) * (s1 - s0);
    }
  }
  return last[1];
}

export function emptyMemory(asOf: string): CardMemory {
  return {
    stabilityDays: V1.initialStabilityDays,
    nextDueAt: asOf,
    lastReview: null,
    lastQuality: null,
    totalReviews: 0,
    correctCount: 0,
    status: 'learning',
    consecutiveCorrectFast: 0,
    masteredAt: null,
    avgResponseTimeMs: null,
    retrievalStrength: 0,
    recentFailCount: 0,
    recentFailWindowStart: null,
    lastFailedAt: null,
    leechSuppressionCount: 0,
  };
}

export function startOfStudyDay(dateMs: number, offsetMinutes: number): number {
  const shifted = dateMs + offsetMinutes * 60_000;
  return Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY - offsetMinutes * 60_000;
}

function updateStability(current: number, quality: number, maximum: number): number {
  const baseline = Number.isFinite(current) && current > 0 ? current : V1.initialStabilityDays;
  if (quality < 3) return Math.max(V1.minimumStabilityDays, baseline * V1.failureStabilityMultiplier);
  const multiplier = 1.4 + 0.1 * Math.max(0, quality - 3);
  return Math.min(maximum, baseline * multiplier);
}

function updateRetrieval(
  stored: number,
  quality: number,
  totalReviews: number,
  daysSince: number,
  stabilityDays: number,
): number {
  const decayFactor = daysSince <= 0 ? 1 : Math.pow(1 + daysSince / stabilityDays, -0.5);
  const decayed = stored * decayFactor;
  const target = targetStrengthFor(quality);
  const alpha = totalReviews === 0
    ? 0.9
    : Math.min(0.7, Math.max(0.3, 0.7 / Math.sqrt(Math.max(1, totalReviews))));
  return decayed + (target - decayed) * alpha;
}

function computeNextDueAt(strength: number, reviewedAt: number, stabilityDays: number): number {
  if (!Number.isFinite(strength) || strength <= V1.dueThreshold) return reviewedAt;
  if (!Number.isFinite(stabilityDays) || stabilityDays <= 0) return reviewedAt;
  const ratio = strength / V1.dueThreshold;
  const daysUntilDue = stabilityDays * (ratio * ratio - 1);
  if (!Number.isFinite(daysUntilDue) || daysUntilDue <= 0) return reviewedAt;
  return reviewedAt + daysUntilDue * MS_PER_DAY;
}

export function reviewCard(current: CardMemory, input: ReviewInput): CardMemory {
  const reviewedAt = Date.parse(input.at);
  if (!Number.isFinite(reviewedAt)) throw new Error('review time is not a timestamp');
  const maximum = input.maximumStabilityDays ?? COHORT_MEMORY_POLICY_V1.maximumStabilityDays;
  const offset = input.studyDayBoundaryOffsetMinutes ?? 0;
  const lastMs = current.lastReview ? Date.parse(current.lastReview) : null;
  const daysSince = lastMs == null ? 0 : (reviewedAt - lastMs) / MS_PER_DAY;
  const quality = input.quality;
  const stabilityDays = updateStability(current.stabilityDays, quality, maximum);
  const retrievalStrength = updateRetrieval(
    current.retrievalStrength,
    quality,
    current.totalReviews,
    daysSince,
    current.stabilityDays,
  );
  const totalReviews = current.totalReviews + 1;
  const correct = quality >= 3;
  const correctCount = current.correctCount + (correct ? 1 : 0);
  const fast = input.responseTimeMs != null && input.responseTimeMs < V1.fastThresholdMs;
  let consecutiveCorrectFast = current.consecutiveCorrectFast;
  if (correct && fast) consecutiveCorrectFast += 1;
  else if (!correct) consecutiveCorrectFast = 0;

  let avgResponseTimeMs = current.avgResponseTimeMs;
  if (input.responseTimeMs != null) {
    avgResponseTimeMs = avgResponseTimeMs == null
      ? input.responseTimeMs
      : Math.round(V1.responseTimeEmaAlpha * input.responseTimeMs + (1 - V1.responseTimeEmaAlpha) * avgResponseTimeMs);
  }

  const shouldGraduate = input.complexity === 1
    ? consecutiveCorrectFast >= 3
    : input.complexity === 2
      ? totalReviews >= 5 && retrievalStrength >= 0.8
      : false;

  let status = current.status;
  let masteredAt = current.masteredAt;
  let nextDueInDays: number | null = null;
  if (current.status === 'mastered' && !correct) {
    status = 'reviewing';
    masteredAt = null;
  } else if (shouldGraduate && current.status !== 'mastered' && current.status !== 'retired') {
    status = 'mastered';
    masteredAt = input.at;
    nextDueInDays = V1.masteredIntervalsDays[input.complexity] ?? 90;
  } else if (current.status === 'learning' && correct && totalReviews >= 2) {
    status = 'reviewing';
  }

  let recentFailCount = 0;
  let recentFailWindowStart: string | null = null;
  let lastFailedAt: string | null = null;
  if (!correct) {
    const windowStart = current.recentFailWindowStart ? Date.parse(current.recentFailWindowStart) : NaN;
    const windowAgeHours = Number.isFinite(windowStart) ? (reviewedAt - windowStart) / 3_600_000 : Infinity;
    if (!Number.isFinite(windowStart) || windowAgeHours > V1.struggleWindowHours) {
      recentFailCount = 1;
      recentFailWindowStart = input.at;
    } else {
      recentFailCount = current.recentFailCount + 1;
      recentFailWindowStart = current.recentFailWindowStart;
    }
    lastFailedAt = input.at;
  }

  let leechSuppressionCount = current.leechSuppressionCount;
  if (quality < 3 && totalReviews >= V1.leechMinimumReviews && correctCount === 0) {
    leechSuppressionCount += 1;
  }

  let nextDueMs = nextDueInDays == null
    ? computeNextDueAt(retrievalStrength, reviewedAt, stabilityDays)
    : reviewedAt + nextDueInDays * MS_PER_DAY;
  const studyDayStart = startOfStudyDay(reviewedAt, offset);
  const nextStudyDay = studyDayStart + MS_PER_DAY;
  if (input.reviewsOnStudyDay >= V1.reviewsPerStudyDayBeforeDueFloor && nextDueMs < nextStudyDay) {
    nextDueMs = nextStudyDay;
  }
  if (quality < 3) {
    const failPushbackDays = recentFailCount >= 3 ? 3 : recentFailCount >= 2 ? 2 : 1;
    const failureFloor = studyDayStart + failPushbackDays * MS_PER_DAY;
    if (nextDueMs < failureFloor) nextDueMs = failureFloor;
  }
  if (input.liked && quality >= 3) {
    const shortened = (nextDueMs - reviewedAt) * V1.likedIntervalMultiplier;
    nextDueMs = reviewedAt + shortened;
    if (nextDueMs < nextStudyDay) nextDueMs = nextStudyDay;
  }

  return {
    stabilityDays,
    nextDueAt: new Date(nextDueMs).toISOString(),
    lastReview: new Date(reviewedAt).toISOString(),
    lastQuality: quality,
    totalReviews,
    correctCount,
    status,
    consecutiveCorrectFast,
    masteredAt,
    avgResponseTimeMs,
    retrievalStrength,
    recentFailCount,
    recentFailWindowStart,
    lastFailedAt,
    leechSuppressionCount,
  };
}

export function isDue(memory: CardMemory | undefined, now: string): boolean {
  if (!memory) return true;
  return Date.parse(memory.nextDueAt) <= Date.parse(now);
}

export const TEACHING_STATE_THRESHOLDS = Object.freeze({
  LEARNING_RECALL_CEILING: 0.5,
  CONSOLIDATING_RECALL_CEILING: 0.85,
  MASTERY_CONFIDENCE_FLOOR: 0.7,
});

export type TeachingState = 'naive' | 'learning' | 'consolidating' | 'mastered';

export function classifyTeachingState(input: {
  exposureCount: number;
  recallOnExamDay: number;
  confidence: number;
}): TeachingState {
  const T = TEACHING_STATE_THRESHOLDS;
  if (input.exposureCount <= 0) return 'naive';
  if (input.recallOnExamDay < T.LEARNING_RECALL_CEILING) return 'learning';
  if (input.recallOnExamDay < T.CONSOLIDATING_RECALL_CEILING) return 'consolidating';
  if (input.confidence < T.MASTERY_CONFIDENCE_FLOOR) return 'consolidating';
  return 'mastered';
}

export interface ConceptEdge {
  source: string;
  target: string;
  kind: 'prereq';
  weight: number;
}

/** Prerequisite half of Cohort's buildConceptEdges. Similarity kNN is omitted. */
export function prereqEdges(concepts: { id: string; prerequisiteIds: string[] }[]): ConceptEdge[] {
  const ids = new Set(concepts.map((c) => c.id));
  const edges: ConceptEdge[] = [];
  for (const concept of concepts) {
    for (const pid of concept.prerequisiteIds) {
      if (pid !== concept.id && ids.has(pid)) {
        edges.push({ source: pid, target: concept.id, kind: 'prereq', weight: 1 });
      }
    }
  }
  return edges;
}
