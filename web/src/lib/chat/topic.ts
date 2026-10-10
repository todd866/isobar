/** Shared by prompt history and the panel. Map forecast time is never chat age. */
/** Owner, 9 Oct: "usually starting on a fresh convo unless it's only been a few minutes". */
export const CONVERSATION_GAP_MS = 5 * 60_000;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const name = (value: unknown): string | null => typeof value === 'string' && value.trim()
  ? value.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ') : null;

/** Prefer the nearest-place name carried by a tapped point, otherwise round to
 * 0.1 degrees. Names also join a town tap to its selected-place conversation.
 * An unnamed point must not inherit an unrelated place still in the header. */
export function placeKey(context: unknown): string | null {
  const row = record(context);
  const point = record(row?.point);
  if (point) {
    const nearest = name(point.name);
    // pointName's fallback is a coordinate label, not a nearest place.
    if (nearest && !/^\d+(?:\.\d+)?°[ns]\s+\d+(?:\.\d+)?°[ew]$/.test(nearest)) return `place:${nearest}`;
    const { lat, lon } = point;
    if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90
      || typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) return null;
    const rounded = (value: number) => (Math.round(value * 10) / 10 || 0).toFixed(1);
    return `point:${rounded(lat)},${rounded(lon)}`;
  }
  const place = record(row?.place);
  const key = name(place?.name) ?? name(place?.id);
  return key ? `place:${key}` : null;
}

export interface ConversationMessage {
  createdAt?: Date | string;
  placeKey?: string | null;
  context?: unknown;
}

const timestamp = (value: ConversationMessage['createdAt']): number => value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
const keyOf = (message: ConversationMessage): string | null => message.placeKey === undefined ? placeKey(message.context) : message.placeKey;

/** The latest consecutive conversation ending at `current`, in the caller's
 * display order. Stop at a changed/unknown place, invalid/future date or a gap
 * of five minutes. Never retrieve an older visit to the same place across a break.
 * Sort a copy because archive replies may be displayed after their fast reply. */
export function currentConversation<T extends ConversationMessage>(messages: readonly T[], current: ConversationMessage): T[] {
  const key = keyOf(current);
  let at = timestamp(current.createdAt);
  if (!key || !Number.isFinite(at)) return [];
  const ordered = messages.map((message) => ({ message, at: timestamp(message.createdAt) }))
    .sort((a, b) => (Number.isFinite(a.at) ? a.at : Infinity) - (Number.isFinite(b.at) ? b.at : Infinity));
  const selected = new Set<T>();
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const previous = ordered[i];
    const gap = at - previous.at;
    if (keyOf(previous.message) !== key || !Number.isFinite(gap) || gap < 0 || gap >= CONVERSATION_GAP_MS) break;
    selected.add(previous.message);
    at = previous.at;
  }
  return messages.filter((message) => selected.has(message));
}
