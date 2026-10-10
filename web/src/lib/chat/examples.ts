/** Newest marked replies, short enough to sit under the system prompt. */

import { contextLine } from './context';
import type { ChatContext } from './types';

export interface PromptExample {
  question: string;
  context: string;
  reply: string;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

export function exampleContext(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const row = value as ChatContext;
  if (!('place' in row) && !('lens' in row) && !('timeUtc' in row)) return '';
  try { return contextLine(row).replace(/\s+/g, ' ').trim(); } catch { return ''; }
}

/** Newest five, one line each. Empty when nothing is marked. */
export function exampleBlock(examples: readonly PromptExample[]): string {
  const recent = examples.slice(0, 5).filter((item) => item.question.trim() && item.reply.trim());
  if (!recent.length) return '';
  return [
    'Examples of a reply worth keeping:',
    ...recent.map((item, index) => `${index + 1}. Q: ${clip(item.question, 180)} | ${clip(item.context, 120)} | A: ${clip(item.reply, 280)}`),
  ].join('\n');
}
