import { z } from 'zod';
import { db } from '@/lib/server/prisma';
import { clientIp, record, overAfter } from '@/lib/server/throttle';
import { exactOwner, hashAgentToken, TOKEN_PATTERN } from '@/lib/agent/token';
import { reports } from '@/lib/reports/server';
import { readBody, reportJson } from '@/lib/reports/http';
import { screenAnswer } from '@/lib/chat/watcher';
import { reportsEnabled } from '@/lib/reports/config';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const host = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const identity = {host, id:z.string().min(1).max(128), leaseId:z.string().uuid()};
const claim = {host, role:z.enum(['primary','standby']), standbyMs:z.number().int().min(90_000).max(86_400_000).optional()};
const schema = z.discriminatedUnion('action', [
  z.object({action:z.literal('claim'),...claim}).strict(),
  z.object({action:z.literal('maintenance'),...claim}).strict(),
  z.object({action:z.literal('release'),...identity}).strict(),
  z.object({action:z.literal('notified'),...identity,channel:z.enum(['text-ian','email'])}).strict(),
  z.object({action:z.literal('ready'),...identity,text:z.string().trim().min(1).max(20_000),model:z.string().max(96),toolsUsed:z.array(z.string().max(128)).max(32),
    images:z.array(z.object({src:z.string().max(700_000),alt:z.string().max(240)})).max(2).optional(),
    briefing:z.object({keyNumbers:z.array(z.string().max(300)).max(24),sources:z.array(z.string().max(500)).max(24)}).optional(),
    usage:z.object({promptTokens:z.number().nonnegative().optional(),completionTokens:z.number().nonnegative().optional(),latencyMs:z.number().nonnegative().optional()}).optional(),
  }).strict(),
]);
export async function POST(request: Request) {
  try {
    const secret = process.env.AUTH_SECRET; if (!secret) return reportJson({error:'unavailable'},503);
    const ip = clientIp(request); await record('agentIp',ip); if (await overAfter('agentIp',ip)) return reportJson({error:'rate-limited'},429);
    const bearer = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!bearer || !TOKEN_PATTERN.test(bearer)) return reportJson({error:'unauthorized'},401);
    const token = await db().agentToken.findUnique({ where:{hashedToken:hashAgentToken(bearer,secret)},include:{user:true} });
    if (!token || token.revokedAt || token.scope !== 'owner' || !exactOwner(token.user.email,process.env.ISOBAR_OWNER_EMAIL)) return reportJson({error:'unauthorized'},401);
    await record('agentToken',token.id); if (await overAfter('agentToken',token.id)) return reportJson({error:'rate-limited'},429);
    let raw: unknown; try { raw = JSON.parse(await readBody(request,1_450_000)); } catch { return reportJson({error:'body'},400); }
    const parsed = schema.safeParse(raw); if (!parsed.success) return reportJson({error:'body'},400);
    const input = parsed.data, agent = {id:token.id,host:input.host};
    if (!reportsEnabled() && (input.action === 'claim' || input.action === 'maintenance')) return reportJson(null);
    const service = reports();
    // Revocation checked again in the fenced transaction through service wrappers.
    if (input.action === 'claim') return reportJson(await service.claim(agent,input.role === 'standby' ? input.standbyMs ?? 90_000 : 0));
    if (input.action === 'maintenance') return reportJson(await service.maintenance(agent));
    let ok = false;
    if (input.action === 'ready') {
      if (!input.toolsUsed.some(name => /^mcp__isobar-archive__/.test(name))) return reportJson({error:'archive-evidence-required'},422);
      if ([input.text,input.model,...input.toolsUsed,...input.briefing?.keyNumbers ?? [],...input.briefing?.sources ?? []].some(s => screenAnswer(s).length)) return reportJson({error:'reply-held'},422);
      ok = await service.ready(agent,input.id,input.leaseId,input.text);
    }
    if (input.action === 'release') ok = await service.release(agent,input.id,input.leaseId);
    if (input.action === 'notified') ok = await service.notified(agent,input.id,input.leaseId,input.channel);
    return reportJson(ok ? {ok:true} : {error:'lease-lost'},ok ? 200 : 409);
  } catch { return reportJson({error:'unavailable'},503); }
}
