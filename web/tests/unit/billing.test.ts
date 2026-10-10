import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { billingEnabled, hasPaidAccess, monthlyWindow, type Entitlement } from '../../src/lib/billing/policy';
import { billingView, checkout, deleteBillingAccount, portal, webhook, type BillingStore, type BillingTx } from '../../src/lib/billing/service';
import { stripeClient, StripeFailure, verifyEvent, type StripeClient, type StripeEvent, type StripeObject } from '../../src/lib/billing/stripe';
import { setupStripe } from '../../scripts/setup-stripe';

const now = new Date('2026-10-09T12:00:00Z');
const config = { monthly: 'price_m', yearly: 'price_y' };
const row = (): Entitlement => ({ userId: 'u1', plan: 'monthly', status: 'active',
  currentPeriodStart: new Date('2026-10-01Z'), currentPeriodEnd: new Date('2026-11-01Z'), billingAnchor: new Date('2026-10-01Z'),
  stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', cancelAtPeriodEnd: false, deleting: false });
const sub = (status = 'active'): StripeObject => ({ id: 'sub_1', customer: 'cus_1', status, created: 1,
  metadata: { isobarUserId: 'u1' },
  current_period_start: Date.parse('2026-10-01Z') / 1000, current_period_end: Date.parse('2026-11-01Z') / 1000,
  billing_cycle_anchor: Date.parse('2026-10-01Z') / 1000, items: { data: [{ quantity: 1, price: { id: config.monthly } }] } });
const event = (id = 'evt_1', status = 'active'): StripeEvent => ({ id, type: 'customer.subscription.updated', data: { object: sub(status) } });

/** Transaction double has serialization and rollback; provider state lives outside it. */
class MemoryStore implements BillingStore {
  value: Entitlement | null = row();
  session: string | null = null;
  events = new Set<string>();
  deleted = false;
  failMark = false;
  private tail: Promise<unknown> = Promise.resolve();
  async get() { return this.value; }
  async userForCustomer(customer: string) { return this.value?.stripeCustomerId === customer && !this.deleted ? 'u1' : null; }
  async locked<T>(_id: string, fn: (tx: BillingTx) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.deleted) throw new Error('missing account');
      const snapshot = structuredClone({ value: this.value, session: this.session, events: this.events, deleted: this.deleted });
      try {
        return await fn({
          row: async () => this.value,
          save: async (patch) => { this.value = { ...(this.value ?? { ...row(), status: 'none', plan: null, stripeCustomerId: null, stripeSubscriptionId: null }), ...patch }; if ('checkoutSessionId' in patch) this.session = patch.checkoutSessionId ?? null; },
          checkoutSessionId: async () => this.session,
          seen: async (id) => this.events.has(id),
          mark: async (id) => { if (this.failMark) throw new Error('database'); this.events.add(id); },
          removeUser: async () => { this.deleted = true; this.value = null; },
        });
      } catch (error) { Object.assign(this, snapshot); throw error; }
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
function provider(subscriptions: StripeObject[] = [sub()]) {
  const request = vi.fn(async (_method: string, path: string) => {
    if (path === 'customers') return { id: 'cus_1' };
    if (path === 'checkout/sessions') return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/test' };
    if (path === 'billing_portal/sessions') return { id: 'bps_1', url: 'https://billing.stripe.com/p/session/test' };
    if (path.startsWith('checkout/sessions/')) return { id: 'cs_1', status: 'open', url: 'https://checkout.stripe.com/c/pay/test', metadata: { plan: 'monthly' } };
    return { id: 'cus_1', deleted: true };
  });
  const list = vi.fn(async (path: string) => path === 'subscriptions' ? subscriptions : []);
  return { request, list, stripe: { request, list } as unknown as StripeClient };
}

describe('webhook authentication', () => {
  const raw = JSON.stringify(event());
  const sign = (text = raw, timestamp = now.getTime() / 1000) => `t=${timestamp},v1=${createHmac('sha256', 'whsec_test').update(`${timestamp}.${text}`).digest('hex')}`;
  it('verifies raw bytes and rotated signatures', () => {
    expect(verifyEvent(raw, `v1=${'0'.repeat(64)},${sign()}`, 'whsec_test', now).id).toBe('evt_1');
    expect(() => verifyEvent(`${raw} `, sign(), 'whsec_test', now)).toThrow();
    expect(() => verifyEvent(raw, sign(), 'wrong', now)).toThrow();
    expect(() => verifyEvent(raw, null, 'whsec_test', now)).toThrow();
  });
  it('rejects stale, future, malformed and duplicate timestamp signatures', () => {
    for (const header of [sign(raw, now.getTime() / 1000 - 301), sign(raw, now.getTime() / 1000 + 301), 't=no,v1=no', `${sign()},t=1`]) {
      expect(() => verifyEvent(raw, header, 'whsec_test', now)).toThrow();
    }
  });
});

describe('entitlement transitions', () => {
  it('only grants current active recognized plans; scheduled cancellation keeps access', () => {
    expect(hasPaidAccess(row(), now)).toBe(true);
    expect(hasPaidAccess({ ...row(), cancelAtPeriodEnd: true }, now)).toBe(true);
    for (const status of ['past_due', 'canceled', 'unpaid', 'incomplete', 'trialing']) expect(hasPaidAccess({ ...row(), status }, now)).toBe(false);
    expect(hasPaidAccess(row(), new Date('2026-11-01Z'))).toBe(false);
    expect(hasPaidAccess({ ...row(), currentPeriodStart: new Date('2026-10-10Z') }, now)).toBe(false);
    expect(hasPaidAccess({ ...row(), deleting: true }, now)).toBe(false);
    expect(hasPaidAccess({ ...row(), plan: 'other' }, now)).toBe(false);
  });
  it('slices annual subscriptions monthly, keeping a Jan 31 UTC anniversary after February', () => {
    const annual = { ...row(), plan: 'yearly', billingAnchor: new Date('2026-01-31T12:15:00Z'), currentPeriodStart: new Date('2026-01-31T12:15:00Z'), currentPeriodEnd: new Date('2027-01-31T12:15:00Z') };
    expect(monthlyWindow(annual, new Date('2026-03-01Z'))).toEqual({ start: new Date('2026-02-28T12:15:00Z'), end: new Date('2026-03-31T12:15:00Z') });
    expect(monthlyWindow(null, now).start).toEqual(new Date('2026-10-01Z'));
  });
  it('is disabled unless the complete configuration exists; client view has no IDs', () => {
    expect(billingEnabled({})).toBe(false);
    expect(billingEnabled({ STRIPE_SECRET_KEY: 'test' })).toBe(false);
    expect(billingEnabled({ STRIPE_SECRET_KEY: 'test', STRIPE_WEBHOOK_SECRET: 'test', STRIPE_PRICE_MONTHLY: 'm', STRIPE_PRICE_YEARLY: 'y' })).toBe(true);
    expect(JSON.stringify(billingView(row(), now))).not.toContain('cus_');
  });
});

describe('webhook reconciliation', () => {
  it('duplicate and concurrent deliveries commit once', async () => {
    const store = new MemoryStore(), mock = provider();
    await Promise.all([webhook(store, mock.stripe, config, event()), webhook(store, mock.stripe, config, event())]);
    expect(mock.list).toHaveBeenCalledTimes(1);
    expect(store.events.size).toBe(1);
  });
  it('out-of-order active payload cannot restore a past-due/canceled subscription', async () => {
    const store = new MemoryStore();
    for (const status of ['past_due', 'canceled']) {
      const mock = provider([sub(status)]);
      await webhook(store, mock.stripe, config, event(`evt_${status}`, 'active'));
      expect(store.value?.status).toBe(status);
      expect(hasPaidAccess(store.value, now)).toBe(false);
    }
    await webhook(store, provider([sub()]).stripe, config, event('evt_recovery', 'past_due'));
    expect(hasPaidAccess(store.value, now)).toBe(true);
  });
  it('a transaction failure rolls back the receipt and retries successfully', async () => {
    const store = new MemoryStore(), mock = provider([sub('past_due')]);
    store.failMark = true;
    await expect(webhook(store, mock.stripe, config, event())).rejects.toThrow();
    expect(store.events.size).toBe(0);
    expect(store.value?.status).toBe('active');
    store.failMark = false;
    await webhook(store, mock.stripe, config, event());
    expect(store.value?.status).toBe('past_due');
  });
  it('ignores foreign metadata/customer and unrecognized prices', async () => {
    const store = new MemoryStore(), mock = provider();
    await webhook(store, mock.stripe, config, { ...event(), data: { object: { ...sub(), customer: 'cus_foreign', metadata: { isobarUserId: 'u1' } } } });
    expect(mock.list).not.toHaveBeenCalled();
    await webhook(store, provider([{ ...sub(), items: { data: [{ quantity: 1, price: { id: 'price_other' } }] } }]).stripe, config, event());
    expect(hasPaidAccess(store.value, now)).toBe(false);
    await webhook(store, provider([{ ...sub(), metadata: { isobarUserId: 'other' } }]).stripe, config, event('evt_mismatched'));
    expect(hasPaidAccess(store.value, now)).toBe(false);
  });
});

describe('checkout, portal and deletion', () => {
  it('creates tax-enabled subscription checkout from configured prices without granting access', async () => {
    const store = new MemoryStore(); store.value = null;
    const mock = provider([]);
    await checkout(store, mock.stripe, config, { id: 'u1', email: 'user@example.test' }, 'yearly', 'https://isobar.example');
    expect(mock.request).toHaveBeenCalledWith('POST', 'checkout/sessions', expect.objectContaining({
      mode: 'subscription', customer: 'cus_1', 'line_items[0][price]': 'price_y', 'automatic_tax[enabled]': 'true',
      success_url: 'https://isobar.example/?account=1&billing=success',
    }), expect.any(String));
    expect(hasPaidAccess(store.value, now)).toBe(false);
    expect(store.session).toBe('cs_1');
  });
  it('does not create another subscription, even before webhook arrives', async () => {
    const store = new MemoryStore(), mock = provider();
    await expect(checkout(store, mock.stripe, config, { id: 'u1', email: null }, 'monthly', 'https://isobar.example')).rejects.toThrow('existing subscription');
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('reuses open checkout and retains customer on failure', async () => {
    const store = new MemoryStore(), mock = provider([]); store.session = 'cs_1';
    await checkout(store, mock.stripe, config, { id: 'u1', email: null }, 'monthly', 'https://isobar.example');
    expect(mock.request).not.toHaveBeenCalledWith('POST', 'checkout/sessions', expect.anything(), expect.anything());
    const fresh = new MemoryStore(); fresh.value = null;
    mock.list.mockRejectedValueOnce(new Error('stripe timeout'));
    await expect(checkout(fresh, mock.stripe, config, { id: 'u1', email: null }, 'monthly', 'https://isobar.example')).rejects.toThrow();
    expect(fresh.value?.stripeCustomerId).toBe('cus_1');
  });
  it('portal uses only the authenticated account customer', async () => {
    const store = new MemoryStore(), mock = provider();
    await portal(store, mock.stripe, 'u1', 'https://isobar.example');
    expect(mock.request).toHaveBeenCalledWith('POST', 'billing_portal/sessions', { customer: 'cus_1', return_url: 'https://isobar.example/?account=1' });
  });
  it('deletion cancels via Stripe customer deletion before erasing local account; errors keep it retryable', async () => {
    const store = new MemoryStore(), mock = provider();
    mock.request.mockRejectedValueOnce(new StripeFailure(503));
    await expect(deleteBillingAccount(store, mock.stripe, 'u1', null)).rejects.toThrow();
    expect(store.deleted).toBe(false);
    expect(store.value?.deleting).toBe(false);
    await deleteBillingAccount(store, mock.stripe, 'u1', null);
    expect(mock.request).toHaveBeenCalledWith('DELETE', 'customers/cus_1');
    expect(store.deleted).toBe(true);
    await webhook(store, mock.stripe, config, event());
    expect(store.value).toBeNull();
  });
  it('self-host account deletion needs no Stripe; removing keys with an existing customer fails closed', async () => {
    const store = new MemoryStore();
    await expect(deleteBillingAccount(store, null, 'u1', null)).rejects.toThrow();
    store.value = null;
    await deleteBillingAccount(store, null, 'u1', null);
    expect(store.deleted).toBe(true);
  });
  it('resubscribes after a completed checkout has ended, and retries after Stripe customer deletion already succeeded', async () => {
    const store = new MemoryStore(), mock = provider([sub('canceled')]); store.session = 'cs_old';
    mock.request.mockResolvedValueOnce({ id: 'cs_old', status: 'complete', subscription: 'sub_1' } as never);
    await checkout(store, mock.stripe, config, { id: 'u1', email: null }, 'monthly', 'https://isobar.example');
    expect(store.session).toBe('cs_1');
    mock.list.mockRejectedValueOnce(new StripeFailure(404, 'resource_missing'));
    await deleteBillingAccount(store, mock.stripe, 'u1', null);
    expect(store.deleted).toBe(true);
  });
  it('a missing session is not mistaken for a deleted Stripe customer', async () => {
    const store = new MemoryStore(), mock = provider();
    mock.list.mockResolvedValueOnce([{ id: 'cs_missing' }]);
    mock.request.mockRejectedValueOnce(new StripeFailure(404, 'resource_missing'));
    mock.request.mockResolvedValueOnce({ id: 'cus_1', deleted: false } as never);
    await expect(deleteBillingAccount(store, mock.stripe, 'u1', null)).rejects.toThrow();
    expect(store.deleted).toBe(false);
  });
});

it('the REST adapter pins version, form-encodes fields and never forwards provider error text', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ error: { code: 'bad', message: 'private billing data' } }, { status: 400 }));
  await expect(stripeClient('sk_test_fake', fetchImpl as typeof fetch).request('POST', 'customers', { email: 'a+b@example.test' }, 'request-key')).rejects.toThrow('Billing provider unavailable');
  const args = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  expect(args[1].body).toBe('email=a%2Bb%40example.test');
  expect(args[1].headers).toMatchObject({ 'Stripe-Version': '2024-06-20', 'Idempotency-Key': 'request-key' });
});

it('setup creates US$5/month + US$50/year and portal cancellation at period end, mocked only', async () => {
  const calls: { path: string; fields: Record<string, string> }[] = [];
  const stripe = { list: async () => [], request: async (_method: string, path: string, fields: Record<string, string>) => {
    calls.push({ path, fields }); return { id: path === 'products' ? 'prod_test' : fields['recurring[interval]'] === 'month' ? 'price_m' : 'price_y' };
  } } as unknown as StripeClient;
  expect(await setupStripe(stripe, 'https://isobar.example')).toEqual(config);
  expect(calls.filter((call) => call.path === 'prices').map((call) => [call.fields.currency, call.fields.unit_amount, call.fields['recurring[interval]']])).toEqual([['usd', '500', 'month'], ['usd', '5000', 'year']]);
  expect(calls.at(-1)?.fields['features[subscription_cancel][mode]']).toBe('at_period_end');
});
