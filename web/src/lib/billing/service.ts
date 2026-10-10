import { createHash } from 'node:crypto';
import { hasPaidAccess, type Entitlement, type Plan } from './policy';
import { StripeFailure, type StripeClient, type StripeEvent, type StripeObject } from './stripe';

export interface BillingTx {
  row(): Promise<Entitlement | null>;
  save(patch: Partial<Omit<Entitlement, 'userId'>> & { checkoutSessionId?: string | null }): Promise<void>;
  checkoutSessionId(): Promise<string | null>;
  seen(id: string): Promise<boolean>;
  mark(id: string): Promise<void>;
  removeUser(email: string | null): Promise<void>;
}
export interface BillingStore {
  get(userId: string): Promise<Entitlement | null>;
  userForCustomer(customerId: string): Promise<string | null>;
  /** Lock one existing user for the entire operation, including provider reads. */
  locked<T>(userId: string, fn: (tx: BillingTx) => Promise<T>): Promise<T>;
}
export interface BillingConfig { monthly: string; yearly: string }
export class BillingConflict extends Error {}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const idOf = (value: unknown): string | null => typeof value === 'string' ? value : typeof object(value).id === 'string' ? object(value).id as string : null;
const dateOf = (value: unknown): Date | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
const key = (value: string) => createHash('sha256').update(`isobar-billing-v1:${value}`).digest('hex');

export function subscriptionState(sub: StripeObject, config: BillingConfig): Partial<Entitlement> | null {
  const items = object(sub.items).data;
  if (!Array.isArray(items) || items.length !== 1) return null;
  const item = object(items[0]);
  const price = idOf(item.price);
  const plan: Plan | null = price === config.monthly ? 'monthly' : price === config.yearly ? 'yearly' : null;
  if (!plan || item.quantity !== 1) return null;
  return { plan, status: String(sub.status), stripeSubscriptionId: sub.id,
    currentPeriodStart: dateOf(sub.current_period_start ?? item.current_period_start),
    currentPeriodEnd: dateOf(sub.current_period_end ?? item.current_period_end),
    billingAnchor: dateOf(sub.billing_cycle_anchor ?? sub.start_date), cancelAtPeriodEnd: sub.cancel_at_period_end === true };
}

async function reconcile(tx: BillingTx, stripe: StripeClient, config: BillingConfig, customerId: string): Promise<StripeObject[]> {
  const row = await tx.row();
  const subscriptions = await stripe.list('subscriptions', { customer: customerId, status: 'all' });
  const live = subscriptions.filter((sub) => sub.status !== 'canceled' && sub.status !== 'incomplete_expired');
  const recognized = subscriptions.filter((sub) => idOf(sub.customer) === customerId
    && object(sub.metadata).isobarUserId === row?.userId && subscriptionState(sub, config));
  // Prefer a live subscription; an old cancellation must never revoke its replacement.
  recognized.sort((a, b) => Number(live.includes(b)) - Number(live.includes(a)) || Number(b.created) - Number(a.created));
  const state = recognized[0] ? subscriptionState(recognized[0], config)! : {
    plan: null, status: 'none', stripeSubscriptionId: null, currentPeriodStart: null, currentPeriodEnd: null, billingAnchor: null, cancelAtPeriodEnd: false,
  };
  await tx.save(state);
  return live;
}

export async function checkout(store: BillingStore, stripe: StripeClient, config: BillingConfig,
  user: { id: string; email: string | null }, plan: Plan, origin: string): Promise<string> {
  // Commit the customer reference before starting Checkout. Provider failures
  // later must not roll this durable identity back into an orphaned customer.
  await store.locked(user.id, async (tx) => {
    const row = await tx.row();
    if (row?.deleting) throw new BillingConflict('Account deletion in progress');
    let customer = row?.stripeCustomerId;
    if (!customer) {
      const made = await stripe.request('POST', 'customers', {
        'metadata[isobarUserId]': user.id, ...(user.email ? { email: user.email } : {}),
      }, key(`customer:${user.id}`));
      customer = made.id;
      await tx.save({ stripeCustomerId: customer });
    }
  });
  return store.locked(user.id, async (tx) => {
    const row = await tx.row();
    if (!row?.stripeCustomerId || row.deleting) throw new BillingConflict('Account deletion in progress');
    const customer = row.stripeCustomerId;
    const subscriptions = await stripe.list('subscriptions', { customer, status: 'all' });
    if (subscriptions.some((sub) => sub.status !== 'canceled' && sub.status !== 'incomplete_expired')) throw new BillingConflict('Manage your existing subscription');
    // Store a stable attempt before creating Checkout. A lost HTTP response retries
    // the same provider operation. Open sessions are reused, or expired to switch plan.
    const previous = await tx.checkoutSessionId();
    if (previous) {
      const session = await stripe.request('GET', `checkout/sessions/${encodeURIComponent(previous)}`);
      if (session.status === 'open') {
        if (object(session.metadata).plan === plan && typeof session.url === 'string') return session.url;
        await stripe.request('POST', `checkout/sessions/${encodeURIComponent(previous)}/expire`);
      }
      // Completion can precede its webhook. Stripe's current subscription list above
      // prevents duplicate subscriptions; a completed session awaiting settlement rests.
      if (session.status === 'complete' && !subscriptions.some((sub) => sub.id === idOf(session.subscription))) throw new BillingConflict('Payment is still being confirmed');
    }
    const sessions = await stripe.list('checkout/sessions', { customer, status: 'open' });
    for (const session of sessions) {
      if (object(session.metadata).isobarUserId !== user.id) continue;
      if (object(session.metadata).plan === plan && typeof session.url === 'string') {
        await tx.save({ checkoutSessionId: session.id });
        return session.url;
      }
      await stripe.request('POST', `checkout/sessions/${encodeURIComponent(session.id)}/expire`);
    }
    const session = await stripe.request('POST', 'checkout/sessions', {
      mode: 'subscription', customer, client_reference_id: user.id,
      'line_items[0][price]': config[plan], 'line_items[0][quantity]': '1',
      'automatic_tax[enabled]': 'true', 'tax_id_collection[enabled]': 'true', billing_address_collection: 'required',
      'customer_update[address]': 'auto', 'customer_update[name]': 'auto',
      'metadata[isobarUserId]': user.id, 'metadata[plan]': plan,
      'subscription_data[metadata][isobarUserId]': user.id,
      success_url: `${origin}/?account=1&billing=success`, cancel_url: `${origin}/?account=1&billing=cancel`,
    }, key(`checkout:${user.id}:${plan}:${previous ?? 'first'}:${Math.floor(Date.now() / 1_800_000)}`));
    if (typeof session.url !== 'string') throw new StripeFailure(502);
    await tx.save({ checkoutSessionId: session.id });
    return session.url;
  });
}

export async function portal(store: BillingStore, stripe: StripeClient, userId: string, origin: string): Promise<string> {
  return store.locked(userId, async (tx) => {
    const row = await tx.row();
    if (!row?.stripeCustomerId || row.deleting) throw new BillingConflict('No billing account');
    const session = await stripe.request('POST', 'billing_portal/sessions', { customer: row.stripeCustomerId, return_url: `${origin}/?account=1` });
    if (typeof session.url !== 'string') throw new StripeFailure(502);
    return session.url;
  });
}

const EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed']);

export async function webhook(store: BillingStore, stripe: StripeClient, config: BillingConfig, event: StripeEvent): Promise<void> {
  if (!EVENTS.has(event.type)) return;
  const customer = idOf(event.data.object.customer);
  if (!customer) return;
  const userId = await store.userForCustomer(customer);
  if (!userId) return; // Deleted/foreign customers cannot create or claim an account.
  await store.locked(userId, async (tx) => {
    if (await tx.seen(event.id)) return;
    const row = await tx.row();
    if (!row || row.deleting || row.stripeCustomerId !== customer) return;
    // Read authoritative state *after* taking the lock. Out-of-order events,
    // including same-second events, never write their historical snapshots.
    await reconcile(tx, stripe, config, customer);
    await tx.mark(event.id); // Same transaction as entitlement; failures retry.
  });
}

/** Stripe customer deletion cancels all subscriptions, including a racing Checkout.
 * Provider failure leaves the local account intact and the action retryable. */
export async function deleteBillingAccount(store: BillingStore, stripe: StripeClient | null, userId: string, email: string | null): Promise<void> {
  await store.locked(userId, async (tx) => {
    const row = await tx.row();
    if (row?.stripeCustomerId) {
      if (!stripe) throw new StripeFailure(503);
      await tx.save({ deleting: true });
      const customer = row.stripeCustomerId;
      try {
        const sessions = await stripe.list('checkout/sessions', { customer, status: 'open' });
        for (const session of sessions) await stripe.request('POST', `checkout/sessions/${encodeURIComponent(session.id)}/expire`);
        await stripe.request('DELETE', `customers/${encodeURIComponent(customer)}`);
      } catch (error) {
        // A missing Checkout session is not proof the customer was removed.
        // Confirm customer deletion before erasing the local cancellation handle.
        if (!(error instanceof StripeFailure && error.status === 404 && error.code === 'resource_missing')) throw error;
        let absent = false;
        try {
          const remaining = await stripe.request('GET', `customers/${encodeURIComponent(customer)}`);
          absent = remaining.deleted === true;
        } catch (confirmation) {
          if (!(confirmation instanceof StripeFailure && confirmation.status === 404 && confirmation.code === 'resource_missing')) throw confirmation;
          absent = true;
        }
        if (!absent) throw error;
      }
    }
    await tx.removeUser(email);
  });
}

export function billingView(row: Entitlement | null, now: Date) {
  return { enabled: true, paid: hasPaidAccess(row, now), plan: row?.plan ?? null, status: row?.status ?? null,
    currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null, cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false };
}
