import type { Capacity, Runtime } from './capacity';
import { screenAnswer } from '../../web/src/lib/chat/watcher';
import { validPng, MAX_REPLY_CHARS } from '../../web/src/lib/agent/service';
import type { Runner } from './types';

/** Recheck between attempts. No API runner exists in this dispatch table. */
export function subscriptionRunner(runners: Partial<Record<Runtime, Runner>>, capacity: () => Promise<Capacity>,
  busy: () => Promise<boolean>, selected: (runtime: Runtime | 'waiting' | 'idle') => void = () => {}, guardMs = 20_000): Runner {
  return async (input, signal) => {
    const control = new AbortController();
    const abort = () => control.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let watching = false, done = false;
    const timer = setInterval(() => {
      if (watching || done) return;
      watching = true;
      void (async () => { if (await busy() || !(await capacity()).ok) abort(); })()
        .catch(abort).finally(() => { watching = false; });
    }, guardMs);
    try {
      for (const runtime of ['claude', 'codex', 'cursor'] as const) {
        control.signal.throwIfAborted();
        if (await busy()) throw new Error('yielding to md3');
        const current = await capacity();
        if (!current.ok) throw new Error('subscription capacity unavailable');
        if (!current.runtimes?.includes(runtime) || !runners[runtime]) continue;
        selected(runtime);
        let result;
        try { result = await runners[runtime]!(input, control.signal); }
        catch { control.signal.throwIfAborted(); continue; }
        // A held answer never gets a second runtime to evade the screen.
        const images = result.images ?? [];
        if (!result.text.trim() || result.text.length > MAX_REPLY_CHARS || images.length > 2 ||
            [result.text, result.model, ...result.toolsUsed, ...images.map((image) => image.alt)].some((text) => screenAnswer(text).length) ||
            images.some((image) => !validPng(image.src) || image.alt.length > 240)) throw new Error('reply held');
        control.signal.throwIfAborted();
        return result;
      }
      throw new Error('subscription runtimes unavailable');
    } finally { done = true; clearInterval(timer); signal.removeEventListener('abort', abort); selected('idle'); }
  };
}
