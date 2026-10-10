import type { PrismaClient } from '@prisma/client';
import { reportService, type ReportOptions } from '../../src/lib/reports/service';

type Row = Record<string, any>;
const same = (a: any, b: any) => a instanceof Date || b instanceof Date ? +new Date(a) === +new Date(b) : a === b;
function matches(row: Row, where: any): boolean {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((v) => matches(row, v));
    if (key === 'OR') return (value as any[]).some((v) => matches(row, v));
    if (key.includes('_') && !(key in row) && value && typeof value === 'object') return Object.entries(value as object).every(([k, v]) => matches(row, { [k]: v }));
    const found = row[key];
    if (value === null || typeof value !== 'object' || value instanceof Date) return same(found, value);
    if (!Object.keys(value).some(key=>['is','in','not','gt','gte','lt','lte','equals','mode'].includes(key))) return !!found && matches(found,value);
    if ('is' in value) return value.is === null ? found == null : matches(found ?? {}, value.is);
    return Object.entries(value as object).every(([op, operand]) => {
      if (op === 'in') return (operand as any[]).some((v) => same(found, v));
      if (op === 'not') return !matches({ value: found }, { value: operand });
      if (op === 'gt') return found != null && found > operand;
      if (op === 'gte') return found != null && found >= operand;
      if (op === 'lt') return found != null && found < operand;
      if (op === 'lte') return found != null && found <= operand;
      if (op === 'equals') return same(found, operand);
      if (op === 'mode') return true;
      return same(found, operand);
    });
  });
}

export function makeReportFixture(start = new Date('2026-10-09T00:00:00Z')) {
  let now = new Date(start);
  const users: Row[] = [], subscriptions: Row[] = [], runs: Row[] = [], inbound: Row[] = [], blocks: Row[] = [], threads: Row[] = [], messages: Row[] = [], agentTokens: Row[] = [], entitlements: Row[] = [];
  const relation = (model: string, row: Row, include: any = {}) => {
    const value = { ...row };
    if (model === 'reportRun') value.subscription = subscriptions.find((s) => s.id === row.subscriptionId);
    if (model === 'reportSubscription') value.user = users.find((u) => u.id === row.userId);
    if (model === 'reportRun' && include.subscription?.include?.user) value.subscription = { ...subscriptions.find((s) => s.id === row.subscriptionId), user: users.find((u) => u.id === subscriptions.find((s) => s.id === row.subscriptionId)?.userId) };
    if (model === 'agentToken' && include.user) value.user = users.find((u) => u.id === row.userId);
    return value;
  };
  const dataFor = (model: string) => model === 'user' ? users : model === 'reportSubscription' ? subscriptions : model === 'reportRun' ? runs : model === 'reportInbound' ? inbound : model === 'aiAccessBlock' ? blocks : model === 'chatThread' ? threads : model === 'agentToken' ? agentTokens : model === 'entitlement' ? entitlements : messages;
  const query = (model: string, args: any = {}) => dataFor(model).filter((r) => matches(relation(model, r, args.include), args.where)).sort((a, b) => {
    const orders = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
    const order = orders[0]; if (!order) return 0; const [key, dir] = Object.entries(order)[0] as [string, string]; return (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (dir === 'desc' ? -1 : 1);
  }).slice(0, args.take ?? Infinity).map((r) => relation(model, r, args.include));
  const apply = (row: Row, data: Row) => Object.entries(data).forEach(([key, value]) => { if (value && typeof value === 'object' && 'increment' in value) row[key] = (row[key] ?? 0) + value.increment; else row[key] = value; });
  let sequence=0;
  const defaults=(name:string):Row=>({id:`generated-${++sequence}`,createdAt:new Date(now),...(name==='reportSubscription'?{autoApprove:false,tokenVersion:1,threadId:null,nextRunAt:null}:{}),...(name==='reportRun'?{status:'queued',html:null,text:null,leaseId:null,leaseUntil:null,claimedBy:null,agentTokenId:null,ownerNotifiedAt:null,sendAfterAt:null,dispatchAt:null,deliveryEmail:null,deliveryPayload:null,retryAt:null,failureReason:null,failureNotifiedAt:null,sendAttempts:0,generationAttempts:0}: {})});
  const model = (name: string) => ({
    findUnique: async (args: any) => query(name, args)[0] ?? null,
    findFirst: async (args: any) => query(name, args)[0] ?? null,
    findMany: async (args: any = {}) => query(name, args),
    count: async (args: any = {}) => query(name, args).length,
    create: async ({ data }: any) => { const row = { ...defaults(name), ...data }; dataFor(name).push(row); return relation(name, row); },
    update: async ({ where, data }: any) => { const row = dataFor(name).find((candidate) => matches(relation(name, candidate), where)); if (!row) throw new Error(`missing ${name}`); apply(row, data); return relation(name, row); },
    updateMany: async ({ where, data }: any) => { const found = dataFor(name).filter((r) => matches(relation(name, r), where)); found.forEach((r) => apply(r, data)); return { count: found.length }; },
    upsert: async ({ where, create, update }: any) => { const row = dataFor(name).find((candidate) => matches(relation(name, candidate), where)); if (row) { apply(row, update); return relation(name, row); } const created = { ...defaults(name), ...create }; dataFor(name).push(created); return relation(name, created); },
  });
  const database: any = { user: model('user'), reportSubscription: model('reportSubscription'), reportRun: model('reportRun'), reportInbound: model('reportInbound'), aiAccessBlock: model('aiAccessBlock'), chatThread: model('chatThread'), chatMessage: model('chatMessage'), agentToken: model('agentToken'), entitlement: model('entitlement') };
  let mutex = Promise.resolve();
  database.$executeRaw = async () => [];
  database.$transaction = (fn: any) => { const result = mutex.then(() => fn(database)); mutex = result.then(() => undefined, () => undefined); return result; };
  users.push({ id: 'owner', email: 'owner@example.test', emailVerified: new Date(start) }); agentTokens.push({ id: 'agent-token', userId: 'owner', scope: 'owner', revokedAt: null });
  const addUser = (id: string, email = `${id}@example.test`, patch: Row = {}) => { const existing = users.find((u) => u.id === id); if (existing) { Object.assign(existing, { email, ...patch }); return existing; } const user = { id, email, emailVerified: new Date(start), ...patch }; users.push(user); if (id === 'owner') agentTokens.push({ id: 'agent-token', userId: id, scope: 'owner', revokedAt: null }); return user; };
  const addEntitlement = (userId: string, patch: Row = {}) => { const row = { userId, plan: 'monthly', status: 'active', currentPeriodStart: new Date(+now - 86_400_000), currentPeriodEnd: new Date(+now + 86_400_000), billingAnchor: new Date(now), stripeCustomerId: null, stripeSubscriptionId: null, cancelAtPeriodEnd: false, deleting: false, ...patch }; entitlements.push(row); return row; };
  const addSubscription = (id: string, userId: string, patch: Row = {}) => { const sub = { id, userId, kind: 'recurring', schedule: '0 6 * * *', timezone: 'Australia/Perth', places: [{ name: 'Perth', lat: -31.95, lon: 115.86 }], instructions: 'temperature, rain and wind', complexity: 'simple', tier: 'free', status: 'active', nextRunAt: new Date(+now + 86_400_000), autoApprove: false, tokenVersion: 1, createdAt: new Date(now), ...patch }; subscriptions.push(sub); return sub; };
  const addRun = (id: string, subscriptionId: string, patch: Row = {}) => { const run = { id, subscriptionId, dueAt: new Date(now), createdAt: new Date(now), status: 'queued', messageId: `<${id}@isobar.md>`, inReplyTo: null, leaseId: null, leaseUntil: null, claimedBy: null, agentTokenId: null, generationAttempts: 0, sendAttempts: 0, ownerNotifiedAt: null, sendAfterAt: new Date(now), dispatchAt: null, retryAt: null, failureNotifiedAt: null, html: null, text: null, ...patch }; runs.push(run); return run; };
  const deliver = async (_mail: any, _key: string) => `provider-${runs.length}`;
  const options: ReportOptions = { billingEnabled: true, now: () => new Date(now), secret: 'fixture-secret', ownerEmail: 'owner@example.test', deliver, replyTo: 'reports@isobar.md', senderIdentity: 'isobar.md', perUserCap: 10, globalCap: 100, inboundUserCap: 10, inboundGlobalCap: 100 };
  return { database: database as PrismaClient, options, service: reportService(database as PrismaClient, options), users, subscriptions, runs, inbound, blocks, threads, messages, entitlements, addEntitlement, addUser, addSubscription, addRun, deliver, setNow(value: Date | string) { now = new Date(value); }, advance(ms: number) { now = new Date(+now + ms); }, now: () => new Date(now) };
}
