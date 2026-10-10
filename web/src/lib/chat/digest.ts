/** Last-24-hour digest. Pure: the route loads rows and calls the model. */

import { MODEL_ID } from './types';

export interface DigestMessage {
  id: string;
  threadId: string;
  user: string | null;
  role: string;
  content: string;
  status: string;
  lane: string;
  context: unknown;
  model: string | null;
  costUsd: number | null;
  grade: string | null;
  gradeReason: string | null;
  toolCalls: unknown;
  example: boolean;
  failureReason: string | null;
  createdAt: Date;
}

export interface DigestTurn {
  question: string;
  context: unknown;
  replyId: string | null;
  reply: string | null;
  model: string | null;
  grade: string | null;
  gradeReason: string | null;
  toolCalls: string[];
  example: boolean;
}

export interface DigestHandoff {
  question: string;
  status: string;
  outcome: string | null;
}

export interface DigestThread {
  threadId: string;
  user: string | null;
  costUsd: number;
  turns: DigestTurn[];
  handoffs: DigestHandoff[];
  missed: string | null;
}

export interface DigestView {
  since: string;
  until: string;
  threads: DigestThread[];
}

export function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const name = (item as { name?: unknown }).name;
    return typeof name === 'string' && name ? [name] : [];
  });
}

function handoffQuestion(context: unknown, content: string): string {
  const row = context && typeof context === 'object' ? context as { question?: unknown } : null;
  return row && typeof row.question === 'string' && row.question.trim() ? row.question.trim() : content;
}

function outcome(message: DigestMessage): string | null {
  if (message.status === 'pending') return null;
  if (message.status === 'failed') return message.failureReason;
  return message.content || null;
}

/** Newest threads, each in chronological order. Critique rows become the paragraph. */
export function assembleDigest(messages: readonly DigestMessage[], since: Date, until: Date): DigestView {
  const inWindow = messages.filter((message) => message.createdAt >= since && message.createdAt < until);
  const byThread = new Map<string, DigestMessage[]>();
  for (const message of inWindow) {
    const list = byThread.get(message.threadId) ?? [];
    list.push(message);
    byThread.set(message.threadId, list);
  }
  const threads: DigestThread[] = [];
  for (const [threadId, rows] of byThread) {
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const critique = [...rows].reverse().find((row) => row.role === 'critique' && row.content.trim());
    const turns: DigestTurn[] = [];
    const handoffs: DigestHandoff[] = [];
    let open: DigestTurn | null = null;
    for (const row of rows) {
      if (row.role === 'user') {
        open = {
          question: row.content, context: row.context, replyId: null, reply: null, model: null,
          grade: null, gradeReason: null, toolCalls: [], example: false,
        };
        turns.push(open);
        continue;
      }
      if (row.role !== 'assistant') continue;
      if (row.lane === 'slow') {
        handoffs.push({ question: handoffQuestion(row.context, row.content), status: row.status, outcome: outcome(row) });
        continue;
      }
      const target = open ?? {
        question: '', context: row.context, replyId: null, reply: null, model: null,
        grade: null, gradeReason: null, toolCalls: [], example: false,
      };
      if (!open) turns.push(target);
      target.replyId = row.id;
      target.reply = row.content;
      target.model = row.model;
      target.grade = row.grade;
      target.gradeReason = row.gradeReason;
      target.toolCalls = toolNames(row.toolCalls);
      target.example = row.example;
      open = null;
    }
    if (!turns.length && !handoffs.length) continue;
    const costUsd = rows.reduce((sum, row) => sum + (row.costUsd != null && Number.isFinite(row.costUsd) ? row.costUsd : 0), 0);
    threads.push({
      threadId,
      user: rows.find((row) => row.user)?.user ?? null,
      costUsd,
      turns,
      handoffs,
      missed: critique?.content.trim() ?? null,
    });
  }
  threads.sort((a, b) => {
    const aAt = byThread.get(a.threadId)?.at(-1)?.createdAt.getTime() ?? 0;
    const bAt = byThread.get(b.threadId)?.at(-1)?.createdAt.getTime() ?? 0;
    return bAt - aAt;
  });
  return { since: since.toISOString(), until: until.toISOString(), threads: threads.slice(0, 100) };
}

export function critiquePrompt(threads: readonly { transcript: string }[]): string {
  return [
    'You review Isobar conversations for the owner.',
    'For each thread write one paragraph: what the answer missed, and what would have made it better.',
    'Same order as the threads. Separate paragraphs with one blank line. No headings, no numbers.',
    ...threads.map((thread, index) => `\nThread ${index + 1}\n${thread.transcript}`),
  ].join('\n');
}

export function threadTranscript(thread: DigestThread): string {
  const lines = [
    thread.user ?? 'Signed out',
    ...thread.turns.flatMap((turn) => [
      `Q: ${turn.question.slice(0, 500)}`,
      `A: ${(turn.reply ?? '').slice(0, 800)}`,
      turn.grade ? `Grade: ${turn.grade}` : '',
    ]),
    ...thread.handoffs.map((handoff) => `Slow: ${handoff.status} ${handoff.outcome ?? ''}`.trim()),
  ];
  return lines.filter(Boolean).join('\n').slice(0, 4_000);
}

/** One paragraph per thread, split on a blank line. A mismatch is not a critique. */
export function parseCritiques(text: string, count: number): string[] | null {
  if (count <= 0) return [];
  const parts = text.trim().split(/\n\s*\n/).map((part) => part.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
  if (parts.length !== count) return null;
  if (parts.some((part) => part.length < 20)) return null;
  return parts.map((part) => part.slice(0, 1_200));
}

export function withCritiques(view: DigestView, critiques: readonly { threadId: string; text: string }[]): DigestView {
  const byId = new Map(critiques.map((item) => [item.threadId, item.text]));
  return {
    ...view,
    threads: view.threads.map((thread) => ({ ...thread, missed: byId.get(thread.threadId) ?? thread.missed })),
  };
}

export function digestEmail(view: DigestView): string {
  return view.threads.map((thread) => {
    const lines = [
      thread.user ?? 'Signed out',
      ...thread.turns.flatMap((turn) => [`Q: ${turn.question}`, turn.reply ? `A: ${turn.reply}` : 'A: —']),
      ...thread.handoffs.map((handoff) => `Slow ${handoff.status}${handoff.outcome ? `: ${handoff.outcome}` : ''}`),
      thread.missed ?? '',
    ];
    return lines.filter(Boolean).join('\n');
  }).join('\n\n');
}

export function digestModel(tier: 'sonnet' | 'haiku'): string {
  return tier === 'haiku' ? MODEL_ID.haiku : MODEL_ID.sonnet;
}

export interface DigestRun {
  view: DigestView;
  critiques: { threadId: string; text: string }[];
  costUsd: number | null;
  model: string | null;
  email: string | null;
}

/**
 * Fills missing paragraphs when the lane is open, then offers one email
 * if any thread exists and today's note has not been sent.
 */
export async function runDigest(input: {
  now: Date;
  messages: readonly DigestMessage[];
  /** Public Sonnet (or the capped model) still has today's allowance. */
  modelOpen: boolean;
  digestTier: 'sonnet' | 'haiku' | 'rest';
  alreadySent: boolean;
  send: boolean;
  complete: (prompt: string, model: 'sonnet' | 'haiku') => Promise<{ text: string; costUsd: number } | null>;
}): Promise<DigestRun> {
  const since = new Date(input.now.getTime() - 24 * 60 * 60 * 1000);
  const view = assembleDigest(input.messages, since, input.now);
  const pending = view.threads.filter((thread) => !thread.missed && thread.turns.some((turn) => turn.question));
  let critiques: { threadId: string; text: string }[] = [];
  let costUsd: number | null = null;
  let model: string | null = null;
  if (pending.length && input.modelOpen && input.digestTier !== 'rest') {
    const tier = input.digestTier;
    const done = await input.complete(critiquePrompt(pending.map((thread) => ({ transcript: threadTranscript(thread) }))), tier);
    model = digestModel(tier);
    if (done) {
      costUsd = done.costUsd;
      const parsed = parseCritiques(done.text, pending.length);
      if (parsed) critiques = pending.map((thread, index) => ({ threadId: thread.threadId, text: parsed[index] }));
    }
  }
  const filled = withCritiques(view, critiques);
  const email = input.send && filled.threads.length > 0 && !input.alreadySent ? digestEmail(filled) : null;
  return { view: filled, critiques, costUsd, model, email };
}
