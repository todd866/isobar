import type { PrismaClient } from '@prisma/client';
import { validPng } from '../agent/service';
import { LINES } from './types';
import { placeKey } from './topic';

const headers = { 'cache-control': 'private, no-store', vary: 'Cookie' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
export interface ThreadDeps { userId: string | null; database: PrismaClient; limited: () => Promise<boolean> }

/** Read only the authenticated user's thread; never create one during polling. */
export async function getThread(request: Request, deps: ThreadDeps): Promise<Response> {
  if (!deps.userId) return json({ error: 'unauthorized' }, 401);
  if (await deps.limited()) return json({ error: 'rate-limited' }, 429);
  const id = new URL(request.url).searchParams.get('id');
  const thread = await deps.database.chatThread.findFirst({
    where: { userId: deps.userId, ...(id ? { id } : {}) },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], select: { id: true },
  });
  if (!thread) return id ? json({ error: 'not-found' }, 404) : json({ id: null, messages: [] });
  const rows = await deps.database.chatMessage.findMany({
    where: { threadId: thread.id, role: { in: ['user', 'assistant'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
    select: { id: true, role: true, content: true, status: true, lane: true, model: true, createdAt: true, images: true, context: true },
  });
  // Keep the latest archive row even after it completes, so a long conversation
  // cannot strand an old pending glyph outside the recent-message window.
  const pending = await deps.database.chatMessage.findMany({
    where: { threadId: thread.id, role: 'assistant', lane: {in:['slow','report']} },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1,
    select: { id: true, role: true, content: true, status: true, lane: true, model: true, createdAt: true, images: true, context: true },
  });
  const unique = [...new Map([...pending, ...rows].map((row) => [row.id, row])).values()];
  unique.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return json({ id: thread.id, messages: unique.map((row) => {
    const complete = row.status === 'complete';
    const context = row.context && typeof row.context === 'object' && !Array.isArray(row.context) ? row.context : {};
    const check = 'check' in context && context.check && typeof context.check === 'object' && !Array.isArray(context.check) ? context.check : null;
    const checkLine = check && 'line' in check && typeof check.line === 'string' ? check.line : null;
    const images = complete && Array.isArray(row.images) ? row.images.filter((value): value is { src: string; alt: string } =>
      !!value && typeof value === 'object' && !Array.isArray(value) && typeof value.src === 'string' && validPng(value.src) && typeof value.alt === 'string') : [];
    return {
      id: row.id, role: row.role, lane: row.lane === 'report' ? 'slow' : row.lane, status: row.status, model: row.model, createdAt: row.createdAt.toISOString(), placeKey: placeKey(row.context),
      content: complete ? row.content : row.status === 'held' ? checkLine ?? LINES.held : row.status === 'failed' ? LINES.failed : '', images,
      ...(complete && check && 'severity' in check && check.severity === 'soft' && checkLine ? { caveat: checkLine } : {}),
      ...(complete && 'anchors' in context ? { anchors: context.anchors } : {}),
      ...(complete && context.reportOffer === true ? { reportOffer: true } : {}),
      ...(['userMessageId', 'answerId', 'archiveId', 'archiveLine', 'source', 'reportId'].reduce<Record<string, string>>((out, key) => {
        const value = context[key];
        if (typeof value === 'string') out[key] = value;
        return out;
      }, {})),
    };
  }) });
}
