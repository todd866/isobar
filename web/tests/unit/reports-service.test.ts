import { describe, expect, it, vi } from 'vitest';
import { signReportToken } from '../../src/lib/reports/tokens';
import { makeReportFixture } from './reports-store.fixture';

const agent = { id: 'agent-token', host: 'laptop' };
const command = (patch: Record<string, unknown> = {}) => ({ action: 'create', kind: 'recurring', schedule: '0 6 * * *', timezone: 'Australia/Perth', places: [{ name: 'Perth', lat: -31.95, lon: 115.86 }], instructions: 'temperature, rain and wind', ...patch });

describe('report service store behavior', () => {
  it('claims a due run once across two daemons and respects the 20 minute window', async () => {
    const f = makeReportFixture(); f.addUser('alice'); f.addSubscription('sub', 'alice', { nextRunAt: new Date('2026-10-09T00:30:00Z') }); f.addRun('run', 'sub', { dueAt: new Date('2026-10-09T00:30:00Z') });
    expect(await f.service.claim(agent)).toBeNull();
    f.setNow('2026-10-09T00:10:01Z');
    const [first, second] = await Promise.all([f.service.claim(agent), f.service.claim({ ...agent, host: 'standby' })]);
    expect(first?.id).toBeTruthy(); expect(second).toBeNull();
  });

  it('rejects stale generation leases and accepts only the current lease', async () => {
    const f = makeReportFixture(); f.addUser('alice'); f.addSubscription('sub', 'alice'); const run = f.addRun('run', 'sub');
    const claim = await f.service.claim(agent); expect(claim?.id).toBe(run.id);
    f.advance(16 * 60_000);
    expect(await f.service.ready(agent, run.id, claim!.leaseId, 'report')).toBe(false);
    expect(await f.service.release(agent, run.id, claim!.leaseId)).toBe(false);
  });

  it('holds before due and sends after the recurring five minute owner window', async () => {
    const f = makeReportFixture(); f.addUser('alice'); f.addSubscription('sub', 'alice'); const run = f.addRun('run', 'sub');
    const claim = await f.service.claim(agent); expect(await f.service.ready(agent, run.id, claim!.leaseId, 'Perth temperature is 20 C.')).toBe(true);
    const task = await f.service.maintenance(agent); expect(task?.id).toBe(run.id);
    expect(await f.service.notified(agent, run.id, task!.leaseId, 'text-ian')).toBe(true);
    expect(f.runs[0].sendAfterAt).toBeTruthy();
    f.advance(5 * 60_000); await f.service.maintenance(agent);
    expect(f.runs[0].status).toBe('sent');
  });

  it('honors a signed hold token before the due time', async () => {
    const f = makeReportFixture(); f.addUser('alice'); f.addSubscription('sub', 'alice'); const run = f.addRun('run', 'sub');
    const claim = await f.service.claim(agent); expect(await f.service.ready(agent, run.id, claim!.leaseId, 'Perth temperature is 20 C.')).toBe(true);
    const token = signReportToken(f.options.secret, 'hold', run.id, 1, new Date(+f.now() + 60_000));
    expect(await f.service.hold(run.id, token)).toBe(true); expect(f.runs[0].status).toBe('held');
    await f.service.maintenance(agent); expect(f.runs[0].status).toBe('held');
  });

  it('rejects a revoked owner agent token', async () => {
    const f = makeReportFixture(); f.addUser('alice'); f.addSubscription('sub', 'alice'); f.addRun('run', 'sub');
    await (f.database as any).agentToken.updateMany({ where: { id: 'agent-token' }, data: { revokedAt: new Date() } });
    expect(await f.service.claim(agent)).toBeNull();
  });

  it('skips owner one-off approval and sends at due time', async () => {
    const f = makeReportFixture(); f.addUser('owner'); f.addSubscription('sub', 'owner', { kind: 'once', schedule: null, nextRunAt: null }); const run = f.addRun('run', 'sub');
    const claim = await f.service.claim(agent); expect(await f.service.ready(agent, run.id, claim!.leaseId, 'Perth temperature is 20 C.')).toBe(true);
    expect(f.runs[0].status).toBe('awaiting-owner');
    await f.service.maintenance(agent); expect(f.runs[0].status).toBe('sent');
  });

  it('uses the current verified account email and rejects unverified recipients', async () => {
    const f = makeReportFixture(); f.addUser('alice', 'typed@example.test', { emailVerified: null });
    expect((await f.service.command('alice', command())).ok).toBe(false);
    const alice = f.users.find((u) => u.id === 'alice')!; alice.email = 'current@example.test'; alice.emailVerified = new Date();
    expect((await f.service.command('alice', command())).ok).toBe(true);
  });

  it('enforces one free recurring report and allows complex work only while paid', async () => {
    const f = makeReportFixture(); f.addUser('alice');
    expect((await f.service.command('alice', command())).ok).toBe(true);
    expect((await f.service.command('alice', command({ instructions: 'detailed surf and swell', complexity: 'complex' }))).ok).toBe(false);
    f.subscriptions.length = 0; f.addEntitlement('alice', { currentPeriodEnd: new Date(+f.now() + 60_000) });
    expect((await f.service.command('alice', command({ instructions: 'detailed surf and swell', complexity: 'complex' }))).ok).toBe(true);
    f.entitlements[0].currentPeriodEnd = new Date(+f.now() - 1);
    expect((await f.service.command('alice', command({ instructions: 'detailed aviation TAF', complexity: 'complex' }))).ok).toBe(false);
  });

  it('respects AiAccessBlock at claim and delivery', async () => {
    const f = makeReportFixture(); f.addUser('alice'); f.addSubscription('sub', 'alice'); f.addRun('run', 'sub'); f.blocks.push({ id: 'b', scope: 'alice', until: new Date(+f.now() + 60_000), liftedAt: null });
    expect(await f.service.claim(agent)).toBeNull();
    f.blocks[0].liftedAt = new Date(); const claim = await f.service.claim(agent); expect(claim).toBeTruthy();
    expect(await f.service.ready(agent, claim!.id, claim!.leaseId, 'Perth temperature is 20 C.')).toBe(true); f.blocks[0].liftedAt = null; f.blocks[0].until = new Date(+f.now() + 60_000);
    expect(await f.service.maintenance(agent)).toBeNull(); expect(f.runs[0].status).toBe('awaiting-owner');
  });

  it('unsubscribes with the signed token and cancels pending work', async () => {
    const f = makeReportFixture(); f.addUser('alice'); f.addSubscription('sub', 'alice'); const run = f.addRun('run', 'sub', { status: 'awaiting-owner' });
    const token = signReportToken(f.options.secret, 'unsubscribe', 'sub', 1);
    expect(await f.service.unsubscribe('sub', token)).toBe(true); expect(f.subscriptions[0].status).toBe('cancelled'); expect(f.runs[0].status).toBe('held');
    expect(await f.service.unsubscribe('sub', token)).toBe(true); expect(run.id).toBe('run');
  });

  it('retries delivery once with immutable idempotency key then reports failure', async () => {
    const f = makeReportFixture(); f.addUser('alice'); f.addSubscription('sub', 'alice', { autoApprove: true }); const run = f.addRun('run', 'sub');
    const claim = await f.service.claim(agent); await f.service.ready(agent, run.id, claim!.leaseId, 'Perth temperature is 20 C.');
    const deliver = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('provider-ok'); (f.options as any).deliver = deliver;
    await f.service.maintenance(agent); expect(deliver).toHaveBeenCalledTimes(1); expect(f.runs[0].status).toBe('awaiting-owner');
    f.advance(61_000); await f.service.maintenance(agent); expect(deliver).toHaveBeenCalledTimes(2); expect(deliver.mock.calls[0][1]).toBe(deliver.mock.calls[1][1]);
  });

  it('applies concurrent global and per-user send caps', async () => {
    const f = makeReportFixture(); f.options.globalCap = 1; f.options.perUserCap = 1;
    f.addUser('alice'); f.addUser('bob');
    for (const [sub, user, run] of [['a', 'alice', 'ra'], ['b', 'bob', 'rb']] as const) { f.addSubscription(sub, user, { autoApprove: true }); f.addRun(run, sub); const c = await f.service.claim(agent); await f.service.ready(agent, c!.id, c!.leaseId, 'Perth temperature is 20 C.'); }
    await Promise.all([f.service.maintenance(agent), f.service.maintenance({ ...agent, host: 'other' })]);
    expect(f.runs.filter((r) => r.status === 'sent')).toHaveLength(1);
  });
});

describe('report dispatch boundaries',()=>{
 it('does not deliver when sender identity is missing',async()=>{
  const f=makeReportFixture();f.addUser('alice');f.addSubscription('sub','alice',{autoApprove:true});const run=f.addRun('run','sub');
  const job=await f.service.claim(agent);expect(job).toBeTruthy();expect(await f.service.ready(agent,job!.id,job!.leaseId,'Perth forecast')).toBe(true);
  const deliver=vi.fn(async()=> 'provider-ok');f.options.deliver=deliver;f.options.senderIdentity='';
  await f.service.maintenance(agent);
  expect(deliver).not.toHaveBeenCalled();expect(run.status).toBe('awaiting-owner');
 });
 it('one-off reports poll in the chat and complete once after a two minute window',async()=>{
  const f=makeReportFixture();f.addUser('alice');f.threads.push({id:'thread',userId:'alice'});
  const reply=await f.service.command('alice',command({kind:'once',schedule:undefined}),'thread') as {reportId:string};
  expect(reply.reportId).toBeTruthy();expect(f.messages[0]).toMatchObject({lane:'report',status:'pending'});
  const job=await f.service.claim(agent);expect(job).toBeTruthy();await f.service.ready(agent,job!.id,job!.leaseId,'Perth forecast');
  const notify=await f.service.maintenance(agent);expect(notify!.message.length).toBeLessThanOrEqual(300);
  await f.service.notified(agent,job!.id,notify!.leaseId,'text-ian');
  f.advance(119_999);await f.service.maintenance(agent);expect(f.runs[0].status).toBe('awaiting-owner');
  f.advance(1);await f.service.maintenance(agent);expect(f.runs[0].status).toBe('sent');
  expect(f.messages).toHaveLength(1);expect(f.messages[0]).toMatchObject({id:reply.reportId,status:'complete'});
 });
 it('retries once with the frozen payload and then notifies through the local channel',async()=>{
  const f=makeReportFixture();f.addUser('alice');f.addSubscription('sub','alice',{autoApprove:true});f.addRun('run','sub');
  const job=await f.service.claim(agent);await f.service.ready(agent,job!.id,job!.leaseId,'Perth forecast');
  const send=vi.fn(async()=>{throw new Error('mock outage');});f.options.deliver=send;
  await f.service.maintenance(agent);f.options.senderIdentity='new identity after first request';
  f.advance(61_000);const failed=await f.service.maintenance(agent);
  expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);expect(f.runs[0].status).toBe('failed');
  expect(failed!.message).toContain('report failed');await f.service.notified(agent,failed!.id,failed!.leaseId,'text-ian');
  f.advance(61_000);await f.service.maintenance(agent);expect(send).toHaveBeenCalledTimes(2);expect(f.runs[0].failureNotifiedAt).not.toBeNull();
 });
 it('holds a retry if the verified account email changed after reservation',async()=>{
  const f=makeReportFixture();const user=f.addUser('alice');f.addSubscription('sub','alice',{autoApprove:true});f.addRun('run','sub');
  const job=await f.service.claim(agent);await f.service.ready(agent,job!.id,job!.leaseId,'Perth forecast');
  const send=vi.fn(async()=>{throw new Error('mock outage');});f.options.deliver=send;
  await f.service.maintenance(agent);user.email='new@example.test';f.advance(61_000);await f.service.maintenance(agent);
  expect(send).toHaveBeenCalledTimes(1);expect(f.runs[0]).toMatchObject({status:'held',failureReason:'account-email-changed'});
 });
 it('enforces a per-user cap separately from the global cap',async()=>{
  const f=makeReportFixture();f.addUser('alice');f.addEntitlement('alice');f.options.perUserCap=1;
  for(const id of ['a','b']){f.addSubscription(id,'alice',{autoApprove:true});f.addRun(id,id);const job=await f.service.claim(agent);await f.service.ready(agent,job!.id,job!.leaseId,'Perth forecast');}
  await Promise.all([f.service.maintenance(agent),f.service.maintenance(agent)]);expect(f.runs.filter(r=>r.status==='sent')).toHaveLength(1);
 });
 it('updates a prepared recurring report for today instead of skipping it',async()=>{
  const f=makeReportFixture(new Date('2026-10-09T21:45:00Z'));f.addUser('alice');f.addSubscription('sub','alice',{nextRunAt:new Date('2026-10-09T22:00:00Z')});
  const job=await f.service.claim(agent);expect(job).toBeTruthy();
  expect((await f.service.command('alice',{action:'update',id:'sub',instructions:'Shorter'})).ok).toBe(true);
  const next=await f.service.claim(agent);expect(next?.id).toBe(job!.id);expect(next?.report.instructions).toContain('Shorter');
  expect(await f.service.ready(agent,job!.id,job!.leaseId,'Old content')).toBe(false);
 });
 it('updates one-off instructions without creating another billable report',async()=>{
  const f=makeReportFixture();f.addUser('alice');await f.service.command('alice',command({kind:'once',schedule:undefined}));
  expect((await f.service.command('alice',{action:'update',id:f.subscriptions[0].id,instructions:'Shorter'})).ok).toBe(true);
  expect(f.runs).toHaveLength(1);expect(f.runs[0].status).toBe('queued');
 });
});

it('free daily allowance is shared by one-off and recurring deliveries',async()=>{
 const f=makeReportFixture();f.addUser('alice');
 for(const [id,kind] of [['once','once'],['daily','recurring']] as const){f.addSubscription(id,'alice',{kind,autoApprove:true});f.addRun(id,id);const job=await f.service.claim(agent);await f.service.ready(agent,job!.id,job!.leaseId,'Perth forecast');}
 await Promise.all([f.service.maintenance(agent),f.service.maintenance(agent)]);
 expect(f.runs.filter(r=>r.status==='sent')).toHaveLength(1);
});

it('a simple one-off alongside a free recurring report does not silently require paid access',async()=>{
 const f=makeReportFixture();f.addUser('alice');await f.service.command('alice',command());
 expect((await f.service.command('alice',command({kind:'once',schedule:undefined}))).ok).toBe(true);
 expect(f.subscriptions.find(s=>s.kind==='once')?.tier).toBe('free');expect(await f.service.claim(agent)).toBeTruthy();
});


describe('reports share billing entitlement policy', () => {
  it.each([
    { status: 'past_due' }, { status: 'canceled' }, { deleting: true }, { plan: 'unknown' },
    { currentPeriodStart: new Date('2026-10-10T00:00:00Z') }, { currentPeriodEnd: new Date('2026-10-09T00:00:00Z') },
  ])('rejects inactive billing state %j at admission and claim', async patch => {
    const f = makeReportFixture(); f.addUser('alice'); f.addEntitlement('alice', patch);
    expect((await f.service.command('alice', command({ kind: 'once', complexity: 'complex' }))).ok).toBe(false);
    f.addSubscription('sub', 'alice', { kind: 'once', tier: 'paid' }); f.addRun('run', 'sub');
    expect(await f.service.claim(agent)).toBeNull();
  });
  it('keeps cancellation-at-period-end access but rechecks before ready and delivery', async () => {
    const f = makeReportFixture(); f.addUser('alice'); const entitlement = f.addEntitlement('alice', { plan: 'yearly', cancelAtPeriodEnd: true });
    expect((await f.service.command('alice', command({ kind: 'once', complexity: 'complex' }))).ok).toBe(true);
    f.subscriptions[0].autoApprove = true;
    const job = await f.service.claim(agent); expect(job).toBeTruthy();
    entitlement.status = 'past_due';
    expect(await f.service.ready(agent, job!.id, job!.leaseId, 'Perth forecast')).toBe(false);
    entitlement.status = 'active';
    expect(await f.service.ready(agent, job!.id, job!.leaseId, 'Perth forecast')).toBe(true);
    const send = vi.fn(async () => 'mock'); f.options.deliver = send;
    entitlement.currentPeriodEnd = f.now();
    await f.service.maintenance(agent); expect(send).not.toHaveBeenCalled();
  });
  it('does not grant paid access from an old entitlement when billing is disabled', async () => {
    const f = makeReportFixture(); f.addUser('alice'); f.addEntitlement('alice'); f.options.billingEnabled = false;
    expect((await f.service.command('alice', command({ kind: 'once', complexity: 'complex' }))).ok).toBe(false);
  });
});
