import { NextResponse } from 'next/server';
import { clientIp } from '@/lib/server/throttle';
import { allowTrafficRequest, lookupFlightRoute, sessionToken } from '@/lib/server/traffic-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  const callsign = new URL(request.url).searchParams.get('callsign')?.trim().toUpperCase() ?? '';
  if (!/^[A-Z0-9][A-Z0-9 -]{1,11}$/.test(callsign)) return NextResponse.json({ error: 'query' }, { status: 400, headers: NO_STORE });
  if (!(await allowTrafficRequest(clientIp(request), Date.now(), true))) return NextResponse.json({ error: 'slow' }, { status: 429, headers: NO_STORE });
  const token = sessionToken(request.headers.get('x-traffic-session'));
  const route = await lookupFlightRoute(callsign);
  return NextResponse.json({ route, sessionToken: token }, { headers: { ...NO_STORE, 'X-Traffic-Session': token } });
}
