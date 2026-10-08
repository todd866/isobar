import type { Card } from './model.ts';

export type Page = 'review' | 'live' | 'plan' | 'exam' | 'profile';

export type Mode =
  | 'mixed'
  | 'met'
  | 'nav'
  | 'plan'
  | 'performance'
  | 'law'
  | 'human'
  | 'systems'
  | 'aero';

export const MODES: { id: Mode; label: string }[] = [
  { id: 'mixed', label: 'Mixed' },
  { id: 'met', label: 'Met' },
  { id: 'nav', label: 'Nav' },
  { id: 'plan', label: 'Flight planning' },
  { id: 'performance', label: 'Performance & loading' },
  { id: 'law', label: 'Air law' },
  { id: 'human', label: 'Human factors' },
  { id: 'systems', label: 'Systems' },
  { id: 'aero', label: 'Aerodynamics' },
];

export function modePool(cards: Card[], mode: Mode): Card[] {
  if (mode === 'mixed') return cards;
  if (mode === 'met') return cards.filter((card) => card.subject === 'met');
  if (mode === 'plan') return cards.filter((card) => card.subject === 'plan' && card.kind !== 'later');
  if (mode === 'performance') return cards.filter((card) => card.kind === 'later');
  return [];
}

export function modeEnabled(mode: Mode, cards: Card[]): boolean {
  if (mode === 'mixed') return cards.length > 0;
  return modePool(cards, mode).length > 0;
}

/** Worked YPPH–YSSY steps, in plan order, including steps that are not due. */
export function planQueue(cards: Card[]): string[] {
  return cards
    .filter((card) => card.planStep != null)
    .sort((a, b) => (a.planStep ?? 0) - (b.planStep ?? 0) || a.id.localeCompare(b.id))
    .map((card) => card.id);
}

export function chipFor(card: Card | null, page: Page, mode: Mode = 'mixed'): { id: string; label: string } {
  if (page === 'live') return { id: 'live', label: 'Live' };
  if (page === 'profile') return { id: 'profile', label: 'Profile' };
  if (card?.kind === 'later') return { id: 'performance', label: 'Performance & loading' };
  if (card?.subject === 'plan') return { id: 'plan', label: 'Flight planning' };
  if (card?.subject === 'live') return { id: 'live', label: 'Live' };
  if (card?.subject === 'met') return { id: 'met', label: 'Met' };
  if (mode !== 'mixed') {
    const found = MODES.find((item) => item.id === mode);
    if (found) return { id: found.id, label: found.label };
  }
  return { id: 'met', label: 'Met' };
}

export function chipOptions(cards: Card[]): { id: string; label: string; enabled: boolean }[] {
  const subjects = MODES.filter((mode) => mode.id !== 'mixed').map((mode) => ({
    id: mode.id,
    label: mode.label,
    enabled: modeEnabled(mode.id, cards),
  }));
  return [...subjects, { id: 'live', label: 'Live', enabled: true }];
}

export function figureKind(card: Card | null): 'chart' | 'taf' | 'none' {
  const focus = card?.focus;
  if (!focus) return 'none';
  if (focus.mapX != null && focus.mapY != null) return 'chart';
  if (focus.marks?.length || focus.needle || focus.opening || focus.icao) return 'taf';
  return 'none';
}

export function pillLabel(done: number, due: number): string {
  return `${done}/${due}`;
}

export function sitting(page: Page): boolean {
  return page === 'review' || page === 'plan' || page === 'exam';
}
