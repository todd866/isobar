import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { trafficQuery } from '../../src/lib/traffic';
import { GET } from '../../src/app/api/traffic/route';
import { GET as trace, DELETE as clear } from '../../src/app/api/traffic/trace/route';
import { GET as lookup } from '../../src/app/api/traffic/route-lookup/route';
import { clearTrafficSessionCaches } from '../../src/lib/server/traffic-session';
afterEach(() => { vi.unstubAllGlobals(); clearTrafficSessionCaches(); });
it('validates bbox including the antimeridian and rejects absent/empty coordinates', () => {
  expect(trafficQuery(new URLSearchParams('radiusNm=80'))).toBeNull();
  expect(trafficQuery(new URLSearchParams('bbox=115,-33,117,-31'))?.lon).toBe(116);
  expect(trafficQuery(new URLSearchParams('bbox=179,-1,-179,1'))?.lon).toBe(-180);
  for (const bbox of ['a,0,2,1', '1,,2,3', '1,50,2,40', '1,-91,2,10']) expect(trafficQuery(new URLSearchParams({ bbox }))).toBeNull();
});
it('coalesces tile requests but keeps histories private and deletes closed sessions', async () => {
  const now = Date.now();
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ now, ac: [{ hex: 'abc123', flight: 'QFA642', lat: -32, lon: 116, alt_baro: 18000, seen_pos: 1 }] })));
  vi.stubGlobal('fetch', fetcher);
  const a = 'aaaaaaaaaaaaaaaaaaaaaaaa', b = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const request = (token: string) => new Request('http://test/api/traffic?lat=-32&lon=116&radiusNm=80', { headers: { 'X-Traffic-Session': token } });
  const [one, two] = await Promise.all([GET(request(a)), GET(request(b))]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(one.headers.get('cache-control')).toBe('no-store');
  expect(two.headers.get('x-traffic-session')).toBe(b);
  const read = (token: string) => new Request('http://test/api/traffic/trace?hex=abc123', { headers: { 'X-Traffic-Session': token } });
  expect((await (await trace(read(a))).json()).points).toHaveLength(1);
  expect((await (await trace(read('cccccccccccccccccccccccc'))).json()).points).toHaveLength(0);
  await clear(read(a));
  expect((await (await trace(read(a))).json()).points).toHaveLength(0);
  expect((await (await trace(read(b))).json()).points).toHaveLength(1);
});
it('disabled route lookup never contacts the provider and invalid inputs fail closed', async () => {
  vi.stubGlobal('fetch', vi.fn());
  const response = await lookup(new Request('http://test/api/traffic/route-lookup?callsign=QFA642'));
  expect(await response.json()).toMatchObject({ route: null });
  expect(fetch).not.toHaveBeenCalled();
  expect((await GET(new Request('http://test/api/traffic?radiusNm=80'))).status).toBe(400);
  expect((await trace(new Request('http://test/api/traffic/trace?hex=not-a-hex'))).status).toBe(400);
});
