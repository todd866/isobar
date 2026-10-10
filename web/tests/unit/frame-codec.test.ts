import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeFrameBytes, shuffleUint16, unshuffleUint16 } from '../../src/lib/frame-codec';
import { FRAME_READY, openChart } from '../../src/lib/chart-store';
import { readManifest } from '../../src/lib/manifest';

function sample(cells: number): Uint8Array {
  const values = new Uint16Array(cells);
  for (let i = 0; i < cells; i += 1) values[i] = i === 3 ? 65535 : 1500 + ((i * 37) % 900);
  return new Uint8Array(values.buffer);
}

describe('frame transfer encoding', () => {
  it('shuffle is lossless', () => {
    const raw = sample(301 * 201);
    expect(unshuffleUint16(shuffleUint16(raw))).toEqual(raw);
  });

  it('decodes gzip planes, planes a host already gunzipped, and raw frames', async () => {
    const raw = sample(64);
    const planes = shuffleUint16(raw);
    expect(await decodeFrameBytes(new Uint8Array(zlib.gzipSync(planes)), 'shuffle-gzip')).toEqual(raw);
    expect(await decodeFrameBytes(planes, 'shuffle-gzip')).toEqual(raw);
    expect(await decodeFrameBytes(raw, 'raw')).toBe(raw);
  });

  it('manifest reads the encoding, raw by default, and rejects unknown ones', () => {
    const base = {
      schema: 2, contract: 'isobar-web', run: '2026-10-06T12:00:00Z', generated: '2026-10-06T12:00:00Z', forecast_hours: [0, 3],
      grid: { west: 100, east: 101, north: 0, south: -1, step: 0.5, nx: 3, ny: 2, dtype: 'uint16' },
      places: [], aviation: 'aviation.json', attribution: [],
    };
    const variable = (encoding?: string) => ({ frames: ['a.u16z', 'b.u16z'], units: 'x', scale: 0.1, offset: 0, fill: 65535, ...(encoding ? { encoding } : {}) });
    const vars = (encoding?: string) => ({ mslp: variable(encoding), rain24: variable(encoding), t2m: variable(encoding), wind: variable(encoding) });
    expect(readManifest({ ...base, variables: vars('shuffle-gzip') }).variables.mslp.encoding).toBe('shuffle-gzip');
    expect(readManifest({ ...base, variables: vars() }).variables.mslp.encoding).toBe('raw');
    expect(() => readManifest({ ...base, variables: vars('zstd') })).toThrow(/encoding/);
  });

  it('the chart store loads shuffle-gzip frames to the same values', async () => {
    const cells = 6;
    const raw = sample(cells);
    const stored = new Uint8Array(zlib.gzipSync(shuffleUint16(raw)));
    const variable = { frames: ['frames/x/f000.u16z', 'frames/x/f003.u16z'], encoding: 'shuffle-gzip', units: 'x', scale: 0.1, offset: 0, fill: 65535 };
    const json = {
      schema: 2, contract: 'isobar-web', run: '2026-10-06T12:00:00Z', generated: '2026-10-06T12:00:00Z', forecast_hours: [0, 3],
      grid: { west: 100, east: 101, north: 0, south: -1, step: 0.5, nx: 3, ny: 2, dtype: 'uint16' },
      variables: { mslp: variable, rain24: variable, t2m: variable, wind: variable },
      places: [], aviation: 'aviation.json', attribution: [],
    };
    const chart = await openChart({
      nowMs: Date.parse('2026-10-06T13:00:00Z'),
      fetchBytes: async (url) => {
        if (url === '/data/manifest.json') return new TextEncoder().encode(JSON.stringify(json));
        if (url.includes('/frames/')) return stored;
        return null;
      },
    });
    expect(chart).not.toBeNull();
    await chart!.complete;
    expect(chart!.state.mslp[0]).toBe(FRAME_READY);
    expect(Array.from(chart!.packed.mslp.subarray(0, cells))).toEqual(Array.from(new Uint16Array(raw.buffer)));
  });
});
