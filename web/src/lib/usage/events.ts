/** Usage events. The browser batches USAGE_KINDS. Connector calls are server-written (`api`, `mcp`) and are not accepted from the beacon. */

export const USAGE_KINDS = [
  'lens', 'point', 'place', 'scrub', 'hold', 'session-start', 'session-end', 'chat-open', 'train-answer', 'learn-start', 'od-decision',
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

/** Kinds the public weather connector writes. Kept out of USAGE_KINDS so a page cannot forge them. */
export const CONNECTOR_EVENT_KINDS = ['api', 'mcp'] as const;
export type ConnectorEventKind = (typeof CONNECTOR_EVENT_KINDS)[number];

export const USAGE_INTERVAL_MS = 10_000;
export const USAGE_NOTICE = 'Conversations and use are stored to improve Isobar';

export interface UsageDraft {
  kind: UsageKind;
  at: string;
  payload: Record<string, unknown>;
}

const KIND = new Set<string>(USAGE_KINDS);

export function sanitizeBatch(body: unknown, now: Date): UsageDraft[] | null {
  const row = body && typeof body === 'object' ? body as { events?: unknown } : null;
  if (!row || !Array.isArray(row.events) || row.events.length === 0 || row.events.length > 30) return null;
  const events: UsageDraft[] = [];
  for (const item of row.events) {
    if (!item || typeof item !== 'object') return null;
    const kind = (item as { kind?: unknown }).kind;
    const at = (item as { at?: unknown }).at;
    const payload = (item as { payload?: unknown }).payload;
    if (typeof kind !== 'string' || !KIND.has(kind)) return null;
    if (typeof at !== 'string') return null;
    const when = new Date(at);
    if (!Number.isFinite(when.getTime())) return null;
    if (Math.abs(when.getTime() - now.getTime()) > 2 * 24 * 60 * 60 * 1000) return null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (JSON.stringify(payload).length > 2_000) return null;
    events.push({ kind: kind as UsageKind, at: when.toISOString(), payload: payload as Record<string, unknown> });
  }
  return events;
}

export interface UsageClock {
  pending: UsageDraft[];
  lastSentAt: number | null;
}

/**
 * First batch sends at once. Later batches wait out the 10s gap.
 * pagehide sends whatever is still queued.
 */
export function reduceUsage(
  state: UsageClock,
  now: number,
  reason: 'track' | 'due' | 'hide',
  event?: UsageDraft,
): { state: UsageClock; send: UsageDraft[] | null; waitMs: number | null } {
  const pending = event ? [...state.pending, event] : state.pending;
  if (!pending.length) return { state: { pending, lastSentAt: state.lastSentAt }, send: null, waitMs: null };
  const elapsed = state.lastSentAt == null ? USAGE_INTERVAL_MS : now - state.lastSentAt;
  if (reason !== 'hide' && elapsed < USAGE_INTERVAL_MS) {
    return { state: { pending, lastSentAt: state.lastSentAt }, send: null, waitMs: USAGE_INTERVAL_MS - elapsed };
  }
  return { state: { pending: [], lastSentAt: now }, send: pending, waitMs: null };
}

export interface UsageExportRow {
  id: string;
  userId: string | null;
  deviceId: string;
  at: string;
  kind: string;
  payload: unknown;
}

export function usageNdjson(rows: readonly UsageExportRow[]): string {
  if (!rows.length) return '';
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

export function exportSince(raw: string | null): Date | null {
  if (!raw?.trim()) return null;
  const date = new Date(raw.trim());
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Account deletion removes that user's chat and keeps events with no user id. */
export function afterAccountDeletion<T extends { userId: string | null }>(events: readonly T[], userId: string): T[] {
  return events.map((event) => event.userId === userId ? { ...event, userId: null } : event);
}

export function chatThreadsAfterDeletion<T extends { userId: string | null }>(threads: readonly T[], userId: string): T[] {
  return threads.filter((thread) => thread.userId !== userId);
}
