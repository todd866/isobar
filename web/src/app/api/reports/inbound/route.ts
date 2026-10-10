import { reports } from '@/lib/reports/server';
import { readBody, reportJson } from '@/lib/reports/http';
import { receiveInbound } from '@/lib/reports/inbound';
import { activeAccessBlock } from '@/lib/chat/access-block';
import { db } from '@/lib/server/prisma';
import { reportsEnabled } from '@/lib/reports/config';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request:Request) {
  const secret=process.env.ISOBAR_REPORT_INBOUND_SECRET;
  if (!reportsEnabled() || !secret || process.env.ISOBAR_REPORT_INBOUND_ENABLED !== '1') return reportJson({error:'unavailable'},503);
  try {
    const envelope=JSON.parse(await readBody(request)), service=reports();
    await receiveInbound(envelope,request.headers.get('x-isobar-signature') ?? '',{secret,mailbox:process.env.ISOBAR_REPORT_REPLY_TO ?? 'reports@isobar.md',deps:{
      reserve:(id,sender)=>service.reserveInbound(id,sender),execute:(id,command,reply)=>service.inboundCommand(id,command,reply),
      lookup:(id,reply)=>service.inboundContext(id,reply),blocked:async id=>(await activeAccessBlock(db(),id)).blocked,
      model:{apiKey:process.env.ISOBAR_ANTHROPIC_API_KEY ?? ''},
    }});
    // Uniform ingress ACK: no account existence oracle and no email backscatter.
    return reportJson({ok:true});
  } catch { return reportJson({ok:true}); }
}
