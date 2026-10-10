import { describe, expect, it, vi, afterEach } from 'vitest';
import { makeReportFixture } from './reports-store.fixture';
import { emailQuestion } from '../../src/lib/reports/client';
import { mergeSlowEntries } from '../../src/lib/chat/thread-client';
import { UPSELL } from '../../src/lib/reports/policy';

function fixture() {
  const f = makeReportFixture(); f.addUser('alice'); f.addEntitlement('alice');
  f.threads.push({ id: 'thread', userId: 'alice' });
  f.messages.push({ id: 'question', threadId: 'thread', role: 'user', status: 'complete', content: 'Compare the fronts on my trip.' });
  f.messages.push({ id: 'answer', threadId: 'thread', role: 'assistant', lane: 'fast', status: 'complete', context: {
    reportOffer: true, userMessageId: 'question', timeUtc: '2026-10-09T06:00:00Z',
    place: { id: 'perth', name: 'Perth', zone: 'Australia/Perth' },
    reportDraft: { timezone: 'Australia/Perth', places: [{ name: 'Perth', lat: -31.95, lon: 115.86 }] },
  } });
  return f;
}

describe('one-tap reports from saved questions', () => {
  it('creates one run across concurrent taps and retries, then emails the account address', async () => {
    const f = fixture();
    const results = await Promise.all([f.service.emailQuestion('alice', 'answer'), f.service.emailQuestion('alice', 'answer')]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(results[0]).toMatchObject({ reportId: results[1].reportId });
    expect(f.runs).toHaveLength(1);
    expect(f.subscriptions[0]).toMatchObject({ kind: 'once', complexity: 'complex', tier: 'paid', threadId: 'thread' });
    expect(f.subscriptions[0].instructions).toContain('Compare the fronts on my trip.');
    expect(f.subscriptions[0].instructions).toContain('2026-10-09T06:00:00Z');
    expect(f.messages.find(row => row.id === results[0].reportId)?.context).toMatchObject({ source: 'report', answerId: 'answer', userMessageId: 'question', place: { id: 'perth' } });
    f.users.find(user => user.id === 'alice')!.email = 'current@example.test';
    f.subscriptions[0].autoApprove = true;
    const agent = { id: 'agent-token', host: 'test' };
    const job = await f.service.claim(agent);
    await f.service.ready(agent, job!.id, job!.leaseId, 'Detailed forecast.');
    const deliver = vi.fn(async () => 'mock'); f.options.deliver = deliver;
    await f.service.maintenance(agent);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ to: 'current@example.test' }), expect.any(String));
    expect(f.runs[0].status).toBe('sent');
  });

  it('uses billing limits for free and expired accounts and permits a later upgrade', async () => {
    const f = fixture(); f.entitlements.length = 0;
    expect(await f.service.emailQuestion('alice', 'answer')).toMatchObject({ ok: false, line: UPSELL });
    f.addEntitlement('alice', { status: 'past_due' });
    expect((await f.service.emailQuestion('alice', 'answer')).ok).toBe(false);
    expect(f.runs).toHaveLength(0);
    f.entitlements[0].status = 'active';
    expect((await f.service.emailQuestion('alice', 'answer')).ok).toBe(true);
  });

  it('rejects another account, invented offers, held answers and missing questions', async () => {
    const f = fixture(); f.addUser('bob'); f.addEntitlement('bob');
    expect((await f.service.emailQuestion('bob', 'answer')).ok).toBe(false);
    const answer = f.messages[1]; answer.context.reportOffer = false;
    expect((await f.service.emailQuestion('alice', 'answer')).ok).toBe(false);
    answer.context.reportOffer = true; answer.status = 'held';
    expect((await f.service.emailQuestion('alice', 'answer')).ok).toBe(false);
    answer.status = 'complete'; answer.context.userMessageId = 'missing';
    expect((await f.service.emailQuestion('alice', 'answer')).ok).toBe(false);
    expect(f.runs).toHaveLength(0);
  });

  it('rechecks access blocks and email verification on the tap', async () => {
    const f = fixture(); f.users.find(user => user.id === 'alice')!.emailVerified = null;
    expect((await f.service.emailQuestion('alice', 'answer')).ok).toBe(false);
    f.users.find(user => user.id === 'alice')!.emailVerified = f.now();
    f.blocks.push({ scope: 'alice', liftedAt: null, until: new Date(+f.now() + 60_000) });
    expect((await f.service.emailQuestion('alice', 'answer')).ok).toBe(false);
    expect(f.runs).toHaveLength(0);
  });
});

afterEach(() => vi.unstubAllGlobals());
it('client sends only the saved answer ID and exposes a limit without retrying', async () => {
  const fetchMock = vi.fn(async () => Response.json({ ok: false, line: UPSELL }, { status: 409 }));
  vi.stubGlobal('fetch', fetchMock);
  expect(await emailQuestion('answer')).toEqual({ ok: false, line: UPSELL });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('/api/chat/report', expect.objectContaining({ body: JSON.stringify({ messageId: 'answer' }), credentials: 'same-origin' }));
});


it('an older thread poll cannot erase the report ID just returned by a tap', () => {
  const merged = mergeSlowEntries([{ id: 'answer', messageId: 'answer', kind: 'reply', text: 'Offer', reportOffer: true, reportId: 'report-run' }], [{
    id: 'answer', role: 'assistant', content: 'Offer', status: 'complete', lane: 'fast', model: null,
    createdAt: '2026-10-09T00:00:00Z', placeKey: 'place:perth', images: [], reportOffer: true,
  }]);
  expect(merged[0]).toMatchObject({ reportOffer: true, reportId: 'report-run' });
});
