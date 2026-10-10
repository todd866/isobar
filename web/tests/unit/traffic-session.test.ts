import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { clearTrafficSessionCaches, lookupFlightRoute, recordTrafficSnapshot, sessionTrail } from '../../src/lib/server/traffic-session';

const row = { hex: 'abc123', callsign: 'QFA642', registration: '', type: 'A320', latitude: -32, longitude: 116, pressureAltitudeFt: 12000, distanceNm: 1, positionTimeMs: 1_799_999_999_000 };
afterEach(() => { clearTrafficSessionCaches(); delete process.env.ADSBDB_ROUTES_ENABLED; });

describe('traffic session', () => {
  it('keeps bounded session history and separates tokens', () => {
    recordTrafficSnapshot('token-a-abcdefghijklmnopqrstuvwxyz', [row], 1_800_000_000_000);
    expect(sessionTrail('token-a-abcdefghijklmnopqrstuvwxyz', 'abc123', 1_800_000_000_000)?.points).toHaveLength(1);
    expect(sessionTrail('token-b-abcdefghijklmnopqrstuvwxyz', 'abc123')).toBeNull();
  });

  it('keeps route lookup disabled by default', async () => {
    const fetcher = async () => { throw new Error('must not call'); };
    expect(await lookupFlightRoute('QFA642', fetcher as typeof fetch)).toBeNull();
  });

  it('caches positive and negative route responses when explicitly enabled', async () => {
    process.env.ADSBDB_ROUTES_ENABLED = '1'; let calls = 0;
    const fetcher = async () => { calls += 1; return new Response(JSON.stringify({ response: { flightroute: { origin: { icao: 'YPPH', latitude: -32, longitude: 116 }, destination: { icao: 'YPAD', latitude: -35, longitude: 139 } } } }), { status: 200 }); };
    expect((await lookupFlightRoute('QFA642', fetcher as typeof fetch))?.destination.icao).toBe('YPAD');
    await lookupFlightRoute('QFA642', fetcher as typeof fetch); expect(calls).toBe(1);
    const bad = async () => new Response('{}', { status: 200 });
    expect(await lookupFlightRoute('VOZ771', bad as typeof fetch)).toBeNull();
    expect(await lookupFlightRoute('VOZ771', bad as typeof fetch)).toBeNull();
  });
});

describe('expiry, concurrent calls, and byte limits', () => {
  it('expires idle sessions, evicts at the cap, and deletes on layer close', async () => {
    const { deleteTrafficSession } = await import('../../src/lib/server/traffic-session');
    const now = row.positionTimeMs + 1000;
    recordTrafficSnapshot('idle', [row], now);
    expect(sessionTrail('idle', row.hex, now + 31 * 60000)).toBeNull();
    for (let i = 0; i < 257; i++) recordTrafficSnapshot(`session-${i}`, [row], now);
    expect(sessionTrail('session-0', row.hex, now)).toBeNull();
    expect(sessionTrail('session-256', row.hex, now)?.points).toHaveLength(1);
    deleteTrafficSession('session-256');
    expect(sessionTrail('session-256', row.hex, now)).toBeNull();
  });
  it('coalesces in-flight routes and expires negative cache entries', async () => {
    process.env.ADSBDB_ROUTES_ENABLED = '1'; let clock = 1_800_000_000_000;
    const time = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    try {
      const first = lookupFlightRoute('QFA642', fetcher), second = lookupFlightRoute('qfa642', fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1);
      release(new Response('{}')); expect(await first).toBeNull(); expect(await second).toBeNull();
      await lookupFlightRoute('QFA642', fetcher); expect(fetcher).toHaveBeenCalledTimes(1);
      clock += 11 * 60000;
      const third = lookupFlightRoute('QFA642', fetcher); expect(fetcher).toHaveBeenCalledTimes(2);
      release(new Response('{}')); await third;
    } finally { time.mockRestore(); }
  });
  it('bounds chunked route responses before consuming the whole body', async () => {
    process.env.ADSBDB_ROUTES_ENABLED = '1'; let cancelled = false;
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(270000)); }, cancel() { cancelled = true; },
    })));
    expect(await lookupFlightRoute('QFA642', fetcher)).toBeNull(); expect(cancelled).toBe(true);
  });
  it('separates detail and bbox IP buckets so taps do not stop normal polling', async () => {
    const { allowTrafficRequest } = await import('../../src/lib/server/traffic-session');
    for (let i = 0; i < 40; i++) expect(await allowTrafficRequest('fixture', 100000, true)).toBe(true);
    expect(await allowTrafficRequest('fixture', 100000, true)).toBe(false);
    expect(await allowTrafficRequest('fixture', 100000)).toBe(true);
    expect(await allowTrafficRequest('fixture', 161000, true)).toBe(true);
  });
});
