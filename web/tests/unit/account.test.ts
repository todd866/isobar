import { describe, expect, it } from 'vitest';
import { emptyMemory, reviewCard } from '../../../training/src/scheduler.ts';
import { emptyRecord } from '../../../training/src/instruments/e6b/skills.ts';
import type { ProgressFile } from '../../../training/src/progress.ts';
import { mergeDoc, mergeE6B, mergeMemory, mergeSettings, mergeStreak, mergeTraining, sameJson } from '../../src/lib/account/merge.ts';
import { DOC_LIMITS, checkDoc, parsePut } from '../../src/lib/account/validate.ts';
import { callbackHref, isCode, normalEmail, landingLink, safeReturn, signInEmail } from '../../src/lib/account/email.ts';

const T0 = '2026-10-01T00:00:00.000Z';
const reviewed = (times: number, start = T0) => {
  let memory = emptyMemory(start);
  for (let i = 0; i < times; i += 1) {
    memory = reviewCard(memory, { quality: 4, at: new Date(Date.parse(start) + i * 86_400_000).toISOString(), responseTimeMs: 4000, complexity: 2, reviewsOnStudyDay: 1 });
  }
  return memory;
};

describe('merge', () => {
  it('keeps the card memory with more reviews, then the later review', () => {
    const one = reviewed(1);
    const three = reviewed(3);
    expect(mergeMemory(one, three)).toBe(three);
    expect(mergeMemory(three, one)).toBe(three);
    const later = reviewed(1, '2026-10-05T00:00:00.000Z');
    expect(mergeMemory(one, later)).toBe(later);
    expect(mergeMemory(undefined, one)).toBe(one);
  });

  it('never drops a card from either side', () => {
    const device: ProgressFile = { version: 1, cards: { a: reviewed(2), b: reviewed(1) }, streak: { count: 2, lastDay: '2026-10-02' } };
    const account: ProgressFile = { version: 1, cards: { b: reviewed(4), c: reviewed(1) }, streak: { count: 5, lastDay: '2026-10-01' }, flags: [{ cardId: 'c', note: 'typo', at: T0 }] };
    const merged = mergeTraining(account, device)!;
    expect(Object.keys(merged.cards).sort()).toEqual(['a', 'b', 'c']);
    expect(merged.cards.b.totalReviews).toBe(4);
    expect(merged.streak).toEqual({ count: 2, lastDay: '2026-10-02' });
    expect(merged.flags).toHaveLength(1);
    // Symmetric in content.
    expect(sameJson(mergeTraining(device, account), merged)).toBe(true);
    // Idempotent: merging the result with either side changes nothing.
    expect(sameJson(mergeTraining(merged, device), merged)).toBe(true);
    expect(sameJson(mergeTraining(account, merged), merged)).toBe(true);
  });

  it('takes whichever side exists', () => {
    const device: ProgressFile = { version: 1, cards: { a: reviewed(1) }, streak: { count: 1, lastDay: '2026-10-01' } };
    expect(mergeTraining(null, device)).toBe(device);
    expect(mergeTraining(device, null)).toBe(device);
    expect(mergeTraining(null, null)).toBeNull();
    expect(mergeTraining({ version: 2 } as unknown as ProgressFile, device)).toBe(device);
  });

  it('streaks: later day wins, same day keeps the longer count', () => {
    expect(mergeStreak({ count: 9, lastDay: '2026-10-01' }, { count: 1, lastDay: '2026-10-03' })).toEqual({ count: 1, lastDay: '2026-10-03' });
    expect(mergeStreak({ count: 2, lastDay: '2026-10-03' }, { count: 4, lastDay: '2026-10-03' })).toEqual({ count: 4, lastDay: '2026-10-03' });
    expect(mergeStreak({ count: 0, lastDay: null }, { count: 1, lastDay: '2026-10-01' })).toEqual({ count: 1, lastDay: '2026-10-01' });
  });

  it('E6-B: furthest stage, fastest best, union of solved, later daily set', () => {
    const a = { ...emptyRecord(), stages: { tsd: 'solo' as const, fuel: 'watch' as const }, bests: { tsd: 30_000 }, curriculum: { tsd: { stage: 'guided' as const, solved: ['x'] } }, daily: { day: '2026-10-02', set: ['tsd' as const], done: 3, misses: 0 }, memories: { 'e6b:tsd': reviewed(2) } };
    const b = { ...emptyRecord(), stages: { tsd: 'guided' as const, fuel: 'done' as const }, bests: { tsd: 25_000, fuel: 40_000 }, curriculum: { tsd: { stage: 'done' as const, solved: ['y'] } }, daily: { day: '2026-10-01', set: ['fuel' as const], done: 6, misses: 1 }, firstContact: true, memories: { 'e6b:fuel': reviewed(1) } };
    const merged = mergeE6B(a, b)!;
    expect(merged.stages).toEqual({ tsd: 'solo', fuel: 'done' });
    expect(merged.bests).toEqual({ tsd: 25_000, fuel: 40_000 });
    expect(merged.curriculum!.tsd.stage).toBe('done');
    expect(merged.curriculum!.tsd.solved.sort()).toEqual(['x', 'y']);
    expect(merged.daily!.day).toBe('2026-10-02');
    expect(merged.firstContact).toBe(true);
    expect(Object.keys(merged.memories).sort()).toEqual(['e6b:fuel', 'e6b:tsd']);
  });

  it('settings: newest stamp per key; an unstamped value loses to a stamped one', () => {
    const account = { values: { theme: 'dark' as const, speed: 8, place: 'perth' }, at: { theme: '2026-10-02T00:00:00Z', speed: '2026-10-01T00:00:00Z', place: '2026-10-01T00:00:00Z' } };
    const device = { values: { theme: 'light' as const, speed: 32, place: 'sydney' }, at: { theme: '2026-10-01T00:00:00Z', speed: '2026-10-03T00:00:00Z' } };
    expect(mergeSettings(account, device)).toEqual({
      values: { theme: 'dark', speed: 32, place: 'perth' },
      at: { theme: '2026-10-02T00:00:00Z', speed: '2026-10-03T00:00:00Z', place: '2026-10-01T00:00:00Z' },
    });
    // First sign-in: an empty account adopts the device's values.
    expect(mergeSettings(null, device).values).toEqual(device.values);
    expect(mergeDoc('settings', { values: {}, at: {} }, device)).toEqual(mergeSettings(null, device));
  });

  it('sameJson ignores key order and undefined', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1, d: undefined })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
  });
});

describe('validate', () => {
  it('accepts real documents and strips unknown keys', () => {
    const training: ProgressFile = { version: 1, cards: { 'met:1': reviewed(2) }, streak: { count: 1, lastDay: '2026-10-01' }, e6b: { ...emptyRecord(), stages: { tsd: 'solo' } } };
    const ok = checkDoc('training', { ...training, extra: 'x' });
    expect(ok.ok).toBe(true);
    expect((ok as { data: Record<string, unknown> }).data.extra).toBeUndefined();
    expect(checkDoc('e6b', emptyRecord()).ok).toBe(true);
    expect(checkDoc('settings', { values: { theme: 'dark', speed: 8, place: 'sydney' }, at: { theme: T0 } }).ok).toBe(true);
  });

  it('rejects bad shapes', () => {
    expect(checkDoc('settings', { values: { speed: 0 }, at: { speed: T0 } }).ok).toBe(true);
    expect(mergeSettings(null, { values: { speed: 0 }, at: { speed: T0 } }).values.speed).toBe(0);
    expect(checkDoc('settings', { values: { speed: 3 }, at: {} })).toEqual({ ok: false, error: 'invalid' });
    expect(checkDoc('settings', { values: { theme: 'sepia' }, at: {} })).toEqual({ ok: false, error: 'invalid' });
    expect(checkDoc('settings', { values: { units: 'local' }, at: { units: T0 } }).ok).toBe(true);
    expect(checkDoc('settings', { values: { units: 'metric' }, at: {} })).toEqual({ ok: false, error: 'invalid' });
    expect(checkDoc('settings', { values: { place: '../x' }, at: {} })).toEqual({ ok: false, error: 'invalid' });
    expect(checkDoc('training', { version: 2, cards: {}, streak: { count: 0, lastDay: null } }).ok).toBe(false);
    expect(checkDoc('training', { version: 1, cards: { a: { totalReviews: 'many' } }, streak: { count: 0, lastDay: null } }).ok).toBe(false);
    expect(checkDoc('e6b', null).ok).toBe(false);
  });

  it('enforces size limits before parsing', () => {
    const cards: Record<string, unknown> = {};
    const memory = reviewed(1);
    // Build an oversized document in linear time; repeated serialization made
    // fixture setup exceed the test timeout on a busy shared machine.
    const count = Math.ceil(DOC_LIMITS.training / JSON.stringify(memory).length) + 1;
    for (let i = 0; i < count; i += 1) cards[`card-${i}`] = memory;
    expect(checkDoc('training', { version: 1, cards, streak: { count: 0, lastDay: null } })).toEqual({ ok: false, error: 'too-large' });
    expect(checkDoc('settings', { values: { places: Array(5000).fill('sydney') }, at: {} })).toEqual({ ok: false, error: 'too-large' });
  });

  it('parses PUT bodies strictly', () => {
    expect(parsePut({ kind: 'settings', baseRev: 0, data: {} }).ok).toBe(true);
    expect(parsePut({ kind: 'users', baseRev: 0, data: {} }).ok).toBe(false);
    expect(parsePut({ kind: 'settings', baseRev: -1, data: {} }).ok).toBe(false);
    expect(parsePut({ kind: 'settings', baseRev: 0, data: {}, userId: 'x' }).ok).toBe(false);
  });
});

describe('sign-in email', () => {
  const origin = 'https://isobar.md';
  it('returns only to this site, never to the API, and drops stale sign-in params', () => {
    expect(safeReturn(origin, 'https://evil.example/x').toString()).toBe('https://isobar.md/');
    expect(safeReturn(origin, '/api/account').toString()).toBe('https://isobar.md/');
    expect(safeReturn(origin, 'https://isobar.md/train?card=a&signin_error=code#x').toString()).toBe('https://isobar.md/train?card=a');
    expect(safeReturn(origin, 'not a url %%').toString()).toBe('https://isobar.md/not%20a%20url%20%%');
  });

  it('link carries the code back to the page; callback names the code as the token', () => {
    const link = new URL(landingLink(origin, 'https://isobar.md/e6b', '012345', 'a@b.co'));
    expect(link.pathname).toBe('/e6b');
    expect(link.searchParams.get('signin_code')).toBe('012345');
    expect(link.searchParams.get('signin_email')).toBe('a@b.co');
    const callback = new URL(callbackHref('012345', 'a@b.co', 'https://isobar.md/e6b'), origin);
    expect(callback.pathname).toBe('/api/auth/callback/email');
    expect(callback.searchParams.get('token')).toBe('012345');
  });

  it('codes are eight digits; the email shows the code and escapes the link', () => {
    expect(isCode('01234567')).toBe(true);
    expect(isCode('012345')).toBe(false);
    expect(isCode('0123456a')).toBe(false);
    const mail = signInEmail('01234567', 'https://isobar.md/?a=1&b="2"');
    expect(mail.subject).toContain('0123 4567');
    expect(mail.html).toContain('&amp;b=&quot;2&quot;');
    expect(mail.text).toContain('0123 4567');
  });

  it('one address normaliser refuses anything but a plain mailbox', () => {
    expect(normalEmail(' Ian@Example.COM ')).toBe('ian@example.com');
    for (const bad of ['ian@example.com,1', 'Ian <ian@example.com>', 'ian@ex ample.com', 'ian@example', 'ian@@example.com', '']) {
      expect(normalEmail(bad)).toBeNull();
    }
  });
});
