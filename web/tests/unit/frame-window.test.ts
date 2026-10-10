import { describe, expect, it, vi } from 'vitest';
import { chartFrame, FRAME_FAILED, FRAME_MISSING, FRAME_PENDING, FRAME_READY, openChart, type LoadedChart } from '../../src/lib/chart-store';
import { legendState } from '../../src/lib/legend';

const run = '2026-10-09T00:00:00Z';
const now = Date.parse(run) + 4 * 3600000;
const hours = Array.from({ length: 53 }, (_, i) => i * 3);
const cells = 6;
const json = () => ({ schema: 2, contract: 'isobar-web', run, generated: run, forecast_hours: hours,
  grid: { west: 100, east: 101, north: 0, south: -1, step: 0.5, nx: 3, ny: 2, dtype: 'uint16' },
  variables: Object.fromEntries(['mslp', 'rain24', 't2m', 'wind', 'u10', 'v10'].map((name) => [name, {
    frames: hours.map((hour) => `frames/${name}/f${String(hour).padStart(3, '0')}.u16`), units: 'x', scale: 0.1, offset: 0, fill: 65535,
  }])), places: [], aviation: 'aviation.json', attribution: [] });

function fixture() {
  const requests: string[] = [];
  let offline = false;
  const gates: (() => void)[] = [];
  let paused = false;
  const data = json();
  const fetchBytes = async (url: string) => {
    if (url.endsWith('manifest.json')) return new TextEncoder().encode(JSON.stringify(data));
    if (url.endsWith('.packed')) {
      requests.push(url);
      if (offline) return null;
      return new Uint8Array(Uint16Array.from({ length: cells * hours.length }, (_, i) => 10000 + hours[Math.floor(i / cells)]).buffer);
    }
    if (!url.includes('/frames/')) return null;
    requests.push(url);
    if (paused) await new Promise<void>((resolve) => gates.push(resolve));
    if (offline) return null;
    const hour = Number(/f(\d+)\./.exec(url)![1]);
    return new Uint8Array(new Uint16Array(cells).fill(10000 + hour).buffer);
  };
  return { data, fetchBytes, requests, offline: () => { offline = true; }, online: () => { offline = false; },
    pause: () => { paused = true; }, release: () => { paused = false; for (const done of gates.splice(0)) done(); } };
}
async function idle(chart: LoadedChart) {
  await vi.waitFor(() => { expect(chart.cacheStats!().active).toBe(0); expect(chart.cacheStats!().queued).toBe(0); });
}

describe('bounded interactive forecast', () => {
  it('prepares a neighbourhood, never the whole 53-frame variable', async () => {
    const f = fixture();
    const chart = (await openChart({ fields: 'opened', nowMs: now, fetchBytes: f.fetchBytes }))!;
    await chart.complete;
    expect(f.requests).toHaveLength(5);
    expect(chart.packed.mslp.byteLength).toBe(0);
    expect(chart.cacheStats!().bytes).toBe(5 * cells * 2);
    expect(chartFrame(chart, 'mslp', 1)[0]).toBe(10003);
    expect(chart.state.mslp[30]).toBe(FRAME_PENDING);
    await chart.want('rain24', 240);
    expect(f.requests.filter((url) => url.includes('/rain24/'))).toHaveLength(2);
  });

  it('drops obsolete queued work and promotes the newest time while in-flight requests finish', async () => {
    const f = fixture();
    const chart = (await openChart({ fields: 'opened', nowMs: now, fetchBytes: f.fetchBytes, concurrency: 1 }))!;
    await chart.complete;
    f.pause();
    chart.prepare!(240, ['rain24']);
    expect(f.requests.at(-1)).toContain('/rain24/f003');
    chart.prepare!(3600, ['t2m']);
    f.release();
    await idle(chart);
    expect(f.requests.filter((url) => url.includes('/rain24/'))).toHaveLength(1);
    const next = f.requests.findIndex((url) => url.includes('/rain24/f003')) + 1;
    expect(f.requests[next]).toContain('/mslp/f060');
    expect(chartFrame(chart, 't2m', 20)[0]).toBe(10060);
    expect(chart.state.t2m[20]).toBe(FRAME_READY);
  });

  it('evicts old frames within a byte budget and can reload them without treating them as missing', async () => {
    const f = fixture();
    const chart = (await openChart({ fields: 'opened', nowMs: now, fetchBytes: f.fetchBytes, cacheBytes: cells * 2 * 12 }))!;
    await chart.complete;
    for (const minute of [240, 3600, 7200, 240]) {
      chart.prepare!(minute, ['rain24', 'u10', 'v10']);
      await idle(chart);
      const stats = chart.cacheStats!();
      expect(stats.bytes).toBeLessThanOrEqual(stats.limit);
      expect(stats.limit).toBe(cells * 2 * 12);
      const index = Math.floor(minute / 180);
      for (const name of ['mslp', 'rain24', 'u10', 'v10']) expect(chartFrame(chart, name, index)[0]).toBe(10000 + hours[index]);
    }
    expect(chart.state.mslp[40]).toBe(FRAME_PENDING);
    expect(chartFrame(chart, 'mslp', 40)).toHaveLength(0);
  });

  it('reuses a prepared lens offline with no extra requests', async () => {
    const f = fixture();
    const chart = (await openChart({ fields: 'opened', nowMs: now, fetchBytes: f.fetchBytes }))!;
    chart.prepare!(240, ['rain24']); await idle(chart);
    chart.prepare!(240, ['t2m']); await idle(chart);
    const count = f.requests.length;
    f.offline();
    chart.prepare!(240, ['rain24']); await chart.want('rain24', 240); await idle(chart);
    expect(f.requests).toHaveLength(count);
    expect(legendState(chart.state.rain24, { i0: 1, i1: 2, t: 0.3 })).toBe('ready');
  });

  it('does not busy-retry a failure, but explicit retry recovers it', async () => {
    const f = fixture();
    const chart = (await openChart({ fields: 'opened', nowMs: now, fetchBytes: f.fetchBytes }))!;
    await chart.complete; f.offline();
    chart.prepare!(240, ['rain24']); await idle(chart);
    expect(chart.state.rain24[1]).toBe(FRAME_FAILED);
    expect(legendState(chart.state.rain24, { i0: 1, i1: 2, t: 0.3 })).toBe('error');
    const count = f.requests.length;
    for (let i = 0; i < 10; i++) chart.prepare!(240, ['rain24']);
    expect(f.requests).toHaveLength(count);
    f.online(); chart.retry!(240, ['rain24']); await idle(chart);
    expect(chart.state.rain24[1]).toBe(FRAME_READY);
    expect(chartFrame(chart, 'rain24', 1)[0]).toBe(10003);
    expect(chart.state.rain24[3]).toBe(FRAME_READY);
    expect(chart.state.rain24[4]).toBe(FRAME_READY);
  });

  it('downloads a legacy packed variable once for its requested window and preserves ready frames on failure', async () => {
    const f = fixture();
    const spec = f.data.variables.rain24 as unknown as Record<string, unknown>;
    delete spec.frames; spec.file = 'rain24.packed';
    const chart = (await openChart({ fields: 'opened', nowMs: now, fetchBytes: f.fetchBytes, concurrency: 1 }))!;
    await chart.complete;
    chart.prepare!(240, ['rain24']); await idle(chart);
    expect(f.requests.filter((url) => url.endsWith('.packed'))).toHaveLength(1);
    expect(chartFrame(chart, 'rain24', 1)[0]).toBe(10003);
    expect(chart.frames!.rain24.size).toBe(5);
    f.offline(); chart.prepare!(3600, ['rain24']); await idle(chart);
    expect(chart.state.rain24[20]).toBe(FRAME_FAILED);
    expect(chart.state.rain24[1]).toBe(FRAME_READY);
    expect(chartFrame(chart, 'rain24', 1)[0]).toBe(10003);
  });

  it('keeps a metadata hole missing when retrying', async () => {
    const f = fixture();
    f.data.variables.rain24.frames[1] = null as unknown as string;
    const chart = (await openChart({ fields: 'opened', nowMs: now, fetchBytes: f.fetchBytes }))!;
    await chart.want('rain24', 240);
    chart.retry!(240, ['rain24']); await idle(chart);
    expect(chart.state.rain24[1]).toBe(FRAME_MISSING);
    expect(f.requests.some((url) => url.includes('/rain24/f003'))).toBe(false);
  });
});
