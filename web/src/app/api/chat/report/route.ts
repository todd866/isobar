import 'server-only';
import { auth } from '@/lib/server/auth';
import { foreignOrigin } from '@/lib/server/origin';
import { overAfter, record } from '@/lib/server/throttle';
import { reports } from '@/lib/reports/server';
import { readBody, reportJson } from '@/lib/reports/http';
import { reportsEnabled } from '@/lib/reports/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Queue a one-off detailed report for the signed-in user’s email address. */
export async function POST(request: Request): Promise<Response> {
  if (foreignOrigin(request)) return reportJson({ error: 'origin' }, 403);
  const userId = (await auth())?.user?.id;
  if (!userId) return reportJson({ error: 'unauthorized' }, 401);
  if (!reportsEnabled()) return reportJson({ error: 'unavailable' }, 503);

  try {
    await record('chatUser', userId);
    if (await overAfter('chatUser', userId)) return reportJson({ error: 'rate-limited' }, 429);

    let raw: unknown;
    try { raw = JSON.parse(await readBody(request, 4_096)); } catch { return reportJson({ error: 'body' }, 400); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reportJson({ error: 'body' }, 400);
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).length !== 1 || typeof row.messageId !== 'string' || row.messageId.length === 0 || row.messageId.length > 128) {
      return reportJson({ error: 'body' }, 400);
    }

    const result = await reports().emailQuestion(userId, row.messageId);
    return reportJson(result, result.ok ? 200 : 409);
  } catch {
    return reportJson({ error: 'unavailable' }, 503);
  }
}
