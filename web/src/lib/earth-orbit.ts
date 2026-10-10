import { json2satrec, twoline2satrec, propagate, gstime, eciToEcf, eciToGeodetic, sunPos, jday, type SatRec } from 'satellite.js';

export type Vec3 = [number, number, number];
export interface OrbitSource {
  kind: 'reference' | 'elements';
  epoch: string;
  retrievedAt: string | null;
  omm?: Parameters<typeof json2satrec>[0];
  tle?: [string, string];
}

// Published example, not current telemetry. Never advance this orbit to today's date.
// https://github.com/shashwatak/satellite-js#sample-usage-calculate-look-angles-geodetic-position-etc
export const REFERENCE_ORBIT: OrbitSource = {
  kind: 'reference', epoch: '2019-06-05T12:12:58.000Z', retrievedAt: null,
  tle: [
    '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992',
    '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442',
  ],
};
export const MAX_ORBIT_AGE_MS = 48 * 3600_000;

export function parseOrbitSource(raw: unknown): OrbitSource {
  if (!raw || typeof raw !== 'object') throw new Error('Orbit unavailable');
  const source = raw as OrbitSource;
  if (source.kind === 'reference') return REFERENCE_ORBIT;
  const o = source.omm;
  if (source.kind !== 'elements' || !o || Number(o.NORAD_CAT_ID) !== 25544) throw new Error('ISS orbit required');
  for (const [key, expected] of Object.entries({CENTER_NAME:'EARTH', REF_FRAME:'TEME', TIME_SYSTEM:'UTC', MEAN_ELEMENT_THEORY:'SGP4'})) {
    if (o[key] !== undefined && o[key] !== expected) throw new Error('Unsupported orbit convention');
  }
  for (const key of ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
    'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'] as const) {
    if (typeof o[key] !== 'number' || !Number.isFinite(o[key])) throw new Error('Invalid orbit elements');
  }
  if (Number(o.MEAN_MOTION) < 14 || Number(o.MEAN_MOTION) > 17 || Number(o.ECCENTRICITY) < 0 || Number(o.ECCENTRICITY) >= .05 ||
      Number(o.INCLINATION) < 0 || Number(o.INCLINATION) > 180 || typeof o.EPOCH !== 'string') throw new Error('Invalid ISS orbit');
  const epoch = Date.parse(o.EPOCH.endsWith('Z') ? o.EPOCH : o.EPOCH + 'Z');
  if (!Number.isFinite(epoch) || !source.retrievedAt || !Number.isFinite(Date.parse(source.retrievedAt))) throw new Error('Missing orbit time');
  return { kind: 'elements', epoch: new Date(epoch).toISOString(), retrievedAt: source.retrievedAt, omm: o };
}

export function orbitRecord(source: OrbitSource): SatRec {
  return source.omm ? json2satrec(source.omm) : twoline2satrec(source.tle![0], source.tle![1]);
}

// Earth-fixed right-handed scene: X Greenwich, Y north, Z 90° west. Distances km.
export function sceneVector(v: { x: number; y: number; z: number }): Vec3 { return [v.x, v.z, -v.y]; }
export function unit(v: Vec3): Vec3 {
  const n = Math.hypot(...v);
  if (!n || !Number.isFinite(n)) throw new Error('Invalid orbit frame');
  return v.map(x => x / n) as Vec3;
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
export interface OrbitFrame {
  position: Vec3; radial: Vec3; along: Vec3; normal: Vec3; sun: Vec3;
  latitude: number; longitude: number; altitude: number; shadow: boolean;
}
export function orbitFrame(source: OrbitSource, record: SatRec, utcMs: number): OrbitFrame {
  const epoch = Date.parse(source.epoch);
  if (!Number.isFinite(utcMs) || !Number.isFinite(epoch) || Math.abs(utcMs - epoch) > MAX_ORBIT_AGE_MS) throw new Error('Orbit outside supported time');
  const date = new Date(utcMs), pv = propagate(record, date);
  if (!pv) throw new Error('Orbit propagation failed');
  const gmst = gstime(date);
  const position = sceneVector(eciToEcf(pv.position, gmst));
  // Rotate inertial velocity, not ground-relative velocity: this defines the orbital frame.
  const velocity = sceneVector(eciToEcf(pv.velocity, gmst));
  if (![...position, ...velocity].every(Number.isFinite)) throw new Error('Invalid orbit position');
  const radial = unit(position), normal = unit(cross(position, velocity)), along = unit(cross(normal, radial));
  const geo = eciToGeodetic(pv.position, gmst);
  if (geo.height < 100 || geo.height > 1000) throw new Error('ISS altitude outside supported range');
  const rsun = sunPos(jday(date)).rsun;
  const sun = unit(sceneVector(eciToEcf({ x: rsun[0], y: rsun[1], z: rsun[2] }, gmst)));
  const dot = position.reduce((n, x, i) => n + x * sun[i], 0);
  // Cylindrical umbra approximation; no penumbra or atmospheric refraction claim.
  const shadow = dot < 0 && Math.hypot(...position.map((x, i) => x - dot * sun[i])) < 6378.137;
  return { position, radial, normal, along, sun, latitude: geo.latitude * 180 / Math.PI,
    longitude: geo.longitude * 180 / Math.PI, altitude: geo.height, shadow };
}
