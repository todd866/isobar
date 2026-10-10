import 'server-only';
import { reports } from '@/lib/reports/server';
import { auth } from '@/lib/server/auth';
import { foreignOrigin } from '@/lib/server/origin';
import { overAfter, record } from '@/lib/server/throttle';
import { postArchive } from '@/lib/chat/archive';
import { prismaChatStore } from '@/lib/chat/prisma-store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request): Promise<Response> {
  const headers = { 'cache-control': 'private, no-store', vary: 'Cookie' };
  if (foreignOrigin(request)) return Response.json({ error: 'origin' }, { status: 403, headers });
  const userId = (await auth())?.user?.id ?? null;
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  try {
    const input=await request.clone().json().catch(()=>null);
    if(input?.action==='cancel' && typeof input.messageId==='string' && /^report-[A-Za-z0-9_-]{1,128}$/.test(input.messageId)) return Response.json(await reports().cancelOneOff(userId,input.messageId),{headers});
    return await postArchive(request, { userId, originBlocked: false, store: prismaChatStore(process.env.ISOBAR_OWNER_EMAIL ?? null), limited: async () => {
      await record('chatUser', userId);
      return overAfter('chatUser', userId);
    } });
  } catch { return Response.json({ line: 'Archive unavailable' }, { status: 503, headers }); }
}
