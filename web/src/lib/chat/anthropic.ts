/**
 * Claude Messages API via fetch. Opus uses output_config effort medium.
 * Usage that this ledger cannot price exactly is refused, never stored as zero.
 */

import { MODEL_ID, type Tier } from './types';
import { readEvents } from './sse';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

const MAX_TOKENS: Record<'opus' | 'sonnet' | 'haiku', number> = { opus: 8000, sonnet: 6000, haiku: 2000 };

export class AnthropicError extends Error {
  constructor(message: string, readonly promptTokens: number | null, readonly completionTokens: number | null) {
    super(message);
    this.name = 'AnthropicError';
  }
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface Completion {
  text: string;
  calls: ToolCall[];
  stop: string;
  promptTokens: number;
  completionTokens: number;
  rawContent: unknown[];
}

interface Usage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * Billed usage, priced conservatively: cache tokens count as full-price input.
 * A billed reply whose usage cannot be read is charged the request's ceiling,
 * never zero (the API bills it whether or not we can parse it).
 */
function usageOf(usage: Usage | undefined, ceiling: { promptTokens: number; completionTokens: number }): { promptTokens: number; completionTokens: number } {
  const input = count(usage?.input_tokens);
  const output = count(usage?.output_tokens);
  if (input == null || output == null) return ceiling;
  const cached = (count(usage?.cache_creation_input_tokens) ?? 0) + (count(usage?.cache_read_input_tokens) ?? 0);
  return { promptTokens: input + cached, completionTokens: output };
}

/** Worst case for a request we cannot account exactly: about 3 characters a token in, max_tokens out. */
function ceilingFor(body: Record<string, unknown>, maxTokens: number): { promptTokens: number; completionTokens: number } {
  return { promptTokens: Math.ceil(JSON.stringify(body).length / 3), completionTokens: maxTokens };
}

export function modelFor(tier: 'opus' | 'sonnet' | 'haiku'): { model: string; effort: 'medium' | null; maxTokens: number } {
  if (tier === 'opus') return { model: MODEL_ID.opus, effort: 'medium', maxTokens: MAX_TOKENS.opus };
  if (tier === 'sonnet') return { model: MODEL_ID.sonnet, effort: null, maxTokens: MAX_TOKENS.sonnet };
  return { model: MODEL_ID.haiku, effort: null, maxTokens: MAX_TOKENS.haiku };
}

export async function completeAnthropic(input: {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | null;
  maxTokens: number;
  system: string;
  messages: unknown[];
  tools?: ToolSpec[];
  /** 'none' makes the model answer from what it has, with the tools still defined. */
  toolChoice?: 'auto' | 'none';
  fetchImpl?: typeof fetch;
  /** Text deltas from the Messages API, before the round or post-check finishes. */
  onText?: (delta: string) => void;
}): Promise<Completion> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens,
    system: input.system,
    messages: input.messages,
  };
  if (input.tools?.length) body.tools = input.tools;
  if (input.tools?.length && input.toolChoice === 'none') body.tool_choice = { type: 'none' };
  if (input.effort) body.output_config = { effort: input.effort };
  if (input.onText) body.stream = true;
  let response: Response;
  try {
    response = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': input.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // The request may have reached the API and been billed: charge the ceiling.
    const ceiling = ceilingFor(body, input.maxTokens);
    throw new AnthropicError('anthropic request failed: network', ceiling.promptTokens, ceiling.completionTokens);
  }
  // An error status is not billed.
  if (!response.ok) throw new AnthropicError(`anthropic request failed: ${response.status}`, 0, 0);
  let json: { model?: unknown; stop_reason?: unknown; content?: unknown; usage?: Usage };
  try {
    if (input.onText && response.headers.get('content-type')?.includes('text/event-stream')) {
      if (!response.body) throw new Error('missing stream');
      const blocks: Record<string, unknown>[] = [];
      const partialInputs = new Map<number, string>();
      let usage: Usage = {}, stop: unknown, finished = false;
      for await (const event of readEvents(response.body)) {
        const message = event.message as { usage?: Usage } | undefined;
        const delta = event.delta as Record<string, unknown> | undefined;
        const index = event.index as number;
        if (event.type === 'message_start') usage = { ...message?.usage };
        if (event.type === 'content_block_start') {
          blocks[index] = { ...(event.content_block as Record<string, unknown>) };
          if (blocks[index].type === 'text' && typeof blocks[index].text === 'string' && blocks[index].text) input.onText(blocks[index].text as string);
        }
        if (event.type === 'content_block_delta') {
          const block = blocks[index];
          if (!block || !delta) throw new Error('invalid block');
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            block.text = String(block.text ?? '') + delta.text;
            input.onText(delta.text);
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            partialInputs.set(index, (partialInputs.get(index) ?? '') + delta.partial_json);
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            block.thinking = String(block.thinking ?? '') + delta.thinking;
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            block.signature = String(block.signature ?? '') + delta.signature;
          }
        }
        if (event.type === 'content_block_stop' && partialInputs.has(index)) {
          // A tool called with no arguments streams an empty string, not "{}".
          const raw = partialInputs.get(index)!.trim();
          blocks[index].input = raw ? JSON.parse(raw) : (blocks[index].input ?? {});
        }
        if (event.type === 'message_delta') { stop = delta?.stop_reason; usage = { ...usage, ...(event.usage as Usage) }; }
        if (event.type === 'error') throw new Error('stream error');
        if (event.type === 'message_stop') { finished = true; break; }
      }
      if (!finished) throw new Error('incomplete stream');
      json = { stop_reason: stop, content: blocks, usage };
    } else {
      json = await response.json() as typeof json;
      // A JSON response is also supported by test fixtures and API-compatible hosts.
      if (input.onText && Array.isArray(json.content)) for (const block of json.content) {
        if (block?.type === 'text' && typeof block.text === 'string') input.onText(block.text);
      }
    }
  } catch (error) {
    const ceiling = ceilingFor(body, input.maxTokens);
    const why = error instanceof Error ? error.message : String(error);
    throw new AnthropicError(`anthropic response incomplete or invalid: ${why}`.slice(0, 120), ceiling.promptTokens, ceiling.completionTokens);
  }
  const usage = usageOf(json.usage, ceilingFor(body, input.maxTokens));
  const stop = typeof json.stop_reason === 'string' ? json.stop_reason : 'unknown';
  if (stop === 'refusal') throw new AnthropicError('anthropic refused', usage.promptTokens, usage.completionTokens);
  const content = Array.isArray(json.content) ? json.content : [];
  const calls: ToolCall[] = [];
  const text: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const row = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
    if (row.type === 'text' && typeof row.text === 'string') text.push(row.text);
    if (row.type === 'tool_use' && typeof row.id === 'string' && typeof row.name === 'string') {
      calls.push({ id: row.id, name: row.name, input: row.input ?? {} });
    }
  }
  return { text: text.join('').trim(), calls, stop, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, rawContent: content };
}

export function tierEffort(tier: Tier): 'medium' | null {
  return tier === 'opus' ? 'medium' : null;
}
