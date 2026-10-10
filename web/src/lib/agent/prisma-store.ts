import { Prisma, type PrismaClient } from '@prisma/client';
import { currentConversation } from '../chat/topic';
import type { AgentPrincipal, TokenRecord } from './token';
import type { AgentReply, AgentStore, Candidate, ClaimPayload } from './service';
import { billingEnabled } from '../billing/policy';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Compare-and-swap lives in UPDATE's predicate, never in a read then blind write. */
export function prismaAgentStore(database: PrismaClient, ownerEmail: string | null): AgentStore {
  async function eligible(caller: AgentPrincipal, now = new Date()): Promise<Prisma.ChatMessageWhereInput> {
    const suspended = await database.chatCluster.findMany({ where: { suspended: true }, select: { id: true } });
    const owner = ownerEmail ? await database.user.findUnique({ where: { email: ownerEmail.trim().toLowerCase() }, select: { id: true } }) : null;
    const blocks = await database.aiAccessBlock.findMany({ where: { liftedAt: null, until: { gt: now } }, select: { scope: true } });
    if (blocks.some((row) => row.scope === 'global')) return { id: { in: [] } };
    const blockedUsers = blocks.map((row) => row.scope).filter((scope) => scope !== 'global');
    return {
      role: 'assistant', lane: 'slow',
      thread: { user: { is: {
        AND: [
          ...(caller.scope === 'user' ? [{ id: caller.userId }] : []),
          { id: { notIn: blockedUsers } },
        ],
        OR: [
          ...(owner ? [{ id: owner.id }] : []),
          { clusterId: null },
          { clusterId: { notIn: suspended.map((row) => row.id) } },
        ],
      } } },
    };
  }
  async function held(caller: AgentPrincipal, id: string, leaseId: string, now: Date, host: string, checkBlocks = true): Promise<Prisma.ChatMessageWhereInput> {
    const blocks = checkBlocks ? await database.aiAccessBlock.findMany({ where: { liftedAt: null, until: { gt: now } }, select: { scope: true } }) : [];
    if (blocks.some((row) => row.scope === 'global')) return { id: { in: [] } };
    return {
      id, role: 'assistant', lane: 'slow', status: 'claimed', leaseId, leaseUntil: { gt: now }, agentTokenId: caller.id,
      agentToken: { is: { revokedAt: null, userId: caller.userId, scope: caller.scope } },
      claimedBy: host,
      thread: { AND: [
        ...(caller.scope === 'user' ? [{ userId: caller.userId }] : []),
        { userId: { notIn: blocks.map((row) => row.scope) } },
      ] },
    };
  }
  return {
    async token(hashedToken) {
      const row = await database.agentToken.findUnique({ where: { hashedToken }, include: { user: { select: { email: true } } } });
      if (!row || (row.scope !== 'owner' && row.scope !== 'user')) return null;
      return { id: row.id, userId: row.userId, scope: row.scope, revokedAt: row.revokedAt, email: row.user.email } satisfies TokenRecord;
    },
    async touchToken(id, now) {
      const result = await database.agentToken.updateMany({ where: { id, revokedAt: null }, data: { lastUsedAt: now } });
      return result.count === 1;
    },
    async expire(now) {
      await database.chatMessage.updateMany({
        where: { lane: 'slow', status: 'claimed', OR: [{ leaseUntil: { lte: now } }, { leaseUntil: null }] },
        data: { status: 'pending', leaseId: null, leaseUntil: null, claimedBy: null, agentTokenId: null },
      });
    },
    async next(caller, now, olderThan) {
      const where = { ...await eligible(caller, now), status: 'pending', ...(olderThan ? { createdAt: { lte: olderThan } } : {}) };
      const select = { id: true, threadId: true, context: true, createdAt: true } as const;
      const orderBy = [{ createdAt: 'asc' }, { id: 'asc' }] as Prisma.ChatMessageOrderByWithRelationInput[];
      if (caller.scope === 'owner') {
        const own = await database.chatMessage.findFirst({ where: { AND: [where, { thread: { userId: caller.userId } }] }, select, orderBy });
        if (own) return own;
      }
      if (billingEnabled()) {
        const paidWhere: Prisma.ChatMessageWhereInput = {
          thread: { user: { is: { entitlement: { is: {
            status: 'active', deleting: false, plan: { in: ['monthly', 'yearly'] },
            currentPeriodStart: { lte: now }, currentPeriodEnd: { gt: now },
          } } } } },
        };
        const priority = await database.chatMessage.findFirst({ where: { AND: [where, paidWhere] }, select, orderBy });
        if (priority) return priority;
      }
      return database.chatMessage.findFirst({ where, select, orderBy });
    },
    async claim(caller, row, leaseId, now, until, host, olderThan) {
      const result = await database.chatMessage.updateMany({
        where: { AND: [await eligible(caller, now), { id: row.id, status: 'pending', ...(olderThan ? { createdAt: { lte: olderThan } } : {}) }] },
        data: { status: 'claimed', leaseId, leaseUntil: until, agentTokenId: caller.id, claimedBy: host },
      });
      return result.count === 1;
    },
    async payload(row: Candidate): Promise<ClaimPayload> {
      const context = record(row.context);
      // Old fast-lane rows contained only {question}. Recover the snapshot from
      // the question immediately before that hand-off, not today's map.
      const questionRow = await database.chatMessage.findFirst({
        where: { threadId: row.threadId, role: 'user', ...(typeof context.userMessageId === 'string' ? { id: context.userMessageId } : { createdAt: { lte: row.createdAt } }) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { context: true, content: true, createdAt: true, id: true },
      });
      const users = questionRow ? await database.chatMessage.findMany({
        where: { threadId: row.threadId, role: 'user', createdAt: { lte: questionRow.createdAt } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 6, select: { createdAt: true, id: true },
      }) : [];
      const oldest = users.at(-1);
      const messages = oldest ? await database.chatMessage.findMany({
        where: { threadId: row.threadId, role: { in: ['user', 'assistant'] }, status: 'complete', createdAt: { gte: oldest.createdAt, lte: row.createdAt } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 24, select: { role: true, content: true, context: true, createdAt: true },
      }) : [];
      const { question, userMessageId: _userMessageId, ...snapshot } = context;
      return {
        question: (typeof question === 'string' ? question : questionRow?.content ?? '').slice(0, 4000),
        context: { ...record(questionRow?.context), ...snapshot },
        thread: currentConversation(messages, { context: { ...record(questionRow?.context), ...snapshot }, createdAt: row.createdAt }).map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content.slice(0, 3000) })),
        // There is no learner profile field yet. Never infer a level from grades.
        user: { level: null, goal: null },
      };
    },
    async reply(caller: AgentPrincipal, id: string, leaseId: string, now: Date, reply: AgentReply, host: string) {
      return database.$transaction(async (tx) => {
        const where = await held(caller, id, leaseId, now, host);
        const row = await tx.chatMessage.findFirst({ where, select: { threadId: true, createdAt: true } });
        if (!row) return false;
        const result = await tx.chatMessage.updateMany({
          where,
          data: { content: reply.text, model: reply.model, toolsUsed: [...new Set(reply.toolsUsed)], images: reply.images as unknown as Prisma.InputJsonValue,
            status: 'complete', leaseId: null, leaseUntil: null, claimedBy: null, deliveredAt: now, costUsd: 0,
            promptTokens: reply.usage?.promptTokens ?? null, completionTokens: reply.usage?.completionTokens ?? null,
            latencyMs: reply.usage?.latencyMs ?? null },
        });
        if (result.count !== 1) return false;
        // Only a successfully leased, screened answer can switch this thread to
        // Haiku. Legacy daemons still provide their answer as the briefing.
        await tx.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${row.threadId} FOR UPDATE`;
        const thread = await tx.chatThread.findFirst({ where: { id: row.threadId }, select: { laptopBriefing: true } });
        const prior = record(thread?.laptopBriefing);
        const priorAt = Date.parse(String(prior.sourceCreatedAt ?? prior.at ?? ''));
        if (Number.isFinite(priorAt) && (priorAt > row.createdAt.getTime() || (priorAt === row.createdAt.getTime() && String(prior.messageId) > id))) return true;
        await tx.chatThread.update({ where: { id: row.threadId }, data: {
          laptopBriefing: { answer: reply.text, keyNumbers: reply.briefing?.keyNumbers ?? [],
            sources: reply.briefing?.sources ?? [], messageId: id, at: now.toISOString(), sourceCreatedAt: row.createdAt.toISOString() },
        } });
        return true;
      });
    },
    async release(caller, id, leaseId, now, host) {
      const result = await database.chatMessage.updateMany({
        where: await held(caller, id, leaseId, now, host, false),
        data: { status: 'pending', leaseId: null, leaseUntil: null, claimedBy: null, agentTokenId: null },
      });
      return result.count === 1;
    },
    async health(now) {
      const [pending, claimed, expired, oldest, delivered, heartbeats] = await Promise.all([
        database.chatMessage.count({ where: { lane: 'slow', status: 'pending' } }),
        database.chatMessage.count({ where: { lane: 'slow', status: 'claimed' } }),
        database.chatMessage.count({ where: { lane: 'slow', status: 'claimed', OR: [{ leaseUntil: { lte: now } }, { leaseUntil: null }] } }),
        database.chatMessage.findFirst({ where: { lane: 'slow', status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
        database.chatMessage.findFirst({ where: { lane: 'slow', status: 'complete', deliveredAt: { not: null } }, orderBy: { deliveredAt: 'desc' }, select: { deliveredAt: true } }),
        database.agentHeartbeat.findMany({ orderBy: { lastSeen: 'desc' }, take: 20, select: { host: true, role: true, runtime: true, version: true, lastSeen: true } }),
      ]);
      return { pending, claimed, expired, backlog: pending + claimed, oldestPendingAt: oldest?.createdAt.toISOString() ?? null,
        lastDeliveredAt: delivered?.deliveredAt?.toISOString() ?? null, heartbeats: heartbeats.map(({ host, role, runtime, version, lastSeen }) => ({ host, role, runtime, version, lastSeen })) };
    },
    async heartbeat(caller, input, now) {
      await database.agentHeartbeat.upsert({
        where: { host_tokenId: { host: input.host, tokenId: caller.id } },
        create: { host: input.host, tokenId: caller.id, role: input.role, runtime: input.runtime, version: input.version, lastSeen: now },
        update: { role: input.role, runtime: input.runtime, version: input.version, lastSeen: now },
      });
    },
  };
}
