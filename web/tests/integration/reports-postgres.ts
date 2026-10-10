/** Local-only migration/locking rehearsal; no model, mail or live account access. */
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { reportService, type ReportOptions } from '../../src/lib/reports/service';
import { signReportToken } from '../../src/lib/reports/tokens';
const connectionString = process.env.ISOBAR_TEST_DATABASE_URL ?? '';
const url = new URL(connectionString);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
assert(url.pathname.startsWith('/isobar_test_'), 'Use a disposable isobar_test_ database');
const client = () => new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const a = client(), b = client();
const now = new Date('2026-10-10T00:00:00Z');
const sent: string[] = [];
const options: ReportOptions = {
 now: () => now, secret: 'local-integration-fixture-not-a-secret', ownerEmail: 'owner@example.test',
 deliver: async (_mail, key) => { sent.push(key); return 'mock-provider'; },
 replyTo: 'reply@example.test', senderIdentity: 'Test fixture only', billingEnabled: false,
 perUserCap: 10, globalCap: 100, inboundUserCap: 10, inboundGlobalCap: 100,
};
const one = reportService(a, options), two = reportService(b, options);
try {
 await a.user.create({ data: { id: 'owner', email: 'owner@example.test', emailVerified: now } });
 await a.agentToken.create({ data: { id: 'token', userId: 'owner', hashedToken: 'fixture', label: 'fixture', scope: 'owner' } });
 const agent = { id: 'token', host: 'one' }, other = { id: 'token', host: 'two' };
 const sub = await a.reportSubscription.create({ data: { userId: 'owner', kind: 'once', timezone: 'Australia/Perth', places: [{ name: 'Perth', lat: -31.95, lon: 115.86 }], instructions: 'temperature, rain and wind', autoApprove: true } });
 const run = await a.reportRun.create({ data: { subscriptionId: sub.id, dueAt: now, messageId: '<fixture@example.test>' } });
 const claims = await Promise.all([one.claim(agent), two.claim(other)]);
 assert.equal(claims.filter(Boolean).length, 1, 'two daemons may not claim one run');
 const index = claims.findIndex(Boolean), lease = claims[index]!;
 const owner = index === 0 ? agent : other;
 assert.equal(await one.ready(owner, run.id, 'stale-lease', 'Perth temperature is 20 C.'), false);
 assert.equal(await one.ready(owner, run.id, lease.leaseId, 'Perth temperature is 20 C.'), true);
 await Promise.all([one.maintenance(agent), two.maintenance(other)]);
 assert.equal(sent.length, 1, 'two daemons may not dispatch one report twice');
 assert.equal((await a.reportRun.findUniqueOrThrow({ where: { id: run.id } })).status, 'sent');
 // A database lock held by another connection must fence a signed cancellation.
 const held = await a.reportRun.create({ data: { subscriptionId: sub.id, dueAt: new Date(+now + 1), messageId: '<hold@example.test>', status: 'awaiting-owner' } });
 let release!: () => void, acquired!: () => void;
 const heldLock = new Promise<void>(r => { acquired = r; });
 const unlock = new Promise<void>(r => { release = r; });
 const locker = a.$transaction(async tx => {
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(176917, 1)`;
   acquired(); await unlock;
 });
 await heldLock;
 let finished = false;
 const token = signReportToken(options.secret, 'hold', held.id, 1, new Date(+now + 60_000));
 const holding = two.hold(held.id, token).then(result => { finished = true; return result; });
 try {
   await new Promise(r => setTimeout(r, 100));
   assert.equal(finished, false, 'hold must wait for transaction lock');
 } finally { release(); await locker; }
 assert.equal(await holding, true);
 assert.equal((await a.reportRun.findUniqueOrThrow({ where: { id: held.id } })).status, 'held');
 console.log('PASS PostgreSQL: migration schema, exclusive claims, stale lease, single delivery and hold lock');
} finally {
 await a.user.deleteMany({ where: { id: 'owner' } });
 await Promise.all([a.$disconnect(), b.$disconnect()]);
}
