import { NextResponse } from 'next/server';
import { parseAerodromeReports } from '@/lib/aviation-report';
import { clientIp } from '@/lib/chat/identity';
import { overAfter, record } from '@/lib/server/throttle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TTL_MS = 60_000;
const UA = 'isobar-web/1 (place forecast)';
// Edge-cached for a minute so repeat lookups never reach aviationweather.gov.
const CACHE = { 'Cache-Control': 'public, max-age=60, s-maxage=60' };
const MEMORY_MAX = 2_000;
const memory = new Map<string, { at: number; body: ReturnType<typeof parseAerodromeReports> }>();

async function pull(kind: 'metar' | 'taf', icao: string): Promise<unknown> {
  const response = await fetch(`https://aviationweather.gov/api/data/${kind}?ids=${icao}&format=json`, {
    headers: { accept: 'application/json', 'user-agent': UA },
    cache: 'no-store',
  });
  if (!response.ok) return null;
  return response.json();
}

/** METAR and TAF for one ICAO. The upstream API is not readable from the browser. */
export async function GET(request: Request): Promise<Response> {
  const icao = new URL(request.url).searchParams.get('icao')?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{4}$/.test(icao)) return NextResponse.json({ error: 'icao' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  // Each miss costs two upstream requests: limit per address so a scripted sweep
  // of ICAO codes cannot get the site blocked upstream.
  const ip = clientIp(request);
  await record('aviationIp', ip);
  if (await overAfter('aviationIp', ip)) return NextResponse.json({ error: 'slow' }, { status: 429, headers: { 'Cache-Control': 'no-store' } });
  const hit = memory.get(icao);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.body ?? { icao, metar: null, taf: null }, { headers: CACHE });
  let metar: unknown = null;
  let taf: unknown = null;
  try {
    [metar, taf] = await Promise.all([pull('metar', icao), pull('taf', icao)]);
  } catch {
    metar = null;
    taf = null;
  }
  const body = parseAerodromeReports(icao, metar, taf);
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value!);
  memory.set(icao, { at: Date.now(), body });
  return NextResponse.json(body ?? { icao, name: icao, lat: null, lon: null, metar: null, taf: null }, { headers: CACHE });
}
