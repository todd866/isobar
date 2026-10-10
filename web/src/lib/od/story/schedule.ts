import { lowCommitment, priorPerson, type Person } from '../../../../../training/src/ability';
import { DECREES, ruleStrand } from '../decrees';
import { schedulerTarget } from '../learn';
import { beatAt, storyShift } from './shifts';
import { WEATHER_DECREES, type StoryCase } from './types';

export interface ScheduledSlot {
  index: number;
  decreeId: string;
  conceptId: string;
  strand: StoryCase['strand'];
  difficulty: number;
  beat: ReturnType<typeof beatAt>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mastery(person: Person, conceptId: string): number {
  const stat = person.concepts[conceptId];
  return stat ? (stat.correct + 1) / (stat.exposure + 2) : 0;
}

/** Weakest active concept. Ties keep decree order and do not draw a random number. */
function pickWeak(person: Person, shift: number, rng: () => number) {
  const active = DECREES.slice(0, shift);
  const ranked = [...active].sort((a, b) => mastery(person, a.conceptId) - mastery(person, b.conceptId) || a.shiftIntroduced - b.shiftIntroduced);
  const best = mastery(person, ranked[0]!.conceptId);
  const tied = ranked.filter(d => mastery(person, d.conceptId) === best);
  if (tied.length === 1) return tied[0]!;
  return tied[Math.floor(rng() * tied.length)]!;
}

/**
 * Queue for one shift. Slot 0 introduces today's decree. Later slots prefer the
 * least-established active concept. Difficulty comes from the Learn scheduler.
 */
export function scheduleShift(person: Person, shift: number, seed: number): ScheduledSlot[] {
  const script = storyShift(shift);
  if (!person.rules) throw new RangeError('Operational Decision requires a Code edition');
  const active = DECREES.slice(0, shift);
  const introduced = active[active.length - 1]!;
  if (introduced.id !== script.decreeId) throw new RangeError('Story decree does not match the Code');
  const rng = mulberry32(seed >>> 0);
  const slots: ScheduledSlot[] = [];
  for (let index = 0; index < script.dossierCount; index += 1) {
    const rule = index === 0 ? introduced : pickWeak(person, shift, rng);
    const strand = ruleStrand(rule, person.rules);
    const target = schedulerTarget(person, strand, rng, {
      position: index,
      consecutiveFailures: person.consecutiveFailures,
      lowCommitment: lowCommitment(person),
    });
    slots.push({
      index,
      decreeId: rule.id,
      conceptId: rule.conceptId,
      strand,
      difficulty: Math.max(-4, Math.min(4, target.difficulty)),
      beat: beatAt(shift, index),
    });
  }
  return slots;
}

/** A playable queue when no dossiers were supplied. Failing slots are explicit, never invented weather. */
export function previewCases(shift: number, seed: number): StoryCase[] {
  const person = priorPerson({ level: 'curious', goal: 'weather', rules: 'aus', now: 0 });
  return scheduleShift(person, shift, seed).map(slot => {
    const failing = slot.index % 3 === 2;
    const weather = failing && (WEATHER_DECREES as readonly string[]).includes(slot.decreeId);
    return {
      id: `preview-${shift}-${slot.index}`,
      decreeId: slot.decreeId,
      strand: slot.strand,
      difficulty: slot.difficulty,
      failing,
      weatherBad: weather,
      route: 'KES–ORL',
      clock: '1840Z',
      fact: failing ? 'The sheet and the bulletin disagree.' : 'The sheet matches the bulletin.',
    };
  });
}

export function inspectorSlots(shift: number, count: number, seed: number): number[] {
  if (!Number.isInteger(shift) || shift < 1 || !Number.isInteger(count) || count < 1) throw new RangeError('Invalid audit');
  const rng = mulberry32((seed >>> 0) ^ (Math.imul(shift, 0x9E3779B9) >>> 0));
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  const n = shift >= 6 ? 2 : 1;
  return order.slice(0, Math.min(n, count)).sort((a, b) => a - b);
}
