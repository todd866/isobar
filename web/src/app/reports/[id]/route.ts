import { auth } from '@/lib/server/auth';
import { foreignOrigin } from '@/lib/server/origin';
import { exactOwner } from '@/lib/agent/token';
import { reports } from '@/lib/reports/server';
import { reportJson } from '@/lib/reports/http';
import { escapeHtml } from '@/lib/reports/email';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {params:Promise<{id:string}>};
async function owner() { const session = await auth(); return exactOwner(session?.user?.email,process.env.ISOBAR_OWNER_EMAIL); }
export async function GET(request:Request,context:Context) {
  if (!await owner()) return reportJson({error:'Owner sign-in required. Open Account in isobar.md, then reopen this link.'},401);
  try {
    const {id} = await context.params, url = new URL(request.url), action = url.searchParams.get('a') === 'hold' ? 'hold' : 'preview';
    const run = await reports().preview(id,url.searchParams.get('t'),action);
    if (!run) return reportJson({error:'Link expired'},404);
    const controls = action === 'hold' ? `<form method="post"><button style="font:inherit;padding:12px">Hold report</button></form>` : '';
    const trust = `<form method="post" action="/api/reports/trust"><input type="hidden" name="id" value="${escapeHtml(run.subscriptionId)}"><input type="hidden" name="autoApprove" value="${run.subscription.autoApprove ? 'false' : 'true'}"><button style="font:inherit;padding:8px">${run.subscription.autoApprove ? 'Review future reports' : 'Auto-approve future reports'}</button></form>`;
    return new Response(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isobar report</title></head><body style="font:16px system-ui;max-width:660px;margin:auto;padding:20px"><a href="/">Back to map</a><p>${escapeHtml(run.subscription.user.email ?? '')} · ${escapeHtml(run.status)}</p>${controls}${run.html ?? '<p>Report not ready</p>'}${trust}</body></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"}});
  } catch { return reportJson({error:'unavailable'},503); }
}
export async function POST(request:Request,context:Context) {
  if (foreignOrigin(request) || !await owner()) return reportJson({error:'forbidden'},403);
  const {id} = await context.params;
  try { const ok = await reports().hold(id,new URL(request.url).searchParams.get('t')); return reportJson({ok,line:ok?'Report held.':'Report already sent, held or link expired.'},ok?200:409); }
  catch { return reportJson({error:'unavailable'},503); }
}
