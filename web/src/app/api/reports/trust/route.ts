import { auth } from '@/lib/server/auth';
import { foreignOrigin } from '@/lib/server/origin';
import { exactOwner } from '@/lib/agent/token';
import { reports } from '@/lib/reports/server';
import { readBody, reportJson } from '@/lib/reports/http';
export const runtime = 'nodejs';
export async function POST(request:Request) {
  if (foreignOrigin(request)) return reportJson({error:'origin'},403);
  const session = await auth(); if (!exactOwner(session?.user?.email,process.env.ISOBAR_OWNER_EMAIL)) return reportJson({error:'forbidden'},403);
  try { const body = new URLSearchParams(await readBody(request,1024)), id = body.get('id'), value = body.get('autoApprove');
    if (!id || id.length>128 || !['true','false'].includes(value ?? '')) return reportJson({error:'body'},400);
    await reports().trust(id,value==='true'); return reportJson({ok:true,line:value==='true'?'Future reports auto-approved.':'Future reports require review.'});
  } catch { return reportJson({error:'unavailable'},503); }
}
