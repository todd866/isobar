import { describe, expect, it } from 'vitest';
import {
  afterAccountDeletion, chatThreadsAfterDeletion, exportSince, reduceUsage, sanitizeBatch, usageNdjson,
  type UsageClock, type UsageDraft,
} from '../../src/lib/usage/events';
import { isTestTraffic } from '../../src/lib/usage/test-traffic';

const NOW = new Date('2026-10-08T12:00:00Z');

describe('test traffic marker', () => {
  it('accepts only the exact header or cookie marker', () => {
    expect(isTestTraffic(new Request('https://isobar.md', { headers: { 'isobar-test': '1' } }))).toBe(true);
    expect(isTestTraffic(new Request('https://isobar.md', { headers: { cookie: 'isobar-test=1' } }))).toBe(true);
    expect(isTestTraffic(new Request('https://isobar.md', { headers: { 'isobar-test': '10' } }))).toBe(false);
    expect(isTestTraffic(new Request('https://isobar.md', { headers: { cookie: 'other=1; isobar-testing=1' } }))).toBe(false);
  });
});

function event(kind: UsageDraft['kind'], at = NOW.toISOString()): UsageDraft {
  return { kind, at, payload: { lens: 'wind' } };
}

describe('usage batching', () => {
  it('sends the first batch at once, then at most one every 10s, and always on hide', () => {
    let clock: UsageClock = { pending: [], lastSentAt: null };
    const first = reduceUsage(clock, 0, 'track', event('lens'));
    expect(first.send?.map((item) => item.kind)).toEqual(['lens']);
    clock = first.state;

    const held = reduceUsage(clock, 1_000, 'track', event('point'));
    expect(held.send).toBeNull();
    expect(held.waitMs).toBe(9_000);
    clock = held.state;

    const early = reduceUsage(clock, 5_000, 'due');
    expect(early.send).toBeNull();

    const later = reduceUsage(clock, 10_000, 'due');
    expect(later.send?.map((item) => item.kind)).toEqual(['point']);
    clock = later.state;

    const queued = reduceUsage(clock, 11_000, 'track', event('scrub'));
    expect(queued.send).toBeNull();
    const hide = reduceUsage(queued.state, 12_000, 'hide');
    expect(hide.send?.map((item) => item.kind)).toEqual(['scrub']);
    expect(reduceUsage({ pending: [], lastSentAt: 12_000 }, 12_100, 'hide').send).toBeNull();
  });

  it('rejects an unknown kind, a huge payload, and an empty batch', () => {
    expect(sanitizeBatch({ events: [{ kind: 'lens', at: NOW.toISOString(), payload: { lens: 'wind' } }] }, NOW)?.[0].kind).toBe('lens');
    expect(sanitizeBatch({ events: [{ kind: 'click', at: NOW.toISOString(), payload: {} }] }, NOW)).toBeNull();
    expect(sanitizeBatch({ events: [] }, NOW)).toBeNull();
    expect(sanitizeBatch({ events: [{ kind: 'lens', at: NOW.toISOString(), payload: { blob: 'x'.repeat(3000) } }] }, NOW)).toBeNull();
    expect(sanitizeBatch({ events: [{ kind: 'lens', at: 'not-a-date', payload: {} }] }, NOW)).toBeNull();
  });
});

describe('usage export and deletion', () => {
  const rows = [
    { id: 'a', userId: 'u1', deviceId: 'dev', at: '2026-10-08T01:00:00.000Z', kind: 'lens', payload: { lens: 'wind' } },
    { id: 'b', userId: 'u2', deviceId: 'other', at: '2026-10-08T02:00:00.000Z', kind: 'point', payload: { lat: 1 } },
  ];

  it('writes one JSON object per line', () => {
    const text = usageNdjson(rows);
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(text.trim().split('\n')[0])).toMatchObject({ id: 'a', kind: 'lens' });
    expect(usageNdjson([])).toBe('');
    expect(exportSince('2026-10-08T00:00:00Z')?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(exportSince('nope')).toBeNull();
    expect(exportSince(null)).toBeNull();
  });

  it('deletes that user\'s chat and anonymises their events', () => {
    expect(afterAccountDeletion(rows, 'u1')).toEqual([
      { ...rows[0], userId: null },
      rows[1],
    ]);
    expect(chatThreadsAfterDeletion([
      { id: 't1', userId: 'u1' },
      { id: 't2', userId: 'u2' },
      { id: 't3', userId: null },
    ], 'u1')).toEqual([{ id: 't2', userId: 'u2' }, { id: 't3', userId: null }]);
  });
});
