import { auth } from '@/lib/server/auth';
import { foreignOrigin } from '@/lib/server/origin';
import { reports } from '@/lib/reports/server';
import { readBody, reportJson } from '@/lib/reports/http';
import { reportsEnabled } from '@/lib/reports/config';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  const session = await auth(); if (!session?.user?.id) return reportJson({ error:'unauthorized' },401);
  if (!reportsEnabled()) return reportJson({ enabled: false, subscriptions: [] });
  try { return reportJson({ subscriptions: await reports().list(session.user.id) }); } catch { return reportJson({error:'unavailable'},503); }
}
export async function POST(request: Request) {
  if (foreignOrigin(request)) return reportJson({error:'origin'},403);
  const session = await auth(); if (!session?.user?.id) return reportJson({error:'unauthorized'},401);
  let body: unknown; try { body = JSON.parse(await readBody(request)); } catch { return reportJson({error:'body'},400); }
  // Account UI only controls existing subscriptions. Natural-language creation
  // goes through chat's watcher and authenticated mutation tool.
  const row = body as {action?:string;id?:string};
  if (!row || Object.keys(row).some(key=>!['action','id'].includes(key)) || !['pause','resume','cancel'].includes(row.action ?? '') || typeof row.id !== 'string') return reportJson({error:'body'},400);
  try { return reportJson(await reports().command(session.user.id, body)); } catch { return reportJson({error:'unavailable'},503); }
}
