/** The body POST /api/agent/reply accepts. Context and tool calls are required. */

export interface AgentToolCall {
  name: string;
  input: unknown;
  output?: unknown;
}

export interface AgentReply {
  messageId: string;
  content: string;
  context: Record<string, unknown>;
  toolCalls: AgentToolCall[];
  status: 'complete' | 'failed';
  model: string | null;
}

export function parseAgentReply(body: unknown): AgentReply | { error: string } {
  const row = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  if (!row) return { error: 'body' };
  const messageId = typeof row.messageId === 'string' ? row.messageId.trim() : '';
  if (!messageId || messageId.length > 80) return { error: 'message' };
  if (typeof row.content !== 'string') return { error: 'content' };
  if (!row.context || typeof row.context !== 'object' || Array.isArray(row.context)) return { error: 'context' };
  if (!Array.isArray(row.toolCalls)) return { error: 'tools' };
  const toolCalls: AgentToolCall[] = [];
  for (const call of row.toolCalls) {
    if (!call || typeof call !== 'object' || Array.isArray(call)) return { error: 'tools' };
    const name = (call as { name?: unknown }).name;
    if (typeof name !== 'string' || !name.trim()) return { error: 'tools' };
    const item: AgentToolCall = { name: name.trim().slice(0, 80), input: (call as { input?: unknown }).input ?? null };
    if ('output' in (call as object)) item.output = (call as { output?: unknown }).output;
    toolCalls.push(item);
  }
  const status = row.status == null || row.status === 'complete' ? 'complete' : row.status === 'failed' ? 'failed' : null;
  if (!status) return { error: 'status' };
  const model = row.model == null ? null : typeof row.model === 'string' ? row.model.slice(0, 80) : null;
  if (row.model != null && model == null) return { error: 'model' };
  return {
    messageId,
    content: row.content.slice(0, 20_000),
    context: row.context as Record<string, unknown>,
    toolCalls,
    status,
    model,
  };
}
