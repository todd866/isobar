import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { chartFromDir } from '../../src/lib/chat/data';
import { shuffleUint16 } from '../../src/lib/frame-codec';
import { readManifest } from '../../src/lib/manifest';

// The published frames are shuffle-gzip; reading them as raw gave the chat a
// 41,688-value "frame" for a 259,920-cell grid and every sample came back missing.
describe('chat frames', () => {
  it('decodes shuffle-gzip frames the way the browser does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-frames-'));
    mkdirSync(join(dir, 'frames'));
    const raw = new Uint8Array(new Uint16Array([100, 200, 300, 400]).buffer);
    writeFileSync(join(dir, 'frames', 'm0.u16z'), gzipSync(shuffleUint16(raw)));
    const manifest = {
      schema: 2, contract: 'isobar-web', run: '2026-10-08T00:00:00Z', generated: '2026-10-08T04:00:00Z', forecast_hours: [0], uniform_step_hours: null,
      grid: { west: 0, east: 1, north: 1, south: 0, step: 1, nx: 2, ny: 2, wraps_longitude: false, dtype: 'uint16', endian: 'little', fill: 65535 },
      variables: Object.fromEntries(['mslp', 'rain24', 't2m', 'wind'].map((name) => [name, { frames: ['frames/m0.u16z'], encoding: 'shuffle-gzip', units: 'x', scale: 1, offset: 0, fill: 65535 }])),
      aviation: 'aviation.json', points: 'points.json',
      places: [{ id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.86, icao: 'YPPH' }],
      attribution: [{ source: 'ECMWF Open Data', licence: 'CC BY 4.0' }],
    };
    expect(() => readManifest(manifest)).not.toThrow();
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const { chart } = chartFromDir(dir, join(dir, 'none.json'), join(dir, 'none.json'));
    const frame = chart.frame('mslp', 0);
    expect(frame?.length).toBe(4);
    expect(Array.from(frame ?? [])).toEqual([100, 200, 300, 400]);
  });
});
