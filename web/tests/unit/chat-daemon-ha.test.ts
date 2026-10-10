import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chooseRuntimes, MAX_CAPACITY_AGE_SECONDS } from '../../../tools/chat-daemon/capacity';
import { BUSY_STALE_MS, md3Busy } from '../../../tools/chat-daemon/yield';
import { daemonSettings, readEnvFile, startHeartbeat } from '../../../tools/chat-daemon/daemon';
import { subscriptionRunner } from '../../../tools/chat-daemon/runtime';
import { processOne } from '../../../tools/chat-daemon/loop';
import { apiClient } from '../../../tools/chat-daemon/api';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const root = path.resolve(import.meta.dirname, '../../../build/slow-lane-qa');
const dirs: string[] = [];
async function scratch() { await mkdir(root, { recursive: true }); const dir = await mkdtemp(path.join(root, 'ha-')); dirs.push(dir); return dir; }
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
function feed() {
  const pool = (pool: string, remainingPct: number) => ({ pool, remainingPct, ageSeconds: 1, freshness: 'fresh', asOf: new Date(NOW - 1000).toISOString(), resetAt: new Date(NOW + 60_000).toISOString() });
  return { services: { claude: { pools: [pool('5h', 80), pool('7d', 60)] }, codex: { pools: [pool('codex:primary', 60)] }, cursor: { pools: [pool('api', 0), pool('cursor', 30)] } } };
}
const all = ['codex', 'cursor'] as const;
const input = { question: 'A front?', context: {}, thread: [], user: { level: null, goal: null } };
const answer = { text: 'A front.', model: 'codex-chatgpt', toolsUsed: [] };

describe('capacity and md3 priority', () => {
  it('uses Claude, Codex, Cursor in order, keeping pools separate', () => {
    expect(chooseRuntimes(feed(), all, NOW).runtimes).toEqual(['claude', 'codex', 'cursor']);
    const value = feed(); value.services.cursor.pools[1].remainingPct = 0; value.services.cursor.pools[0].remainingPct = 100;
    expect(chooseRuntimes(value, all, NOW).runtimes).toEqual(['claude', 'codex']);
    expect(chooseRuntimes(feed(), [], NOW).runtimes).toEqual(['claude']);
  });
  it('yields all work while either Claude window is low', () => {
    for (const index of [0, 1]) { const value = feed(); value.services.claude.pools[index].remainingPct = 1; expect(chooseRuntimes(value, all, NOW).ok).toBe(false); }
  });
  it('unknown, stale, malformed, reset-elapsed capacity never authorizes a pool', () => {
    expect(chooseRuntimes(null, all, NOW).ok).toBe(false);
    const value = feed(); value.services.claude.pools.forEach((pool) => { pool.freshness = 'stale'; });
    expect(chooseRuntimes(value, all, NOW).runtimes).toEqual(['codex', 'cursor']);
    for (const pool of Object.values(value.services).flatMap((service) => service.pools)) { pool.ageSeconds = MAX_CAPACITY_AGE_SECONDS + 1; }
    expect(chooseRuntimes(value, all, NOW).ok).toBe(false);
    const reset = feed(); reset.services.codex.pools[0].resetAt = new Date(NOW).toISOString();
    expect(chooseRuntimes(reset, all, NOW).runtimes).not.toContain('codex');
  });
  it('covers absent, idle, busy and stale busy lock files', async () => {
    const file = path.join(await scratch(), 'busy.json');
    expect(await md3Busy(file, NOW)).toBe(false);
    await writeFile(file, JSON.stringify({ inFlight: 0, since: new Date(NOW).toISOString(), host: 'air' }));
    await utimes(file, new Date(NOW), new Date(NOW)); expect(await md3Busy(file, NOW)).toBe(false);
    await writeFile(file, JSON.stringify({ inFlight: 1, since: new Date(NOW - BUSY_STALE_MS * 2).toISOString(), host: 'air' }));
    await utimes(file, new Date(NOW), new Date(NOW)); expect(await md3Busy(file, NOW)).toBe(true); // mtime, not since
    expect(await md3Busy(file, NOW + BUSY_STALE_MS + 1)).toBe(false);
    await writeFile(file, '{bad'); expect(await md3Busy(file)).toBe(true);
  });
});

describe('subscription fallback and leases', () => {
  it('falls through failed CLIs without an API runner and stops after success', async () => {
    const claude = vi.fn(async () => { throw new Error('quota'); }), codex = vi.fn(async () => answer), cursor = vi.fn(async () => answer);
    const capacity = vi.fn(async () => ({ ok: true, runtimes: ['claude', 'codex', 'cursor'] as const as any }));
    const run = subscriptionRunner({ claude, codex, cursor }, capacity, async () => false);
    expect(await run(input, new AbortController().signal)).toEqual(answer);
    expect(claude).toHaveBeenCalledOnce(); expect(codex).toHaveBeenCalledOnce(); expect(cursor).not.toHaveBeenCalled();
    expect(capacity).toHaveBeenCalledTimes(2);
  });
  it('rechecks priority before fallback and keeps unavailable work pending', async () => {
    let busy = false;
    const codex = vi.fn(async () => answer);
    const run = subscriptionRunner({ claude: async () => { busy = true; throw new Error('down'); }, codex }, async () => ({ ok: true, runtimes: ['claude', 'codex'] }), async () => busy);
    const api = { pending: vi.fn(async () => ({ id: 'job', ...input, leaseId: 'lease', leaseUntil: new Date(Date.now() + 900_000).toISOString() })), reply: vi.fn(), release: vi.fn(), heartbeat: vi.fn(), health: vi.fn() };
    expect(await processOne(api, run, async () => ({ ok: true }))).toBe('released');
    expect(codex).not.toHaveBeenCalled(); expect(api.reply).not.toHaveBeenCalled(); expect(api.release).toHaveBeenCalledWith('job', 'lease');
  });
  it('yields an active job when md3 becomes busy, waiting for runner cleanup', async () => {
    let busy = false, closed = false;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const codex = vi.fn(async () => answer);
    const run = subscriptionRunner({ claude: async (_input, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { closed = true; reject(new Error('stopped')); }, { once: true });
      started();
    }), codex }, async () => ({ ok: true, runtimes: ['claude', 'codex'] }), async () => busy, () => {}, 10);
    const running = run(input, new AbortController().signal);
    const checked = expect(running).rejects.toThrow();
    await didStart; busy = true; await checked;
    expect(codex).not.toHaveBeenCalled();
    expect(closed).toBe(true);
  });
  it('does not try another runtime after a held answer', async () => {
    const codex = vi.fn(async () => answer);
    const run = subscriptionRunner({ claude: async () => ({ ...answer, text: 'Read /Users/' + 'example/file' }), codex },
      async () => ({ ok: true, runtimes: ['claude', 'codex'] }), async () => false);
    await expect(run(input, new AbortController().signal)).rejects.toThrow('held');
    expect(codex).not.toHaveBeenCalled();
  });
  it('aborts without falling through to another runtime', async () => {
    const abort = new AbortController(), codex = vi.fn(async () => answer);
    const run = subscriptionRunner({ claude: async () => { abort.abort(); throw new Error('abort'); }, codex }, async () => ({ ok: true, runtimes: ['claude', 'codex'] }), async () => false);
    await expect(run(input, abort.signal)).rejects.toThrow(); expect(codex).not.toHaveBeenCalled();
  });
});

describe('configuration, transport, heartbeats', () => {
  it('reads literal role and yield settings without executing shell syntax', async () => {
    const file = path.join(await scratch(), 'daemon.env');
    await writeFile(file, `ISOBAR_AGENT_TOKEN=isb_agent_${'a'.repeat(43)}\nISOBAR_URL=https://isobar.test\nISOBAR_DAEMON_ROLE=standby\nISOBAR_DAEMON_HOST=laptop\nISOBAR_STANDBY_MS=120000\nISOBAR_YIELD_LOCK=~/busy.json\n`, { mode: 0o600 });
    expect(daemonSettings(await readEnvFile(file), '/home/test')).toEqual({ role: 'standby', host: 'laptop', standbyMs: 120000, yieldLock: '/home/test/busy.json', ownerNotify:'text-ian' });
    expect(() => daemonSettings({ ISOBAR_DAEMON_ROLE: 'anything' })).toThrow();
    expect(() => daemonSettings({ ISOBAR_STANDBY_MS: '0' })).toThrow();
    expect(daemonSettings({ISOBAR_OWNER_NOTIFY:'email'}).ownerNotify).toBe('email');
    expect(()=>daemonSettings({ISOBAR_OWNER_NOTIFY:'shell'})).toThrow();
  });
  it('sends exact host fencing on every write and supports health without claiming', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(null));
    const settings = daemonSettings({ ISOBAR_DAEMON_HOST: 'laptop', ISOBAR_DAEMON_ROLE: 'standby' });
    const api = apiClient('https://isobar.test', 'secret', fetcher, 100, settings);
    await api.pending(); await api.reply({ id: 'm', leaseId: 'lease', ...answer }); await api.release('m', 'lease'); await api.heartbeat('codex', 'version-1'); await api.health();
    const sent = fetcher.mock.calls.map(([url, opts]) => ({ url, body: JSON.parse(String(opts?.body)) }));
    expect(sent[0]).toEqual({ url: 'https://isobar.test/api/agent/claim', body: { host: 'laptop', role: 'standby', standbyMs: 90000 } });
    expect(sent[1].body.host).toBe('laptop'); expect(sent[2].body.host).toBe('laptop');
    expect(sent[3].body).toEqual({ host: 'laptop', role: 'standby', runtime: 'codex', version: 'version-1' });
    expect(sent[4].url).toContain('/health');
  });
  it('keeps heartbeat active during work and writes a private timestamped cache', async () => {
    const state = await scratch(); let runtime = 'claude';
    const api = { heartbeat: vi.fn(async () => {}), health: vi.fn(async () => ({ pending: 2, claimed: 1 })), pending: vi.fn(), reply: vi.fn(), release: vi.fn() };
    const stop = startHeartbeat(api, state, () => runtime, 'test', () => {}, 20);
    try {
      await vi.waitFor(() => expect(api.heartbeat).toHaveBeenCalledWith('claude', 'test'));
      runtime = 'codex'; await vi.waitFor(() => expect(api.heartbeat).toHaveBeenCalledWith('codex', 'test'));
      await vi.waitFor(async () => expect(JSON.parse(await readFile(path.join(state, 'health.json'), 'utf8')).server).toEqual({ pending: 2, claimed: 1 }));
    } finally { await stop(); }
  });
});
