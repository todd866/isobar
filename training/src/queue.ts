import type { Card, Concept, Subject } from './model.ts';
import { isDue, type CardMemory } from './scheduler.ts';

export type Filter = 'all' | Subject;

export interface QueueInput {
  cards: Card[];
  concepts: Concept[];
  memories: Record<string, CardMemory>;
  now: string;
  filter: Filter;
  /** When false, unlocked questions stay even if they are not due. Later cards are left out. */
  dueOnly?: boolean;
}

function satisfied(conceptId: string, cards: Card[], memories: Record<string, CardMemory>): boolean {
  return cards.some((card) => card.kind === 'mcq'
    && card.conceptIds.includes(conceptId)
    && (memories[card.id]?.correctCount ?? 0) > 0);
}

function unlocked(card: Card, concepts: Concept[], cards: Card[], memories: Record<string, CardMemory>): boolean {
  if (card.planStep != null || card.subject === 'live' || card.kind === 'later') return true;
  return card.conceptIds.every((id) => {
    const concept = concepts.find((item) => item.id === id);
    if (!concept) return false;
    return concept.prerequisiteIds.every((pid) => satisfied(pid, cards, memories));
  });
}

function included(card: Card, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'plan') return card.subject === 'plan' || card.planStep != null;
  if (filter === 'live') return card.subject === 'live';
  return card.subject === filter;
}

/** Due, unlocked cards. Worked-plan steps lead, then other live cards, then the deck. */
export function selectQueue(input: QueueInput): string[] {
  const chosen = input.cards.filter((card) => {
    if (!included(card, input.filter)) return false;
    if (!unlocked(card, input.concepts, input.cards, input.memories)) return false;
    if (input.dueOnly === false) return card.kind === 'mcq';
    if (card.kind === 'later') return true;
    return isDue(input.memories[card.id], input.now);
  });
  const rank = (card: Card): [number, number, string] => {
    if (card.planStep != null) return [0, card.planStep, card.id];
    if (card.subject === 'live') return [1, 0, card.id];
    if (card.subject === 'met') return [2, 0, card.id];
    return [3, 0, card.id];
  };
  chosen.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2]);
  });
  return chosen.map((card) => card.id);
}

export function reviewsOnStudyDay(memories: Record<string, CardMemory>, at: string, offsetMinutes = 0): number {
  const ms = Date.parse(at);
  const shifted = ms + offsetMinutes * 60_000;
  const day = Math.floor(shifted / 86_400_000);
  let count = 0;
  for (const memory of Object.values(memories)) {
    if (!memory.lastReview) continue;
    const last = Date.parse(memory.lastReview) + offsetMinutes * 60_000;
    if (Math.floor(last / 86_400_000) === day) count += 1;
  }
  return count + 1;
}
