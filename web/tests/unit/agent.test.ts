import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { postAgent, claimNext, LEASE_MS, MAX_REPLY_CHARS, type AgentDeps } from '../../src/lib/agent/service';
import { prismaArchiveStore } from '../../src/lib/chat/archive-store';
import { archiveRow } from '../../src/lib/chat/archive';
import { prismaAgentStore } from '../../src/lib/agent/prisma-store';
import { hashAgentToken, mintAgentToken, type AgentPrincipal } from '../../src/lib/agent/token';
import { getThread } from '../../src/lib/chat/thread';
import { tokenOptions } from '../../scripts/agent-token';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const SECRET = 'unit-only-secret';
const owner = { id: 'owner-token', userId: 'owner', scope: 'owner' as const };
const alice = { id: 'alice-token', userId: 'alice', scope: 'user' as const };
const bob = { id: 'bob-token', userId: 'bob', scope: 'user' as const };

type Row = Record<string, any>; // Prisma double: real adapter predicates, atomic synchronous updates below.
function matches(row: any, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((x) => matches(row, x));
    if (key === 'OR') return value.some((x: Row) => matches(row, x));
    const found = row?.[key];
    if (!value || typeof value !== 'object' || value instanceof Date) return value instanceof Date ? +found === +value : found === value;
    if ('is' in value) return value.is === null ? found == null : found != null && matches(found, value.is);
    return Object.entries(value).every(([op, operand]: [string, any]) => {
      if (op === 'in') return operand.includes(found);
      if (op === 'notIn') return !operand.includes(found);
      if (op === 'not') return found !== operand;
      if (op === 'gt') return found != null && found > operand;
      if (op === 'gte') return found != null && found >= operand;
      if (op === 'lte') return found != null && found <= operand;
      if (op === 'lt') return found != null && found < operand;
      return matches(found, { [op]: operand });
    });
  });
}
function fixture() {
  let time = NOW;
  const users: Row[] = ['owner', 'alice', 'bob'].map((id) => ({ id, email: `${id}@example.test`, clusterId: null, chatStanding: null }));
  const threads: Row[] = users.map((u) => ({ id: `thread-${u.id}`, userId: u.id, updatedAt: new Date(NOW) }));
  threads.push({ id: 'thread-anon', userId: null as any, updatedAt: new Date(NOW) });
  const clusters: Row[] = [];
  const accessBlocks: Row[] = [];
  const heartbeats: Row[] = [];
  const messages: Row[] = [];
  const tokens: Row[] = [];
  const secrets = new Map<string, string>();
  for (const principal of [owner, alice, bob]) {
    const minted = mintAgentToken(SECRET);
    secrets.set(principal.id, minted.token);
    tokens.push({ ...principal, hashedToken: minted.hashedToken, revokedAt: null });
  }
  const relation = (row: Row) => ({ ...row,
    thread: { ...threads.find((t) => t.id === row.threadId), user: users.find((u) => u.id === threads.find((t) => t.id === row.threadId)?.userId) ?? null },
    agentToken: tokens.find((t) => t.id === row.agentTokenId) ?? null,
  });
  const query = (rows: Row[], args: Row) => {
    let result = rows.filter((row) => matches(row, args.where ?? {}));
    for (const order of [...(Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [])].reverse()) {
      const [key, direction] = Object.entries(order)[0];
      result = result.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (direction === 'desc' ? -1 : 1));
    }
    return args.take ? result.slice(0, args.take) : result;
  };
  const messageUpdate = vi.fn(async ({ where, data }: Row) => {
    const found = messages.filter((row) => matches(relation(row), where));
    // No await between predicate evaluation and mutation: this is the CAS.
    found.forEach((row) => Object.assign(row, data));
    return { count: found.length };
  });
  const database = {
    user: { findUnique: vi.fn(async ({ where }: Row) => users.find((row) => matches(row, where)) ?? null) },
    chatCluster: { findMany: vi.fn(async (args: Row) => query(clusters, args)), findUnique: vi.fn(async (args: Row) => query(clusters, args)[0] ?? null) },
    chatThread: { findFirst: vi.fn(async (args: Row) => query(threads, args)[0] ?? null), update: vi.fn(async ({where, data}: Row) => { const row = threads.find((row) => matches(row, where)); Object.assign(row!, data); return row; }) },
    aiAccessBlock: { findMany: vi.fn(async (args: Row) => query(accessBlocks, args)), findFirst: vi.fn(async (args: Row) => query(accessBlocks, args)[0] ?? null) },
    agentToken: {
      findUnique: vi.fn(async ({ where }: Row) => {
        const token = tokens.find((row) => matches(row, where));
        return token ? { ...token, user: users.find((u) => u.id === token.userId) } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const found = tokens.filter((row) => matches(row, where)); found.forEach((row) => Object.assign(row, data));
        return { count: found.length };
      }),
    },
    chatMessage: {
      findFirst: vi.fn(async (args: Row) => query(messages.map(relation), args)[0] ?? null),
      findMany: vi.fn(async (args: Row) => query(messages.map(relation), args)),
      count: vi.fn(async (args: Row) => query(messages.map(relation), args).length),
      updateMany: messageUpdate,
      create: vi.fn(async ({data}: Row) => { const row = { id: `new-${messages.length}`, ...data }; messages.push(row); return row; }),
    },
    agentHeartbeat: {
      upsert: vi.fn(async ({ where, create, update }: Row) => {
        const found = heartbeats.find((row) => row.host === where.host_tokenId.host && row.tokenId === where.host_tokenId.tokenId);
        if (found) Object.assign(found, update); else heartbeats.push({ ...create });
        return found ?? create;
      }),
      findMany: vi.fn(async (args: Row) => query(heartbeats, args)),
    },
  } as unknown as PrismaClient;
  let queue = Promise.resolve();
  database.$queryRaw = vi.fn(async () => []) as any;
  database.$transaction = ((fn: (tx: PrismaClient) => Promise<unknown>) => {
    const result = queue.then(() => fn(database)); queue = result.then(() => {}, () => {}); return result;
  }) as any;
  function add(id: string, userId = 'alice', patch: Row = {}) {
    const row = { id, threadId: `thread-${userId}`, role: 'assistant', lane: 'slow', status: 'pending',
      content: '', context: { question: 'Why the wind change?', timeUtc: '2026-10-08T18:00:00Z' }, model: null, images: null,
      createdAt: new Date(time), leaseId: null, leaseUntil: null, agentTokenId: null, claimedBy: null, deliveredAt: null, ...patch };
    messages.push(row); return row;
  }
  const store = prismaAgentStore(database, 'owner@example.test');
  const deps: AgentDeps = { store, secret: SECRET, ownerEmail: 'owner@example.test', now: () => new Date(time), limited: vi.fn(async () => false) };
  const call = (action: 'pending' | 'claim' | 'reply' | 'release' | 'health' | 'heartbeat', caller: AgentPrincipal = alice, payload?: unknown) => {
    const actual = action;
    const body = actual === 'claim' ? (payload ?? { host: 'air-primary', role: 'primary' }) : (payload ?? {});
    return postAgent(actual, new Request(`https://isobar.test/api/agent/${actual}`, {
    method: 'POST', headers: { authorization: `Bearer ${secrets.get(caller.id)}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), deps);
  };
  const answer = (claim: any, text = 'The archived run shows the front approaching Perth.') => ({ id: claim.id, leaseId: claim.leaseId, host: 'air-primary', text, model: 'claude-opus-5-5', toolsUsed: ['mcp__isobar-archive__sample'] });
  return { store, database, deps, add, threads, users, clusters, accessBlocks, heartbeats, messages, tokens, secrets, call, answer, messageUpdate, advance: (ms: number) => { time += ms; } };
}

describe('agent claims through the Prisma CAS adapter', () => {
  it('retires the legacy pending endpoint', async () => {
    const f = fixture();
    const response = await postAgent('pending', new Request('https://isobar.test/api/agent/pending', {
      method: 'POST', headers: { authorization: `Bearer ${f.secrets.get(alice.id)}` },
    }), f.deps);
    expect(response.status).toBe(410);
  });
  it('gives exactly one of two concurrent claimers the same row', async () => {
    const f = fixture(); f.add('slow');
    const originalNext = f.store.next;
    let readers = 0;
    let open!: () => void;
    const bothRead = new Promise<void>((resolve) => { open = resolve; });
    f.store.next = async (caller) => {
      const row = await originalNext(caller);
      if (readers < 2) {
        expect(row?.id).toBe('slow');
        readers += 1;
        if (readers === 2) open();
        await bothRead;
      }
      return row;
    };
    const responses = await Promise.all([f.call('claim', alice), f.call('claim', owner)]);
    const results = await Promise.all(responses.map((r) => r.json()));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(f.messages[0].status).toBe('claimed');
    expect(f.messageUpdate.mock.calls.some(([args]) => args.where.AND?.some((part: any) => part.status === 'pending') && args.data.status === 'claimed')).toBe(true);
  });
  it('gives exactly one lease when two hosts use the same token', async () => {
    const f = fixture(); f.add('slow');
    const originalNext = f.store.next;
    let readers = 0; let open!: () => void;
    const barrier = new Promise<void>((resolve) => { open = resolve; });
    f.store.next = async (...args) => {
      const row = await originalNext(...args);
      readers += 1;
      if (readers === 2) open();
      if (readers <= 2) await barrier;
      return row;
    };
    const [a, b] = await Promise.all([
      f.call('claim', alice, { host: 'air-primary', role: 'primary' }),
      f.call('claim', alice, { host: 'air-standby', role: 'primary' }),
    ]);
    expect((await Promise.all([a.json(), b.json()])).filter(Boolean)).toHaveLength(1);
  });
  it('standby claims only at the age boundary and can take over an expired lease', async () => {
    const f = fixture(); const row = f.add('slow');
    expect(await (await f.call('claim', alice, { host: 'air-standby', role: 'standby', standbyMs: 90_000 })).json()).toBeNull();
    f.advance(90_000); row.createdAt = new Date(NOW - 90_000);
    const claim = await (await f.call('claim', alice, { host: 'air-standby', role: 'standby', standbyMs: 90_000 })).json();
    expect(claim.id).toBe('slow');
    f.advance(LEASE_MS);
    const takeover = await (await f.call('claim', alice, { host: 'air-primary', role: 'primary' })).json();
    expect(takeover.leaseId).not.toBe(claim.leaseId);
    expect((await f.call('reply', alice, f.answer(claim))).status).toBe(409);
  });
  it('filters blocked users without widening a user token to other threads', async () => {
    const f = fixture(); f.add('alice-row', 'alice'); f.add('bob-row', 'bob');
    f.accessBlocks.push({ scope: 'bob', until: new Date(NOW + 60_000), liftedAt: null });
    expect((await (await f.call('claim', alice)).json()).id).toBe('alice-row');
  });
  it('expires at the lease boundary, permits one new claim, rejects the old holder even with the same token', async () => {
    const f = fixture(); f.add('slow');
    const first = await (await f.call('claim')).json();
    expect(Date.parse(first.leaseUntil) - NOW).toBe(LEASE_MS);
    f.advance(LEASE_MS);
    expect((await f.call('reply', alice, f.answer(first))).status).toBe(409);
    const claims = await Promise.all([f.call('claim'), f.call('claim')]);
    const renewed = (await Promise.all(claims.map((r) => r.json()))).filter(Boolean);
    expect(renewed).toHaveLength(1);
    expect(renewed[0].leaseId).not.toBe(first.leaseId);
    expect((await f.call('reply', alice, f.answer(first))).status).toBe(409);
    expect((await f.call('reply', alice, f.answer(renewed[0]))).status).toBe(200);
  });
  it('user scope cannot claim another user or anonymous; owner takes its own first', async () => {
    const f = fixture(); f.add('b', 'bob'); f.add('anon', 'anon');
    expect(await (await f.call('claim')).json()).toBeNull();
    f.add('o', 'owner');
    expect((await (await f.call('claim', owner)).json()).id).toBe('o');
    expect((await (await f.call('claim', owner)).json()).id).toBe('b');
    expect(await (await f.call('claim', owner)).json()).toBeNull();
  });
  it('owner scope serves lower standings, respects suspensions, and never checks API budgets', async () => {
    const f = fixture(); f.add('a');
    f.users[1].chatStanding = { tier: 'haiku', pinnedTier: null };
    const first = await (await f.call('claim', owner)).json();
    expect(first.id).toBe('a');
    expect((await f.call('release', owner, { id: first.id, leaseId: first.leaseId, host: 'air-primary' })).status).toBe(200);
    f.users[1].chatStanding.pinnedTier = 'opus'; f.users[1].clusterId = 'suspended';
    f.clusters.push({ id: 'suspended', suspended: true });
    expect(await (await f.call('claim', owner)).json()).toBeNull();
    f.clusters[0].suspended = false;
    expect((await (await f.call('claim', owner)).json()).id).toBe('a');
  });
  it('returns saved context, six exchanges, no profile guesses or watcher rows', async () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) {
      f.add(`u${i}`, 'alice', { role: 'user', lane: 'fast', status: 'complete', content: `Question ${i}`, context: { runId: 'run-at-send', place: { name: 'Perth' } }, createdAt: new Date(NOW - 100 + i * 2) });
      f.add(`a${i}`, 'alice', { lane: 'fast', status: 'complete', content: `Answer ${i}`, context: { place: { name: 'Perth' } }, createdAt: new Date(NOW - 99 + i * 2) });
    }
    f.add('watch', 'alice', { role: 'screen', status: 'complete', content: 'private screen' });
    f.add('slow', 'alice', { context: { question: 'Archive question' } });
    const claim = await (await f.call('claim')).json();
    expect(claim.context).toEqual({ runId: 'run-at-send', place: { name: 'Perth' } });
    expect(claim.question).toBe('Archive question');
    expect(claim.thread).toHaveLength(12);
    expect(claim.thread[0].content).toBe('Question 2');
    expect(claim.user).toEqual({ level: null, goal: null });
    expect(JSON.stringify(claim)).not.toContain('private screen');
  });
  it('releases a claimed row when payload loading fails', async () => {
    const f = fixture(); f.add('slow'); f.store.payload = async () => { throw new Error('unavailable'); };
    await expect(claimNext(alice, f.store, f.deps.now, { host: 'air-primary' })).rejects.toThrow('unavailable');
    expect(f.messages[0].status).toBe('pending');
  });
});

describe('agent replies, tokens and release', () => {
  it('honours new global blocks at CAS, and target-user blocks at owner delivery', async () => {
    const f = fixture(); const row = f.add('slow');
    const candidate = await f.store.next(owner, f.deps.now());
    f.accessBlocks.push({ scope: 'global', until: new Date(NOW + 60_000), liftedAt: null });
    expect(await f.store.claim(owner, candidate!, '12345678-1234-4123-8123-123456789012', f.deps.now(), new Date(NOW + LEASE_MS), 'air')).toBe(false);
    expect(row.status).toBe('pending');
    f.accessBlocks[0].liftedAt = new Date(NOW);
    const claim = await (await f.call('claim', owner)).json();
    f.accessBlocks.push({ scope: 'alice', until: new Date(NOW + 60_000), liftedAt: null });
    expect((await f.call('reply', owner, f.answer(claim))).status).toBe(409);
    expect((await f.call('release', owner, { id: claim.id, leaseId: claim.leaseId, host: 'air-primary' })).status).toBe(200);
    f.advance(60_000);
    expect((await (await f.call('claim', owner)).json()).id).toBe('slow');
  });
  it('stores independent heartbeat hosts and restricts health writes to owner tokens', async () => {
    const f = fixture();
    for (const [host, role] of [['air', 'primary'], ['laptop', 'standby']]) {
      expect((await f.call('heartbeat', owner, { host, role, runtime: 'claude', version: 'ha1' })).status).toBe(200);
    }
    expect((await f.call('heartbeat', alice, { host: 'rogue', role: 'primary', runtime: 'idle', version: 'ha1' })).status).toBe(403);
    const health = await (await f.call('health', owner)).json();
    expect(health.heartbeats).toHaveLength(2);
    expect(JSON.stringify(health)).not.toContain('owner-token');
    expect(health.heartbeats[0].lastSeen).toBe(new Date(NOW).toISOString());
  });
  it('rejects invalid hosts, short standby delays and bodies above the byte cap', async () => {
    const f = fixture();
    for (const payload of [{host:'bad host',role:'primary'}, {host:'laptop',role:'standby',standbyMs:0}, {host:'air',role:'bad'}]) {
      expect((await f.call('claim', owner, payload)).status).toBe(400);
    }
    expect((await f.call('claim', owner, { host:'air', role:'primary', padding:'x'.repeat(1_450_000) })).status).toBe(400);
  });

  it('returns owner-only health without message content', async () => {
    const f = fixture();
    f.add('pending'); f.add('secret', 'alice', { status: 'complete', content: 'PRIVATE ANSWER', deliveredAt: new Date(NOW) });
    expect((await f.call('health', alice)).status).toBe(403);
    const response = await f.call('health', owner);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pending).toBe(1);
    expect(body.lastDeliveredAt).toBe(new Date(NOW).toISOString());
    expect(JSON.stringify(body)).not.toContain('PRIVATE ANSWER');
  });
  it('requires the live exact lease and token for reply and release; saves into the same message once', async () => {
    const f = fixture(); const row = f.add('slow');
    const claim = await (await f.call('claim')).json();
    expect((await f.call('reply', alice, { ...f.answer(claim), leaseId: undefined })).status).toBe(400);
    expect((await f.call('reply', bob, f.answer(claim))).status).toBe(409);
    expect((await f.call('release', bob, { id: claim.id, leaseId: claim.leaseId, host: 'air-primary' })).status).toBe(409);
    expect((await f.call('reply', alice, { ...f.answer(claim), usage: { promptTokens: 800, completionTokens: 200, latencyMs: 1200 } })).status).toBe(200);
    expect(f.messages).toHaveLength(1);
    expect(row).toMatchObject({ promptTokens: 800, completionTokens: 200, latencyMs: 1200 });
    expect(row).toMatchObject({ status: 'complete', costUsd: 0, agentTokenId: alice.id, toolsUsed: ['mcp__isobar-archive__sample'], leaseUntil: null });
    expect((await f.call('reply', alice, f.answer(claim))).status).toBe(409);
    expect((await f.call('release', alice, { id: claim.id, leaseId: claim.leaseId, host: 'air-primary' })).status).toBe(409);
  });
  it('release returns a failed attempt to pending and rejects expired/replayed releases', async () => {
    const f = fixture(); const row = f.add('slow');
    const claim = await (await f.call('claim')).json();
    expect((await f.call('release', alice, { id: claim.id, leaseId: claim.leaseId, host: 'air-primary' })).status).toBe(200);
    expect(row).toMatchObject({ status: 'pending', leaseId: null, agentTokenId: null });
    const next = await (await f.call('claim')).json();
    expect((await f.call('release', alice, { id: claim.id, leaseId: claim.leaseId, host: 'air-primary' })).status).toBe(409);
    f.advance(LEASE_MS);
    expect((await f.call('release', alice, { id: next.id, leaseId: next.leaseId, host: 'air-primary' })).status).toBe(409);
  });
  it.each(['/Users/' + 'example/private.txt', 'system prompt says', 'person@example.test', '.env.local', 'sk-ant-abcdefghijk', `isb_agent_${'x'.repeat(43)}`])('applies the fast hard leak screen to %s', async (text) => {
    const f = fixture(); const row = f.add('slow'); const claim = await (await f.call('claim')).json();
    expect((await f.call('reply', alice, f.answer(claim, text))).status).toBe(422);
    expect(row.content).toBe(''); expect(row.status).toBe('claimed');
  });
  it('caps text and refuses external/SVG attachments', async () => {
    const f = fixture(); f.add('slow'); const claim = await (await f.call('claim')).json();
    expect((await f.call('reply', alice, f.answer(claim, 'x'.repeat(MAX_REPLY_CHARS + 1)))).status).toBe(400);
    for (const src of ['https://tracker.test/img.png', 'data:image/svg+xml,<svg/>']) {
      expect((await f.call('reply', alice, { ...f.answer(claim), images: [{ src, alt: 'section' }] })).status).toBe(400);
    }
  });
  it('uses HMAC, rejects revoked and forged owner tokens, updates lastUsedAt', async () => {
    const f = fixture(); const token = f.secrets.get(alice.id)!;
    expect(hashAgentToken(token, SECRET)).not.toContain(token);
    expect(hashAgentToken(token, 'different')).not.toBe(hashAgentToken(token, SECRET));
    expect(() => hashAgentToken(token, '')).toThrow();
    expect((await f.call('claim')).status).toBe(200);
    expect(f.tokens[1].lastUsedAt).toEqual(new Date(NOW));
    f.tokens[1].scope = 'owner'; expect((await f.call('claim')).status).toBe(401);
    f.tokens[1].scope = 'user'; f.tokens[1].revokedAt = new Date(NOW); expect((await f.call('claim')).status).toBe(401);
  });
  it('requires owner account for owner-scope minting and validates CLI input', () => {
    expect(tokenOptions(['--email', 'alice@example.test', '--label', 'Laptop'], 'owner@example.test').scope).toBe('user');
    expect(() => tokenOptions(['--email', 'alice@example.test', '--label', 'Laptop', '--scope', 'owner'], 'owner@example.test')).toThrow();
    expect(() => tokenOptions(['--email', 'owner+alias@example.test', '--label', 'Laptop', '--scope', 'owner'], 'owner@example.test')).toThrow();
  });
  it('rate-limits before claiming and returns no-store on all outcomes', async () => {
    const f = fixture(); const row = f.add('slow'); f.deps.limited = async () => true;
    const response = await f.call('claim');
    expect(response.status).toBe(429); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(row.status).toBe('pending');
  });
});

describe('GET /api/chat/thread', () => {
  it('requires sign-in, returns only the caller thread and hides held content, grades, leases and context', async () => {
    const f = fixture();
    f.add('b', 'bob', { status: 'complete', content: 'Bob private' });
    f.add('a', 'alice', { status: 'complete', content: 'Alice answer' });
    f.add('held', 'alice', { status: 'held', content: 'SECRET', grade: 'interesting', leaseId: 'SECRET', context: { question: 'SECRET' } });
    f.add('screen', 'alice', { role: 'screen', content: 'SECRET' });
    const run = (userId: string | null, suffix = '') => getThread(new Request(`https://isobar.test/api/chat/thread${suffix}`), { userId, database: f.database, limited: async () => false });
    expect((await run(null)).status).toBe(401);
    expect(f.database.chatThread.findFirst).not.toHaveBeenCalled();
    expect((await run('alice', '?id=thread-bob')).status).toBe(404);
    const response = await run('alice'); const json = await response.json();
    expect(json.id).toBe('thread-alice'); expect(json.messages).toHaveLength(2);
    expect(json.messages.find((x: any) => x.id === 'held').content).toBe('Not answered: this reply did not pass the safety check.');
    expect(JSON.stringify(json)).not.toMatch(/SECRET|Bob private|grade|leaseId|context/);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
  });
});

describe('archive queue and laptop briefing persistence', () => {
  it('serialises concurrent automatic/manual admissions across one user', async () => {
    const f = fixture(), store = prismaArchiveStore(f.database, 'owner@example.test');
    const row = archiveRow({ threadId: 'thread-alice', userMessageId: 'question', question: 'Okanagan rain?', answer: 'Kelowna only.', gaps: ['Other valley stations'], context: {}, source: 'automatic' });
    const results = await Promise.all([store.queueSlow('alice', row), store.queueSlow('alice', row)]);
    expect(results.map((result) => result.status).sort()).toEqual(['pending', 'queued']);
    expect(f.messages).toHaveLength(1);
    expect(f.database.$queryRaw).toHaveBeenCalledWith(expect.anything(), 'alice');
    const id = f.messages[0].id;
    const claim = await (await f.call('claim')).json();
    expect(claim.id).toBe(id);
    expect(await store.cancelSlow('alice', id)).toMatchObject({ status: 'claimed' });
    expect(f.messages[0].status).toBe('claimed');
  });
  it('pending undo wins against a later claim and ownership is enforced at mutation', async () => {
    const f = fixture(), store = prismaArchiveStore(f.database, 'owner@example.test'); f.add('job');
    expect(await store.cancelSlow('bob', 'job')).toMatchObject({ status: 'not-found' });
    expect(await store.cancelSlow('alice', 'job')).toMatchObject({ status: 'cancelled' });
    expect(await (await f.call('claim')).json()).toBeNull();
  });
  it.each([
    { tier: 'sonnet', pinnedTier: null },
    { tier: 'haiku', pinnedTier: null },
    { tier: 'opus', pinnedTier: 'haiku' },
  ])('queues and claims an unsuspended signed-in user regardless of standing: %j', async (standing) => {
    const f = fixture(), store = prismaArchiveStore(f.database, 'owner@example.test');
    f.users[1].chatStanding = standing;
    const row = archiveRow({ threadId: 'thread-alice', userMessageId: 'q', question: 'Rain?', answer: 'A ridge persists.', gaps: ['Check, extend and correct this answer from the archive.'], context: {}, source: 'automatic' });
    const queued = await store.queueSlow('alice', row);
    expect(queued.status).toBe('queued');
    expect((await (await f.call('claim')).json()).id).toBe(queued.messageId);
  });
  it('denies queue admission for wrong thread and suspension; a pinned tier does not bypass suspension', async () => {
    const f = fixture(), store = prismaArchiveStore(f.database, 'owner@example.test');
    const row = archiveRow({ threadId: 'thread-alice', userMessageId: 'q', question: 'Rain?', answer: '', gaps: [], context: {}, source: 'manual' });
    expect(await store.queueSlow('bob', row)).toMatchObject({ status: 'denied' });
    f.users[1].chatStanding = { tier: 'haiku', pinnedTier: null };
    const queued = await store.queueSlow('alice', row);
    expect(queued.status).toBe('queued');
    expect(await store.cancelSlow('alice', queued.messageId!)).toMatchObject({ status: 'cancelled' });
    f.users[1].chatStanding.pinnedTier = 'opus'; f.users[1].clusterId = 's'; f.clusters.push({ id: 's', suspended: true });
    expect(await store.queueSlow('alice', row)).toMatchObject({ status: 'denied' });
    f.clusters[0].suspended = false;
    expect(await store.queueSlow('alice', row)).toMatchObject({ status: 'queued' });
  });
  it('keeps the exact owner eligible for queue admission and claim even when suspended', async () => {
    const f = fixture(), store = prismaArchiveStore(f.database, 'owner@example.test');
    f.users[0].chatStanding = { tier: 'haiku', pinnedTier: null };
    f.users[0].clusterId = 's'; f.clusters.push({ id: 's', suspended: true });
    const row = archiveRow({ threadId: 'thread-owner', userMessageId: 'q', question: 'Rain?', answer: '', gaps: [], context: {}, source: 'automatic' });
    const queued = await store.queueSlow('owner', row);
    expect(queued.status).toBe('queued');
    expect((await (await f.call('claim', owner)).json()).id).toBe(queued.messageId);
  });
  it.each([true, false])('completes the same slow row and persists a per-thread briefing (structured=%s)', async (structured) => {
    const f = fixture(); f.add('job');
    const claim = await (await f.call('claim')).json();
    const briefing = { keyNumbers: ['Penticton 12 mm at 18Z'], sources: ['ECMWF run 2026-10-08T00Z; station CYLW'] };
    const response = await f.call('reply', alice, { ...f.answer(claim), ...(structured ? { briefing } : {}) });
    expect(response.status).toBe(200);
    expect(f.messages[0]).toMatchObject({ id: 'job', status: 'complete', threadId: 'thread-alice' });
    expect(f.threads[1].laptopBriefing).toMatchObject({ answer: f.answer(claim).text, messageId: 'job', keyNumbers: structured ? briefing.keyNumbers : [], sources: structured ? briefing.sources : [] });
    expect(f.threads[0].laptopBriefing).toBeUndefined();
    expect(f.threads[2].laptopBriefing).toBeUndefined();
  });
  it('rejects private or oversized evidence without completing the claim or switching tier', async () => {
    const f = fixture(); f.add('job');
    const claim = await (await f.call('claim')).json();
    expect((await f.call('reply', alice, { ...f.answer(claim), briefing: { keyNumbers: [], sources: ['/Users/' + 'example/archive'] } })).status).toBe(422);
    expect((await f.call('reply', alice, { ...f.answer(claim), briefing: { keyNumbers: Array(25).fill('1 mm'), sources: [] } })).status).toBe(400);
    expect(f.threads[1].laptopBriefing).toBeUndefined();
    expect(f.messages[0].status).toBe('claimed');
  });
});

it('does not let an older legacy job replace a newer conversation briefing', async () => {
  const f = fixture();
  f.add('older', 'alice', { createdAt: new Date(NOW - 60_000) });
  const claim = await (await f.call('claim')).json();
  f.threads[1].laptopBriefing = { answer: 'Newer answer', keyNumbers: [], sources: [], messageId: 'newer', at: new Date(NOW).toISOString(), sourceCreatedAt: new Date(NOW).toISOString() };
  expect((await f.call('reply', alice, f.answer(claim))).status).toBe(200);
  expect(f.messages[0].status).toBe('complete');
  expect(f.threads[1].laptopBriefing.answer).toBe('Newer answer');
});

it.each(['global', 'alice', 'bob', 'expired', 'lifted'])('checks AiAccessBlock at archive admission: %s', async (scope) => {
  const f = fixture(), store = prismaArchiveStore(f.database, 'owner@example.test');
  f.accessBlocks.push({ scope: scope === 'expired' || scope === 'lifted' ? 'global' : scope,
    liftedAt: scope === 'lifted' ? new Date() : null, until: new Date(Date.now() + (scope === 'expired' ? -60_000 : 60_000)) });
  const row = archiveRow({ threadId: 'thread-alice', userMessageId: 'q', question: 'Rain?', answer: '', gaps: [], context: {}, source: 'manual' });
  expect(await store.queueSlow('alice', row)).toMatchObject({ status: scope === 'global' || scope === 'alice' ? 'denied' : 'queued' });
});

it.each(['changed', 'gap', 'unknown'])('limits daemon history with the shared conversation helper: %s', async (scenario) => {
  const f = fixture();
  f.add('earlier', 'alice', { role: 'user', status: 'complete', content: 'Earlier private topic', context: scenario === 'unknown' ? {} : { place: { name: scenario === 'changed' ? 'Kelowna' : 'Perth' } }, createdAt: new Date(NOW - (scenario === 'gap' ? 300_100 : 100)) });
  f.add('question', 'alice', { role: 'user', status: 'complete', content: 'Current question', context: { place: { name: 'Perth' } }, createdAt: new Date(NOW - 10) });
  f.add('job', 'alice', { context: { question: 'Current question', userMessageId: 'question', place: { name: 'Perth' } } });
  const claim = await (await f.call('claim')).json();
  expect(claim.thread.map((row: Row) => row.content)).toEqual(['Current question']);
});
