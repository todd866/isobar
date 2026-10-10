import { describe, expect, it } from 'vitest';
import { earlierTurns } from '../../src/lib/chat/handler';
import type { StoredMessage } from '../../src/lib/chat/store';
import { CONVERSATION_GAP_MS, currentConversation, placeKey } from '../../src/lib/chat/topic';

const now = new Date('2026-10-09T03:00:00Z');
const perth = { place: { id: 'perth', name: 'Perth' } };
const kelowna = { place: { id: 't.49.888.-119.496', name: 'Kelowna' } };
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const message = (minutes: number, context: unknown = perth) => ({ context, createdAt: ago(minutes) });
const anchor = { context: perth, createdAt: now };

describe('conversation place keys', () => {
  it('normalizes names, falls back to id, and leaves missing context unknown', () => {
    expect(placeKey(perth)).toBe('place:perth');
    expect(placeKey({ place: { name: '  PERTH  ' } })).toBe(placeKey(perth));
    expect(placeKey({ place: { id: 'perth' } })).toBe(placeKey(perth));
    for (const value of [null, undefined, [], {}, { place: {} }, { camera: { lat: -32, lon: 116 } }]) expect(placeKey(value)).toBeNull();
  });

  it('joins a named tap to its nearest place, ahead of the header place', () => {
    expect(placeKey({ ...perth, point: { name: 'Kelowna', lat: 49.888, lon: -119.496 } })).toBe(placeKey(kelowna));
    expect(placeKey({ ...kelowna, point: { name: 'Perth', lat: -31.95, lon: 115.86 } })).toBe(placeKey(perth));
  });

  it('rounds unnamed points, including the UI coordinate fallback, without using the header', () => {
    const point = { lat: 49.888, lon: -119.496 };
    expect(placeKey({ ...perth, point })).toBe('point:49.9,-119.5');
    expect(placeKey({ point: { ...point, name: '49.89°N 119.50°W' } })).toBe(placeKey({ point }));
    expect(placeKey({ point: { lat: 49.89, lon: -119.49 } })).toBe(placeKey({ point }));
    expect(placeKey({ point: { lat: 49.75, lon: -119.49 } })).not.toBe(placeKey({ point }));
    expect(placeKey({ point: { lat: -0.01, lon: 0 } })).toBe('point:0.0,0.0');
    expect(placeKey({ ...perth, point: { lat: NaN, lon: 0 } })).toBeNull();
    expect(placeKey({ point: { lat: 91, lon: 0 } })).toBeNull();
  });
});

describe('current conversation', () => {
  it('continues consecutive gaps under 5 minutes, even across a longer total duration', () => {
    const rows = [message(11), message(7), message(3)];
    expect(currentConversation(rows, anchor)).toEqual(rows);
  });

  it('breaks at exactly 5 minutes, both on opening and within history', () => {
    expect(CONVERSATION_GAP_MS).toBe(300_000);
    expect(currentConversation([message(5)], anchor)).toEqual([]);
    const rows = [message(6), message(1)];
    expect(currentConversation(rows, anchor)).toEqual([rows[1]]);
    expect(currentConversation([message(4.999)], anchor)).toHaveLength(1);
  });

  it('never resurrects a previous visit across another place', () => {
    const rows = [message(3), message(2, kelowna), message(1)];
    expect(currentConversation(rows, anchor)).toEqual([rows[2]]);
    expect(currentConversation(rows.slice(0, 2), anchor)).toEqual([]);
    expect(currentConversation([message(1)], { context: kelowna, createdAt: now })).toEqual([]);
  });

  it('fails closed at missing context, missing/invalid dates and future messages', () => {
    const rows = [message(3), message(2, null), message(1)];
    expect(currentConversation(rows, anchor)).toEqual([rows[2]]);
    expect(currentConversation([message(1)], { context: null, createdAt: now })).toEqual([]);
    for (const createdAt of [undefined, 'bad date', ago(-1)]) {
      expect(currentConversation([{ context: perth, createdAt }], anchor)).toEqual([]);
    }
    expect(currentConversation([], anchor)).toEqual([]);
  });

  it('uses wall time and the same keys on wire rows; preserves archive display order', () => {
    const rows = [
      { placeKey: 'place:perth', createdAt: ago(3).toISOString() },
      { placeKey: 'place:perth', createdAt: ago(1).toISOString() }, // fast reply
      { placeKey: 'place:perth', createdAt: ago(2).toISOString() }, // earlier pending row
    ];
    const copy = [...rows];
    expect(currentConversation(rows, { ...anchor, context: { ...perth, timeUtc: '2040-01-01', lens: 'fly' } })).toEqual(rows);
    expect(rows).toEqual(copy);
  });
});

const stored = (role: string, content: string, minutes: number, context: unknown = perth, patch: Partial<StoredMessage> = {}): StoredMessage => ({
  id: content, threadId: 'thread', role, content, status: 'complete', lane: 'fast', context, createdAt: ago(minutes),
  model: null, effort: null, promptTokens: null, completionTokens: null, latencyMs: null, costUsd: null,
  grade: null, gradeReason: null, failureReason: null, toolCalls: null, example: false, ...patch,
});

describe('earlier prompt turns', () => {
  it('includes only the current consecutive place segment, ignoring watcher accounting rows', () => {
    const rows = [stored('user', 'old', 10, kelowna), stored('assistant', 'old reply', 9, kelowna),
      stored('user', 'here', 2), stored('screen', 'ALLOW', 1.5, null), stored('assistant', 'here reply', 1)];
    expect(earlierTurns(rows, perth, now)).toEqual([{ question: 'here', answer: 'here reply' }]);
    expect(earlierTurns(rows, kelowna, now)).toEqual([]);
    expect(earlierTurns(rows, perth, ago(-30))).toEqual([]);
  });

  it('does not pair an unanswered question with the next question’s answer or include held/slow replies', () => {
    const rows = [stored('user', 'unanswered', 5), stored('assistant', 'held', 4, perth, { status: 'held' }),
      stored('user', 'answered', 3), stored('assistant', 'archive', 2.5, perth, { lane: 'slow' }), stored('assistant', 'answer', 2)];
    expect(earlierTurns(rows, perth, now)).toEqual([{ question: 'answered', answer: 'answer' }]);
  });

  it('caps the current conversation at six exchanges', () => {
    const rows = Array.from({ length: 8 }, (_, i) => [stored('user', `q${i}`, 4 - i * 0.5), stored('assistant', `a${i}`, 3.75 - i * 0.5)]).flat();
    expect(earlierTurns(rows, perth, now).map((turn) => turn.question)).toEqual(['q2', 'q3', 'q4', 'q5', 'q6', 'q7']);
  });
});
