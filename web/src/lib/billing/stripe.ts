import { createHmac, timingSafeEqual } from 'node:crypto';

// A small server-only REST adapter; no SDK download or Stripe calls during tests/build.
// Pin the API contract (including subscription-level period dates) explicitly.
export const STRIPE_API_VERSION = '2024-06-20';
export class StripeFailure extends Error {
  constructor(readonly status: number, readonly code?: string) { super('Billing provider unavailable'); }
}
export type StripeObject = Record<string, unknown> & { id: string };
export interface StripeClient {
  request<T = StripeObject>(method: 'GET' | 'POST' | 'DELETE', path: string, fields?: Record<string, string>, key?: string): Promise<T>;
  list(path: string, fields: Record<string, string>): Promise<StripeObject[]>;
}

export function stripeClient(secret: string, fetchImpl: typeof fetch = fetch): StripeClient {
  const client: StripeClient = {
    async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, fields: Record<string, string> = {}, key?: string): Promise<T> {
      const form = new URLSearchParams(fields);
      const response = await fetchImpl(`https://api.stripe.com/v1/${path}${method === 'GET' ? `?${form}` : ''}`, {
        method, cache: 'no-store', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${secret}`, 'Stripe-Version': STRIPE_API_VERSION,
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(method === 'POST' ? { body: form.toString() } : {}),
      });
      const body = await response.json();
      if (!response.ok) throw new StripeFailure(response.status, body?.error?.code);
      return body as T;
    },
    async list(path, fields) {
      const rows: StripeObject[] = [];
      for (let page = 0; page < 10; page += 1) {
        const result = await client.request<{ data: StripeObject[]; has_more: boolean }>('GET', path, {
          ...fields, limit: '100', ...(rows.length ? { starting_after: rows.at(-1)!.id } : {}),
        });
        rows.push(...result.data);
        if (!result.has_more) return rows;
        if (!result.data.length) break;
      }
      throw new StripeFailure(502);
    },
  };
  return client;
}

export interface StripeEvent { id: string; type: string; data: { object: StripeObject } }
/** Verify the original bytes, multiple v1 signatures (rotation), and replay age. */
export function verifyEvent(raw: string, header: string | null, secret: string, now = new Date()): StripeEvent {
  if (!secret || !header) throw new Error('signature');
  const parts = header.split(',').map((part) => part.trim().split('='));
  const timestamps = parts.filter(([name]) => name === 't');
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0][1] ?? '')) throw new Error('signature');
  const timestamp = Number(timestamps[0][1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now.getTime() / 1000 - timestamp) > 300) throw new Error('signature');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest();
  const valid = parts.some(([name, value]) => name === 'v1' && /^[a-f0-9]{64}$/i.test(value ?? '')
    && timingSafeEqual(expected, Buffer.from(value, 'hex')));
  if (!valid) throw new Error('signature');
  const event = JSON.parse(raw) as StripeEvent;
  if (!event || typeof event.id !== 'string' || !event.id.startsWith('evt_') || typeof event.type !== 'string'
    || !event.data?.object || typeof event.data.object.id !== 'string') throw new Error('event');
  return event;
}
