import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), db: vi.fn(), checkout: vi.fn(), portal: vi.fn(), webhook: vi.fn(), get: vi.fn() }));
vi.mock('../../src/lib/server/auth', () => ({ auth: mocks.auth }));
vi.mock('../../src/lib/server/prisma', () => ({ databaseConfigured: () => true, db: mocks.db }));
vi.mock('../../src/lib/billing/prisma-store', () => ({ prismaBillingStore: () => ({ get: mocks.get }) }));
vi.mock('../../src/lib/billing/service', async (original) => ({ ...await original<typeof import('../../src/lib/billing/service')>(), checkout: mocks.checkout, portal: mocks.portal, webhook: mocks.webhook }));
import { billingGet, billingPost, billingWebhook } from '../../src/lib/billing/routes';

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: 'whsec_mock', STRIPE_PRICE_MONTHLY: 'price_m', STRIPE_PRICE_YEARLY: 'price_y', BILLING_SITE_URL: 'https://isobar.test' })) vi.stubEnv(name, value);
  mocks.auth.mockResolvedValue({ user: { id: 'u1', email: 'pilot@example.test' } });
  mocks.get.mockResolvedValue(null);
  mocks.checkout.mockResolvedValue('https://checkout.stripe.com/c/pay/mock');
});
afterEach(() => vi.unstubAllEnvs());
const post = (body: unknown = { plan: 'monthly' }, origin = 'https://isobar.test') => new Request('https://isobar.test/api/billing/checkout', {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('billing routes', () => {
  it('requires a signed-in user and ignores submitted user/customer/price IDs', async () => {
    mocks.auth.mockResolvedValueOnce(null);
    expect((await billingPost(post(), 'checkout')).status).toBe(401);
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect((await billingPost(post({ plan: 'yearly', userId: 'other', customer: 'cus_other', price: 'fake' }), 'checkout')).status).toBe(200);
    expect(mocks.checkout).toHaveBeenCalledWith(expect.anything(), expect.anything(), { monthly: 'price_m', yearly: 'price_y' }, { id: 'u1', email: 'pilot@example.test' }, 'yearly', 'https://isobar.test');
  });
  it('rejects invalid plans and untrusted/missing origins, including forwarded-host spoofing', async () => {
    expect((await billingPost(post({ plan: 'lifetime' }), 'checkout')).status).toBe(400);
    const spoof = post({}, 'https://evil.test'); spoof.headers.set('x-forwarded-host', 'evil.test');
    expect((await billingPost(spoof, 'portal')).status).toBe(403);
    const missing = post(); missing.headers.delete('origin');
    expect((await billingPost(missing, 'checkout')).status).toBe(403);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('disabled self-host does not instantiate auth, database or Stripe', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect(await (await billingGet()).json()).toEqual({ enabled: false });
    expect((await billingPost(post(), 'checkout')).status).toBe(404);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it('raw signature failure never reaches reconciliation; provider failure asks Stripe to retry', async () => {
    const raw = JSON.stringify({ id: 'evt_route', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1' } } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = `t=${timestamp},v1=${createHmac('sha256', 'whsec_mock').update(`${timestamp}.${raw}`).digest('hex')}`;
    const request = (body = raw, sig = signature) => new Request('https://isobar.test/api/billing/webhook', { method: 'POST', body, headers: { 'stripe-signature': sig } });
    expect((await billingWebhook(request(`${raw} `))).status).toBe(400);
    expect(mocks.webhook).not.toHaveBeenCalled();
    mocks.webhook.mockRejectedValueOnce(new Error('network'));
    expect((await billingWebhook(request())).status).toBe(503);
    mocks.webhook.mockResolvedValueOnce(undefined);
    expect((await billingWebhook(request())).status).toBe(200);
    expect((await billingWebhook(request(' '.repeat(1_048_577)))).status).toBe(413);
  });
});
