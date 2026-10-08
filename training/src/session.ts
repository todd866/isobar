import type { Card } from './model.ts';
import type { Filter } from './queue.ts';

export interface Session {
  queue: string[];
  index: number;
  phase: 'ask' | 'revealed';
  selected: string | null;
  shownAt: number;
  filter: Filter;
}

export interface GradeEvent {
  cardId: string;
  quality: number;
  responseTimeMs: number;
}

export function openSession(queue: string[], filter: Filter, now: number): Session {
  return { queue, index: 0, phase: 'ask', selected: null, shownAt: now, filter };
}

export function reduce(
  session: Session,
  action:
    | { type: 'choose'; optionId: string }
    | { type: 'reveal'; now: number }
    | { type: 'grade'; quality: number; now: number }
    | { type: 'next'; now: number },
  card: Card | null,
): { session: Session; grade: GradeEvent | null } {
  if (action.type === 'choose') {
    if (session.phase !== 'ask' || !card || card.kind !== 'mcq') return { session, grade: null };
    if (!card.options.some((option) => option.id === action.optionId)) return { session, grade: null };
    return { session: { ...session, selected: action.optionId }, grade: null };
  }
  if (action.type === 'reveal') {
    if (session.phase !== 'ask' || !card) return { session, grade: null };
    return { session: { ...session, phase: 'revealed' }, grade: null };
  }
  if (action.type === 'grade') {
    if (session.phase !== 'revealed' || !card) return { session, grade: null };
    if (!Number.isInteger(action.quality) || action.quality < 1 || action.quality > 4) return { session, grade: null };
    const responseTimeMs = Math.max(0, action.now - session.shownAt);
    return {
      session: {
        ...session,
        index: session.index + 1,
        phase: 'ask',
        selected: null,
        shownAt: action.now,
      },
      grade: { cardId: card.id, quality: action.quality, responseTimeMs },
    };
  }
  if (session.phase !== 'revealed') return { session, grade: null };
  const index = session.index + 1;
  return {
    session: {
      ...session,
      index,
      phase: 'ask',
      selected: null,
      shownAt: action.now,
    },
    grade: null,
  };
}
