import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveAction, mergeSlowEntries, type ThreadMessage } from '../../src/lib/chat/thread-client';

afterEach(() => vi.unstubAllGlobals());
const row = (patch: Partial<ThreadMessage>): ThreadMessage => ({
  id: 'id', role: 'assistant', content: 'answer', status: 'complete', lane: 'fast', model: 'claude-opus-5-5',
  createdAt: '2026-10-08T00:00:00Z', placeKey: 'place:perth', images: [], ...patch,
});

describe('archive escalation client', () => {
  it.each([
    [{ status: 'queued', messageId: 'slow-1', line: 'Checking the archive for more (a few minutes)' }, 'queue', 'fast-1'],
    [{ status: 'cancelled' }, 'cancel', 'slow-1'],
    [{ status: 'claimed' }, 'cancel', 'slow-1'],
  ] as const)('sends the signed-in %s action and accepts its response', async (body, action, messageId) => {
    const fetcher = vi.fn(async () => Response.json(body)); vi.stubGlobal('fetch', fetcher);
    await expect(archiveAction(action, messageId)).resolves.toEqual(body);
    expect(fetcher).toHaveBeenCalledWith('/api/chat/archive', expect.objectContaining({ method: 'POST', body: JSON.stringify({ action, messageId }), credentials: 'same-origin' }));
  });

  it('keeps a completed slow answer below its original exchange after later questions', () => {
    const rows = mergeSlowEntries([], [
      row({ id: 'u1', role: 'user', lane: 'fast', content: 'Okanagan rain?', createdAt: '2026-10-08T00:00:00Z' }),
      row({ id: 'a1', lane: 'fast', content: 'Fast answer', userMessageId: 'u1', createdAt: '2026-10-08T00:00:01Z' }),
      row({ id: 'u2', role: 'user', lane: 'fast', content: 'Hunter wind?', createdAt: '2026-10-08T00:00:02Z' }),
      row({ id: 'a2', lane: 'fast', content: 'Later answer', userMessageId: 'u2', createdAt: '2026-10-08T00:00:03Z' }),
      row({ id: 's1', lane: 'slow', content: 'Archive answer', archiveId: 's1', userMessageId: 'u1', createdAt: '2026-10-08T00:00:04Z' }),
    ]);
    expect(rows.map((item) => item.messageId)).toEqual(['u1', 'a1', 's1', 'u2', 'a2']);
    expect(rows[2]).toMatchObject({ kind: 'reply', deliveryStatus: 'complete', archive: true, text: 'Archive answer' });
  });
});

it('hydrates cancellation without losing the fast answer or reviving pending work from an old snapshot', () => {
  const fast = row({ id: 'fast', archiveId: 'job', content: 'Useful fast answer' });
  const pending = row({ id: 'job', lane: 'slow', status: 'pending', content: '', answerId: 'fast' });
  const initial = mergeSlowEntries([], [fast, pending]);
  const cancelled = mergeSlowEntries(initial, [{ ...pending, status: 'cancelled' }]);
  expect(cancelled.find((entry) => entry.messageId === 'fast')?.text).toBe('Useful fast answer');
  expect(cancelled.find((entry) => entry.messageId === 'job')).toMatchObject({ pending: false, deliveryStatus: 'cancelled' });
  const stale = mergeSlowEntries(cancelled, [pending]);
  expect(stale.find((entry) => entry.messageId === 'job')?.pending).toBe(false);
});

it('times out a stalled mutation and passes an explicit rate-limit line through', async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    const pending = expect(archiveAction('queue', 'fast')).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(10_001); await pending;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'denied', line: 'Slow down a little' }, { status: 429 })));
    await expect(archiveAction('queue', 'fast')).resolves.toEqual({ status: 'denied', line: 'Slow down a little' });
  } finally { vi.useRealTimers(); }
});
