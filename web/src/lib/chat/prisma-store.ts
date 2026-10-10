/** Prisma backing for the fast lane. Migrations are applied by the owner, not here. */

import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { activeAccessBlock } from './access-block';
import { clusterEmail } from './cluster';
import type { SpendRow } from './budgets';
import type { Entitlement } from '../billing/policy';
import type { ChatStore, ClusterRow, NewMessage, StoredMessage } from './store';
import { db } from '../server/prisma';
import { prismaArchiveStore } from './archive-store';

function message(row: {
  id: string; threadId: string; role: string; content: string; status: string; lane: string; context: unknown;
  model: string | null; effort: string | null; promptTokens: number | null; completionTokens: number | null;
  latencyMs: number | null; costUsd: number | null;   grade: string | null; gradeReason: string | null;
  failureReason: string | null; toolCalls: unknown; example: boolean; createdAt: Date;
}): StoredMessage {
  return row;
}

export function prismaChatStore(ownerEmail: string | null): ChatStore {
  const database = db();
  return {
    async accessBlocked(userId, deviceHash) { return (await activeAccessBlock(database, userId, new Date(), deviceHash ?? null)).blocked; },
    ...prismaArchiveStore(database, ownerEmail),
    async linksMatching(deviceHash, ipHash, email) {
      const OR = [
        deviceHash ? { kind: 'device', hash: deviceHash } : null,
        ipHash ? { kind: 'ip', hash: ipHash } : null,
        email ? { kind: 'email', hash: email } : null,
      ].filter((item): item is { kind: string; hash: string } => !!item);
      if (!OR.length) return [];
      const rows = await database.chatLink.findMany({ where: { OR } });
      return rows.map((row) => ({ clusterId: row.clusterId, kind: row.kind as 'device' | 'ip' | 'email', hash: row.hash }));
    },
    async flagIp(ipHash, clusterId) {
      await database.chatLink.upsert({
        where: { kind_hash: { kind: 'ipflag', hash: ipHash } },
        create: { clusterId, kind: 'ipflag', hash: ipHash },
        update: { clusterId, createdAt: new Date() },
      });
    },
    async ipFlagged(ipHash, since) {
      return !!(await database.chatLink.findFirst({ where: { kind: 'ipflag', hash: ipHash, createdAt: { gte: since } }, select: { id: true } }));
    },
    async signupsOnIp(ipHash) {
      const links = await database.chatLink.findMany({ where: { kind: 'ip', hash: ipHash }, select: { clusterId: true } });
      if (!links.length) return [];
      const users = await database.user.findMany({
        where: { clusterId: { in: links.map((link) => link.clusterId) } },
        select: { clusterId: true, createdAt: true },
      });
      return users.flatMap((user) => user.clusterId ? [{ clusterId: user.clusterId, ipHash, atMs: user.createdAt.getTime() }] : []);
    },
    async ensureCluster(id) {
      const row = await database.chatCluster.upsert({
        where: { id },
        create: { id, suspended: false, blockCount: 0 },
        update: {},
      });
      return { id: row.id, suspended: row.suspended, blockDay: row.blockDay, blockCount: row.blockCount };
    },
    async saveCluster(row: ClusterRow) {
      await database.chatCluster.update({
        where: { id: row.id },
        data: { suspended: row.suspended, blockDay: row.blockDay, blockCount: row.blockCount },
      });
    },
    async addLink(clusterId, kind, hash) {
      try {
        await database.chatLink.create({ data: { clusterId, kind, hash } });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      }
    },
    async setUserCluster(userId, clusterId) {
      await database.user.update({ where: { id: userId }, data: { clusterId } });
    },
    async clusterUserIds(clusterId) {
      const users = await database.user.findMany({ where: { clusterId }, select: { id: true } });
      return users.map((user) => user.id);
    },
    async standing(userId) {
      const row = await database.chatStanding.findUnique({ where: { userId } });
      return row ? { tier: row.tier, pinnedTier: row.pinnedTier } : null;
    },
    async setStanding(userId, tier, pinnedTier) {
      await database.chatStanding.upsert({
        where: { userId },
        create: { userId, tier, pinnedTier },
        update: { tier, pinnedTier },
      });
    },
    async grades(userId, limit) {
      const rows = await database.chatMessage.findMany({
        where: { grade: { not: null }, thread: { userId } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { grade: true },
      });
      return rows.flatMap((row) => row.grade ? [row.grade] : []);
    },
    async thread(userId, deviceHash) {
      const existing = await database.chatThread.findFirst({
        where: userId ? { userId } : { deviceHash },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, laptopBriefing: true },
      });
      if (existing) return existing;
      return database.chatThread.create({ data: { userId, deviceHash }, select: { id: true, laptopBriefing: true } });
    },
    async history(threadId, limit) {
      const rows = await database.chatMessage.findMany({ where: { threadId }, orderBy: { createdAt: 'desc' }, take: limit });
      return rows.reverse().map(message);
    },
    async insert(row: NewMessage) {
      const created = await database.chatMessage.create({
        data: {
          threadId: row.threadId, role: row.role, content: row.content, status: row.status, lane: row.lane,
          context: row.context == null ? undefined : row.context as Prisma.InputJsonValue,
          model: row.model ?? null, effort: row.effort ?? null,
          promptTokens: row.promptTokens ?? null, completionTokens: row.completionTokens ?? null,
          latencyMs: row.latencyMs ?? null, costUsd: row.costUsd ?? null,
          grade: row.grade ?? null, gradeReason: row.gradeReason ?? null, failureReason: row.failureReason ?? null,
          toolCalls: row.toolCalls == null ? undefined : row.toolCalls as Prisma.InputJsonValue,
          example: row.example ?? false,
          deliveredAt: row.role === 'assistant' && row.status === 'complete' ? new Date() : undefined,
        },
      });
      return message(created);
    },
    async update(id, patch) {
      await database.chatMessage.update({
        where: { id },
        data: {
          content: patch.content, status: patch.status, grade: patch.grade, gradeReason: patch.gradeReason,
          failureReason: patch.failureReason, model: patch.model, costUsd: patch.costUsd,
          promptTokens: patch.promptTokens, completionTokens: patch.completionTokens,
          latencyMs: patch.latencyMs, effort: patch.effort,
          context: patch.context === undefined ? undefined : patch.context as Prisma.InputJsonValue,
          toolCalls: patch.toolCalls === undefined ? undefined : patch.toolCalls as Prisma.InputJsonValue,
          example: patch.example,
          ...(patch.status === 'complete' ? { deliveredAt: new Date() } : {}),
        },
      });
    },
    async pendingSlow(userId) {
      const row = await database.chatMessage.findFirst({
        where: { lane: 'slow', status: { in: ['pending', 'claimed'] }, thread: { userId } },
        select: { id: true },
      });
      return !!row;
    },
    async anonCount(key, day) {
      const row = await database.anonChatQuota.findUnique({ where: { deviceHash_day: { deviceHash: key, day } } });
      return row?.count ?? 0;
    },
    async bumpAnon(key, day) {
      const row = await database.anonChatQuota.upsert({
        where: { deviceHash_day: { deviceHash: key, day } },
        create: { deviceHash: key, day, count: 1 },
        update: { count: { increment: 1 } },
        select: { count: true },
      });
      return row.count;
    },
    async spendSince(since, until) {
      const rows = await database.chatMessage.findMany({
        where: { lane: 'fast', createdAt: { gte: since, lt: until }, model: { not: null } },
        select: {
          model: true, costUsd: true, createdAt: true, lane: true,
          thread: { select: { userId: true, deviceHash: true, user: { select: { email: true } } } },
        },
      });
      return rows.map((row): SpendRow => ({
        userId: row.thread.userId,
        deviceHash: row.thread.deviceHash,
        model: row.model,
        costUsd: row.costUsd,
        createdAt: row.createdAt,
        lane: row.lane,
        owner: clusterEmail(row.thread.user?.email) === ownerEmail && !!ownerEmail,
      }));
    },
    async entitlement(userId) {
      return (database as PrismaClient & { entitlement: { findUnique(args: unknown): Promise<Entitlement | null> } }).entitlement.findUnique({ where: { userId } });
    },
    async claimNotice(id) {
      try {
        await database.chatNotice.create({ data: { id } });
        return true;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
        throw error;
      }
    },
    async hasNotice(id) {
      return !!(await database.chatNotice.findUnique({ where: { id }, select: { id: true } }));
    },
    async markNotice(id) {
      await database.chatNotice.upsert({ where: { id }, create: { id }, update: {} });
    },
    async examples(limit) {
      const replies = await database.chatMessage.findMany({
        where: { example: true, role: 'assistant' },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      const out: { question: string; context: unknown; reply: string }[] = [];
      for (const reply of replies) {
        const question = await database.chatMessage.findFirst({
          where: { threadId: reply.threadId, role: 'user', createdAt: { lte: reply.createdAt } },
          orderBy: { createdAt: 'desc' },
        });
        if (!question) continue;
        out.push({ question: question.content, context: question.context, reply: reply.content });
      }
      return out;
    },
    async markExample(id, example) {
      await database.chatMessage.update({ where: { id }, data: { example } });
    },
  };
}
