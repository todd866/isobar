import 'server-only';
import { auth } from '@/lib/server/auth';
import { db } from '@/lib/server/prisma';
import { overAfter, record } from '@/lib/server/throttle';
import { getThread } from '@/lib/chat/thread';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request): Promise<Response> {
  try {
    const userId = (await auth())?.user?.id ?? null;
    // Do not even construct a database client for a signed-out poll.
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'cache-control': 'private, no-store', vary: 'Cookie' } });
    return await getThread(request, { userId, database: db(), limited: async () => {
      await record('chatThread', userId);
      return overAfter('chatThread', userId);
    } });
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'cache-control': 'private, no-store', vary: 'Cookie' } });
  }
}
