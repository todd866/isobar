import { describe, expect, it } from 'vitest';
import { completeAnthropic, AnthropicError } from '../../src/lib/chat/anthropic';
import { readChatStream } from '../../src/lib/chat/thread-client';
import { parsePostCheck, HARD_LINES, buildPostCheckPrompt } from '../../src/lib/chat/watcher';
import { eventsResponse, messageEvents, eventBytes } from './chat-stream.fixture';

const input = { apiKey: 'mock', model: 'claude-sonnet-5-5', effort: null, maxTokens: 100, system: 'test', messages: [] } as const;
const wire = { content: [{ type: 'text', text: 'Hobart’s chart…' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, stop_reason: 'end_turn' };

describe('Messages API streaming', () => {
  it('delivers text before message_stop and reconstructs tool JSON, thinking and billed usage', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let received = '', finished = false;
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), { headers: { 'content-type': 'text/event-stream' } });
    const completion = completeAnthropic({ ...input, messages: [], onText: (text) => { received += text; }, fetchImpl: async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true }); return response;
    } }).then((value) => { finished = true; return value; });
    const events = messageEvents({ ...wire, stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: 'internal', signature: 'signature' },
      { type: 'text', text: 'Hobart’s chart…' },
      { type: 'tool_use', id: 't1', name: 'aerodrome_weather', input: { icao: 'YMHB' } },
    ] });
    for (const event of events.slice(0, -2)) controller.enqueue(eventBytes(event));
    await expect.poll(() => received).toBe('Hobart’s chart…');
    expect(finished).toBe(false);
    for (const event of events.slice(-2)) controller.enqueue(eventBytes(event));
    controller.close();
    const done = await completion;
    expect(done).toMatchObject({ text: received, stop: 'tool_use', promptTokens: 17, completionTokens: 5,
      calls: [{ id: 't1', name: 'aerodrome_weather', input: { icao: 'YMHB' } }] });
    expect(done.rawContent[0]).toEqual({ type: 'thinking', thinking: 'internal', signature: 'signature' });
  });
  it('accepts a tool called with no arguments (an empty input_json_delta stream)', async () => {
    // Production 9 Oct: JSON.parse("") failed every answer that called a no-argument tool.
    const events: Record<string, unknown>[] = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't0', name: 'chart_summary', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ];
    const done = await completeAnthropic({ ...input, onText: () => {}, fetchImpl: async () => eventsResponse(events) });
    expect(done.calls).toEqual([{ id: 't0', name: 'chart_summary', input: {} }]);
  });

  it('handles fragmented UTF-8 and CRLF event boundaries', async () => {
    let received = '';
    const done = await completeAnthropic({ ...input, messages: [], onText: (text) => { received += text; }, fetchImpl: async () => eventsResponse(messageEvents(wire)) });
    expect(received).toBe('Hobart’s chart…');
    expect(done.text).toBe(received);
  });
  it.each(['eof', 'error', 'malformed'] as const)('prices a %s interruption conservatively and never returns a completion', async (failure) => {
    const events = messageEvents(wire).slice(0, -1);
    if (failure === 'error') events.push({ type: 'error', error: { type: 'overloaded_error' } });
    const response = failure === 'malformed' ? new Response('data: {broken}\n\n', { headers: { 'content-type': 'text/event-stream' } }) : eventsResponse(events);
    const error = await completeAnthropic({ ...input, messages: [], onText: () => {}, fetchImpl: async () => response }).catch((err) => err);
    expect(error).toBeInstanceOf(AnthropicError);
    expect(error.promptTokens).toBeGreaterThan(0);
    expect(error.completionTokens).toBe(100);
  });
  it('preserves thinking/signature deltas for the next tool round without displaying them', async () => {
    let text = '';
    const events = messageEvents(wire);
    events.splice(1, 0,
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'private reasoning' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'signed' } },
      { type: 'content_block_stop', index: 1 });
    const done = await completeAnthropic({ ...input, messages: [], onText: (delta) => { text += delta; }, fetchImpl: async () => eventsResponse(events) });
    expect(text).toBe('Hobart’s chart…');
    expect(done.rawContent[1]).toEqual({ type: 'thinking', thinking: 'private reasoning', signature: 'signed' });
  });
});

describe('chat stream completion', () => {
  it('applies status, token, replacement and caveat events in order, stopping at done', async () => {
    const received: unknown[] = [];
    const done = await readChatStream(eventsResponse([{ status: 'Writing…' }, { delta: 'first' }, { replace: 'final', caveat: 'A caveat.', done: true }, { delta: 'ignored' }]), (event) => received.push(event));
    expect(received).toHaveLength(3);
    expect(done).toMatchObject({ replace: 'final', caveat: 'A caveat.' });
  });
  it('rejects a missing done event and malformed data', async () => {
    await expect(readChatStream(eventsResponse([{ delta: 'partial' }]), () => {})).rejects.toThrow('interrupted');
    await expect(readChatStream(new Response('data: broken\n\n'), () => {})).rejects.toThrow();
  });
});

describe('finished-answer checks', () => {
  it.each(Object.entries(HARD_LINES))('uses a plain replacement for HARD %s', (category, line) => {
    expect(parsePostCheck(`HARD ${category}: reason`)).toMatchObject({ severity: 'hard', line, reason: 'reason' });
  });
  it('keeps unsourced claims with a short caveat, including legacy HOLD', () => {
    const line = 'Wind direction here is estimated from the isobars, not model data.';
    expect(parsePostCheck(`SOFT: ${line}`)).toMatchObject({ severity: 'soft', line });
    expect(parsePostCheck('HOLD: unsourced wind direction')).toMatchObject({ severity: 'soft', reason: 'unsourced wind direction' });
    expect(buildPostCheckPrompt('wind?', 'NW estimate', 'estimated from isobars')).toContain('sourced with a caveat');
  });
  it('tells the user when the checker cannot finish and never echoes a secret in a caveat', () => {
    expect(parsePostCheck('')).toMatchObject({ severity: 'soft', line: 'Some claims in this reply could not be checked.' });
    expect(parsePostCheck('SOFT: sk-ant-private-secret')).toMatchObject({ line: 'Some claims in this reply could not be checked.' });
  });
});
