import 'server-only';
import { auth } from '@/lib/server/auth';
import { db } from '@/lib/server/prisma';
import { ownerGate } from '@/lib/chat/gate';
import { chatEnv } from '@/lib/chat/handler';
import { exportSince, usageNdjson } from '@/lib/usage/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Owner-only NDJSON of usage events since a timestamp. The Mac script gzips it. */
export async function GET(request: Request): Promise<Response> {
  const env = chatEnv();
  const session = await auth().catch(() => null);
  const allowed = ownerGate({
    sessionEmail: session?.user?.email,
    ownerEmail: env.ownerEmail,
    header: request.headers.get('x-isobar-digest'),
    authorization: request.headers.get('authorization'),
    secret: process.env.ISOBAR_DIGEST_SECRET ?? null,
  });
  if (!allowed) return new Response(null, { status: 404 });
  const since = exportSince(new URL(request.url).searchParams.get('since'));
  if (!since) return Response.json({ error: 'since' }, { status: 400, headers: { 'cache-control': 'private, no-store' } });
  const rows = await db().usageEvent.findMany({
    where: { at: { gte: since } },
    orderBy: { at: 'asc' },
    take: 200_000,
  });
  const body = usageNdjson(rows.map((row) => ({
    id: row.id, userId: row.userId, deviceId: row.deviceId, at: row.at.toISOString(), kind: row.kind, payload: row.payload,
  })));
  return new Response(body, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}
