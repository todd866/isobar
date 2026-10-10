import type { Beat, ShiftScript } from './types';

function shift(number: number, decreeId: string, dossierCount: number, quota: number, beats: Beat[], accidentAfter: ShiftScript['accidentAfter'] = null, epilogue = false): ShiftScript {
  return { number, decreeId, dossierCount, quota, beats, accidentAfter, epilogue };
}

/** Twelve narrative shifts. Dossier counts are the queue; the scheduler fills each slot. */
export const STORY_SHIFTS: readonly ShiftScript[] = [
  shift(1, 'forecast-coverage', 5, 2, [
    { at: 1, role: 'first-officer' },
    { at: 2, role: 'captain' },
    { at: 4, role: 'aftermath' },
  ]),
  shift(2, 'destination-alternate', 5, 2, [
    { at: 0, role: 'first-officer' },
    { at: 1, role: 'rebel', hook: 'manifest-note' },
    { at: 2, role: 'captain' },
    { at: 4, role: 'aftermath' },
  ]),
  shift(3, 'forecast-groups', 6, 2, [
    { at: 0, role: 'callback', hook: 'manifest-note' },
    { at: 2, role: 'first-officer' },
    { at: 3, role: 'captain' },
    { at: 5, role: 'aftermath' },
  ]),
  shift(4, 'crosswind', 6, 2, [
    { at: 1, role: 'first-officer' },
    { at: 2, role: 'captain' },
    { at: 5, role: 'aftermath' },
  ], 'authority-gradient'),
  shift(5, 'icing', 6, 3, [
    { at: 1, role: 'first-officer' },
    { at: 2, role: 'captain' },
    { at: 3, role: 'rebel', hook: 'border-diversion' },
    { at: 5, role: 'aftermath' },
  ]),
  shift(6, 'thunderstorms', 7, 3, [
    { at: 0, role: 'callback', hook: 'border-diversion' },
    { at: 2, role: 'first-officer' },
    { at: 3, role: 'captain' },
    { at: 6, role: 'aftermath' },
  ]),
  shift(7, 'fuel', 7, 3, [
    { at: 1, role: 'first-officer' },
    { at: 3, role: 'captain' },
    { at: 6, role: 'aftermath' },
  ], 'plan-continuation'),
  shift(8, 'duty', 7, 3, [
    { at: 2, role: 'first-officer' },
    { at: 3, role: 'captain' },
    { at: 6, role: 'aftermath' },
  ]),
  shift(9, 'takeoff-distance', 8, 3, [
    { at: 2, role: 'first-officer' },
    { at: 4, role: 'captain' },
    { at: 7, role: 'aftermath' },
  ]),
  shift(10, 'landing-distance', 8, 4, [
    { at: 2, role: 'first-officer' },
    { at: 4, role: 'captain' },
    { at: 7, role: 'aftermath' },
  ]),
  shift(11, 'contaminated-runway', 8, 4, [
    { at: 1, role: 'first-officer' },
    { at: 3, role: 'captain' },
    { at: 7, role: 'aftermath' },
  ], 'get-there-itis'),
  shift(12, 'density-altitude', 9, 4, [
    { at: 2, role: 'first-officer' },
    { at: 4, role: 'captain' },
    { at: 8, role: 'aftermath' },
  ], null, true),
];

export function storyShift(number: number): ShiftScript {
  const found = STORY_SHIFTS[number - 1];
  if (!found || found.number !== number) throw new RangeError('Unknown story shift');
  return found;
}

export function beatAt(number: number, index: number) {
  return storyShift(number).beats.find(b => b.at === index) ?? null;
}
