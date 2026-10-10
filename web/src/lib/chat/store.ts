/** The rows the fast lane reads and writes. Prisma implements this; tests use a memory double. */

import type { LinkRecord } from './cluster';
import type { SpendRow } from './budgets';
import type { ArchiveResult } from './archive';
import type { Entitlement } from '../billing/policy';

export interface ClusterRow {
  id: string;
  suspended: boolean;
  blockDay: string | null;
  blockCount: number;
}

export interface StandingRow {
  tier: string;
  pinnedTier: string | null;
}

export interface StoredMessage {
  id: string;
  threadId: string;
  role: string;
  content: string;
  status: string;
  lane: string;
  context: unknown;
  model: string | null;
  effort: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
  costUsd: number | null;
  grade: string | null;
  gradeReason: string | null;
  failureReason: string | null;
  toolCalls: unknown;
  example: boolean;
  createdAt: Date;
}

export interface NewMessage {
  threadId: string;
  role: string;
  content: string;
  status: string;
  lane: string;
  context?: unknown;
  model?: string | null;
  effort?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs?: number | null;
  costUsd?: number | null;
  grade?: string | null;
  gradeReason?: string | null;
  failureReason?: string | null;
  toolCalls?: unknown;
  example?: boolean;
}

export interface ChatStore {
  accessBlocked(userId: string | null, deviceHash?: string | null): Promise<boolean>;
  linksMatching(deviceHash: string | null, ipHash: string | null, email: string | null): Promise<LinkRecord[]>;
  signupsOnIp(ipHash: string): Promise<{ clusterId: string; ipHash: string; atMs: number }[]>;
  ensureCluster(id: string): Promise<ClusterRow>;
  saveCluster(row: ClusterRow): Promise<void>;
  addLink(clusterId: string, kind: 'device' | 'ip' | 'email', hash: string): Promise<void>;
  /** Mark an address a suspended cluster used. A soft signal only: it never links accounts. */
  flagIp(ipHash: string, clusterId: string): Promise<void>;
  /** True when the address was flagged at or after `since`. */
  ipFlagged(ipHash: string, since: Date): Promise<boolean>;
  setUserCluster(userId: string, clusterId: string): Promise<void>;
  clusterUserIds(clusterId: string): Promise<string[]>;
  standing(userId: string): Promise<StandingRow | null>;
  setStanding(userId: string, tier: string, pinnedTier: string | null): Promise<void>;
  /** Newest first. */
  grades(userId: string, limit: number): Promise<string[]>;
  thread(userId: string | null, deviceHash: string | null): Promise<{ id: string; laptopBriefing?: unknown }>;
  history(threadId: string, limit: number): Promise<StoredMessage[]>;
  insert(row: NewMessage): Promise<StoredMessage>;
  update(id: string, patch: Partial<NewMessage>): Promise<void>;
  pendingSlow(userId: string): Promise<boolean>;
  /** Atomic, per-user admission: standing and one pending/claimed job across all threads. */
  queueSlow(userId: string, row: NewMessage): Promise<ArchiveResult>;
  cancelSlow(userId: string, messageId: string): Promise<ArchiveResult>;
  archiveTarget(userId: string, answerId: string): Promise<{ question: StoredMessage; answer: StoredMessage } | null>;
  anonCount(key: string, day: string): Promise<number>;
  /** Atomic increment; returns the count including this message. */
  bumpAnon(key: string, day: string): Promise<number>;
  spendSince(since: Date, until: Date): Promise<SpendRow[]>;
  entitlement?(userId: string): Promise<Entitlement | null>;
  /** Atomic daily claim; false means another request already claimed it. */
  claimNotice?(id: string): Promise<boolean>;
  hasNotice(id: string): Promise<boolean>;
  markNotice(id: string): Promise<void>;
  /** Newest marked replies, each with the question that prompted it. */
  examples(limit: number): Promise<{ question: string; context: unknown; reply: string }[]>;
  markExample(id: string, example: boolean): Promise<void>;
}
