import { createHash } from 'node:crypto';
import { CONNECTOR_EVENT_KINDS, type ConnectorEventKind } from '../usage/events';

/** Anonymous public weather reads. REST and MCP share both windows. */
export const CONNECTOR_LIMITS = {
  connectorIp: { max: 30, windowMs: 60_000 },
  connectorIpDay: { max: 2_000, windowMs: 24 * 60 * 60_000 },
} as const;

export type LimitVerdict = 'ok' | 'minute' | 'day';

export interface ConnectorUsage {
  kind: ConnectorEventKind;
  tool: string;
  lat: number | null;
  lon: number | null;
}

function blind(ip: string): string {
  return createHash('sha256').update(`isobar-connector:${ip}`).digest('base64url');
}

function roundDegree(value: number): number {
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Nearest degree. An unusable pair becomes nulls, so a latitude is never stored alone. */
export function coarsePoint(lat: number | null | undefined, lon: number | null | undefined): { lat: number | null; lon: number | null } {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return { lat: null, lon: null };
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { lat: null, lon: null };
  return { lat: roundDegree(lat), lon: roundDegree(lon) };
}

/** The only connector payload written to UsageEvent. No address, no query text. */
export function connectorEvent(input: ConnectorUsage): { kind: ConnectorEventKind; payload: { tool: string; lat: number | null; lon: number | null; caller: 'anonymous' } } {
  const kind = (CONNECTOR_EVENT_KINDS as readonly string[]).includes(input.kind) ? input.kind : 'api';
  const where = coarsePoint(input.lat, input.lon);
  return {
    kind,
    payload: {
      tool: input.tool.slice(0, 80),
      lat: where.lat,
      lon: where.lon,
      caller: 'anonymous',
    },
  };
}

/**
 * In-process sliding window for when the database throttle is unavailable.
 * Keys are hashes. The database path is the limit that holds across instances.
 */
export function createLimiter(now: () => number = Date.now): (ip: string) => Promise<LimitVerdict> {
  const buckets = new Map<string, number[]>();
  return async (ip: string) => {
    const t = now();
    const key = blind(ip);
    const kept = (buckets.get(key) ?? []).filter((at) => t - at < CONNECTOR_LIMITS.connectorIpDay.windowMs);
    kept.push(t);
    buckets.set(key, kept);
    if (buckets.size > 20_000) {
      for (const old of buckets.keys()) {
        if (old !== key) {
          buckets.delete(old);
          break;
        }
      }
    }
    if (kept.length > CONNECTOR_LIMITS.connectorIpDay.max) return 'day';
    const minute = kept.filter((at) => t - at < CONNECTOR_LIMITS.connectorIp.windowMs).length;
    if (minute > CONNECTOR_LIMITS.connectorIp.max) return 'minute';
    return 'ok';
  };
}

let shared: ((ip: string) => Promise<LimitVerdict>) | null = null;

export function memoryLimit(ip: string): Promise<LimitVerdict> {
  shared ??= createLimiter();
  return shared(ip);
}
