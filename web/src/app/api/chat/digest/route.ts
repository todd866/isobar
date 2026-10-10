import 'server-only';
import { activeAccessBlock } from '@/lib/chat/access-block';
import { auth } from '@/lib/server/auth';
import { db } from '@/lib/server/prisma';
import { completeAnthropic, modelFor } from '@/lib/chat/anthropic';
import { dailyAllowance, publicSpend, type SpendRow } from '@/lib/chat/budgets';
import { runDigest, type DigestMessage } from '@/lib/chat/digest';
import { ownerGate, presentedSecret, secretMatch } from '@/lib/chat/gate';
import { govern, ledgerSince } from '@/lib/chat/governor';
import { chatEnv } from '@/lib/chat/handler';
import { messageCostUsd } from '@/lib/chat/pricing';
import { prismaChatStore } from '@/lib/chat/prisma-store';
import { utcDay } from '@/lib/chat/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Owner session, `x-isobar-digest` or a bearer of ISOBAR_DIGEST_SECRET, or Vercel's CRON_SECRET bearer. Cron omits `view` and sends the email. */
export async function GET(request: Request): Promise<Response> {
  const env = chatEnv();
  const session = await auth().catch(() => null);
  const header = request.headers.get('x-isobar-digest');
  const authorization = request.headers.get('authorization');
  const allowed = ownerGate({
    sessionEmail: session?.user?.email,
    ownerEmail: env.ownerEmail,
    header, authorization,
    secret: process.env.ISOBAR_DIGEST_SECRET ?? null,
  }) || secretMatch(presentedSecret(null, authorization), process.env.CRON_SECRET ?? null);
  if (!allowed) return new Response(null, { status: 404 });

  const send = !new URL(request.url).searchParams.has('view');
  const now = new Date();
  const database = db();
  const lookback = new Date(now.getTime() - 26 * 60 * 60 * 1000);
  const [messages, spendRows] = await Promise.all([
    database.chatMessage.findMany({
      where: { createdAt: { gte: lookback, lt: now } },
      orderBy: { createdAt: 'asc' },
      include: { thread: { select: { user: { select: { email: true } } } } },
    }),
    database.chatMessage.findMany({
      where: { createdAt: { gte: ledgerSince(now, env.governor.windowStart), lt: now }, model: { not: null } },
      select: { model: true, costUsd: true, createdAt: true, lane: true, thread: { select: { userId: true } } },
    }),
  ]);
  const ledger: SpendRow[] = spendRows.map((row) => ({
    userId: row.thread.userId, model: row.model, costUsd: row.costUsd, createdAt: row.createdAt, lane: row.lane,
  }));
  const decision = govern({
    accessBlocked: (await activeAccessBlock(database, session?.user?.id ?? null)).blocked,
    rows: ledger.map((row) => ({ at: row.createdAt, costUsd: row.costUsd, lane: row.lane === 'slow' ? 'slow' : 'api' })),
    now, totalUsd: env.governor.totalUsd, windowStart: env.governor.windowStart, windowEnd: env.governor.windowEnd,
  });
  const pub = publicSpend(ledger, now);
  const pool = decision.digest === 'haiku' ? pub.haiku : pub.sonnet;
  const cap = decision.digest === 'haiku' ? env.publicCaps.haiku : env.publicCaps.sonnet;
  const allowance = dailyAllowance(cap, pool.monthBeforeToday, now);
  const modelOpen = decision.digest !== 'rest' && !pub.incomplete && allowance > pool.today;
  const store = prismaChatStore(env.ownerEmail);
  const notice = `digest-${utcDay(now)}`;
  const result = await runDigest({
    now,
    messages: messages.map((row): DigestMessage => ({
      id: row.id, threadId: row.threadId, user: row.thread.user?.email ?? null, role: row.role,
      content: row.content, status: row.status, lane: row.lane, context: row.context, model: row.model,
      costUsd: row.costUsd, grade: row.grade, gradeReason: row.gradeReason, toolCalls: row.toolCalls,
      example: row.example, failureReason: row.failureReason, createdAt: row.createdAt,
    })),
    modelOpen, digestTier: decision.digest, alreadySent: await store.hasNotice(notice), send,
    complete: async (prompt, tier) => {
      if (!env.apiKey || (await activeAccessBlock(database, session?.user?.id ?? null)).blocked) return null;
      const spec = modelFor(tier);
      try {
        const done = await completeAnthropic({
          apiKey: env.apiKey, model: spec.model, effort: null, maxTokens: 2_000,
          system: 'You only review. You do not answer the pilot.',
          messages: [{ role: 'user', content: prompt }], fetchImpl: fetch,
        });
        const costUsd = messageCostUsd(spec.model, done.promptTokens, done.completionTokens);
        if (costUsd == null) return null;
        return { text: done.text, costUsd };
      } catch { return null; }
    },
  });
  if (result.costUsd != null && result.critiques.length === 0) {
    const line = 'The review could not be read.';
    for (const thread of result.view.threads) {
      if (thread.missed || !thread.turns.some((turn) => turn.question)) continue;
      thread.missed = line;
      result.critiques.push({ threadId: thread.threadId, text: line });
    }
  }
  if (result.costUsd != null && result.model) {
    const thread = await store.thread(null, 'digest');
    await store.insert({
      threadId: thread.id, role: 'digest', content: '', status: 'complete', lane: 'fast',
      model: result.model, costUsd: result.costUsd,
    });
  }
  for (const critique of result.critiques) {
    await store.insert({
      threadId: critique.threadId, role: 'critique', content: critique.text, status: 'complete', lane: 'fast',
    });
  }
  if (result.email && env.resendKey && env.emailFrom && env.ownerEmail) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.resendKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.emailFrom, to: env.ownerEmail, subject: 'Isobar chat digest', text: result.email }),
      });
      if (response.ok) await store.markNotice(notice);
    } catch { /* the next morning tries again */ }
  }
  return Response.json(result.view, { headers: { 'cache-control': 'private, no-store' } });
}
