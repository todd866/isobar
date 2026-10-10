/** The prompt the fast lane sends. The system text is ISOBAR.md. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contextLine } from './context';
import type { ChatContext } from './types';
import { briefingPrompt, type LaptopBriefing } from './briefing';

export const EXCHANGE_LIMIT = 6;
const EARLIER_CHARS = 1_200;

let cached: string | null = null;

export function systemPrompt(): string {
  if (cached) return cached;
  // Relative to the project root: bundled code does not sit next to this file.
  cached = readFileSync(join(process.cwd(), 'src', 'lib', 'chat', 'ISOBAR.md'), 'utf8').trim();
  return cached;
}

export interface PromptTurn {
  question: string;
  answer: string;
}

export function buildChatPrompt(input: { context: ChatContext; earlier: readonly PromptTurn[]; message: string; briefing?: LaptopBriefing | null }): string {
  const sections: string[] = [];
  const line = contextLine(input.context);
  if (line) sections.push(`[On screen]\n${line}`);
  if (input.briefing) sections.push(briefingPrompt(input.briefing));
  const recent = input.earlier.slice(-EXCHANGE_LIMIT);
  if (recent.length) {
    sections.push(['[Earlier]', ...recent.flatMap((turn) => [
      `Q: ${turn.question}`,
      `A: ${turn.answer.length > EARLIER_CHARS ? `${turn.answer.slice(0, EARLIER_CHARS)}…` : turn.answer}`,
    ])].join('\n'));
  }
  sections.push(`[Message]\n${input.message}`);
  return sections.join('\n\n');
}

/** Keep report tool use terse and identity-safe when the tool is available. */
export const REPORT_CHAT_GUIDANCE = 'For signed-in report requests, use manage_reports. The tool owns the verified recipient and subscription limits; never ask for or invent an email address. Confirm a successful change in one short line. If the tool says the free tier is exceeded, state that paid access is needed in one line and stop.';
