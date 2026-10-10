/**
 * Who is asking, from Isobar's own records: device cookie, IP hash, sign-up
 * time, and the normalised mailbox (plus-addressing stripped).
 */

import { normalEmail } from '../account/email';
import { disposableDomain } from './disposable';

/** Ten minutes: two sign-ups on one IP in that window are one cluster. */
export const SIGNUP_WINDOW_MS = 10 * 60 * 1000;

/** Three blocks in a UTC day suspends the cluster. */
export const BLOCKS_BEFORE_SUSPEND = 3;

/** Lower case, plus-tag removed. `a+b@x.com` and `a@x.com` are one mailbox. */
export function clusterEmail(raw: string | null | undefined): string | null {
  const email = normalEmail(raw);
  if (!email) return null;
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at).split('+')[0];
  const domain = email.slice(at + 1);
  if (!local || !domain) return null;
  return `${local}@${domain}`;
}

export function isDisposableEmail(raw: string | null | undefined): boolean {
  return disposableDomain(clusterEmail(raw));
}

export interface LinkRecord {
  clusterId: string;
  kind: 'device' | 'ip' | 'email';
  hash: string;
}

export interface SignupRecord {
  clusterId: string;
  ipHash: string | null;
  atMs: number;
}

export interface ClusterMatch {
  clusterId: string | null;
  matched: boolean;
}

/**
 * The cluster this identity already belongs to, or null when nothing links.
 * Several matches: the cluster with the most hits, then the smaller id.
 */
export function resolveClusterId(
  input: { deviceHash: string | null; ipHash: string | null; email: string | null; signedUpAtMs: number | null },
  links: readonly LinkRecord[],
  signups: readonly SignupRecord[],
): ClusterMatch {
  const hits = new Map<string, number>();
  const add = (id: string) => hits.set(id, (hits.get(id) ?? 0) + 1);
  for (const link of links) {
    if (link.kind === 'device' && input.deviceHash && link.hash === input.deviceHash) add(link.clusterId);
    if (link.kind === 'ip' && input.ipHash && link.hash === input.ipHash) add(link.clusterId);
    if (link.kind === 'email' && input.email && link.hash === input.email) add(link.clusterId);
  }
  if (input.ipHash && input.signedUpAtMs != null) {
    for (const signup of signups) {
      if (signup.ipHash !== input.ipHash || !Number.isFinite(signup.atMs)) continue;
      if (Math.abs(signup.atMs - input.signedUpAtMs) <= SIGNUP_WINDOW_MS) add(signup.clusterId);
    }
  }
  if (hits.size === 0) return { clusterId: null, matched: false };
  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { clusterId: ranked[0][0], matched: true };
}

export function nextBlock(cluster: { blockDay: string | null; blockCount: number; suspended: boolean }, day: string): { blockDay: string; blockCount: number; suspended: boolean } {
  if (cluster.suspended) return { blockDay: cluster.blockDay ?? day, blockCount: cluster.blockCount, suspended: true };
  const blockCount = cluster.blockDay === day ? cluster.blockCount + 1 : 1;
  return { blockDay: day, blockCount, suspended: blockCount >= BLOCKS_BEFORE_SUSPEND };
}

/** Flagged accounts never get an allow from a malformed watcher line. */
export function accountFlagged(input: { tier: string; blockCount: number; grades: readonly string[]; disposable: boolean }): boolean {
  if (input.disposable) return true;
  if (input.tier !== 'opus') return true;
  if (input.blockCount > 0) return true;
  return input.grades.some((grade) => grade === 'off-purpose' || grade === 'abusive');
}
