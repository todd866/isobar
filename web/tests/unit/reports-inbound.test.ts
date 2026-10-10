import { describe, expect, it, vi } from 'vitest';
import { receiveInbound, signInbound, stripQuotedText, type InboundEnvelope } from '../../src/lib/reports/inbound';
import type { Completion } from '../../src/lib/chat/anthropic';

const envelope = (overrides: Partial<InboundEnvelope> = {}): InboundEnvelope => ({
  id: 'mail-1', from: 'person@example.com', to: 'reports@isobar.md', text: 'Give me a report for Perth today.', messageId: '<mail-1@example.com>', timestamp: new Date().toISOString(),
  auth: { spf: 'pass', dkim: 'pass', spfDomain: 'example.com', dkimDomain: 'example.com', fromDomain: 'example.com' }, ...overrides,
});
const completion = (calls: Completion['calls'] = [], text = 'ALLOW'): Completion => ({ text, calls, stop: 'end_turn', promptTokens: 1, completionTokens: 1, rawContent: [] });
const options = (complete: (input: unknown) => Promise<Completion>, extra: Record<string, unknown> = {}) => ({ secret: 'secret-secret-secret', mailbox: 'reports@isobar.md', deps: { model: { apiKey: 'test' }, complete, reserve: vi.fn(async () => ({ id: 'user-1' })), execute: vi.fn(async () => ({ ok: true })), ...extra } });

describe('inbound report mail', () => {
  it('uses constant-time signed normalized envelopes and rejects stale or forged mail', async () => {
    const complete = vi.fn(async () => completion());
    const env = envelope();
    await expect(receiveInbound(env, signInbound('secret-secret-secret', env), options(complete))).resolves.toMatchObject({ ok: false, reason: 'invalid' });
    await expect(receiveInbound(env, 'forged', options(complete))).resolves.toEqual({ ok: false, reason: 'ignored' });
    const stale = envelope({ timestamp: Date.now() - 6 * 60_000 });
    await expect(receiveInbound(stale, signInbound('secret-secret-secret', stale), options(complete))).resolves.toEqual({ ok: false, reason: 'ignored' });
  });

  it('rejects unaligned authentication and unknown senders before model calls', async () => {
    const complete = vi.fn(async () => completion());
    const bad = envelope({ auth: { ...envelope().auth, dkimDomain: 'other.example' } });
    await expect(receiveInbound(bad, signInbound('secret-secret-secret', bad), options(complete))).resolves.toEqual({ ok: false, reason: 'ignored' });
    const unknown = options(complete, { reserve: vi.fn(async () => null) });
    const env = envelope();
    await expect(receiveInbound(env, signInbound('secret-secret-secret', env), unknown)).resolves.toEqual({ ok: false, reason: 'ignored' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('signs receiver classifications and rechecks blocks between model calls', async () => {
    const complete = vi.fn().mockResolvedValueOnce(completion([], 'ALLOW')).mockResolvedValueOnce(completion([{ id: 'c', name: 'manage_reports', input: { action: 'create' } }]));
    const env = envelope({ receiver: { autoSubmitted: true } });
    const unsigned = envelope({ receiver: { autoSubmitted: false } });
    await expect(receiveInbound(env, signInbound('secret-secret-secret', unsigned), options(complete))).resolves.toEqual({ ok: false, reason: 'ignored' });
    let checks = 0;
    const guarded = options(complete, { blocked: async () => ++checks > 1 });
    await expect(receiveInbound(unsigned, signInbound('secret-secret-secret', unsigned), guarded)).resolves.toEqual({ ok: false, reason: 'blocked' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('strips quoted history and ignores automatic or bulk traffic', async () => {
    expect(stripQuotedText('New request\n> old request\nOn yesterday wrote:\nold')).toBe('New request');
    const complete = vi.fn(async () => completion());
    for (const receiver of [{ autoSubmitted: true }, { bounce: true }, { precedence: 'list' }]) {
      const env = envelope({ receiver });
      await expect(receiveInbound(env, signInbound('secret-secret-secret', env), options(complete))).resolves.toEqual({ ok: false, reason: 'ignored' });
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it('screens before extraction and executes only the report tool', async () => {
    const command = { action: 'create', kind: 'once', timezone: 'Australia/Perth', places: [{ name: 'Perth', lat: -31.95, lon: 115.86 }], instructions: 'wind and rain' };
    const complete = vi.fn()
      .mockResolvedValueOnce(completion([], 'ALLOW'))
      .mockResolvedValueOnce(completion([{ id: 'call-1', name: 'manage_reports', input: command }]));
    const execute = vi.fn(async () => ({ ok: true }));
    const result = await receiveInbound(envelope(), signInbound('secret-secret-secret', envelope()), options(complete, { execute }));
    expect(result).toMatchObject({ ok: true, userId: 'user-1' });
    expect(execute).toHaveBeenCalledWith('user-1', command, undefined);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('does not spend model capacity when blocked or unavailable', async () => {
    const complete = vi.fn(async () => completion());
    const env = envelope();
    await expect(receiveInbound(env, signInbound('secret-secret-secret', env), options(complete, { blocked: async () => true }))).resolves.toEqual({ ok: false, reason: 'blocked' });
    await expect(receiveInbound(env, signInbound('secret-secret-secret', env), { ...options(complete), deps: { ...options(complete).deps, model: undefined } })).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('requires an explicit id for mutating a report from a reply', async () => {
    const complete = vi.fn().mockResolvedValueOnce(completion([], 'ALLOW')).mockResolvedValueOnce(completion([{ id: 'c', name: 'manage_reports', input: { action: 'update', instructions: 'shorter' } }]));
    const env = envelope({ inReplyTo: '<old@isobar.md>' });
    await expect(receiveInbound(env, signInbound('secret-secret-secret', env), options(complete))).resolves.toEqual({ ok: false, reason: 'invalid' });
  });
});
