/** Owner view of standing, blocks and the month's ledger. Pure: the page only fetches. */

import { dailyAllowance, publicSpend, userSpend, type SpendRow } from './budgets';
import { clusterEmail } from './cluster';
import { monthStart, type Tier } from './types';

export function ownerAllowed(email: string | null | undefined, ownerEmail: string | null | undefined): boolean {
  const owner = clusterEmail(ownerEmail);
  return !!owner && clusterEmail(email) === owner;
}

export interface AdminGrade {
  grade: string;
  reason: string | null;
  at: string;
}

export interface AdminUserRow {
  id: string;
  email: string | null;
  clusterId: string | null;
  tier: string;
  pinnedTier: string | null;
  monthUsd: number;
  todayUsd: number;
  todayAllowance: number;
  todayLeft: number;
  grades: AdminGrade[];
}

export interface AdminPool {
  spentMonth: number;
  allowanceToday: number;
  leftToday: number;
}

export interface AdminView {
  users: AdminUserRow[];
  suspensions: { clusterId: string; blockCount: number; messages: string[] }[];
  models: { opus: number; sonnet: number; haiku: number };
  publicPools: { opus: AdminPool; sonnet: AdminPool; haiku: AdminPool };
  signedInUsd: number;
  signedInCap: number;
}

export interface AdminInput {
  now: Date;
  userCap: number;
  publicCaps: { opus: number; sonnet: number; haiku: number };
  signedInCap: number;
  users: { id: string; email: string | null; clusterId: string | null; tier: string | null; pinnedTier: string | null }[];
  clusters: { id: string; suspended: boolean; blockCount: number }[];
  grades: { userId: string; grade: string; reason: string | null; at: Date }[];
  /** User messages that the watcher blocked, already limited. */
  blocked: { clusterId: string | null; content: string }[];
  spend: SpendRow[];
}

function pool(monthBeforeToday: number, today: number, cap: number, now: Date): AdminPool {
  const allowanceToday = dailyAllowance(cap, monthBeforeToday, now);
  return {
    spentMonth: monthBeforeToday + today,
    allowanceToday,
    leftToday: Math.max(0, allowanceToday - today),
  };
}

export function shapeAdmin(input: AdminInput): AdminView {
  const start = monthStart(input.now);
  const models = { opus: 0, sonnet: 0, haiku: 0 };
  let signedInUsd = 0;
  for (const row of input.spend) {
    if (row.createdAt < start || row.createdAt >= input.now || row.costUsd == null) continue;
    const family = row.model?.includes('opus') ? 'opus' : row.model?.includes('sonnet') ? 'sonnet' : row.model?.includes('haiku') ? 'haiku' : null;
    if (family) models[family] += row.costUsd;
    if (row.userId && !row.owner) signedInUsd += row.costUsd;
  }
  const pub = publicSpend(input.spend, input.now);
  const users = input.users.map((user) => {
    const spend = userSpend(input.spend, user.id, input.now).spend;
    const allowance = dailyAllowance(input.userCap, spend.monthBeforeToday, input.now);
    const grades = input.grades.filter((grade) => grade.userId === user.id).slice(0, 10).map((grade) => ({
      grade: grade.grade, reason: grade.reason, at: grade.at.toISOString(),
    }));
    return {
      id: user.id,
      email: user.email,
      clusterId: user.clusterId,
      tier: user.tier ?? 'opus',
      pinnedTier: user.pinnedTier,
      monthUsd: spend.monthBeforeToday + spend.today,
      todayUsd: spend.today,
      todayAllowance: allowance,
      todayLeft: Math.max(0, allowance - spend.today),
      grades,
    };
  });
  const byCluster = new Map<string, string[]>();
  for (const message of input.blocked) {
    if (!message.clusterId) continue;
    const list = byCluster.get(message.clusterId) ?? [];
    if (list.length < 8) list.push(message.content.slice(0, 180));
    byCluster.set(message.clusterId, list);
  }
  const suspensions = input.clusters.filter((cluster) => cluster.suspended).map((cluster) => ({
    clusterId: cluster.id, blockCount: cluster.blockCount, messages: byCluster.get(cluster.id) ?? [],
  }));
  return {
    users,
    suspensions,
    models,
    publicPools: {
      opus: pool(pub.opus.monthBeforeToday, pub.opus.today, input.publicCaps.opus, input.now),
      sonnet: pool(pub.sonnet.monthBeforeToday, pub.sonnet.today, input.publicCaps.sonnet, input.now),
      haiku: pool(pub.haiku.monthBeforeToday, pub.haiku.today, input.publicCaps.haiku, input.now),
    },
    signedInUsd,
    signedInCap: input.signedInCap,
  };
}

export function parsePin(value: string | null): Tier | null | undefined {
  if (value == null) return undefined;
  if (value === '') return null;
  return value === 'opus' || value === 'sonnet' || value === 'haiku' || value === 'off' ? value : undefined;
}
