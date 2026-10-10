/** Tiny deterministic trainer export served in-memory by file-backed browser QA. */
const run = '2026-10-07T00:00:00Z';
const place = { id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -1, lon: 101, icao: 'YPPH' };
const variable = (name: string, units: string, offset: number) => ({
  frames: [`frames/${name}/f000.u16`, `frames/${name}/f003.u16`], units, scale: 0.1, offset, fill: 65535,
});
const json = (value: unknown) => ({ body: Buffer.from(JSON.stringify(value)), contentType: 'application/json' });

export const trainingFixture = new Map<string, { body: Buffer; contentType: string }>([
  ['/data/manifest.json', json({
    schema: 2, contract: 'isobar-web', run, generated: run, forecast_hours: [0, 3],
    grid: { west: 100, east: 101, north: 0, south: -1, step: 0.5, nx: 3, ny: 3, dtype: 'uint16' },
    variables: { mslp: variable('mslp', 'hPa', 850), rain24: variable('rain24', 'mm', 0), t2m: variable('t2m', 'C', -40), wind: variable('wind', 'kt', 0) },
    places: [place], aviation: 'aviation.json', points: 'points.json',
    attribution: [{ source: 'Synthetic trainer fixture', licence: 'Test data' }],
  })],
  ['/data/points.json', json({
    run, hours: [0, 3],
    places: { perth: { t: [20, 22], wspd: [10, 12], wdir: [180, 200], tp: [0, 1], cc: [10, 20] } },
  })],
  ['/data/aviation.json', json({
    airports: [{ ...place,
      metar: { raw: 'METAR YPPH 070300Z 22013KT 9999 FEW026 22/13 Q1016', time: '2026-10-07T03:00:00Z' },
      taf: { raw: 'TAF YPPH 070205Z 0703/0806 23014KT CAVOK FM071000 27012KT', issue: '2026-10-07T02:05:00Z', from: '2026-10-07T03:00:00Z', to: '2026-10-08T06:00:00Z' },
    }], sigmets: [],
  })],
]);
const frame = Buffer.alloc(18);
for (let i = 0; i < 9; i++) frame.writeUInt16LE(1660, i * 2);
for (const hour of ['000', '003']) trainingFixture.set(`/data/frames/mslp/f${hour}.u16`, { body: frame, contentType: 'application/octet-stream' });
