/** All archive admissions use the store's per-user transaction, including undo. */
import type { ChatStore, NewMessage } from './store';
import { LINES } from './types';
import { screenAnswer } from './watcher';

export const ARCHIVE_CHECKING = LINES.archiveChecking;
export type ArchiveResult = { status: 'queued' | 'pending' | 'denied' | 'cancelled' | 'claimed' | 'not-found'; messageId?: string };

export function parseArchiveGaps(output: string): string[] {
  const line = output.split('\n').map((line) => line.trim()).find((line) => line.startsWith('ARCHIVE_GAPS:'));
  if (!line) return [];
  try {
    const value: unknown = JSON.parse(line.slice('ARCHIVE_GAPS:'.length).trim());
    if (!Array.isArray(value) || value.length > 6 || !value.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 240 && !screenAnswer(item).length)) return [];
    return [...new Set(value.map((item: string) => item.trim()))];
  } catch { return []; }
}

export function archiveRow(input: {
  threadId: string; userMessageId: string; answerId?: string; question: string;
  answer: string; gaps: string[]; context: unknown; source: 'automatic' | 'tool' | 'manual' | 'handoff';
}): NewMessage {
  const context = input.context && typeof input.context === 'object' && !Array.isArray(input.context) ? input.context : {};
  return { threadId: input.threadId, role: 'assistant', content: '', status: 'pending', lane: 'slow', toolCalls: [],
    context: { ...context, question: input.question, fastAnswer: input.answer.slice(0, 20_000), gaps: input.gaps,
      userMessageId: input.userMessageId, answerId: input.answerId ?? null, source: input.source } };
}

export async function postArchive(request: Request, deps: {
  userId: string | null; originBlocked: boolean; store: ChatStore; limited: () => Promise<boolean>;
}): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store', vary: 'Cookie' } });
  if (deps.originBlocked) return json({ error: 'origin' }, 403);
  if (!deps.userId) return json({ error: 'unauthorized' }, 401);
  let input: { action?: unknown; messageId?: unknown };
  try { input = await request.json(); } catch { return json({ error: 'body' }, 400); }
  if (!input || (input.action !== 'queue' && input.action !== 'cancel') || typeof input.messageId !== 'string' || !input.messageId || input.messageId.length > 128) return json({ error: 'body' }, 400);
  // Undo remains available even when queue admission is throttled.
  if (input.action === 'cancel') return json(await deps.store.cancelSlow(deps.userId, input.messageId));
  if (await deps.limited()) return json({ status: 'denied', line: LINES.slow }, 429);
  const target = await deps.store.archiveTarget(deps.userId, input.messageId);
  if (!target || target.answer.content === LINES.blocked) return json({ status: 'not-found' }, 404);
  const result = await deps.store.queueSlow(deps.userId, archiveRow({
    threadId: target.answer.threadId, userMessageId: target.question.id, answerId: target.answer.id,
    question: target.question.content, answer: target.answer.content, context: target.question.context,
    gaps: ['Investigate the question further with regional samples, observations, history and run comparisons where relevant.'], source: 'manual',
  }));
  return json({ ...result, line: result.status === 'queued' ? ARCHIVE_CHECKING : result.status === 'pending' ? 'One archive question is already in flight' : 'Archive unavailable' });
}
