/** Billing is optional. No configured Stripe installation means no paid tier. */
export type Plan = 'monthly' | 'yearly';
export interface Entitlement {
  userId: string;
  plan: string | null;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  billingAnchor: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  cancelAtPeriodEnd: boolean;
  deleting: boolean;
}

export function billingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_YEARLY'].every((key) => !!env[key]?.trim());
}

/** Cancel-at-period-end remains active; past-due/immediate cancellation does not. */
export function hasPaidAccess(row: Entitlement | null, now: Date): boolean {
  return !!row && !row.deleting && (row.plan === 'monthly' || row.plan === 'yearly') && row.status === 'active'
    && !!row.currentPeriodStart && row.currentPeriodStart <= now
    && !!row.currentPeriodEnd && row.currentPeriodEnd > now;
}

function anniversary(anchor: Date, months: number): Date {
  const result = new Date(anchor);
  result.setUTCDate(1);
  result.setUTCMonth(anchor.getUTCMonth() + months);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(anchor.getUTCDate(), last));
  return result;
}

/** Annual billing still buys a monthly API allowance. Clamp month-end anchors. */
export function monthlyWindow(row: Entitlement | null, now: Date): { start: Date; end: Date } {
  const anchor = row?.billingAnchor ?? row?.currentPeriodStart;
  if (!anchor || !Number.isFinite(anchor.getTime()) || anchor > now) {
    return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
  }
  let months = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth();
  if (anniversary(anchor, months) > now) months -= 1;
  const start = anniversary(anchor, months);
  const end = anniversary(anchor, months + 1);
  return { start: row?.currentPeriodStart && row.currentPeriodStart > start ? row.currentPeriodStart : start,
    end: row?.currentPeriodEnd && row.currentPeriodEnd < end ? row.currentPeriodEnd : end };
}
