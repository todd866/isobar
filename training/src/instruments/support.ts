import type { Card } from '../model.ts';
import type { InstrumentId } from './types.ts';

export type { InstrumentId } from './types.ts';

const SKILL_INSTRUMENT: Record<string, InstrumentId> = {
  'wind-component': 'wind', groundspeed: 'wind',
  'isa-dev': 'atmosphere', 'met-level': 'profile',
  'table-cell': 'interpolation', interpolate: 'interpolation',
  'cg-shift': 'balance',
};

export function instrumentForCard(card: Card | null): InstrumentId | null {
  if (!card || card.kind !== 'numeric') return null;
  const skill = card.drill?.skill ?? card.topics.find((topic) => topic in SKILL_INSTRUMENT);
  if (skill === 'zone-fuel' || skill === 'zone-time') {
    const given = card.numeric?.given ?? {};
    if (given.trackDeg == null || given.windFromDeg == null || given.windKt == null) return null;
    return 'wind';
  }
  return skill ? SKILL_INSTRUMENT[skill] ?? null : null;
}
