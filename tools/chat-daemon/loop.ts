import { readCapacity } from './capacity';
import { screenAnswer } from '../../web/src/lib/chat/watcher';
import { validPng, MAX_REPLY_CHARS } from '../../web/src/lib/agent/service';
import type { AgentApi, Runner } from './types';
import { notifyOwner, processMaintenance, processReport } from './reports';

export const POLL_MS = 20_000;
export const screenAgentReply = screenAnswer;

export async function processOne(api: AgentApi, runner: Runner, capacity = readCapacity, shutdown?: AbortSignal): Promise<'idle' | 'waiting' | 'complete' | 'released'> {
  if (shutdown?.aborted) return 'idle';
  if (!(await capacity()).ok) return 'waiting';
  if (shutdown?.aborted) return 'idle';
  const report = await api.reportClaim?.();
  if (report) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    shutdown?.addEventListener('abort', forwardAbort, { once: true });
    if (shutdown?.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
    try { controller.signal.throwIfAborted(); await processReport(api, runner, report, controller.signal); return 'complete'; }
    catch { return 'released'; }
    finally { clearTimeout(timeout); shutdown?.removeEventListener('abort', forwardAbort); }
  }
  const pending = await api.pending();
  if (!pending) return 'idle';
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  shutdown?.addEventListener('abort', forwardAbort, { once: true });
  if (shutdown?.aborted) controller.abort();
  const started = Date.now();
  const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
  try {
    controller.signal.throwIfAborted();
    const result = await runner({ question: pending.question, context: pending.context, thread: pending.thread, user: pending.user }, controller.signal);
    controller.signal.throwIfAborted();
    const images = result.images ?? [];
    if (!result.text.trim() || result.text.length > MAX_REPLY_CHARS ||
        [result.text, result.model, ...result.toolsUsed, ...images.map((image) => image.alt), ...result.briefing?.keyNumbers ?? [], ...result.briefing?.sources ?? []].some((text) => screenAnswer(text).length) ||
        images.length > 2 || images.some((image) => !validPng(image.src) || image.alt.length > 240)) throw new Error('reply held');
    await api.reply({ id: pending.id, leaseId: pending.leaseId, ...result, images,
      usage: { ...result.usage, latencyMs: Date.now() - started } });
    return 'complete';
  } catch {
    // Release exactly once. If the API is down, expiry recovers the claim.
    await api.release(pending.id, pending.leaseId);
    return 'released';
  } finally {
    clearTimeout(timeout); shutdown?.removeEventListener('abort', forwardAbort);
  }
}

export function startDaemon(api: AgentApi, runner: Runner, options: { intervalMs?: number; capacity?: () => Promise<{ ok: boolean }>; log?: (event: string) => void } = {}): () => Promise<void> {
  const shutdown = new AbortController();
  let running: Promise<void> | null = null;
  const check = () => {
    if (shutdown.signal.aborted || running) return;
    running = processOne(api, runner, options.capacity ?? readCapacity, shutdown.signal)
      .then((result) => { options.log?.(`poll:${result}`); }, () => { options.log?.('poll:error'); })
      .finally(() => { running = null; });
  };
  check();
  const timer = setInterval(check, options.intervalMs ?? POLL_MS);
  return async () => { clearInterval(timer); shutdown.abort(); await running; };
}

/** Maintenance has its own cadence and does not consume model capacity. */
export function startReportMaintenance(api: AgentApi, options: { notify?:typeof notifyOwner; intervalMs?: number; log?: (event: string) => void } = {}): () => Promise<void> {
  const shutdown = new AbortController(); let running: Promise<void> | null = null;
  const check = () => {
    if (shutdown.signal.aborted || running) return;
    running = processMaintenance(api, { log: options.log, notify:options.notify }).then((result) => options.log?.(`maintenance:${result}`), () => options.log?.('maintenance:error')).finally(() => { running = null; });
  };
  check(); const timer = setInterval(check, options.intervalMs ?? POLL_MS);
  return async () => { clearInterval(timer); shutdown.abort(); await running; };
}
