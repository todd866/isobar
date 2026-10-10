import { NextResponse } from 'next/server';
import {
  cacheGet,
  cacheSet,
  closestAircraft,
  fetchAdsbSnapshot,
  TRAFFIC_RESPONSE_CAP,
  trafficTile,
  trafficQuery,
  type TrafficCacheEntry,
  type TrafficSnapshot,
} from '@/lib/traffic';
import { clientIp } from '@/lib/server/throttle';
import { allowTrafficRequest, recordTrafficSnapshot, sessionToken } from '@/lib/server/traffic-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const inflight = new Map<string, Promise<TrafficSnapshot | null>>();
const memory = new Map<string, TrafficCacheEntry<TrafficSnapshot | null>>();

/**
 * ADSB.lol open data (ODbL). One upstream read per rounded tile per 5 s.
 * Browsers hit this route, not api.adsb.lol. A missing rate-limit store fails
 * closed so a broken database cannot turn into an unbounded upstream poll.
 */
async function limit(request: Request): Promise<Response | null> {
  const ip = clientIp(request);
  if (await allowTrafficRequest(ip)) return null;
  return NextResponse.json({ error: 'slow' }, { status: 429, headers: NO_STORE });
}

function send(snapshot: TrafficSnapshot | null, lat: number, lon: number, token: string): Response {
  if (!snapshot) return NextResponse.json({ error: 'upstream' }, { status: 502, headers: NO_STORE });
  recordTrafficSnapshot(token, closestAircraft(snapshot.aircraft, lat, lon, 64), Date.now());
  return NextResponse.json({
    time: snapshot.timeMs,
    source: snapshot.source,
    radiusNm: snapshot.radiusNm,
    aircraft: closestAircraft(snapshot.aircraft, lat, lon, TRAFFIC_RESPONSE_CAP),
    sessionToken: token,
    routeLookupEnabled: process.env.ADSBDB_ROUTES_ENABLED === '1',
  }, { headers: { ...NO_STORE, 'X-Traffic-Session': token } });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = trafficQuery(url.searchParams);
  if (!query) return NextResponse.json({ error: 'query' }, { status: 400, headers: NO_STORE });
  const { lat, lon, radiusNm } = query;
  const tile = trafficTile(lat, lon, radiusNm);
  if (!tile) return NextResponse.json({ error: 'query' }, { status: 400, headers: NO_STORE });
  const blocked = await limit(request);
  if (blocked) return blocked;
  const token = sessionToken(request.headers.get('x-traffic-session'));
  const now = Date.now();
  const cached = cacheGet(memory, tile.key, now);
  if (cached !== undefined) return send(cached, lat, lon, token);
  let pending = inflight.get(tile.key);
  if (!pending) {
    if (inflight.size >= 64) return NextResponse.json({ error: 'busy' }, { status: 503, headers: NO_STORE });
    pending = fetchAdsbSnapshot(lat, lon, radiusNm, now).then((snapshot) => { cacheSet(memory, tile.key, snapshot, Date.now()); return snapshot; }).finally(() => inflight.delete(tile.key));
    inflight.set(tile.key, pending);
  }
  return send(await pending, lat, lon, token);
}
