import { randomBytes, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, ReportSubscription } from '@prisma/client';
import { exactOwner } from '../agent/token';
import { hasPaidAccess } from '../billing/policy';
import { screenAnswer } from '../chat/watcher';
import { CLAIM_EARLY_MS, commandSchema, isComplex, REPORT_LEASE_MS, sendAfter, UPSELL, verifiedRecipient, type ReportCommand, type ReportPlace } from './policy';
import { nextOccurrence } from './schedule';
import { escapeHtml, renderReport, type Deliver, type Mail } from './email';
import { signReportToken, verifyReportToken, type Purpose } from './tokens';

type Tx = Prisma.TransactionClient;
export interface ReportOptions {
  now: () => Date; secret: string; ownerEmail: string | null; deliver: Deliver;
  replyTo: string; senderIdentity: string; perUserCap: number; globalCap: number;
  inboundUserCap: number; inboundGlobalCap: number; billingEnabled: boolean;
}
export interface ReportAgent { id: string; host: string }
const no = (line: string) => ({ ok: false, line });
const yes = (line: string) => ({ ok: true, line });
const dayStart = (now: Date) => new Date(now.toISOString().slice(0, 10));
const clearLease = { leaseId: null, leaseUntil: null, claimedBy: null, agentTokenId: null };
const active = ['queued', 'generating', 'awaiting-owner'];
const places = (sub: ReportSubscription) => sub.places as ReportPlace[];

/** All mutations use one database lock, including cap reservation and dispatch.
 * A provider idempotency key bridges crashes between its acceptance and commit.
 * Keep the HTTP provider timeout shorter than this transaction's deadline. */
export function reportService(database: PrismaClient, options: ReportOptions) {
  const locked = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => database.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(176917, 1)`;
    return fn(tx);
  }, { maxWait: 15_000, timeout: 25_000 });
  const validAgent = async (tx:Tx, agent:ReportAgent) => {
    const token=await tx.agentToken.findFirst({where:{id:agent.id,scope:'owner',revokedAt:null},include:{user:true}});
    return !!token && exactOwner(token.user.email,options.ownerEmail);
  };
  const blocked = async (tx: Tx, userId: string, now: Date) => !!await tx.aiAccessBlock.findFirst({ where: { scope: { in: ['global', userId] }, until: { gt: now }, liftedAt: null }, select: { id: true } });
  const paid = async (tx: Tx, userId: string, email: string | null, now: Date) => exactOwner(email, options.ownerEmail) || (options.billingEnabled && hasPaidAccess(await tx.entitlement.findUnique({ where: { userId } }), now));
  const visible = (sub: ReportSubscription) => ({ id: sub.id, kind: sub.kind, schedule: sub.schedule, timezone: sub.timezone,
    places: sub.places, instructions: sub.instructions, status: sub.status, nextRunAt: sub.nextRunAt });
  async function holdOutstanding(tx:Tx,id:string,reason:string) {
    const rows=await tx.reportRun.findMany({where:{subscriptionId:id,status:{in:active}}});
    await tx.reportRun.updateMany({ where: { subscriptionId: id, status: { in: active } }, data: { status: 'held', failureReason: reason, ...clearLease } });
    await tx.chatMessage.updateMany({where:{id:{in:rows.map(row=>`report-${row.id}`)},lane:'report'},data:{status:'cancelled'}});
  }
  async function allowed(tx: Tx, sub: ReportSubscription, now: Date) {
    const user = await tx.user.findUnique({ where: { id: sub.userId } });
    if (!user || !verifiedRecipient(user) || sub.status !== 'active' || await blocked(tx, sub.userId, now)) return null;
    if (sub.tier === 'paid' && !await paid(tx, sub.userId, user.email, now)) return null;
    return user;
  }
  async function newRun(tx: Tx, sub: ReportSubscription, dueAt: Date, inReplyTo?: string) {
    const id = randomBytes(12).toString('base64url');
    const run=await tx.reportRun.create({ data: { id, subscriptionId: sub.id, dueAt, messageId: `<report.${id}@isobar.md>`, inReplyTo } });
    if(sub.kind==='once' && sub.threadId) await tx.chatMessage.create({data:{id:`report-${id}`,threadId:sub.threadId,role:'assistant',lane:'report',status:'pending',content:'',costUsd:0,context:{reportId:id,source:'report'}}});
    return run;
  }
  async function commandIn(tx: Tx, userId: string, cmd: ReportCommand, threadId?: string, inReplyTo?: string) {
    const now = options.now(), user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) return no('Sign in to use reports.');
    if (threadId && !await tx.chatThread.findFirst({ where: { id: threadId, userId }, select: { id: true } })) return no('Conversation unavailable.');
    if (cmd.action === 'list') return { ...yes('Your reports.'), subscriptions: (await tx.reportSubscription.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 })).map(visible) };
    const old = cmd.id ? await tx.reportSubscription.findFirst({ where: { id: cmd.id, userId } }) : null;
    if (cmd.action !== 'create' && !old) return no('Report not found.');
    if (cmd.action === 'pause' || cmd.action === 'cancel') {
      const status = cmd.action === 'pause' ? 'paused' : 'cancelled';
      if (old!.status === 'cancelled') return yes('Report cancelled.');
      await tx.reportSubscription.update({ where: { id: old!.id }, data: { status, nextRunAt: null, autoApprove: false } });
      await holdOutstanding(tx, old!.id, `subscription-${status}`);
      return yes(`Report ${status}.`);
    }
    if (!verifiedRecipient(user)) return no('Verify your account email to use reports.');
    if (await blocked(tx, userId, now)) return no('Reports are resting. Please try again later.');
    if (old?.status === 'cancelled') return no('This report is cancelled; request a new one.');
    const kind = old?.kind ?? cmd.kind ?? 'recurring';
    if (old && cmd.kind && cmd.kind !== kind) return no('Create a new report to change its frequency.');
    const schedule = kind === 'once' ? null : cmd.schedule ?? old?.schedule;
    const timezone = cmd.timezone ?? old?.timezone;
    const points = cmd.places ?? (old ? places(old) : undefined);
    const instructions = [old?.instructions, cmd.instructions].filter(Boolean).join('\n');
    if (!timezone || !points?.length || !instructions || (kind === 'recurring' && !schedule) || instructions.length > 8000) return no('Choose a place, local time and report instructions.');
    const complex = isComplex(points, instructions, cmd.complexity ?? old?.complexity ?? 'simple');
    const entitled = await paid(tx, userId, user.email, now);
    const recurring = await tx.reportSubscription.count({ where: { userId, kind: 'recurring', status: { not: 'cancelled' }, ...(old ? { id: { not: old.id } } : {}) } });
    if (!entitled && (complex || (kind === 'recurring' && (recurring > 0 || !schedule!.endsWith('* * *'))))) return no(UPSELL);
    const existingOnce = old && kind === 'once' ? await tx.reportRun.findFirst({where:{subscriptionId:old.id,status:{in:['queued','generating','awaiting-owner','held']},dispatchAt:null},orderBy:{createdAt:'desc'}}) : null;
    if (old && kind === 'once' && !existingOnce) return no('This report is finished; request a new one.');
    if (cmd.action === 'create') {
      if (await tx.reportSubscription.count({ where: { userId, kind:'recurring', status: { not: 'cancelled' } } }) >= 20) return no('Pause or cancel an existing report first.');
      const count = await tx.reportRun.count({ where: { subscription:{userId,kind:'once'}, createdAt: { gte: dayStart(now) } } });
      if (kind === 'once' && count >= (entitled ? 10 : 1)) return no(entitled ? 'Today’s report request limit is reached.' : UPSELL);
      if (await tx.reportRun.count({ where: { status: { in: ['queued','generating'] } } }) >= 1000) return no('Reports are busy. Please try later.');
    }
    const nextRunAt = kind === 'once' ? now : nextOccurrence(schedule!, timezone, now);
    const data = { kind, schedule: schedule ?? null, timezone, places: points as Prisma.InputJsonValue, instructions,
      complexity: complex ? 'complex' : 'simple', tier: complex || (kind==='recurring' && (recurring > 0 || (schedule && !schedule.endsWith('* * *')))) ? 'paid' : 'free',
      status: cmd.action === 'update' ? old!.status : 'active', nextRunAt, ...(threadId ? { threadId } : {}) };
    const sub = old ? await tx.reportSubscription.update({ where: { id: old.id }, data: { ...data, autoApprove: false } })
      : await tx.reportSubscription.create({ data: { ...data, userId } });
    if (old) await holdOutstanding(tx, old.id, 'instructions-changed');
    let reportId:string|undefined;
    if (kind === 'once' && sub.status === 'active') {
      if (existingOnce) await tx.reportRun.update({where:{id:existingOnce.id},data:{status:'queued',html:null,text:null,dueAt:now,sendAfterAt:null,ownerNotifiedAt:null,generationAttempts:0,...clearLease}});
      else { const run=await newRun(tx, sub, now, inReplyTo); reportId=`report-${run.id}`; }
      if(existingOnce) {reportId=`report-${existingOnce.id}`;await tx.chatMessage.updateMany({where:{id:reportId,lane:'report'},data:{status:'pending',content:''}});}
      await tx.reportSubscription.update({ where: { id: sub.id }, data: { nextRunAt: null } });
    }
    return {...yes(kind === 'once' ? 'Report queued for your account email and this conversation.' : `Report ${old ? 'updated' : 'scheduled'} for your account email.`),...(reportId?{reportId}:{})};
  }
  async function materialize(tx: Tx, now: Date) {
    const due = await tx.reportSubscription.findMany({ where: { status: 'active', kind: 'recurring', nextRunAt: { lte: new Date(+now + CLAIM_EARLY_MS) } }, orderBy: { nextRunAt: 'asc' }, take: 50 });
    for (const sub of due) {
      if (!await allowed(tx, sub, now)) continue;
      if (sub.nextRunAt && +now - +sub.nextRunAt < 86_400_000) {
        const prior=await tx.reportRun.findUnique({ where: { subscriptionId_dueAt: { subscriptionId: sub.id, dueAt: sub.nextRunAt } } });
        if (!prior) await newRun(tx, sub, sub.nextRunAt);
        else if (prior.status==='held' && ['instructions-changed','subscription-paused'].includes(prior.failureReason ?? '') && !prior.dispatchAt) await tx.reportRun.update({where:{id:prior.id},data:{status:'queued',html:null,text:null,sendAfterAt:null,ownerNotifiedAt:null,generationAttempts:0,failureReason:null,...clearLease}});
      }
      await tx.reportSubscription.update({ where: { id: sub.id }, data: { nextRunAt: nextOccurrence(sub.schedule!, sub.timezone, new Date(Math.max(+now, +sub.nextRunAt!))) } });
    }
    await tx.reportRun.updateMany({ where: { status: 'generating', leaseUntil: { lte: now }, generationAttempts: { lt: 3 } }, data: { status: 'queued', ...clearLease } });
    await tx.reportRun.updateMany({ where: { status: 'generating', leaseUntil: { lte: now }, generationAttempts: { gte: 3 } }, data: { status: 'failed', failureReason: 'generation-retries-exhausted', ...clearLease } });
  }
  function fence(agent: ReportAgent, id: string, leaseId: string, now: Date) {
    return { id, leaseId, claimedBy: agent.host, agentTokenId: agent.id, leaseUntil: { gt: now } };
  }
  function link(purpose: Purpose, id: string, now: Date, version = 1) {
    const token = signReportToken(options.secret, purpose, id, version, new Date(+now + 7 * 86_400_000));
    const prefix = purpose === 'unsubscribe' ? 'api/reports/unsubscribe' : 'reports';
    return `https://isobar.md/${prefix}/${id}?a=${purpose}&t=${token}`;
  }
  return {
    async command(userId: string, input: unknown, threadId?: string) {
      const parsed = commandSchema.safeParse(input);
      if (!parsed.success) return no('That report request needs a valid place, schedule and timezone.');
      return locked(tx => commandIn(tx, userId, parsed.data, threadId));
    },
    /** The answer ID is the idempotency key; question, place and recipient stay server-side. */
    async emailQuestion(userId: string, messageId: string) {
      return locked(async tx => {
        const reply = await tx.chatMessage.findUnique({ where: { id: messageId } });
        if (!reply || reply.role !== 'assistant' || reply.status !== 'complete' || reply.lane !== 'fast'
          || !await tx.chatThread.findFirst({ where: { id: reply.threadId, userId } })) return no('Report unavailable.');
        const context = reply.context && typeof reply.context === 'object' && !Array.isArray(reply.context) ? reply.context : {};
        if (context.reportOffer !== true || typeof context.userMessageId !== 'string') return no('Report unavailable.');
        if (typeof context.reportId === 'string') return { ...yes('Report already requested.'), reportId: context.reportId };
        const question = await tx.chatMessage.findFirst({ where: { id: context.userMessageId, threadId: reply.threadId, role: 'user', status: 'complete' } });
        if (!question) return no('Question unavailable.');
        const draft = context.reportDraft && typeof context.reportDraft === 'object' && !Array.isArray(context.reportDraft) ? context.reportDraft : {};
        const parsed = commandSchema.safeParse({ action: 'create', kind: 'once', complexity: 'complex',
          places: draft.places, timezone: draft.timezone,
          instructions: `Detailed weather report answering: ${question.content}\nForecast time: ${typeof context.timeUtc === 'string' ? context.timeUtc : 'now'}.`,
        });
        if (!parsed.success || !parsed.data.places?.length) return no('Choose a place and ask again.');
        const result = await commandIn(tx, userId, parsed.data, reply.threadId);
        if (result.ok && 'reportId' in result && typeof result.reportId === 'string') {
          await tx.chatMessage.update({ where: { id: reply.id }, data: { context: { ...context, reportId: result.reportId } } });
          await tx.chatMessage.update({ where: { id: result.reportId }, data: { context: { ...context,
            reportOffer: false, reportDraft: null, source: 'report', reportId: result.reportId, answerId: reply.id } } });
        }
        return result;
      });
    },
    async list(userId: string) { return (await database.reportSubscription.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 })).map(visible); },
    async claim(agent: ReportAgent, standbyMs = 0) {
      return locked(async tx => {
        const now = options.now(); if (!await validAgent(tx,agent)) return null; await materialize(tx, now);
        const rows = await tx.reportRun.findMany({ where: { status: 'queued', dueAt: { lte: new Date(+now + CLAIM_EARLY_MS) }, createdAt: { lte: new Date(+now - standbyMs) } }, include: { subscription: true }, orderBy: { dueAt: 'asc' }, take: 100 });
        for (const run of rows) {
          const sub = run.subscription;
          if (!await allowed(tx, sub, now)) continue;
          const leaseId = randomUUID(), leaseUntil = new Date(+now + REPORT_LEASE_MS);
          await tx.reportRun.update({ where: { id: run.id }, data: { status: 'generating', leaseId, leaseUntil, claimedBy: agent.host, agentTokenId: agent.id, generationAttempts: { increment: 1 } } });
          const report = { dueAt: run.dueAt.toISOString(), timezone: sub.timezone, places: places(sub), instructions: sub.instructions, kind: sub.kind, complexity: sub.complexity };
          return { type: 'report', id: run.id, leaseId, leaseUntil: leaseUntil.toISOString(), question: 'Prepare the requested weather report.', context: { report }, report, thread: [], user: { level: null, goal: null } };
        }
        return null;
      });
    },
    async ready(agent: ReportAgent, id: string, leaseId: string, answer: string) {
      if (!answer.trim() || answer.length > 20_000 || screenAnswer(answer).length) return false;
      return locked(async tx => {
        const now = options.now(), run = await tx.reportRun.findFirst({ where: { ...fence(agent, id, leaseId, now), status: 'generating' }, include: { subscription: true } });
        if (!run || !await validAgent(tx,agent)) return false;
        const user = await allowed(tx, run.subscription, now);
        if (!user) return false;
        const skip = run.subscription.autoApprove || (run.subscription.kind === 'once' && exactOwner(user.email, options.ownerEmail));
        const rendered = renderReport(answer, places(run.subscription), run.dueAt);
        await tx.reportRun.update({ where: { id }, data: { ...rendered, status: 'awaiting-owner', sendAfterAt: skip ? run.dueAt : null, ...clearLease } });
        return true;
      });
    },
    async release(agent: ReportAgent, id: string, leaseId: string) {
      return locked(async tx => {
        const now = options.now(), run = await tx.reportRun.findFirst({ where: { ...fence(agent,id,leaseId,now), status: 'generating' } });
        if (!run || !await validAgent(tx,agent)) return false;
        await tx.reportRun.update({ where: { id }, data: { status: run.generationAttempts >= 3 ? 'failed' : 'queued', failureReason: run.generationAttempts >= 3 ? 'generation-retries-exhausted' : null, ...clearLease } });
        return true;
      });
    },
    async hold(id: string, token: string | null) {
      if (!verifyReportToken(token, options.secret, 'hold', id, 1, options.now())) return false;
      return locked(async tx => { const count=(await tx.reportRun.updateMany({ where: { id, status: { in: active } }, data: { status: 'held', failureReason: 'owner-held', ...clearLease } })).count; if(count) await tx.chatMessage.updateMany({where:{id:`report-${id}`,lane:'report'},data:{status:'held'}});return count===1; });
    },
    async preview(id: string, token: string | null, purpose: 'hold' | 'preview') {
      if (!verifyReportToken(token, options.secret, purpose, id, 1, options.now())) return null;
      return database.reportRun.findUnique({ where: { id }, include: { subscription: { include: { user: { select: { email: true } } } } } });
    },
    async trust(id: string, autoApprove: boolean) {
      return locked(tx => tx.reportSubscription.update({ where: { id }, data: { autoApprove } }));
    },
    async unsubscribe(id: string, token: string | null) {
      return locked(async tx => {
        const sub = await tx.reportSubscription.findUnique({ where: { id } });
        if (!sub || !verifyReportToken(token, options.secret, 'unsubscribe', id, sub.tokenVersion, options.now())) return false;
        await tx.reportSubscription.update({ where: { id }, data: { status: 'cancelled', nextRunAt: null, autoApprove: false } });
        await holdOutstanding(tx, id, 'unsubscribed'); return true;
      });
    },
    /** Called by the daemon heartbeat even while model capacity is resting. */
    async maintenance(agent: ReportAgent) {
      // Dispatch one email per tick. Reservations (including failed attempts) count
      // toward UTC-day caps so errors cannot become a retry storm.
      const reservation = await locked(async tx => {
        const now = options.now();
        if (!await validAgent(tx,agent)) return null;
        const due = await tx.reportRun.findMany({ where: { status: 'awaiting-owner', dueAt: { lte: now }, sendAfterAt: { lte: now }, AND: [{ OR: [{ retryAt: null }, { retryAt: { lte: now } }] }, { OR: [{ leaseUntil:null }, { leaseUntil:{lte:now} }] }] }, include: { subscription: true }, orderBy: { dueAt: 'asc' }, take: 100 });
        for (const run of due) {
          const sub = run.subscription, user = await allowed(tx, sub, now);
          if (!user || !run.html || !run.text) continue;
          const email = verifiedRecipient(user)!;
          if (run.deliveryEmail && run.deliveryEmail !== email) {
            await tx.reportRun.update({ where: { id: run.id }, data: { status: 'held', failureReason: 'account-email-changed' } }); continue;
          }
          if (run.dispatchAt && +now - +run.dispatchAt >= 23 * 3_600_000) {
            await tx.reportRun.update({ where: { id: run.id }, data: { status: 'failed', failureReason: 'delivery-outcome-unknown' } }); continue;
          }
          const counts = { dispatchAt: { gte: dayStart(now) }, id: { not: run.id } };
          const perUser = await tx.reportRun.count({ where: { ...counts, subscription: { userId: sub.userId } } });
          const global = await tx.reportRun.count({ where: counts });
          const userCap = await paid(tx,sub.userId,user.email,now) ? options.perUserCap : Math.min(1,options.perUserCap);
          if (perUser >= userCap || global >= options.globalCap) continue;
          if (!options.senderIdentity) continue; // Sender identity is required before rollout.
          const unsubscribe = link('unsubscribe', sub.id, now, sub.tokenVersion);
          const mail = { to: email, subject: `Isobar · ${places(sub).map(p => p.name).join(', ').slice(0, 140)}`, replyTo: options.replyTo,
            html: `${run.html}<footer style="font:12px Arial;color:#58646b">${escapeHtml(options.senderIdentity)} · <a href="${escapeHtml(unsubscribe)}">Unsubscribe</a></footer>`,
            text: `${run.text}\n\n${options.senderIdentity}\nUnsubscribe: ${unsubscribe}`,
            headers: { 'Message-ID': run.messageId, ...(run.inReplyTo ? { 'In-Reply-To': run.inReplyTo, References: run.inReplyTo } : {}), 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
          if (run.sendAttempts >= 2) {
            await tx.reportRun.update({ where: {id:run.id}, data:{status:'failed',failureReason:'delivery-retries-exhausted'} }); continue;
          }
          const leaseId = randomUUID();
          await tx.reportRun.update({ where:{id:run.id}, data:{ deliveryPayload:run.deliveryPayload ?? mail as unknown as Prisma.InputJsonValue,
            deliveryEmail:email, dispatchAt:run.dispatchAt ?? now, sendAttempts:{increment:1}, retryAt:new Date(+now+60_000),
            leaseId, leaseUntil:new Date(+now+60_000), claimedBy:agent.host, agentTokenId:agent.id } });
          return {id:run.id,leaseId};
        }
        return null;
      });
      if (reservation) await locked(async tx => {
        const now=options.now(); if (!await validAgent(tx,agent)) return;
        const run=await tx.reportRun.findFirst({where:{...fence(agent,reservation.id,reservation.leaseId,now),status:'awaiting-owner'},include:{subscription:true}});
        if (!run) return;
        const sub=run.subscription, user=await allowed(tx,sub,now);
        if (!user || verifiedRecipient(user)!==run.deliveryEmail || !run.deliveryPayload) {
          await tx.reportRun.update({where:{id:run.id},data:{status:'held',failureReason:'delivery-authorization-changed',...clearLease}}); return;
        }
        let providerId: string;
        try { providerId=await options.deliver(run.deliveryPayload as unknown as Mail,`isobar-report-${run.id}`); }
        catch {
          await tx.reportRun.update({where:{id:run.id},data:{status:run.sendAttempts>=2?'failed':'awaiting-owner',failureReason:'delivery-failed',...clearLease}}); return;
        }
        await tx.reportRun.update({where:{id:run.id},data:{status:'sent',sentAt:now,providerId,failureReason:null,...clearLease}});
        if (sub.kind==='once' && sub.threadId && await tx.chatThread.findFirst({where:{id:sub.threadId,userId:sub.userId}})) {
          await tx.chatMessage.upsert({where:{id:`report-${run.id}`},update:{status:'complete',content:run.text!,deliveredAt:now},create:{id:`report-${run.id}`,threadId:sub.threadId,role:'assistant',lane:'slow',status:'complete',content:run.text!,deliveredAt:now,costUsd:0,context:{reportId:run.id}}});
        }
      });
      return locked(async tx => {
        const now = options.now();
        if (!await validAgent(tx,agent)) return null;
        const failed = await tx.reportRun.findFirst({ where: { status:'failed',failureNotifiedAt:null,OR:[{leaseUntil:null},{leaseUntil:{lte:now}}] }, orderBy: { createdAt:'asc' } });
        if (failed) {
          await tx.chatMessage.updateMany({where:{id:`report-${failed.id}`,lane:'report'},data:{status:'failed'}});
          const leaseId=randomUUID();
          await tx.reportRun.update({where:{id:failed.id},data:{leaseId,leaseUntil:new Date(+now+60_000),claimedBy:agent.host,agentTokenId:agent.id}});
          return {id:failed.id,leaseId,message:`Isobar report failed · preview ${link('preview',failed.id,now)}`};
        }
        const rows = await tx.reportRun.findMany({ where: { status: 'awaiting-owner', sendAfterAt: null, ownerNotifiedAt: null, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }, include: { subscription: true }, orderBy: { dueAt: 'asc' }, take: 100 });
        for (const run of rows) {
          const user = await allowed(tx, run.subscription, now);
          if (!user) continue;
          const leaseId = randomUUID();
          await tx.reportRun.update({ where: { id: run.id }, data: { leaseId, leaseUntil: new Date(+now + 60_000), claimedBy: agent.host, agentTokenId: agent.id } });
          const time = new Intl.DateTimeFormat('en-GB', { timeZone: run.subscription.timezone, hour:'2-digit', minute:'2-digit' }).format(run.dueAt);
          const recipient = verifiedRecipient(user)!;
          const message = `Isobar report → ${recipient.slice(0, 45)}${recipient.length > 45 ? '…' : ''} at ${time} · preview ${link('preview', run.id, now)} · hold ${link('hold', run.id, now)}`;
          return { id: run.id, leaseId, message };
        }
        return null;
      });
    },
    async notified(agent: ReportAgent, id: string, leaseId: string, channel: 'text-ian' | 'email') {
      return locked(async tx => {
        const now = options.now(), run = await tx.reportRun.findFirst({ where: { ...fence(agent,id,leaseId,now), status:{in:['awaiting-owner','failed']} }, include: { subscription:true } });
        if (!run || !await validAgent(tx,agent) || (run.status !== 'failed' && !await allowed(tx, run.subscription, now))) return false;
        if (channel === 'email') {
          if (!options.ownerEmail) return false;
          const text = `Isobar report ${run.status === 'failed' ? 'failed' : 'ready'} · preview ${link('preview',id,now)} · hold ${link('hold',id,now)}`;
          try { await options.deliver({ to: options.ownerEmail, subject:run.status === 'failed' ? 'Isobar report failed' : 'Isobar report ready',text,html:escapeHtml(text) }, `report-owner-${id}`); }
          catch { return false; }
        }
        await tx.reportRun.update({ where: { id }, data: run.status === 'failed' ? {failureNotifiedAt:now,...clearLease} : { ownerNotifiedAt: now, sendAfterAt: sendAfter(run.dueAt,now,run.subscription.kind), ...clearLease } }); return true;
      });
    },
    async reserveInbound(id: string, sender: string) {
      return locked(async tx => {
        const now = options.now();
        if (await tx.reportInbound.findUnique({ where: { id } })) return null;
        const user = await tx.user.findFirst({ where: { email: { equals: sender, mode:'insensitive' }, emailVerified: { not:null } } });
        if (!user || await blocked(tx,user.id,now)) return null;
        const where = { createdAt: { gte: dayStart(now) } };
        if (await tx.reportInbound.count({ where }) >= options.inboundGlobalCap || await tx.reportInbound.count({ where: { ...where,userId:user.id } }) >= options.inboundUserCap) return null;
        await tx.reportInbound.create({ data: { id,userId:user.id } }); return user;
      });
    },
    async cancelOneOff(userId:string,messageId:string) {
      return locked(async tx=>{
        const run=await tx.reportRun.findFirst({where:{id:messageId.slice(7),subscription:{userId,kind:'once'}},include:{subscription:true}});
        if(!run || !active.includes(run.status)) return {status:'not-found'};
        await tx.reportSubscription.update({where:{id:run.subscriptionId},data:{status:'cancelled',nextRunAt:null}});
        await holdOutstanding(tx,run.subscriptionId,'subscription-cancelled');return {status:'cancelled',messageId};
      });
    },
    async inboundContext(userId:string, inReplyTo:string) {
      const original=await database.reportRun.findFirst({where:{messageId:inReplyTo,subscription:{userId}},include:{subscription:true}});
      return original ? visible(original.subscription) : null;
    },
    async inboundCommand(userId: string, input: unknown, inReplyTo?: string) {
      const parsed = commandSchema.safeParse(input); if (!parsed.success) return no('Invalid request.');
      return locked(async tx => {
        const original = inReplyTo ? await tx.reportRun.findFirst({ where: { messageId:inReplyTo, subscription:{userId} }, include:{subscription:true} }) : null;
        let threadId = original?.subscription.threadId;
        if (threadId && !await tx.chatThread.findFirst({ where:{id:threadId,userId} })) threadId = null;
        if (!threadId) threadId = (await tx.chatThread.create({data:{userId}})).id;
        return commandIn(tx,userId,parsed.data,threadId,original?.messageId);
      });
    },
  };
}
