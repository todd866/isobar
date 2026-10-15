import type { FeedbackEvent } from './buffer';

/** ISO local wall time with a numeric offset, including DST at this instant. */
export function localISO(ms: number, zone: string): string | null {
  if (!Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
    const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
    const wall = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
    const offset = Math.round((Date.parse(`${wall}Z`) - Math.floor(ms / 1000) * 1000) / 60000);
    return `${wall}${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  } catch { return null; }
}
export interface AppIdentity { version: string | null; build: string | null; commit: string | null }
export function makeSnapshot(input: { now: number; zone: string; app: AppIdentity; state: Record<string, unknown>; recent: FeedbackEvent[] }) {
  // JSON clone converts non-finite numbers to null and severs all live references.
  return JSON.parse(JSON.stringify({ schema: 'isobar-feedback/1', surface: 'web', captured_at: new Date(input.now).toISOString(), local_time: localISO(input.now, input.zone), note: null, app: input.app, state: input.state, recent: input.recent, files: [] })) as {
    schema: 'isobar-feedback/1'; surface: 'web'; captured_at: string; local_time: string | null; note: string | null; app: AppIdentity; state: Record<string, unknown>; recent: FeedbackEvent[]; files: string[];
  };
}
