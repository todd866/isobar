import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/server/auth';
import { db } from '@/lib/server/prisma';
import { foreignOrigin } from '@/lib/server/origin';
import { chatEnv } from '@/lib/chat/handler';
import { ownerAllowed, parsePin } from '@/lib/chat/admin-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (foreignOrigin(request)) return NextResponse.json({ error: 'origin' }, { status: 403 });
  const session = await auth();
  const env = chatEnv();
  if (!ownerAllowed(session?.user?.email, env.ownerEmail)) return new NextResponse(null, { status: 404 });
  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  if (action === 'lift') {
    const clusterId = String(form.get('clusterId') ?? '');
    if (clusterId) {
      await db().chatCluster.update({ where: { id: clusterId }, data: { suspended: false, blockCount: 0, blockDay: null } }).catch(() => null);
    }
  }
  if (action === 'example') {
    const messageId = String(form.get('messageId') ?? '');
    if (messageId) await db().chatMessage.update({ where: { id: messageId }, data: { example: true } }).catch(() => null);
  }
  if (action === 'pin') {
    const userId = String(form.get('userId') ?? '');
    const pinned = parsePin(String(form.get('pinnedTier') ?? ''));
    if (userId && pinned !== undefined) {
      await db().chatStanding.upsert({
        where: { userId },
        create: { userId, tier: pinned ?? 'opus', pinnedTier: pinned },
        update: { pinnedTier: pinned },
      });
    }
  }
  const next = String(form.get('next') ?? '/admin/chat');
  const path = next.startsWith('/admin/') && !next.startsWith('//') ? next : '/admin/chat';
  return NextResponse.redirect(new URL(path, request.url), 303);
}
