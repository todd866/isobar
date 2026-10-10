import 'server-only';
import { auth } from '@/lib/server/auth';
import { databaseConfigured } from '@/lib/server/prisma';
import { AnthropicError, completeAnthropic, modelFor } from '@/lib/chat/anthropic';
import { publicSpend, publicTier, userBudgetTier, userSpend } from '@/lib/chat/budgets';
import { chatEnv } from '@/lib/chat/handler';
import { govern, ledgerSince } from '@/lib/chat/governor';
import { messageCostUsd } from '@/lib/chat/pricing';
import { prismaChatStore } from '@/lib/chat/prisma-store';
import {
  ASSIGN_SYSTEM, assignLearn, iconDefault, isInjection, LEARN_TEXT_CAP, modelAllowed, type AssignRequest,
} from '@/lib/learn/assign';
import { isLearnGoal } from '../../../../../../training/src/levels.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function readBody(value: unknown): AssignRequest {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const icon = typeof row.icon === 'string' && isLearnGoal(row.icon) ? row.icon : 'flying';
  const units = row.units === 'us' || row.units === 'local' ? row.units : 'aus';
  const text = typeof row.text === 'string' ? row.text.slice(0, LEARN_TEXT_CAP) : '';
  const place = typeof row.place === 'string' ? row.place.slice(0, 80) : null;
  const topics = Array.isArray(row.topics) ? row.topics.filter((item): item is string => typeof item === 'string').slice(0, 12) : [];
  return { icon, text, units, place, topics };
}

function json(body: unknown): Response {
  return Response.json(body, { headers: { 'cache-control': 'private, no-store' } });
}

/** A prior from Haiku, or the icon default when the ledger, the budget or the model cannot be used. */
export async function POST(request: Request): Promise<Response> {
  let body: unknown = {};
  try { body = await request.json(); } catch { /* empty body uses the icon */ }
  const input = readBody(body);
  const fallback = iconDefault(input.icon, input.units, input.place);
  if (!input.text.trim() || isInjection(input.text)) return json(fallback);
  const env = chatEnv();
  if (!env.apiKey || !databaseConfigured()) return json(fallback);
  try {
    const now = new Date();
    const store = prismaChatStore(env.ownerEmail);
    const spend = await store.spendSince(ledgerSince(now, env.governor.windowStart), now);
    const decision = govern({
      rows: spend.map((row) => ({ at: row.createdAt, costUsd: row.costUsd, lane: row.lane === 'slow' ? 'slow' as const : 'api' as const })),
      now, totalUsd: env.governor.totalUsd, windowStart: env.governor.windowStart, windowEnd: env.governor.windowEnd,
    });
    const session = await auth().catch(() => null);
    const userId = session?.user?.id ?? null;
    const budget = userId
      ? userBudgetTier(userSpend(spend, userId, now).spend, env.userCap, now, userSpend(spend, userId, now).incomplete)
      : publicTier({ now, caps: env.publicCaps, spend: publicSpend(spend, now), newVisitor: false });
    if (!modelAllowed(decision.fast, decision.reason, budget)) return json(fallback);
    const model = modelFor('haiku');
    const result = await assignLearn(input, {
      complete: async (prompt) => {
        let text = '';
        let promptTokens = 0;
        let completionTokens = 0;
        try {
          const done = await completeAnthropic({
            apiKey: env.apiKey ?? '', model: model.model, effort: null, maxTokens: 400,
            system: ASSIGN_SYSTEM, messages: [{ role: 'user', content: prompt }], fetchImpl: fetch,
          });
          text = done.text;
          promptTokens = done.promptTokens;
          completionTokens = done.completionTokens;
        } catch (error) {
          if (error instanceof AnthropicError) {
            promptTokens = error.promptTokens ?? 0;
            completionTokens = error.completionTokens ?? 0;
          }
          text = '';
        }
        const cost = messageCostUsd(model.model, promptTokens, completionTokens);
        if (cost == null) throw new Error('unpriced');
        const thread = await store.thread(userId, null);
        await store.insert({
          threadId: thread.id, role: 'screen', content: 'learn-assign', status: 'complete', lane: 'fast',
          model: model.model, promptTokens, completionTokens, costUsd: cost,
        });
        if (!text) throw new Error('empty');
        return text;
      },
    });
    return json(result);
  } catch {
    return json(fallback);
  }
}
