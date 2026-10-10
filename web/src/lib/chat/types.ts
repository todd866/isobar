/** Shared chat types and the one-line states the panel shows. */

export type Tier = 'opus' | 'sonnet' | 'haiku' | 'off';
export type LiveTier = Tier | 'rest';
export type Grade = 'interesting' | 'ordinary' | 'off-purpose' | 'abusive';
export type PreScreen = 'allow' | 'downgrade' | 'block';

export const LINES = {
  unavailable: 'Chat unavailable',
  resting: 'Chat is resting until tomorrow',
  governor: 'Chat is resting',
  archive: 'Queued, will answer later.',
  archiveChecking: 'Checking the archive for more (a few minutes)',
  reportOffer: 'This question needs a detailed report.',
  reportPreparing: 'Preparing your report…',
  signIn: 'Sign in to keep going',
  paused: 'Chat is paused',
  blocked: 'Isobar only talks weather and flying',
  held: 'Not answered: this reply did not pass the safety check.',
  failed: 'Reply failed',
  interrupted: 'Reply interrupted. Please try again.',
  slow: 'Slow down a little',
} as const;

export interface ChatUnits {
  mode: 'aus' | 'us' | 'local';
  pressure: 'hPa' | 'inHg';
  temp: 'C' | 'F';
  wind: 'kt';
  height: 'ft' | 'm';
  visibility: 'km' | 'sm';
  rain: 'mm' | 'in';
  flightLevel: 'ft' | 'metric';
  transitionFt: number;
}

export interface ChatContext {
  place: { id: string; name: string; zone: string } | null;
  timeUtc: string | null;
  timeLocal: string | null;
  lens: string | null;
  camera: { lat: number; lon: number; zoom: number } | null;
  point: { lat: number; lon: number; name: string | null; profile: unknown } | null;
  fly: { icao: string; metar: string | null; taf: string | null } | null;
  /** Active display units. Null when the client did not send a valid block. */
  units: ChatUnits | null;
  runId: string | null;
  dataSha256: string | null;
  /** Learn card that opened Ask Isobar. Null when chat was opened from the map. */
  level: string | null;
  cardId: string | null;
  rules: 'aus' | 'us' | 'easa' | 'ca' | null;
}

export interface ChatAnchors {
  places: { text: string; lat: number; lon: number }[];
  times: { text: string; timeUtc: string }[];
}

export const MODEL_ID = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
} as const;

export const MODEL_LABEL: Record<string, string> = {
  [MODEL_ID.opus]: 'Opus',
  [MODEL_ID.sonnet]: 'Sonnet',
  [MODEL_ID.haiku]: 'Haiku',
};

export function modelLabel(model: string | null | undefined): string {
  if (!model) return '';
  return MODEL_LABEL[model] ?? '';
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function daysLeftInMonth(now: Date): number {
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return last - now.getUTCDate() + 1;
}

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** One line when a signed-in month has reached its cap. */
export function monthRestLine(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const month = new Intl.DateTimeFormat('en-AU', { month: 'long', timeZone: 'UTC' }).format(next);
  const year = next.getUTCFullYear() === now.getUTCFullYear() ? '' : ` ${next.getUTCFullYear()}`;
  return `Chat rests until 1 ${month}${year}`;
}

export function utcChip(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  const day = new Intl.DateTimeFormat('en-AU', { weekday: 'short', timeZone: 'UTC' }).format(date);
  return `${day} ${String(date.getUTCHours()).padStart(2, '0')}Z`;
}

export function coordChip(lat: number, lon: number): string {
  const ns = lat < 0 ? 'S' : 'N';
  const ew = lon < 0 ? 'W' : 'E';
  return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew}`;
}

const LENS_LABEL: Record<string, string> = {
  pressure: 'Pressure', rain: 'Rain', wind: 'Wind', temp: 'Temp', kite: 'Kite', surf: 'Surf', fly: 'Fly',
};

export function lensChip(lens: string | null): string {
  if (!lens) return '—';
  return LENS_LABEL[lens] ?? lens;
}
