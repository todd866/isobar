import { readFileSync } from 'node:fs';
import path from 'node:path';

type Fixture = { body: Buffer; contentType: string };
const json = (value: unknown): Fixture => ({ body: Buffer.from(JSON.stringify(value)), contentType: 'application/json' });

const run = '2026-10-09T00:00:00.000Z';
const stations = [
  ['YPPH', 'Perth', 'Australia/Perth', -31.9403, 115.9672, '25013KT', '9999 FEW037 SCT045 BKN055'],
  ['YSSY', 'Sydney', 'Australia/Sydney', -33.9461, 151.1772, '04015KT', 'CAVOK'],
  ['YMML', 'Melbourne', 'Australia/Melbourne', -37.6733, 144.8433, '09012KT', '9999 SCT030'],
  ['YSCB', 'Canberra', 'Australia/Sydney', -35.3069, 149.195, '18010KT', '9999 FEW040'],
  ['YHBA', 'Brisbane', 'Australia/Brisbane', -27.3842, 153.1175, '22011KT', '9999 SCT035'],
  ['KBFI', 'Teska', 'America/Los_Angeles', 47.53, -122.302, '14009KT', '9999 FEW025'],
] as const;

const airports = stations.map(([icao, name, zone, lat, lon, wind, cloud]) => ({
  icao, name, zone, lat, lon,
  metar: { raw: `METAR ${icao} 090300Z ${wind} ${cloud} 19/11 Q1012`, time: `${run}` },
  taf: { raw: `TAF ${icao} 090202Z 0903/1006 ${wind} ${cloud} FM091200 28007KT 9999 SCT020 BKN030`, issue: '2026-10-09T02:02:00.000Z', from: '2026-10-09T03:00:00.000Z', to: '2026-10-10T06:00:00.000Z' },
}));

/** Six-station weather fixture keeps loadDeskWeather on the published path. */
export const odDeskFixture = new Map<string, Fixture>([
  ['/data/aviation.json', json({ airports, sigmets: [] })],
  ['/data/sky.json', json({ profiles: [] })],
]);

/** The built-file route is intentionally resolved from this test file, never cwd. */
export function builtFileFor(pathname: string, search = '') {
  const root = path.resolve(new URL('../..', import.meta.url).pathname);
  if (pathname.startsWith('/_next/static/')) return path.join(root, '.next', pathname.slice(7));
  if (pathname.startsWith('/data/') || pathname.startsWith('/od/')) return path.join(root, 'public', pathname);
  const page = pathname === '/' ? '/index' : pathname.replace(/\/$/, '');
  return path.join(root, '.next/server/app', `${page}${search.includes('_rsc=') ? '.rsc' : '.html'}`);
}

export function readBuiltFile(file: string) {
  return readFileSync(file);
}
