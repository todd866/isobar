import 'server-only';
import { auth } from '../server/auth';
import { databaseConfigured, db } from '../server/prisma';
import { billingEnabled } from './policy';
import { prismaBillingStore } from './prisma-store';
import { billingView, BillingConflict, checkout, portal, webhook } from './service';
import { stripeClient, verifyEvent } from './stripe';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const config = () => ({ monthly: process.env.STRIPE_PRICE_MONTHLY!, yearly: process.env.STRIPE_PRICE_YEARLY! });
/** Never derive payment return URLs from Host or forwarded request headers. */
export function billingOrigin(): string {
  const url = new URL(process.env.BILLING_SITE_URL ?? 'https://isobar.md');
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Billing origin');
  return url.origin;
}
export async function billingGet(): Promise<Response> {
  if (!billingEnabled() || !databaseConfigured()) return json({ enabled: false });
  const session = await auth();
  if (!session?.user?.id) return json({ error: 'auth' }, 401);
  try { return json(billingView(await prismaBillingStore(db()).get(session.user.id), new Date())); }
  catch { return json({ error: 'Billing unavailable. Try again.' }, 503); }
}
export async function billingPost(request: Request, action: 'checkout' | 'portal'): Promise<Response> {
  let origin: string;
  try { origin = billingOrigin(); } catch { return json({ error: 'configuration' }, 503); }
  if (request.headers.get('origin') !== origin) return json({ error: 'origin' }, 403);
  if (!billingEnabled() || !databaseConfigured()) return json({ error: 'Billing unavailable' }, 404);
  const session = await auth();
  if (!session?.user?.id) return json({ error: 'auth' }, 401);
  let plan: 'monthly' | 'yearly' = 'monthly';
  if (action === 'checkout') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'plan' }, 400); }
    if (body?.plan !== 'monthly' && body?.plan !== 'yearly') return json({ error: 'plan' }, 400);
    plan = body.plan;
  }
  try {
    const store = prismaBillingStore(db()), stripe = stripeClient(process.env.STRIPE_SECRET_KEY!);
    const url = action === 'checkout'
      ? await checkout(store, stripe, config(), { id: session.user.id, email: session.user.email ?? null }, plan, origin)
      : await portal(store, stripe, session.user.id, origin);
    return json({ url });
  } catch (error) {
    return error instanceof BillingConflict ? json({ error: error.message }, 409) : json({ error: 'Billing unavailable. Try again.' }, 503);
  }
}
export async function billingWebhook(request: Request): Promise<Response> {
  if (!billingEnabled() || !databaseConfigured()) return json({ error: 'unavailable' }, 503);
  // Read bounded raw bytes. Do not parse/re-serialize before signature verification.
  let raw = '';
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'body' }, 400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) { await reader.cancel(); return json({ error: 'body' }, 413); }
      chunks.push(value);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } catch { return json({ error: 'body' }, 400); }
  let event;
  try { event = verifyEvent(raw, request.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET!); }
  catch { return json({ error: 'signature' }, 400); }
  try {
    await webhook(prismaBillingStore(db()), stripeClient(process.env.STRIPE_SECRET_KEY!), config(), event);
    return json({ received: true });
  } catch { return json({ error: 'retry' }, 503); }
}
