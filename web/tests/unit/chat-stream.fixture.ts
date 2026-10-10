/** Messages API wire fixtures. These exercise parsing, not the completion shortcut. */
export function messageEvents(message: Record<string, unknown>): Record<string, unknown>[] {
  const usage = message.usage as Record<string, unknown>;
  const events: Record<string, unknown>[] = [{ type: 'message_start', message: { usage: { ...usage, output_tokens: 0 } } }];
  (message.content as Record<string, unknown>[]).forEach((block, index) => {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'text'
      ? { type: 'text', text: '' } : block.type === 'tool_use' ? { ...block, input: {} } : block });
    if (block.type === 'text') events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    if (block.type === 'tool_use') {
      const json = JSON.stringify(block.input), mid = Math.floor(json.length / 2);
      for (const part of [json.slice(0, mid), json.slice(mid)]) events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: message.stop_reason }, usage: { output_tokens: usage.output_tokens } }, { type: 'message_stop' });
  return events;
}
export const eventBytes = (event: Record<string, unknown>) => new TextEncoder().encode(`event: ${event.type ?? 'message'}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
export function eventsResponse(events: Record<string, unknown>[]): Response {
  return new Response(new ReadableStream({ start(controller) {
    for (const event of events) {
      const bytes = eventBytes(event);
      // Deliberately split both SSE boundaries and UTF-8 codepoints.
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    }
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
