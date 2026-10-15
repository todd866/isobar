import { FeedbackBuffer } from './buffer';
export const history = new FeedbackBuffer();
let enabled = false;
export interface FeedbackSource { state: () => Record<string, unknown>; capture: () => string | null }
let source: FeedbackSource | null = null;
export function registerFeedbackSource(next: FeedbackSource) { source = next; return () => { if (source === next) source = null; }; }
export function feedbackSource() { return source; }
export function feedbackEvent(type: string, data: unknown = null) { if (enabled) history.add(type, data); }
export function enableFeedback() {
  enabled = true;
  let previous = new Map<string, string>();
  const sample = () => {
    const state = source?.state();
    if (!state) return;
    for (const key of ['lens', 'field', 'overlays', 'camera', 'mode', 'place', 'playing', 'rate', 'run_id', 'data_status', 'data_frames']) {
      const value = JSON.stringify(state[key] ?? null);
      if (previous.get(key) !== value) { feedbackEvent(key, state[key] ?? null); previous.set(key, value); }
    }
  };
  sample();
  const timer = window.setInterval(sample, 250); // Camera events capped at 4 Hz.
  const error = (event: ErrorEvent) => feedbackEvent('error', { message: event.message.slice(0, 2000), file: event.filename, line: event.lineno });
  const rejection = (event: PromiseRejectionEvent) => feedbackEvent('unhandledrejection', String(event.reason).slice(0, 2000));
  const original = console.error;
  const wrapped: typeof console.error = (...args) => { feedbackEvent('console.error', args.map(v => { try { return String(v).slice(0, 1000); } catch { return null; } }).slice(0, 8)); original.apply(console, args); };
  console.error = wrapped;
  window.addEventListener('error', error);
  window.addEventListener('unhandledrejection', rejection);
  let observer: PerformanceObserver | null = null;
  try {
    const types = PerformanceObserver.supportedEntryTypes.filter(t => ['longtask', 'long-animation-frame'].includes(t));
    if (types.length) { observer = new PerformanceObserver(list => { for (const e of list.getEntries()) feedbackEvent(e.entryType, { duration: e.duration, start: e.startTime }); }); observer.observe({ entryTypes: types }); }
  } catch { /* Optional browser capability. */ }
  return () => {
    enabled = false; clearInterval(timer); observer?.disconnect(); previous = new Map(); history.clear();
    if (console.error === wrapped) console.error = original;
    window.removeEventListener('error', error); window.removeEventListener('unhandledrejection', rejection);
  };
}
let held = false;
export function holdFeedback(value: boolean) { held = value; }
export function feedbackHeld() { return held; }
