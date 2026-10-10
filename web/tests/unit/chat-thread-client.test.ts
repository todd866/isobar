import { describe, expect, it, vi } from 'vitest';
import { fetchThread, hasPendingSlow, mergeSlowEntries, type ChatEntry, type ThreadMessage } from '../../src/lib/chat/thread-client';

const message = (patch: Partial<ThreadMessage>): ThreadMessage => ({
  id: 'm', role: 'assistant', content: 'answer', status: 'complete', lane: 'slow', model: null,
  createdAt: '2026-10-08T00:00:00Z', placeKey: 'place:perth', images: [], ...patch,
});

describe('chat thread client', () => {
  it('returns the display-safe thread payload for a signed-in caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'thread-1',
      messages: [{ id: 'm1', role: 'assistant', content: 'Archive answer', status: 'complete', lane: 'slow', model: 'claude-opus-5-5', createdAt: '2026-10-08T00:00:00Z', images: [], anchors: { places: [], times: [] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(fetchThread()).resolves.toMatchObject({ id: 'thread-1', messages: [{ id: 'm1', content: 'Archive answer' }] });
    expect(fetch).toHaveBeenCalledWith('/api/chat/thread', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    vi.unstubAllGlobals();
  });

  it('does not turn an unauthenticated response into private thread state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    await expect(fetchThread()).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it('hydrates persisted user and assistant history and retains the archive mark after completion', () => {
    const rows = mergeSlowEntries([], [
      message({ id: 'u', role: 'user', content: 'What changed?', lane: 'slow' }),
      message({ id: 'a', content: 'The low deepened.', status: 'complete', model: 'claude-opus-5-5' }),
    ]);
    expect(rows.map((row) => [row.kind, row.text, row.messageId])).toEqual([
      ['user', 'What changed?', 'u'],
      ['reply', 'The low deepened.', 'a'],
    ]);
    expect(rows[1].archive).toBe(true);
    expect(hasPendingSlow(rows)).toBe(false);
  });

  it('does not let a stale pending snapshot downgrade a completed reply', () => {
    const done: ChatEntry[] = [{ id: 'a', kind: 'reply', text: 'Done', messageId: 'a', archive: true }];
    const rows = mergeSlowEntries(done, [message({ id: 'a', status: 'pending', content: '' })]);
    expect(rows).toEqual(done);
  });

  it('retains the active unplaced local exchange without assigning that identity to legacy unknown rows', () => {
    const local: ChatEntry[] = [{ id: 1, messageId: 'live', kind: 'reply', text: 'Live reply', placeKey: 'local:1' }];
    const rows = mergeSlowEntries(local, [message({ id: 'live', placeKey: null }), message({ id: 'old', placeKey: null })]);
    expect(rows.find((row) => row.messageId === 'live')?.placeKey).toBe('local:1');
    expect(rows.find((row) => row.messageId === 'old')?.placeKey).toBeNull();
  });

  it('replaces a pending archive row without creating a duplicate', () => {
    const pending: ChatEntry[] = [{ id: 'a', kind: 'archive', text: '', messageId: 'a', pending: true, archive: true }];
    const rows = mergeSlowEntries(pending, [message({ id: 'a', content: 'Ready now' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'reply', text: 'Ready now', archive: true });
  });
});

describe('thread reconciliation races', () => {
  it('never folds repeated questions and keeps the archive behind its fast answer', () => {
    const rows = mergeSlowEntries([], [
      message({ id: 'u1', role: 'user', lane: 'fast', content: 'Why?', createdAt: '2026-10-08T00:00:00Z' }),
      message({ id: 'slow', status: 'pending', content: '', createdAt: '2026-10-08T00:00:01Z' }),
      message({ id: 'fast', lane: 'fast', createdAt: '2026-10-08T00:00:02Z' }),
      message({ id: 'u2', role: 'user', lane: 'fast', content: 'Why?', createdAt: '2026-10-08T00:00:03Z' }),
    ]);
    expect(rows.map((row) => row.messageId)).toEqual(['u1', 'fast', 'slow', 'u2']);
    expect(rows.filter((row) => row.text === 'Why?')).toHaveLength(2);
    expect(rows[1].archive).toBe(false);
    const refreshed = mergeSlowEntries(rows, [message({ id: 'slow', content: 'Done', createdAt: '2026-10-08T00:00:01Z' })]);
    expect(refreshed).toHaveLength(4);
    expect(refreshed[2]).toMatchObject({ text: 'Done', archive: true });
  });
  it('aborts a stalled poll after ten seconds so a later tick can retry', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    try {
      const checking = expect(fetchThread()).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(10_000); await checking;
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
  it('forwards logout/close cancellation immediately', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    try {
      const controller = new AbortController(); const checking = expect(fetchThread(controller.signal)).rejects.toThrow('aborted');
      controller.abort(); await checking;
    } finally { vi.unstubAllGlobals(); }
  });
});

it('rehydrates a soft caveat and the display-safe hard replacement without stale progress', () => {
  const entries = mergeSlowEntries([{ id: 'soft', messageId: 'soft', kind: 'reply', text: 'partial', status: 'Writing…' }], [
    message({ id: 'soft', lane: 'fast', content: 'A useful answer.', caveat: 'Wind direction was estimated.' }),
    message({ id: 'hard', lane: 'fast', status: 'held', content: 'Not answered: that reply gave unsafe operational advice.' }),
    message({ id: 'legacy', lane: 'fast', status: 'held', content: 'Reply held' }),
  ]);
  expect(entries[0]).toMatchObject({ text: 'A useful answer.', caveat: 'Wind direction was estimated.' });
  expect(entries[0].status).toBeUndefined();
  expect(entries[1].text).toBe('Not answered: that reply gave unsafe operational advice.');
  expect(entries[2].text).toBe('Not answered: this reply did not pass the safety check.');
});
