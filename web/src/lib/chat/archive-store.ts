import { Prisma, type PrismaClient } from '@prisma/client';
import type { ChatStore } from './store';
import type { ArchiveResult } from './archive';
import { exactOwner } from '../agent/token';
import { activeAccessBlock } from './access-block';

/** The user row is the queue mutex across conversations and simultaneous requests.
 * Claim/cancel races use status predicates, so undo cannot steal a daemon lease. */
export function prismaArchiveStore(database: PrismaClient, ownerEmail: string | null): Pick<ChatStore, 'queueSlow' | 'cancelSlow' | 'archiveTarget'> {
  return {
    async queueSlow(userId, row): Promise<ArchiveResult> {
      return database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user || (await activeAccessBlock(tx, userId)).blocked) return { status: 'denied' };
        const owner = exactOwner(user.email, ownerEmail);
        const suspended = user.clusterId ? await tx.chatCluster.findUnique({ where: { id: user.clusterId }, select: { suspended: true } }) : null;
        if (!owner && suspended?.suspended) return { status: 'denied' };
        if (!await tx.chatThread.findFirst({ where: { id: row.threadId, userId }, select: { id: true } })) return { status: 'denied' };
        // The governor deliberately leaves subscription work uncapped. The
        // per-user slow limit is one pending/claimed job, even in another thread.
        const pending = await tx.chatMessage.findFirst({ where: { lane: 'slow', status: { in: ['pending', 'claimed'] }, thread: { userId } }, select: { id: true } });
        if (pending) return { status: 'pending', messageId: pending.id };
        const created = await tx.chatMessage.create({ data: {
          threadId: row.threadId, role: 'assistant', content: '', status: 'pending', lane: 'slow',
          context: row.context as Prisma.InputJsonValue, toolCalls: [],
        }, select: { id: true } });
        await tx.chatThread.update({ where: { id: row.threadId }, data: { updatedAt: new Date() } });
        return { status: 'queued', messageId: created.id };
      });
    },
    async cancelSlow(userId, messageId): Promise<ArchiveResult> {
      const where = { id: messageId, thread: { userId }, role: 'assistant', lane: 'slow' };
      const result = await database.chatMessage.updateMany({ where: { ...where, status: 'pending' }, data: { status: 'cancelled' } });
      if (result.count === 1) return { status: 'cancelled', messageId };
      const row = await database.chatMessage.findFirst({ where, select: { status: true } });
      return { status: row?.status === 'claimed' ? 'claimed' : row?.status === 'cancelled' ? 'cancelled' : 'not-found' };
    },
    async archiveTarget(userId, answerId) {
      const answer = await database.chatMessage.findFirst({ where: { id: answerId, thread: { userId }, role: 'assistant', status: 'complete' } });
      if (!answer) return null;
      const context = answer.context as Record<string, unknown> | null;
      const question = await database.chatMessage.findFirst({
        where: { threadId: answer.threadId, role: 'user', ...(typeof context?.userMessageId === 'string' ? { id: context.userMessageId } : { createdAt: { lte: answer.createdAt } }) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return question ? { answer, question } : null;
    },
  };
}
