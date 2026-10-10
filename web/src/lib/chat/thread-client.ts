import { LINES } from './types';
import { readEvents } from './sse';

export type ThreadImage = { src: string; alt: string };

export type ThreadMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'pending' | 'claimed' | 'complete' | 'held' | 'failed' | 'cancelled';
  lane: 'fast' | 'slow';
  model: string | null;
  createdAt: string;
  placeKey: string | null;
  images: ThreadImage[];
  caveat?: string;
  anchors?: { places: { text: string; lat: number; lon: number }[]; times: { text: string; timeUtc: string }[] };
  userMessageId?: string;
  answerId?: string;
  archiveId?: string;
  archiveLine?: string;
  source?: string;
  reportOffer?: boolean;
  reportId?: string;
};

export type ThreadResponse = { id: string | null; messages: ThreadMessage[] };

export interface ChatEntry {
  id: string | number;
  kind: 'user' | 'reply' | 'line' | 'archive';
  text: string;
  model?: string;
  anchors?: ThreadMessage['anchors'];
  images?: ThreadImage[];
  messageId?: string;
  pending?: boolean;
  deliveryStatus?: ThreadMessage['status'];
  feedback?: string;
  archive?: boolean;
  createdAt?: string;
  placeKey?: string | null;
  status?: string;
  caveat?: string;
  userMessageId?: string;
  answerId?: string;
  archiveId?: string;
  archiveLine?: string;
  source?: string;
  reportOffer?: boolean;
  reportId?: string;
}

/** A completion event is required: a dropped stream must not look checked. */
export async function readChatStream(response: Response, onEvent: (event: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) throw new Error('Chat unavailable');
  for await (const event of readEvents(response.body)) {
    onEvent(event);
    if (event.done === true) return event;
  }
  throw new Error('Chat stream interrupted');
}

export function hasPendingSlow(entries: ChatEntry[]): boolean {
  return entries.some((entry) => entry.kind === 'archive' && entry.pending);
}

export type ArchiveAction = 'queue' | 'cancel';
export type ArchiveActionResult = { status: 'queued' | 'pending' | 'denied' | 'not-found' | 'cancelled' | 'claimed'; messageId?: string; line?: string };

/** Queue or cancel a slow-lane answer without exposing credentials to callers. */
export async function archiveAction(action: ArchiveAction, messageId: string, signal?: AbortSignal): Promise<ArchiveActionResult> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, 10_000);
  try {
    const response = await fetch('/api/chat/archive', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ action, messageId }), signal: controller.signal,
    });
    const body = await response.json().catch(() => null) as Partial<ArchiveActionResult> | null;
    if (!response.ok && !(response.status === 429 && body?.status === 'denied')) throw new Error(`archive ${response.status}`);
    if (body?.status !== 'queued' && body?.status !== 'pending' && body?.status !== 'denied' && body?.status !== 'not-found'
      && body?.status !== 'cancelled' && body?.status !== 'claimed') throw new Error('invalid archive response');
    return { status: body.status, ...(typeof body.messageId === 'string' ? { messageId: body.messageId } : {}), ...(typeof body.line === 'string' ? { line: body.line } : {}) };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

/** Stable server IDs are the only identity; identical repeated questions remain
 * separate exchanges. A delayed pending snapshot cannot erase a complete reply. */
export function mergeSlowEntries(current: ChatEntry[], messages: ThreadMessage[]): ChatEntry[] {
  const next = [...current];
  for (const message of messages) {
    const index = next.findIndex((entry) => entry.messageId === message.id);
    const prior = index >= 0 ? next[index] : undefined;
    const pending = message.status === 'pending' || message.status === 'claimed';
    if (pending && (prior?.kind === 'reply' || prior?.deliveryStatus === 'cancelled')) continue;
    const entry: ChatEntry = {
      id: prior?.id ?? message.id, messageId: message.id,
      kind: message.role === 'user' ? 'user' : pending || message.status === 'cancelled' ? 'archive' : 'reply',
      // The thread endpoint supplies only a display-safe reason for held rows.
      text: message.status === 'cancelled' ? '' : message.status === 'held' ? (message.content.startsWith('Not answered:') ? message.content : LINES.held)
        : message.status === 'failed' ? LINES.failed : pending ? (message.source === 'report' ? LINES.reportPreparing : LINES.archiveChecking) : message.content,
      caveat: message.caveat,
      model: message.status === 'held' ? undefined : message.model ?? undefined, anchors: message.anchors ?? prior?.anchors, images: message.images,
      pending, deliveryStatus: message.status, feedback: prior?.feedback, archive: message.role === 'assistant' && message.lane === 'slow', createdAt: message.createdAt,
      userMessageId: message.userMessageId, answerId: message.answerId, archiveId: message.lane === 'slow' ? message.id : message.archiveId,
      archiveLine: message.archiveLine, source: message.source, reportOffer: message.reportOffer === true, reportId: message.reportId ?? prior?.reportId,
      // A just-sent Learn exchange may have no map place. Keep its local-only
      // identity through hydration; a fresh open still treats it as unknown.
      placeKey: message.placeKey ?? (prior?.placeKey?.startsWith('local:') ? prior.placeKey : null),
    };
    if (index >= 0) next[index] = entry; else next.push(entry);
  }
  // Fast answers are saved after the pending row. Keep the archive follow-up
  // after the fast answer in each exchange, including on a fresh page load.
  next.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  const groups: { userId?: string; entries: ChatEntry[] }[] = [];
  for (const entry of next) {
    if (entry.kind === 'user') groups.push({ userId: entry.messageId, entries: [entry] });
    else {
      const linked = entry.userMessageId ? groups.find((group) => group.userId === entry.userMessageId) : undefined;
      (linked ?? groups[groups.length - 1] ?? (groups.push({ entries: [] }), groups[groups.length - 1])).entries.push(entry);
    }
  }
  return groups.flatMap((group) => [...group.entries.filter((entry) => !entry.archive), ...group.entries.filter((entry) => entry.archive)]);
}

/** Fetch the display-safe signed-in thread. Logout and account changes abort
 * polling and discard late private responses; closing the sheet keeps polling. */
export async function fetchThread(signal?: AbortSignal): Promise<ThreadResponse | null> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, 10_000);
  try {
    const response = await fetch('/api/chat/thread', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    if (response.status === 401 || response.status === 404) return null;
    if (!response.ok) throw new Error(`thread ${response.status}`);
    const body = await response.json() as Partial<ThreadResponse>;
    if (!Array.isArray(body.messages)) throw new Error('invalid thread');
    return { id: typeof body.id === 'string' ? body.id : null, messages: body.messages.filter(isThreadMessage) };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

function isThreadMessage(value: unknown): value is ThreadMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ThreadMessage>;
  return typeof item.id === 'string' && (item.role === 'user' || item.role === 'assistant')
    && typeof item.content === 'string' && (item.status === 'pending' || item.status === 'claimed' || item.status === 'complete' || item.status === 'held' || item.status === 'failed' || item.status === 'cancelled')
    && (item.lane === 'fast' || item.lane === 'slow') && (item.model == null || typeof item.model === 'string')
    && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
    && (item.placeKey == null || (typeof item.placeKey === 'string' && item.placeKey.length <= 100))
    && Array.isArray(item.images) && item.images.length <= 2
    && item.images.every((image) => image && typeof image.alt === 'string' && typeof image.src === 'string'
      && image.src.length <= 700_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.src))
    && (!item.anchors || (Array.isArray(item.anchors.places) && Array.isArray(item.anchors.times)));
}
