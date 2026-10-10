import 'server-only';
import { Prisma } from '@prisma/client';
import { auth } from '@/lib/server/auth';
import { databaseConfigured, db } from '@/lib/server/prisma';
import { foreignOrigin, requestOrigin } from '@/lib/server/origin';
import { chatEnv } from '@/lib/chat/handler';
import { cookieHeader, cookieValue, DEVICE_COOKIE, newDevice, readDevice } from '@/lib/chat/identity';
import { sanitizeBatch } from '@/lib/usage/events';
import { clientIp } from '@/lib/chat/identity';
import { overAfter, record } from '@/lib/server/throttle';
import { isTestTraffic } from '@/lib/usage/test-traffic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Batched map, chat and Train events. No third-party analytics. */
export async function POST(request: Request): Promise<Response> {
  if (isTestTraffic(request)) return new Response(null, { status: 204, headers: { 'cache-control': 'private, no-store' } });
  if (foreignOrigin(request)) return new Response(null, { status: 403 });
  // The map sends a session-start as soon as it opens. Without a database there
  // is nowhere to store it; dropping the batch must not be a console error.
  if (!databaseConfigured()) return new Response(null, { status: 204, headers: { 'cache-control': 'private, no-store' } });
  const ip = clientIp(request);
  await record('usageIp', ip);
  if (await overAfter('usageIp', ip)) return new Response(null, { status: 429 });
  let body: unknown;
  try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
  const events = sanitizeBatch(body, new Date());
  if (!events) return new Response(null, { status: 400 });

  const env = chatEnv();
  let deviceId = env.authSecret ? readDevice(cookieValue(request.headers.get('cookie'), DEVICE_COOKIE), env.authSecret) : null;
  let cookie: string | undefined;
  if (!deviceId && env.authSecret) {
    const minted = newDevice(env.authSecret);
    deviceId = minted.id;
    cookie = cookieHeader(minted.cookie, requestOrigin(request).startsWith('https:'));
  }
  if (!deviceId) {
    const supplied = body && typeof body === 'object' ? (body as { deviceId?: unknown }).deviceId : null;
    deviceId = typeof supplied === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(supplied) ? supplied : 'unknown';
  }
  let userId: string | null = null;
  try {
    const session = await auth();
    userId = session?.user?.id ?? null;
  } catch { userId = null; }

  await db().usageEvent.createMany({
    data: events.map((event) => ({
      userId, deviceId, at: new Date(event.at), kind: event.kind, payload: event.payload as Prisma.InputJsonValue,
    })),
  });
  const headers = new Headers({ 'cache-control': 'private, no-store' });
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(null, { status: 204, headers });
}
