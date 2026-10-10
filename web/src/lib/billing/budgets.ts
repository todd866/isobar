import type { Entitlement } from './policy';
import { monthlyWindow, hasPaidAccess } from './policy';

export const FREE_MONTHLY_USD = 1;
export const FREE_SOFT_USD = 0.8;
export const PAID_OPUS_USD = 5;
export const PAID_SONNET_USD = 8;
export const PAID_HAIKU_USD = 10;

export type BillingTier = 'opus' | 'sonnet' | 'haiku' | 'haiku-short' | 'rest';

export interface BillingSpendRow {
  userId: string | null;
  deviceHash?: string | null;
  costUsd: number | null;
  createdAt: Date;
  lane?: string | null;
}

export function spendForIdentity(rows: readonly BillingSpendRow[], userId: string | null, deviceHash: string | null, now: Date, entitlement: Entitlement | null = null): number | null {
  const window = entitlement && hasPaidAccess(entitlement, now)
    ? monthlyWindow(entitlement, now)
    : { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: now };
  let total = 0;
  for (const row of rows) {
    if (row.lane === 'slow') continue;
    if (row.createdAt < window.start || row.createdAt >= window.end || row.createdAt >= now) continue;
    if ((userId != null && row.userId === userId) || (userId == null && deviceHash != null && row.deviceHash === deviceHash)) {
      if (row.costUsd == null || !Number.isFinite(row.costUsd) || row.costUsd < 0) return null;
      total += row.costUsd;
    }
  }
  return total;
}

export function paidTier(spend: number | null): BillingTier {
  if (spend == null) return 'haiku-short';
  if (spend < PAID_OPUS_USD) return 'opus';
  if (spend < PAID_SONNET_USD) return 'sonnet';
  if (spend < PAID_HAIKU_USD) return 'haiku';
  return 'haiku-short';
}

export function freeTier(spend: number | null): BillingTier {
  if (spend == null || spend >= FREE_MONTHLY_USD) return 'rest';
  return spend >= FREE_SOFT_USD ? 'haiku-short' : 'haiku';
}

export function isPaid(entitlement: Entitlement | null, now: Date): boolean {
  return hasPaidAccess(entitlement, now);
}

export function upgradeNoticeId(now: Date, identity: string): string {
  const day = now.toISOString().slice(0, 10);
  return `billing-upgrade-${day}-${identity}`;
}
