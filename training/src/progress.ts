import type { SkillBook } from './adaptive.ts';
import type { CardMemory } from './scheduler.ts';
import type { E6BRecord } from './instruments/e6b/skills.ts';
import type { LearnRecord } from './learn-profile.ts';
import { emptyMemory, reviewCard, startOfStudyDay } from './scheduler.ts';

export interface ProgressFlag {
  cardId: string;
  note: string;
  at: string;
}

export interface ProgressFile {
  version: 1;
  cards: Record<string, CardMemory>;
  streak: { count: number; lastDay: string | null };
  flags?: ProgressFlag[];
  /** E6-B skill memory (scheduler cards e6b:<skill>), stages, personal bests and the daily-set streak. */
  e6b?: E6BRecord;
  /** Part-task skill state from the adaptive follow-ups (src/adaptive.ts). */
  skills?: SkillBook;
  /** Learn picker, priors and the ability estimate. Absent on the ATPL bank. */
  learn?: LearnRecord;
}

export function emptyProgress(): ProgressFile {
  return { version: 1, cards: {}, streak: { count: 0, lastDay: null } };
}

export function previousDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date) - 86_400_000).toISOString().slice(0, 10);
}

export function localDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function markStudyDay(progress: ProgressFile, day: string): ProgressFile {
  if (progress.streak.lastDay === day) return progress;
  const count = progress.streak.lastDay === previousDay(day) ? progress.streak.count + 1 : 1;
  return { ...progress, streak: { count, lastDay: day } };
}

export function applyGrade(
  progress: ProgressFile,
  cardId: string,
  input: { quality: number; at: string; responseTimeMs: number | null; complexity: number; day: string },
): ProgressFile {
  const current = progress.cards[cardId] ?? emptyMemory(input.at);
  const dayStart = startOfStudyDay(Date.parse(input.at), 0);
  const earlierToday = Object.values(progress.cards).filter((memory) => {
    if (!memory.lastReview) return false;
    return startOfStudyDay(Date.parse(memory.lastReview), 0) === dayStart;
  }).length;
  const next = reviewCard(current, {
    quality: input.quality,
    at: input.at,
    responseTimeMs: input.responseTimeMs,
    complexity: input.complexity,
    reviewsOnStudyDay: earlierToday + 1,
  });
  return markStudyDay({ ...progress, cards: { ...progress.cards, [cardId]: next } }, input.day);
}

export function meanRetrieval(progress: ProgressFile, cardIds: string[]): number {
  if (!cardIds.length) return 0;
  const total = cardIds.reduce((sum, id) => sum + (progress.cards[id]?.retrievalStrength ?? 0), 0);
  return total / cardIds.length;
}
