import 'server-only';
import { randomBytes } from 'node:crypto';
import { parseFlightRoute, mergeTrackPoints, type FlightRoute, type TrafficTrailPoint } from '../traffic-paths';
import { readTrafficJson, type TrafficAircraft } from '../traffic';
import { databaseConfigured } from './prisma';
import { LIMITS, overAfter, record } from './throttle';

const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_MAX_MS = 4 * 60 * 60_000;
const MAX_SESSIONS = 256;
// Server traces supplement the client buffer; do not multiply per-session server memory
// when the client replay buffer grows. Capture/replay stays in the viewing device.
const MAX_HEXES = 64;
const MAX_SESSION_POINTS = 240;
const ROUTE_TTL_MS = 10 * 60_000;
const requestHits = new Map<string, number[]>();

interface SessionHex { points: TrafficTrailPoint[]; aircraft: TrafficAircraft; }
interface TrafficSession { createdAt: number; touchedAt: number; hexes: Map<string, SessionHex>; }
const sessions = new Map<string, TrafficSession>();

function evict(now: number): void {
  for (const [token, session] of sessions) if (now - session.touchedAt > SESSION_IDLE_MS || now - session.createdAt > SESSION_MAX_MS) sessions.delete(token);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
}

export async function allowTrafficRequest(ip: string, nowMs = Date.now(), detail = false): Promise<boolean> {
  const name = detail ? 'trafficDetailIp' : 'trafficIp';
  const key = `${name}:${ip}`;
  if (!databaseConfigured()) {
    const rule = LIMITS[name];
    for (const [id, hits] of requestHits) if (!hits.length || nowMs - hits[hits.length - 1] >= rule.windowMs) requestHits.delete(id);
    const current = (requestHits.get(key) ?? []).filter((at) => nowMs - at < rule.windowMs);
    if (current.length >= rule.max) { requestHits.set(key, current); return false; }
    current.push(nowMs); requestHits.set(key, current);
    while (requestHits.size > 2048) requestHits.delete(requestHits.keys().next().value!);
    return true;
  }
  try { await record(name, ip); return !(await overAfter(name, ip)); } catch { return false; }
}

function validToken(token: string | null | undefined): token is string { return !!token && /^[A-Za-z0-9_-]{24,128}$/.test(token); }

export function sessionToken(header: string | null | undefined): string {
  if (validToken(header)) return header;
  return randomBytes(24).toString('base64url');
}

export function recordTrafficSnapshot(token: string, aircraft: readonly TrafficAircraft[], nowMs = Date.now()): void {
  evict(nowMs); let session = sessions.get(token);
  if (!session || nowMs - session.createdAt > SESSION_MAX_MS) { session = { createdAt: nowMs, touchedAt: nowMs, hexes: new Map() }; sessions.delete(token); sessions.set(token, session); }
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  session.touchedAt = nowMs;
  for (const row of aircraft) {
    const previous = session.hexes.get(row.hex);
    const points = mergeTrackPoints(previous?.points ?? [], [{ latitude: row.latitude, longitude: row.longitude, timeMs: row.positionTimeMs, pressureAltitudeFt: row.pressureAltitudeFt }], nowMs, MAX_SESSION_POINTS);
    session.hexes.set(row.hex, { points, aircraft: row });
  }
  while (session.hexes.size > MAX_HEXES) session.hexes.delete(session.hexes.keys().next().value!);
}

export function sessionTrail(token: string, hex: string, nowMs = Date.now()): { points: TrafficTrailPoint[]; aircraft?: TrafficAircraft } | null {
  evict(nowMs); const session = sessions.get(token); if (!session) return null; session.touchedAt = nowMs;
  const normalizedHex = hex.trim().toLowerCase();
  const hit = session.hexes.get(normalizedHex); if (!hit) return null;
  hit.points = mergeTrackPoints(hit.points, [], nowMs, MAX_SESSION_POINTS);
  if (!hit.points.length) { session.hexes.delete(normalizedHex); return null; }
  return { points: hit.points.map((point) => ({ ...point })), aircraft: hit.aircraft };
}

interface RouteCache { at: number; value: FlightRoute | null; }
const routeCache = new Map<string, RouteCache>();
const routeInflight = new Map<string, Promise<FlightRoute | null>>();
const MAX_ROUTE_BYTES = 256 * 1024;

/** Disabled unless the owner has explicitly enabled adsbdb after obtaining permission. */
export async function lookupFlightRoute(callsign: string, fetchImpl: typeof fetch = fetch): Promise<FlightRoute | null> {
  const key = callsign.trim().toUpperCase().replace(/\s+/g, '').slice(0, 12);
  if (!key || process.env.ADSBDB_ROUTES_ENABLED !== '1') return null;
  const hit = routeCache.get(key); if (hit && Date.now() - hit.at < ROUTE_TTL_MS) return hit.value;
  const running = routeInflight.get(key); if (running) return running;
  if (routeInflight.size >= 64) return null;
  const task = (async () => {
    let value: FlightRoute | null = null;
    try {
      const response = await fetchImpl(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        value = parseFlightRoute(await readTrafficJson(response, MAX_ROUTE_BYTES), key);
      }
    } catch { value = null; }
    routeCache.set(key, { at: Date.now(), value });
    while (routeCache.size > 512) routeCache.delete(routeCache.keys().next().value!);
    return value;
  })();
  routeInflight.set(key, task); try { return await task; } finally { routeInflight.delete(key); }
}

export function clearTrafficSessionCaches(): void { sessions.clear(); routeCache.clear(); routeInflight.clear(); requestHits.clear(); }

export function deleteTrafficSession(token: string): void { sessions.delete(token); }
