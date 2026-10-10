import { mapUnproject } from './lambert';
/**
 * 10 m flow along the chart. The published u/v field is the wind we draw:
 * near the surface it crosses the isobars slightly toward low pressure, and
 * that cross-isobar part is kept. u is eastward, v northward, both m/s.
 */

import { unproject, type Camera, type Lambert } from './lambert';

export const METRES_PER_DEG_LAT = 111_132;
export const METRES_PER_DEG_LON_EQUATOR = 111_320;
/** One hour of real wind per wall-clock second, so circulation is visible. */
export const FLOW_VISUAL_SCALE = 3600;
export const FLOW_LIFE_SECONDS = 12;
export const FLOW_FADE_SECONDS = 1.5;
/** Calm air is deliberately left unmarked: a zero-length streak still reads as noise. */
export const MIN_STREAK_SPEED_MS = 2.5;
/** A tracer that turns more than a quarter turn in one life is retired. */
export const MAX_PARTICLE_TURN_RADIANS = Math.PI / 2;

export interface GeoPoint {
  lon: number;
  lat: number;
}

export interface Particle extends GeoPoint {
  age: number;
  seedLon: number;
  seedLat: number;
  /** Direction of the last non-calm vector, in radians. */
  headingRadians?: number;
  /** Cumulative absolute heading change during this particle's life. */
  turnRadians?: number;
}

export interface ScalarGrid {
  nx: number;
  ny: number;
  west: number;
  north: number;
  /** Positive degrees, west to east. */
  dlon: number;
  /** Positive degrees, north to south. */
  dlat: number;
  wraps: boolean;
  fill: number;
  scale: number;
  offset: number;
}

/** Advance one point by the wind. Does not wrap longitude. */
export function advect(lon: number, lat: number, u: number, v: number, seconds: number): GeoPoint {
  const out = { lon, lat };
  advectInto(out, lon, lat, u, v, seconds);
  return out;
}

export function advectInto(out: GeoPoint, lon: number, lat: number, u: number, v: number, seconds: number): void {
  const metresLon = Math.max(METRES_PER_DEG_LON_EQUATOR * Math.cos((lat * Math.PI) / 180), 1);
  let nextLat = lat + (v * seconds) / METRES_PER_DEG_LAT;
  const nextLon = lon + (u * seconds) / metresLon;
  if (nextLat > 85) nextLat = 85;
  if (nextLat < -85) nextLat = -85;
  out.lon = nextLon;
  out.lat = nextLat;
}

/**
 * Tangential cyclonic wind around a low. Clockwise south of the equator,
 * anticlockwise north of it. Speed is m/s away from the centre; the centre
 * itself is calm.
 */
export function circularLowWind(lon: number, lat: number, centerLon: number, centerLat: number, speed = 12): { u: number; v: number } {
  const latRad = (centerLat * Math.PI) / 180;
  const east = (lon - centerLon) * Math.max(Math.cos(latRad), 0.2) * METRES_PER_DEG_LON_EQUATOR;
  const north = (lat - centerLat) * METRES_PER_DEG_LAT;
  const mag = Math.hypot(east, north);
  if (!(mag > 1)) return { u: 0, v: 0 };
  const south = centerLat < 0;
  return {
    u: ((south ? north : -north) / mag) * speed,
    v: ((south ? -east : east) / mag) * speed,
  };
}

/** In-place step used by the renderer. `reduced` holds a static streamline. */
function headingDelta(a: number, b: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** Advance a particle, retiring it when its path has turned too far. */
export function stepParticle(particle: Particle, u: number, v: number, dt: number, reduced: boolean): boolean {
  if (reduced) {
    particle.age = 0;
    particle.headingRadians = undefined;
    particle.turnRadians = 0;
    return false;
  }
  if (!(dt > 0)) return false;
  const speed = Math.hypot(u, v);
  if (speed >= MIN_STREAK_SPEED_MS) {
    const heading = Math.atan2(v, u);
    if (particle.headingRadians == null) {
      particle.headingRadians = heading;
      particle.turnRadians = 0;
    } else {
      particle.turnRadians = (particle.turnRadians ?? 0) + Math.abs(headingDelta(particle.headingRadians, heading));
      particle.headingRadians = heading;
    }
    if ((particle.turnRadians ?? 0) > MAX_PARTICLE_TURN_RADIANS) {
      particle.age = FLOW_LIFE_SECONDS;
      return true;
    }
  }
  const beforeAge = particle.age;
  advectInto(particle, particle.lon, particle.lat, u, v, dt * FLOW_VISUAL_SCALE);
  particle.age = beforeAge + dt;
  if (particle.age >= FLOW_LIFE_SECONDS) {
    particle.lon = particle.seedLon;
    particle.lat = particle.seedLat;
    particle.age = 0;
    particle.headingRadians = undefined;
    particle.turnRadians = 0;
  }
  return false;
}

export function hash01(n: number): number {
  let x = Math.imul(n | 0, 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

export function seedParticle(index: number, west: number, south: number, width: number, height: number, salt: number): GeoPoint {
  const u = hash01(index * 2 + salt * 131);
  const v = hash01(index * 2 + 1 + salt * 131);
  return { lon: west + u * width, lat: south + v * height };
}

/** Subtle on every lens; the Wind lens carries about twice the streaks. */
export function particleCount(cssArea: number, windLens: boolean): number {
  const base = Math.round(Math.min(1000, Math.max(96, cssArea / 1100)));
  return windLens ? Math.min(1800, base * 2) : base;
}

/** Faint when calm, longer and darker where the wind is stronger. */
export function streakInk(speedMs: number, windLens: boolean): { alpha: number; lengthPx: number } {
  if (!(speedMs >= MIN_STREAK_SPEED_MS)) return { alpha: 0, lengthPx: 0 };
  // Proportional to speed, steep enough that a normal 8 m/s reads (owner,
  // 9 Oct: the faint version was invisible); near-calm air stays faint.
  return {
    alpha: Math.min(windLens ? 0.85 : 0.75, speedMs * (windLens ? 0.06 : 0.048)),
    lengthPx: Math.min(windLens ? 40 : 34, speedMs * (windLens ? 2.8 : 2.4)),
  };
}

/** Zero opacity AND zero slope at birth/death, including an exact respawn. */
export function smoothFade(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

export function ageFade(age: number): number {
  return smoothFade(age / FLOW_FADE_SECONDS) * smoothFade((FLOW_LIFE_SECONDS - age) / FLOW_FADE_SECONDS);
}

function decodeRaw(raw: number, grid: ScalarGrid): number | null {
  if (raw === grid.fill) return null;
  const value = raw * grid.scale + grid.offset;
  return Number.isFinite(value) ? value : null;
}

/** Bilinear sample. Rows run north to south. A wrapped grid repeats at the dateline. */
export function sampleScalar(frame: Uint16Array, lon: number, lat: number, grid: ScalarGrid): number | null {
  if (!(grid.nx >= 2 && grid.ny >= 2 && grid.dlon > 0 && grid.dlat > 0)) return null;
  const south = grid.north - grid.dlat * (grid.ny - 1);
  if (lat > grid.north || lat < south) return null;
  let x = (lon - grid.west) / grid.dlon;
  const y = (grid.north - lat) / grid.dlat;
  if (grid.wraps) {
    const period = grid.nx;
    x = ((x % period) + period) % period;
  } else if (x < 0 || x > grid.nx - 1) {
    return null;
  }
  const x0 = grid.wraps ? Math.floor(x) : Math.min(grid.nx - 2, Math.floor(x));
  const y0 = Math.min(grid.ny - 1, Math.max(0, Math.floor(y)));
  const tx = x - x0;
  const ty = y - y0;
  const y1 = Math.min(grid.ny - 1, y0 + 1);
  const at = (ix: number, iy: number): number | null => {
    let col = ix;
    if (grid.wraps) col = ((ix % grid.nx) + grid.nx) % grid.nx;
    else if (ix < 0 || ix >= grid.nx) return null;
    return decodeRaw(frame[iy * grid.nx + col], grid);
  };
  const v00 = at(x0, y0);
  const v10 = at(x0 + 1, y0);
  const v01 = at(x0, y1);
  const v11 = at(x0 + 1, y1);
  if (v00 == null || v10 == null || v01 == null || v11 == null) return null;
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

export function sampleBlended(a: Uint16Array, b: Uint16Array, t: number, lon: number, lat: number, grid: ScalarGrid): number | null {
  const left = sampleScalar(a, lon, lat, grid);
  if (t === 0 || a === b) return left;
  if (t === 1) return sampleScalar(b, lon, lat, grid);
  const right = sampleScalar(b, lon, lat, grid);
  if (left == null || right == null) return null;
  return left * (1 - t) + right * t;
}

export interface GeoBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** Geographic window of the camera. Longitude is continuous about the centre. */
export function cameraBounds(geo: Lambert, camera: Camera): GeoBounds | null {
  const centre = unproject(geo, camera.centerX, camera.centerY);
  if (!centre) return null;
  const points = camera.surface ? Array.from({ length: 81 }, (_, i) => mapUnproject(geo, camera, (i % 9) / 4 - 1, Math.floor(i / 9) / 4 - 1)).concat([centre]) : [
    centre,
    unproject(geo, camera.centerX - camera.halfWidth, camera.centerY - camera.halfHeight),
    unproject(geo, camera.centerX + camera.halfWidth, camera.centerY - camera.halfHeight),
    unproject(geo, camera.centerX - camera.halfWidth, camera.centerY + camera.halfHeight),
    unproject(geo, camera.centerX + camera.halfWidth, camera.centerY + camera.halfHeight),
    unproject(geo, camera.centerX - camera.halfWidth, camera.centerY),
    unproject(geo, camera.centerX + camera.halfWidth, camera.centerY),
    unproject(geo, camera.centerX, camera.centerY - camera.halfHeight),
    unproject(geo, camera.centerX, camera.centerY + camera.halfHeight),
  ];
  let west = 0;
  let east = 0;
  let south = centre.lat;
  let north = centre.lat;
  let any = false;
  for (const point of points) {
    if (!point) continue;
    let lon = point.lon;
    while (lon - centre.lon > 180) lon -= 360;
    while (centre.lon - lon > 180) lon += 360;
    if (!any) {
      west = lon;
      east = lon;
      any = true;
    }
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, point.lat);
    north = Math.max(north, point.lat);
  }
  if (!(east > west) || !(north > south)) return null;
  return { west, east, south, north };
}

const EARTH_RADIUS_M = 6_371_000;
const OMEGA = 7.2921e-5;
const AIR_DENSITY = 1.2;
/** Surface friction: the wind runs slower than geostrophic and turns toward low pressure. */
export const SURFACE_FACTOR = 0.7;
export const CROSS_ISOBAR_DEG = 20;

/**
 * Surface wind estimated from the pressure field alone, for when the 10 m
 * components are not published. Geostrophic balance gives a flow along the
 * isobars; an assumed friction slows it and turns it about 20° toward low pressure.
 * This estimate cannot resolve terrain or land/sea friction differences. Within 5° of the equator the balance does not
 * hold and nothing is returned; it fades in to full strength by 15°.
 * `pressureHpa(lon, lat)` samples the (time-blended) MSLP field.
 */
export function surfaceWindFromPressure(
  pressureHpa: (lon: number, lat: number) => number | null,
  lon: number, lat: number, stepDeg: number,
): { u: number; v: number } | null {
  const absLat = Math.abs(lat);
  if (!(absLat >= 5) || absLat > 85 || !(stepDeg > 0)) return null;
  const d = stepDeg;
  const east = pressureHpa(lon + d, lat), west = pressureHpa(lon - d, lat);
  const north = pressureHpa(lon, lat + d), south = pressureHpa(lon, lat - d);
  if (east == null || west == null || north == null || south == null) return null;
  const rad = Math.PI / 180;
  const dx = 2 * EARTH_RADIUS_M * Math.cos(lat * rad) * d * rad;
  const dy = 2 * EARTH_RADIUS_M * d * rad;
  const dpdx = ((east - west) * 100) / dx; // Pa per metre
  const dpdy = ((north - south) * 100) / dy;
  const f = 2 * OMEGA * Math.sin(lat * rad);
  const ug = -dpdy / (AIR_DENSITY * f);
  const vg = dpdx / (AIR_DENSITY * f);
  const speed = Math.hypot(ug, vg);
  const grad = Math.hypot(dpdx, dpdy);
  if (!(speed > 0) || !(grad > 0)) return { u: 0, v: 0 };
  const a = CROSS_ISOBAR_DEG * rad;
  // Along the isobar, plus a component down the pressure gradient (toward low).
  const lowU = -dpdx / grad, lowV = -dpdy / grad;
  const fade = Math.min(1, (absLat - 5) / 10);
  const scale = SURFACE_FACTOR * fade * Math.min(1, 40 / speed);
  return {
    u: scale * (Math.cos(a) * ug + Math.sin(a) * speed * lowU),
    v: scale * (Math.cos(a) * vg + Math.sin(a) * speed * lowV),
  };
}
