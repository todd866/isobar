/** Run deliberately against the owner's Stripe account; never part of build/deploy. */
import { pathToFileURL } from 'node:url';
import { stripeClient, type StripeClient, type StripeObject } from '../src/lib/billing/stripe';

export async function setupStripe(stripe: StripeClient, site: string): Promise<{ monthly: string; yearly: string }> {
  const origin = new URL(site).origin;
  if (!origin.startsWith('https://')) throw new Error('BILLING_SITE_URL must use HTTPS');
  const prices: Record<string, string> = {};
  let product: string | null = null;
  for (const [plan, interval, amount] of [['monthly', 'month', '500'], ['yearly', 'year', '5000']] as const) {
    const lookup = `isobar_ai_usd_${plan}_v1`;
    const found = await stripe.list('prices', { 'lookup_keys[0]': lookup });
    const price = found[0];
    if (price) {
      const recurring = price.recurring as { interval?: string; interval_count?: number };
      if (price.active !== true || price.currency !== 'usd' || price.unit_amount !== Number(amount)
        || price.tax_behavior !== 'exclusive' || recurring?.interval !== interval || recurring.interval_count !== 1
        || typeof price.product !== 'string') throw new Error(`Existing ${plan} price does not match Isobar AI`);
      if (product && product !== price.product) throw new Error('Prices must share one product');
      product = price.product;
      prices[plan] = price.id;
    }
  }
  if (!product) {
    const products = await stripe.list('products', { active: 'true' });
    const existing = products.find((item) => (item.metadata as Record<string, string> | undefined)?.isobarBilling === 'v1');
    product = existing?.id ?? (await stripe.request('POST', 'products', { name: 'Isobar AI', 'metadata[isobarBilling]': 'v1' }, 'isobar-ai-product-v1')).id;
  }
  for (const [plan, interval, amount] of [['monthly', 'month', '500'], ['yearly', 'year', '5000']] as const) {
    if (!prices[plan]) prices[plan] = (await stripe.request('POST', 'prices', {
      product, currency: 'usd', unit_amount: amount, 'recurring[interval]': interval,
      tax_behavior: 'exclusive', lookup_key: `isobar_ai_usd_${plan}_v1`,
    }, `isobar-ai-price-${plan}-v1`)).id;
  }
  const configurations = await stripe.list('billing_portal/configurations', {});
  const current = configurations.find((item: StripeObject) => item.is_default === true);
  await stripe.request('POST', current ? `billing_portal/configurations/${encodeURIComponent(current.id)}` : 'billing_portal/configurations', {
    'business_profile[privacy_policy_url]': `${origin}/privacy`,
    'features[customer_update][enabled]': 'true',
    'features[customer_update][allowed_updates][0]': 'email',
    'features[customer_update][allowed_updates][1]': 'address',
    'features[customer_update][allowed_updates][2]': 'tax_id',
    'features[invoice_history][enabled]': 'true', 'features[payment_method_update][enabled]': 'true',
    'features[subscription_cancel][enabled]': 'true', 'features[subscription_cancel][mode]': 'at_period_end',
    'features[subscription_update][enabled]': 'true',
    'features[subscription_update][default_allowed_updates][0]': 'price',
    'features[subscription_update][proration_behavior]': 'always_invoice',
    'features[subscription_update][products][0][product]': product,
    'features[subscription_update][products][0][prices][0]': prices.monthly,
    'features[subscription_update][products][0][prices][1]': prices.yearly,
  });
  return { monthly: prices.monthly, yearly: prices.yearly };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.STRIPE_SECRET_KEY;
  const site = process.env.BILLING_SITE_URL;
  if (!secret || !site) throw new Error('Set STRIPE_SECRET_KEY and BILLING_SITE_URL in the process environment');
  const prices = await setupStripe(stripeClient(secret), site);
  // Price IDs are configuration, never secret keys. Copy to sensitive deployment env.
  console.log(`STRIPE_PRICE_MONTHLY=${prices.monthly}\nSTRIPE_PRICE_YEARLY=${prices.yearly}`);
}
