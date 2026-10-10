import 'server-only';
import { after } from 'next/server';
import { auth } from '@/lib/server/auth';
import { db } from '@/lib/server/prisma';
import { foreignOrigin, requestOrigin } from '@/lib/server/origin';
import { chatAvailability, chatEnv, postChat, type ChatDeps } from '@/lib/chat/handler';
import { publishedChart } from '@/lib/chat/data';
import { prismaChatStore } from '@/lib/chat/prisma-store';
import { clientIp } from '@/lib/chat/identity';
import { LINES } from '@/lib/chat/types';
import { overAfter, record } from '@/lib/server/throttle';
import { activeAccessBlock, ACCESS_REST_LINE } from '@/lib/chat/access-block';
import { reports } from '@/lib/reports/server';
import { reportsEnabled } from '@/lib/reports/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function deps(request: Request): Promise<ChatDeps> {
  const env = chatEnv();
  const session = await auth();
  let chatSession: ChatDeps['session'] = null;
  if (session?.user?.id) {
    const user = await db().user.findUnique({ where: { id: session.user.id }, select: { id: true, email: true, createdAt: true } });
    if (user) chatSession = { userId: user.id, email: user.email, createdAt: user.createdAt };
  }
  const published = publishedChart();
  return {
    now: new Date(),
    apiKey: env.apiKey,
    authSecret: env.authSecret,
    ownerEmail: env.ownerEmail,
    publicCaps: env.publicCaps,
    userCap: env.userCap,
    signedInTotal: env.signedInTotal,
    resendKey: env.resendKey,
    emailFrom: env.emailFrom,
    governor: env.governor,
    store: prismaChatStore(env.ownerEmail),
    chart: published.chart,
    release: published.release,
    fetchImpl: fetch,
    originBlocked: foreignOrigin(request),
    secureCookie: requestOrigin(request).startsWith('https:'),
    session: chatSession,
    reportCommand: chatSession && reportsEnabled() ? async (input, threadId) => reports().command(chatSession!.userId, input, threadId) : undefined,
  };
}

export async function GET(): Promise<Response> {
  return chatAvailability(process.env.ISOBAR_ANTHROPIC_API_KEY);
}

/** Record first, then judge, so parallel requests each count. */
async function rateLimited(request: Request, userId: string | null): Promise<boolean> {
  const ip = clientIp(request);
  const checks: [Parameters<typeof record>[0], string][] = [['chatIp', ip], ['chatIpDay', ip]];
  if (userId) checks.push(['chatUser', userId]);
  for (const [name, value] of checks) await record(name, value);
  for (const [name, value] of checks) if (await overAfter(name, value)) return true;
  return false;
}

export async function POST(request: Request): Promise<Response> {
  if (foreignOrigin(request)) return Response.json({ error: 'origin' }, { status: 403, headers: { 'cache-control': 'private, no-store' } });
  const supervisor = await auth();
  const block = await activeAccessBlock(db(), supervisor?.user?.id ?? null);
  if (block.blocked) return Response.json({ line: ACCESS_REST_LINE, resting: true }, { status: 200, headers: { 'cache-control': 'private, no-store' } });
  if (!foreignOrigin(request)) {
    const session = supervisor;
    if (await rateLimited(request, session?.user?.id ?? null)) {
      return Response.json({ line: LINES.slow, slow: true }, { status: 429, headers: { 'cache-control': 'private, no-store' } });
    }
  }
  const outcome = await postChat(request, await deps(request));
  if (outcome.later) after(() => outcome.later!());
  return outcome.response;
}
