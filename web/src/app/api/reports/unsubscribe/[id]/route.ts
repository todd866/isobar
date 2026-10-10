import { reports } from '@/lib/reports/server';
import { readBody, reportJson } from '@/lib/reports/http';
import { escapeHtml } from '@/lib/reports/email';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {params:Promise<{id:string}>};
export async function POST(request:Request, context:Context) {
  try {
    const body = await readBody(request,1024);
    if (new URLSearchParams(body).get('List-Unsubscribe') !== 'One-Click') return reportJson({error:'body'},400);
    const {id} = await context.params;
    const ok = await reports().unsubscribe(id,new URL(request.url).searchParams.get('t'));
    return new Response(ok ? 'Unsubscribed' : 'Invalid unsubscribe link', {status:ok?200:400,headers:{'cache-control':'no-store'}});
  } catch { return reportJson({error:'unavailable'},503); }
}
/** GET never mutates: mailbox scanners cannot cancel reports. RFC8058 uses POST. */
export async function GET(request:Request) {
  return new Response(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font:18px system-ui;padding:24px"><form method="post" action="${escapeHtml(new URL(request.url).pathname + new URL(request.url).search)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button style="font:inherit;padding:12px">Unsubscribe</button></form></body></html>`, {headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"}});
}
