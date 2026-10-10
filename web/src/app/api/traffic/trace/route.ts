import { NextResponse } from 'next/server';
import { clientIp } from '@/lib/server/throttle';
import { allowTrafficRequest, deleteTrafficSession, sessionTrail, sessionToken } from '@/lib/server/traffic-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const hex = url.searchParams.get('hex')?.trim().toLowerCase() ?? '';
  if (!/^[a-f0-9]{6,14}$/.test(hex)) return NextResponse.json({ error: 'query' }, { status: 400, headers: NO_STORE });
  if (!(await allowTrafficRequest(clientIp(request), Date.now(), true))) return NextResponse.json({ error: 'slow' }, { status: 429, headers: NO_STORE });
  const token = sessionToken(request.headers.get('x-traffic-session'));
  const trail = sessionTrail(token, hex);
  return NextResponse.json({ points: trail?.points ?? [], source: 'session', sessionToken: token }, { headers: { ...NO_STORE, 'X-Traffic-Session': token } });
}

export async function DELETE(request: Request): Promise<Response> {
  deleteTrafficSession(request.headers.get('x-traffic-session') ?? '');
  return new Response(null, { status: 204, headers: NO_STORE });
}
