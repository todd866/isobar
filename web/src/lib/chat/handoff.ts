/** A hard question, offered to the archive when the fast lane is below Opus. */

import type { ApiCap } from './governor';

const ARCHIVE = /\b(yesterday|observed|observations|climatolog\w*|cross-sections?|ensembles?|archive|verification)\b/i;

export function questionNeedsArchive(message: string): boolean {
  return ARCHIVE.test(message) || /what did the model/i.test(message) || /got wrong/i.test(message);
}

/** Signed-in hard questions go to the slow lane instead of a weaker fast answer. */
export function handoffInstead(input: { signedIn: boolean; fastCap: ApiCap; hard: boolean }): boolean {
  if (!input.signedIn || !input.hard) return false;
  return input.fastCap !== 'opus';
}
