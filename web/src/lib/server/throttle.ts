import 'server-only';
import { createHmac } from 'node:crypto';
import { CONNECTOR_LIMITS } from '../connector/limits';
import { db } from './prisma';

/** DB-backed sliding-window limits. Buckets are HMACs, so no address or IP is stored. */
export const LIMITS = {
  sendEmail: { max: 5, windowMs: 60 * 60_000 },
  sendIp: { max: 20, windowMs: 60 * 60_000 },
  codeEmail: { max: 5, windowMs: 15 * 60_000 },
  codeIp: { max: 30, windowMs: 15 * 60_000 },
  // Never reset by a new code: with 8-digit codes, 50 guesses a day is ~0.02% a year.
  codeEmailDay: { max: 50, windowMs: 24 * 60 * 60_000 },
  // Chat: a person types a question every few seconds at most; anything faster is a script.
  chatUser: { max: 6, windowMs: 60_000 },
  chatIp: { max: 10, windowMs: 60_000 },
  chatIpDay: { max: 300, windowMs: 24 * 60 * 60_000 },
  // Usage beacons: the client sends at most one batch per 10 s per tab.
  usageIp: { max: 30, windowMs: 60_000 },
  // METAR/TAF lookups for any aerodrome; each miss is two upstream requests.
  aviationIp: { max: 30, windowMs: 60_000 },
  // ADS-B tiles. The map polls every 10 s; the rest is panning between tiles.
  trafficIp: { max: 40, windowMs: 60_000 },
  trafficDetailIp: { max: 40, windowMs: 60_000 },
  agentIp: { max: 60, windowMs: 60_000 },
  // Claim/reply plus independent heartbeat/health, including restart bursts.
  agentToken: { max: 30, windowMs: 60_000 },
  chatThread: { max: 12, windowMs: 60_000 },
  // Public weather connector. Anonymous callers share one bucket across REST and MCP.
  connectorIp: CONNECTOR_LIMITS.connectorIp,
  connectorIpDay: CONNECTOR_LIMITS.connectorIpDay,
} as const;
export type LimitName = keyof typeof LIMITS;

export function bucket(name: LimitName, value: string): string {
  const secret = process.env.AUTH_SECRET ?? '';
  return `${name}:${createHmac('sha256', secret).update(value.normalize('NFKC').trim().toLowerCase()).digest('base64url').slice(0, 32)}`;
}

export async function hits(name: LimitName, value: string): Promise<number> {
  const since = new Date(Date.now() - LIMITS[name].windowMs);
  return db().authThrottle.count({ where: { bucket: bucket(name, value), at: { gte: since } } });
}

export async function over(name: LimitName, value: string): Promise<boolean> {
  return (await hits(name, value)) >= LIMITS[name].max;
}

/** After this request's own attempt is recorded: over once attempts exceed the limit. */
export async function overAfter(name: LimitName, value: string): Promise<boolean> {
  return (await hits(name, value)) > LIMITS[name].max;
}

export async function record(name: LimitName, value: string): Promise<void> {
  await db().authThrottle.create({ data: { bucket: bucket(name, value) } });
}

export async function clear(name: LimitName, value: string): Promise<void> {
  await db().authThrottle.deleteMany({ where: { bucket: bucket(name, value) } });
}

/** Drop rows older than the longest window, and expired sign-in codes. Best effort. */
export async function sweep(): Promise<void> {
  const oldest = new Date(Date.now() - Math.max(...Object.values(LIMITS).map((l) => l.windowMs)));
  await Promise.allSettled([
    db().authThrottle.deleteMany({ where: { at: { lt: oldest } } }),
    db().verificationToken.deleteMany({ where: { expires: { lt: new Date() } } }),
  ]);
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || 'unknown';
}
