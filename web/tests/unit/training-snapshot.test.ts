import { describe, expect, it } from 'vitest';
import { loadTrainingSnapshot, trainingSnapshotFromInputs } from '../../src/lib/training-snapshot';
import { readManifest } from '../../src/lib/manifest';

const RUN = '2026-10-06T12:00:00Z';
const manifest = readManifest({
  schema: 2, contract: 'isobar-web', run: RUN, generated: RUN,
  forecast_hours: [0, 3],
  grid: { west: 100, east: 101, north: 0, south: -1, step: 0.5, nx: 3, ny: 3, dtype: 'uint16' },
  variables: {
    mslp: { frames: ['frames/mslp/f000.u16', 'frames/mslp/f003.u16'], units: 'hPa', scale: 0.1, offset: 850, fill: 65535 },
    rain24: { frames: ['frames/rain24/f000.u16', 'frames/rain24/f003.u16'], units: 'mm', scale: 0.1, offset: 0, fill: 65535 },
    t2m: { frames: ['frames/t2m/f000.u16', 'frames/t2m/f003.u16'], units: 'C', scale: 0.1, offset: -40, fill: 65535 },
    wind: { frames: ['frames/wind/f000.u16', 'frames/wind/f003.u16'], units: 'kt', scale: 0.1, offset: 0, fill: 65535 },
  },
  places: [{ id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -1, lon: 101, icao: 'YPPH' }],
  aviation: 'aviation.json', points: 'points.json', attribution: [],
});

const points = {
  run: RUN, hours: [0, 3], places: {
    perth: { t: [20, 22], wspd: [10, 12], wdir: [180, 200], tp: [0, 1], cc: [10, 20] },
  },
};

const aviation = {
  airports: [{ icao: 'YPPH', name: 'Perth', zone: 'Australia/Perth', lat: -1, lon: 101,
    metar: { raw: 'METAR YPPH 070300Z 22013KT 9999 FEW026 22/13 Q1016', time: '2026-10-07T03:00:00.000Z' },
    taf: { raw: 'TAF YPPH 070205Z 0703/0806 23014KT CAVOK FM071000 27012KT', issue: '2026-10-07T02:05:00.000Z', from: '2026-10-07T03:00:00.000Z', to: '2026-10-08T06:00:00.000Z' } }],
  sigmets: [],
};

function bytes(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }

describe('training snapshot adapter', () => {
  it('maps aviation, points and one decoded MSLP frame without inventing gradients', () => {
    const frame = new Uint16Array(9).fill(1660);
    const snapshot = trainingSnapshotFromInputs({ manifest, points, aviation, mslp: frame }, Date.parse(RUN) + 90 * 60 * 1000);
    expect(snapshot.airports[0]?.metar?.wind).toBe('220/13');
    expect(snapshot.airports[0]?.metar?.vis).toBe('10+ km');
    expect(snapshot.airports[0]?.taf?.lines.map((line) => line.text)).toEqual([
      'TAF YPPH 070205Z 0703/0806 23014KT CAVOK', 'FM071000 27012KT',
    ]);
    expect(snapshot.airports[0]?.sample).toMatchObject({ mslpHpa: 1016, windKt: 10, t2mC: 20 });
    expect(snapshot.gradient).toBeNull();
    expect(snapshot.points[0]?.mslpHpa).toBe(1016);
  });

  it('requests manifest, point data, aviation and one MSLP frame only', async () => {
    const requested: string[] = [];
    const fetcher = async (url: string) => {
      requested.push(url);
      if (url === '/data/manifest.json') return bytes({
        schema: 2, contract: 'isobar-web', run: RUN, generated: RUN, forecast_hours: [0, 3],
        grid: { west: 100, east: 101, north: 0, south: -1, step: 0.5, nx: 3, ny: 3, dtype: 'uint16' },
        variables: manifest.variables, places: manifest.places, aviation: 'aviation.json', points: 'points.json', attribution: [],
      });
      if (url === '/data/points.json') return bytes(points);
      if (url === '/data/aviation.json') return bytes(aviation);
      if (url.startsWith('/data/frames/mslp/')) return new Uint8Array(new Uint16Array(9).fill(1660).buffer);
      return null;
    };
    const snapshot = await loadTrainingSnapshot({ nowMs: Date.parse('2026-10-07T03:30:00Z'), fetchBytes: fetcher });
    expect(snapshot).not.toBeNull();
    expect(requested).toEqual([
      '/data/manifest.json', `/data/frames/mslp/f000.u16?run=${encodeURIComponent(RUN)}`,
      '/data/points.json', '/data/aviation.json',
    ]);
  });

  it('keeps an aviation and points snapshot when the optional frame is unavailable', async () => {
    const snapshot = await loadTrainingSnapshot({
      nowMs: Date.parse('2026-10-07T03:30:00Z'),
      fetchBytes: async (url) => url === '/data/manifest.json' ? bytes({
        schema: 2, contract: 'isobar-web', run: RUN, generated: RUN, forecast_hours: [0, 3],
        grid: { west: 100, east: 101, north: 0, south: -1, step: 0.5, nx: 3, ny: 3, dtype: 'uint16' },
        variables: manifest.variables, places: manifest.places, aviation: 'aviation.json', points: 'points.json', attribution: [],
      }) : url === '/data/points.json' ? bytes(points) : url === '/data/aviation.json' ? bytes(aviation) : null,
    });
    expect(snapshot?.airports).toHaveLength(1);
    expect(snapshot?.airports[0]?.sample?.mslpHpa).toBeNull();
    expect(snapshot?.gridSource).toBeNull();
  });
});

const manifestJson = {
  schema: 2, contract: 'isobar-web', run: RUN, generated: RUN, forecast_hours: [0, 3],
  grid: { west: 100, east: 101, north: 0, south: -1, step: 0.5, nx: 3, ny: 3, dtype: 'uint16' },
  variables: manifest.variables, places: manifest.places, aviation: 'aviation.json', points: 'points.json', attribution: [],
};

it.each([null, bytes({ broken: true })])('uses aviation when the manifest is missing or malformed', async (manifestBytes) => {
  const result = await loadTrainingSnapshot({ fetchBytes: async (url) => url.endsWith('manifest.json') ? manifestBytes : bytes(aviation) });
  expect(result.airports[0].metar?.raw).toContain('YPPH');
  expect(result.airports[0].sample).toBeNull();
  expect(result.gridSource).toBeNull();
});

it('keeps airports distinct from city points and rejects another station’s reports', () => {
  const distant = { ...aviation.airports[0], name: 'Perth Airport', lat: -0.5, lon: 100.5 };
  const wrong = { ...distant, icao: 'YSSY' };
  const result = trainingSnapshotFromInputs({ manifest, points, aviation: { airports: [distant, wrong] }, mslp: new Uint16Array(9).fill(1660) });
  expect(result.airports).toHaveLength(2);
  expect(result.airports[0].metar).not.toBeNull();
  expect(result.airports[0].sample).toMatchObject({ mslpHpa: 1016, windKt: null, t2mC: null });
  expect(result.airports[1].metar).toBeNull();
  expect(result.airports[1].taf).toBeNull();
});

it('does not clamp out-of-grid samples or turn fill values into readings', () => {
  const result = trainingSnapshotFromInputs({ manifest, points: null,
    aviation: { airports: [{ ...aviation.airports[0], lon: 102 }, aviation.airports[0]] },
    mslp: new Uint16Array(9).fill(65535),
  });
  expect(result.airports.every((airport) => airport.sample?.mslpHpa === null)).toBe(true);
  expect(result.points[0].t2mC).toBeNull();
});

it('uses custom filenames, never requests legacy full grids and ignores mismatched point runs', async () => {
  const requested: string[] = [];
  const result = await loadTrainingSnapshot({ fetchBytes: async (url) => {
    requested.push(url);
    if (url.endsWith('manifest.json')) return bytes({ ...manifestJson, points: 'custom-points.json', aviation: 'custom-aviation.json',
      variables: { ...manifest.variables, mslp: { ...manifest.variables.mslp, frames: null, file: 'full-mslp.u16' } },
    });
    if (url.endsWith('custom-points.json')) return bytes({ ...points, run: '2026-10-05T12:00:00Z' });
    if (url.endsWith('custom-aviation.json')) return bytes(aviation);
    throw new Error('unexpected fetch');
  } });
  expect(requested).toEqual(['/data/manifest.json', '/data/custom-points.json', '/data/custom-aviation.json']);
  expect(result.airports[0].sample?.t2mC).toBeNull();
});

it.each([new Uint8Array(2), new Uint8Array(new Uint16Array(9).fill(65535).buffer)])('rejects incomplete or empty frames without losing aviation', async (frame) => {
  const result = await loadTrainingSnapshot({ fetchBytes: async (url) => url.endsWith('manifest.json') ? bytes(manifestJson)
    : url.endsWith('aviation.json') ? bytes(aviation) : url.includes('/frames/') ? frame : null });
  expect(result.gridSource).toBeNull();
  expect(result.airports).toHaveLength(1);
});

it('keeps absent SIGMETs missing, tolerates malformed aviation and invalid run times', async () => {
  const result = await loadTrainingSnapshot({ fetchBytes: async (url) => url.endsWith('manifest.json') ? bytes({ ...manifestJson, run: 'invalid' })
    : url.endsWith('aviation.json') ? bytes({ airports: [null, { icao: 'YBAD' }, aviation.airports[0]] }) : null });
  expect(result.airports).toHaveLength(1);
  expect(result.sigmets).toBeNull();
  expect(result.sampleTime).toBeNull();
});

it('does not start requests after disposal and discards an in-flight snapshot', async () => {
  const controller = new AbortController();
  let requests = 0;
  controller.abort();
  await loadTrainingSnapshot({ signal: controller.signal, fetchBytes: async () => { requests++; return null; } });
  expect(requests).toBe(0);
  const active = new AbortController();
  const result = await loadTrainingSnapshot({ signal: active.signal, fetchBytes: async () => { active.abort(); return bytes(manifestJson); } });
  expect(result.airports).toHaveLength(0);
});


it('does not let a partial point product or malformed SIGMET imply known weather', async () => {
  const result = await loadTrainingSnapshot({ fetchBytes: async (url) => url.endsWith('manifest.json') ? bytes(manifestJson)
    : url.endsWith('points.json') ? bytes({ ...points, places: { perth: { t: [20, 21] } } })
    : url.endsWith('aviation.json') ? bytes({ ...aviation, sigmets: [null] }) : null });
  expect(result.airports[0].metar).not.toBeNull();
  expect(result.airports[0].sample?.windKt).toBeNull();
  expect(result.sigmets).toBeNull();
});
