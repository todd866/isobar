import { describe, expect, it } from 'vitest';
import {
  chartFrame,
  FRAME_MISSING,
  FRAME_PENDING,
  FRAME_READY,
  firstPaintFrames,
  loadOrder,
  openChart,
} from '../../src/lib/chart-store';
import { legendState } from '../../src/lib/legend';
import { readManifest } from '../../src/lib/manifest';

const HOURS = [0, 3, 6, 9, 12];
const RUN = '2026-10-06T12:00:00Z';
const RUN_MS = Date.parse(RUN);
const CELLS = 3 * 2;

function frames(name: string, missing: number[] = []) {
  return HOURS.map((hour, index) => (missing.includes(index) ? null : `frames/${name}/f${String(hour).padStart(3, '0')}.u16`));
}

function manifestJson(rainMissing: number[] = []) {
  const variable = (name: string, extra: Record<string, unknown> = {}) => ({
    frames: frames(name, name === 'rain24' ? rainMissing : []), units: 'x', scale: 0.1, offset: 0, fill: 65535, ...extra,
  });
  return {
    schema: 2,
    contract: 'isobar-web',
    run: RUN,
    generated: RUN,
    forecast_hours: HOURS,
    grid: { west: 100, east: 101, north: 0, south: -1, step: 0.5, nx: 3, ny: 2, dtype: 'uint16' },
    variables: { mslp: variable('mslp'), rain24: variable('rain24'), t2m: variable('t2m'), wind: variable('wind') },
    places: [],
    aviation: 'aviation.json',
    attribution: [],
  };
}

function frameBytes(value: number): Uint8Array {
  return new Uint8Array(new Uint16Array(CELLS).fill(value).buffer);
}

/** A fetcher whose frame requests stay unanswered until released. */
function gatedFetcher(json: unknown) {
  const requested: string[] = [];
  const gates: (() => void)[] = [];
  let open = false;
  const fetchBytes = async (url: string): Promise<Uint8Array | null> => {
    requested.push(url);
    if (url === '/data/manifest.json') return new TextEncoder().encode(JSON.stringify(json));
    if (url.startsWith('/coast/')) return null;
    if (url.endsWith('aviation.json')) return new TextEncoder().encode('{"airports":[],"sigmets":[]}');
    const isFirst = requested.filter((item) => item.includes('/frames/')).length <= 2 && url.includes('/mslp/');
    if (!isFirst && !open) await new Promise<void>((resolve) => gates.push(resolve));
    return frameBytes(10100);
  };
  return {
    fetchBytes,
    requested,
    release() {
      open = true;
      for (const gate of gates.splice(0)) gate();
    },
  };
}

describe('first-frame loading', () => {
  const manifest = readManifest(manifestJson());
  const at = RUN_MS + 4 * 3_600_000; // +4 h: between frames 1 and 2

  it('picks the two frames that bracket the wall clock', () => {
    expect(firstPaintFrames(manifest, at)).toEqual([1, 2]);
    expect(firstPaintFrames(manifest, RUN_MS - 3_600_000)).toEqual([0]);
    expect(firstPaintFrames(manifest, RUN_MS + 99 * 3_600_000)).toEqual([4]);
  });

  it('orders MSLP at now first, then the open field, then outward', () => {
    const order = loadOrder(manifest, at, 'rain');
    expect(order.slice(0, 4)).toEqual([['mslp', 1], ['rain24', 1], ['mslp', 2], ['rain24', 2]]);
    expect(order.slice(4, 7)).toEqual([['mslp', 3], ['mslp', 0], ['mslp', 4]]);
    expect(order).toHaveLength(HOURS.length * 4);
    expect(new Set(order.map(([name, index]) => `${name}:${index}`)).size).toBe(HOURS.length * 4);
  });

  it('resolves for the first paint with only the manifest and the MSLP frames at now', async () => {
    const fetcher = gatedFetcher(manifestJson());
    const chart = await openChart({ nowMs: at, field: 'rain', fetchBytes: fetcher.fetchBytes });
    expect(chart).not.toBeNull();
    if (!chart) return;
    expect(chart.state.mslp[1]).toBe(FRAME_READY);
    expect(chart.state.mslp[2]).toBe(FRAME_READY);
    expect(chart.state.mslp[0]).toBe(FRAME_PENDING);
    expect(chart.state.rain24[1]).toBe(FRAME_PENDING);
    const framesBefore = fetcher.requested.filter((url) => url.includes('/frames/'));
    expect(framesBefore.slice(0, 2)).toEqual([
      `/data/frames/mslp/f003.u16?run=${encodeURIComponent(RUN)}`,
      `/data/frames/mslp/f006.u16?run=${encodeURIComponent(RUN)}`,
    ]);
    expect(chart.packed.mslp[1 * CELLS]).toBe(10100);
    fetcher.release();
    await chart.complete;
    for (const name of ['mslp', 'rain24', 't2m', 'wind']) {
      expect(Array.from(chart.state[name])).toEqual(HOURS.map(() => FRAME_READY));
    }
    expect(chart.aviation).toEqual({ airports: [], sigmets: [] });
  });

  it('marks an unlisted frame missing without fetching it', async () => {
    const fetcher = gatedFetcher(manifestJson([0, 1]));
    fetcher.release();
    const chart = await openChart({ nowMs: at, fetchBytes: fetcher.fetchBytes });
    await chart?.complete;
    expect(chart?.state.rain24[0]).toBe(FRAME_MISSING);
    expect(chart?.state.rain24[2]).toBe(FRAME_READY);
    expect(fetcher.requested.some((url) => url.includes('/rain24/f000'))).toBe(false);
  });
});

describe('fields on demand', () => {
  const at = RUN_MS + 4 * 3_600_000;

  function withWind() {
    const json = manifestJson();
    return { ...json, variables: { ...json.variables,
      u10: { ...json.variables.wind, frames: frames('u10'), units: 'm/s', offset: -150 },
      v10: { ...json.variables.wind, frames: frames('v10'), units: 'm/s', offset: -150 },
    } };
  }

  it('interleaves background wind after pressure at each nearest-now index', () => {
    const order = loadOrder(readManifest(withWind()), at).filter(([name]) => ['mslp', 'u10', 'v10'].includes(name));
    expect(order).toEqual([1, 2, 3, 0, 4].flatMap((index) => [['mslp', index], ['u10', index], ['v10', index]]));
  });

  it('explicit vector readers load only their blend while pressure prepares nearby times', async () => {
    const fetcher = gatedFetcher(withWind());
    const chart = (await openChart({ nowMs: at, fields: 'opened', concurrency: 1, fetchBytes: fetcher.fetchBytes }))!;
    const wind = [chart.want('u10'), chart.want('v10')];
    fetcher.release();
    await Promise.all([...wind, chart.complete]);
    const requests = fetcher.requested.filter((url) => url.includes('/frames/')).map((url) => url.split('?')[0].replace('/data/frames/', ''));
    expect(requests).toHaveLength(HOURS.length + 4);
    expect(new Set(requests).size).toBe(requests.length);
    for (const name of ['u10', 'v10']) {
      const requested = requests.filter((url) => url.startsWith(`${name}/`));
      expect(requested).toEqual([`${name}/f003.u16`, `${name}/f006.u16`]);
    }
  });

  it('an explicit lens promotes only its current blend, including wind already queued at mount', async () => {
    const fetcher = gatedFetcher(withWind());
    const chart = (await openChart({ nowMs: at, fields: 'opened', concurrency: 1, fetchBytes: fetcher.fetchBytes }))!;
    const mount = chart.want('u10');
    const lens = chart.want('u10', 12 * 60, 'lens');
    fetcher.release();
    await Promise.all([mount, lens, chart.complete]);
    const requests = fetcher.requested.filter((url) => url.includes('/frames/'));
    // Two first-paint pressure frames, one already in flight, then the lens.
    expect(requests[3]).toContain('/u10/f012');
    expect(requests.some((url) => url.includes('/u10/f000'))).toBe(false);
  });

  it('parallel background wind waits for its pressure frame to settle', async () => {
    const requests: string[] = [];
    const gates: (() => void)[] = [];
    const fetchBytes = async (url: string) => {
      if (url.endsWith('manifest.json')) return new TextEncoder().encode(JSON.stringify(withWind()));
      if (!url.includes('/frames/')) return null;
      requests.push(url);
      if (url.includes('/mslp/') && !/f00[36]/.test(url)) await new Promise<void>((resolve) => gates.push(resolve));
      return frameBytes(10100);
    };
    const chart = (await openChart({ nowMs: at, fields: 'opened', concurrency: 4, fetchBytes }))!;
    try {
      await Promise.all([chart.want('u10'), chart.want('v10')]);
      const wind = requests.filter((url) => /\/(u10|v10)\//.test(url));
      expect(wind).toHaveLength(4);
      expect(wind.every((url) => /f00[36]/.test(url))).toBe(true);
      expect(chart.state.mslp[3]).toBe(FRAME_PENDING);
      expect(chart.state.u10[3]).toBe(FRAME_PENDING);
    } finally {
      for (const release of gates) release();
      await chart.complete;
    }
    expect(chart.state.u10[3]).toBe(FRAME_PENDING);
    expect(chart.state.v10[3]).toBe(FRAME_PENDING);
  });

  it("'opened' streams only MSLP and the opened field until a lens wants another", async () => {
    const fetcher = gatedFetcher(manifestJson());
    fetcher.release();
    const chart = await openChart({ nowMs: at, field: 'rain', fields: 'opened', fetchBytes: fetcher.fetchBytes });
    await chart?.complete;
    if (!chart) return;
    expect(Array.from(chart.state.rain24)).toEqual(HOURS.map(() => FRAME_READY));
    expect(Array.from(chart.state.t2m)).toEqual(HOURS.map(() => FRAME_PENDING));
    expect(fetcher.requested.some((url) => url.includes('/t2m/'))).toBe(false);
    expect(chart.packed.t2m.byteLength).toBe(0);
    expect(chart.packed.wind.byteLength).toBe(0);
    await chart.want('t2m', 4 * 60);
    expect(chart.state.t2m[1]).toBe(FRAME_READY);
    expect(chart.state.t2m[2]).toBe(FRAME_READY);
    expect(chart.packed.t2m.length).toBe(0);
    expect(chartFrame(chart, 't2m', 1).length).toBe(CELLS);
    expect(chart.frames?.t2m.size).toBe(2);
    const t2m = fetcher.requested.filter((url) => url.includes('/t2m/'));
    expect(t2m[0]).toContain('f003');
  });

  it('keeps one bounded request pool when several lenses are opened together', async () => {
    let active = 0, peak = 0;
    const fetchBytes = async (url: string): Promise<Uint8Array | null> => {
      if (url.endsWith('manifest.json')) return new TextEncoder().encode(JSON.stringify(manifestJson()));
      if (!url.includes('/frames/')) return null;
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return frameBytes(10100);
    };
    const chart = await openChart({ nowMs: at, fields: 'opened', concurrency: 2, fetchBytes });
    expect(chart).not.toBeNull();
    await Promise.all(['rain24', 't2m', 'wind'].map((name) => chart!.want(name, 4 * 60)));
    await chart!.complete;
    expect(peak).toBe(2);
    for (const name of ['rain24', 't2m', 'wind']) expect(chart!.state[name][1]).toBe(FRAME_READY);
  });
});

describe('rain legend', () => {
  const blend = { i0: 1, i1: 2, t: 0.5 };

  it('shows the legend when both frames are in', () => {
    expect(legendState(Uint8Array.from([2, 1, 1]), blend)).toBe('ready');
  });

  it('is loading, not unavailable, while a frame streams in', () => {
    expect(legendState(Uint8Array.from([1, 1, 0]), blend)).toBe('loading');
  });

  it('is unavailable only when a frame is really missing', () => {
    expect(legendState(Uint8Array.from([1, 2, 1]), blend)).toBe('missing');
    expect(legendState(Uint8Array.from([1, 1, 1]), null)).toBe('missing');
  });

  it('is ready at now for the exported early hours', async () => {
    // The exporter fills 0-21 h from the previous run, so frame 0 is listed.
    const fetcher = gatedFetcher(manifestJson());
    fetcher.release();
    const chart = await openChart({ nowMs: RUN_MS + 3_600_000, field: 'rain', fetchBytes: fetcher.fetchBytes });
    await chart?.complete;
    expect(legendState(chart?.state.rain24, { i0: 0, i1: 1, t: 0.3 })).toBe('ready');
  });
});
