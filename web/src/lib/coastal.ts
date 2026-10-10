import { ringInPolygon, type Coast, type CoastRing } from './coast';

export interface CoastalSpot {
  lat: number;
  lon: number;
  distanceKm: number;
  /** Bearing from the land at the coast towards the sea, clockwise from north. */
  seawardDeg: number | null;
}

const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

function finiteGeo(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90;
}

function wrapLon(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

function unwrapNear(lon: number, reference: number): number {
  let value = lon;
  while (value - reference > 180) value -= 360;
  while (value - reference < -180) value += 360;
  return value;
}

function localRing(ring: CoastRing, referenceLon: number): CoastRing {
  const lon = new Float32Array(ring.lon.length);
  const lat = new Float32Array(ring.lat);
  if (lon.length === 0) return { lon, lat };
  lon[0] = unwrapNear(ring.lon[0], referenceLon);
  for (let i = 1; i < lon.length; i += 1) lon[i] = unwrapNear(ring.lon[i], lon[i - 1]);
  return { lon, lat };
}

const ringBounds = new WeakMap<CoastRing, { west: number; east: number; south: number; north: number }>();

function boundsOf(ring: CoastRing): { west: number; east: number; south: number; north: number } {
  const cached = ringBounds.get(ring);
  if (cached) return cached;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let i = 0; i < ring.lon.length; i += 1) {
    west = Math.min(west, ring.lon[i]);
    east = Math.max(east, ring.lon[i]);
    south = Math.min(south, ring.lat[i]);
    north = Math.max(north, ring.lat[i]);
  }
  const box = { west, east, south, north };
  ringBounds.set(ring, box);
  return box;
}

function nearBounds(box: { west: number; east: number; south: number; north: number }, lat: number, lon: number, padDeg: number): boolean {
  if (lat < box.south - padDeg || lat > box.north + padDeg) return false;
  // A ring stored across the antimeridian has a min/max wider than 180°.
  if (box.east - box.west >= 180) return true;
  const mid = (box.west + box.east) / 2;
  let x = lon;
  while (x - mid > 180) x -= 360;
  while (x - mid < -180) x += 360;
  const padLon = padDeg / Math.max(0.2, Math.cos(lat * DEG));
  return x >= box.west - padLon && x <= box.east + padLon;
}

function localContains(coast: Coast, lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of coast.rings) {
    if (!nearBounds(boundsOf(ring), lat, lon, 0)) continue;
    inside = ringInPolygon(lon, lat, localRing(ring, lon)) ? !inside : inside;
  }
  return inside;
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * DEG;
  const dLon = (bLon - aLon) * DEG;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Finds the nearest represented coast line. OCST rings encode
 * closed Natural Earth polygon rings. The packer removes
 * the repeated final point, so the final-to-first edge is restored here. The
 * packer does not clip rings to the chart box; this is therefore a real edge,
 * rather than an artificial crop edge. The normal is inferred by probing both
 * sides and therefore does not depend on ring winding.
 */
export function nearestCoast(coast: Coast, point: { lat: number; lon: number }, maxKm = 50): CoastalSpot | null {
  if (!coast || !finiteGeo(point.lat, point.lon) || !Number.isFinite(maxKm) || maxKm < 0) return null;
  let best: { lat: number; lon: number; distanceKm: number; tangentEast: number; tangentNorth: number } | null = null;
  const cosLat = Math.max(0.05, Math.cos(point.lat * DEG));

  const padDeg = maxKm / 111.32 + 0.02;
  for (const ring of coast.rings) {
    if (!nearBounds(boundsOf(ring), point.lat, point.lon, padDeg)) continue;
    const n = Math.min(ring.lon.length, ring.lat.length);
    const local = localRing(ring, point.lon);
    for (let i = 0; i < n; i += 1) {
      const aLat = local.lat[i];
      const aLon = local.lon[i];
      const next = (i + 1) % n;
      const bLat = local.lat[next];
      const bLon = local.lon[next];
      if (!finiteGeo(aLat, aLon) || !finiteGeo(bLat, bLon)) continue;
      const ax = (aLon - point.lon) * cosLat;
      const ay = aLat - point.lat;
      const bx = (bLon - point.lon) * cosLat;
      const by = bLat - point.lat;
      const dx = bx - ax;
      const dy = by - ay;
      const length2 = dx * dx + dy * dy;
      if (!(length2 > 0)) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
      const lat = aLat + (bLat - aLat) * t;
      const lon = wrapLon(aLon + (bLon - aLon) * t);
      const distanceKm = haversineKm(point.lat, point.lon, lat, lon);
      if (distanceKm > maxKm || (best && distanceKm >= best.distanceKm)) continue;
      best = { lat, lon, distanceKm, tangentEast: (bLon - aLon) * cosLat, tangentNorth: bLat - aLat };
    }
  }
  if (!best) return null;

  const length = Math.hypot(best.tangentEast, best.tangentNorth);
  const eastLeft = -best.tangentNorth / length;
  const northLeft = best.tangentEast / length;
  let seawardDeg: number | null = null;
  let orientation: boolean | null = null;
  // Smallest probes preserve the land/sea split on small islands. Larger
  // probes provide a fallback when the nearest point lies on a narrow inlet.
  for (const probeKm of [0.1, 0.25, 1, 2]) {
    const probeLat = (probeKm / EARTH_RADIUS_KM) / DEG;
    const probeLon = probeLat / Math.max(0.05, Math.cos(best.lat * DEG));
    const leftLon = best.lon + eastLeft * probeLon;
    const leftLat = best.lat + northLeft * probeLat;
    const rightLon = best.lon - eastLeft * probeLon;
    const rightLat = best.lat - northLeft * probeLat;
    const leftLand = localContains(coast, leftLon, leftLat);
    const rightLand = localContains(coast, rightLon, rightLat);
    if (leftLand === rightLand) continue;
    const leftIsLand = leftLand;
    if (orientation != null && orientation !== leftIsLand) {
      orientation = null;
      break;
    }
    orientation = leftIsLand;
  }
  if (orientation != null) {
    const east = orientation ? -eastLeft : eastLeft;
    const north = orientation ? -northLeft : northLeft;
    seawardDeg = (Math.atan2(east, north) / DEG + 360) % 360;
  }
  return { lat: best.lat, lon: best.lon, distanceKm: best.distanceKm, seawardDeg };
}

function angularDifference(a: number, b: number): number {
  return Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
}

/** Classifies a meteorological FROM direction against the coast's seaward normal. */
export function shoreDirection(windFrom: number | null, seawardDeg: number | null): 'onshore' | 'cross-on' | 'cross' | 'cross-off' | 'offshore' | null {
  if (windFrom == null || seawardDeg == null || !Number.isFinite(windFrom) || !Number.isFinite(seawardDeg)) return null;
  const difference = angularDifference(windFrom, seawardDeg);
  if (difference < 22.5) return 'onshore';
  if (difference < 67.5) return 'cross-on';
  if (difference < 112.5) return 'cross';
  if (difference < 157.5) return 'cross-off';
  return 'offshore';
}

export interface KiteBand { min: number; max: number }
export const DEFAULT_KITE_BAND: KiteBand = { min: 15, max: 25 };
export function validKiteBand(value: unknown): value is KiteBand {
  if (!value || typeof value !== 'object') return false;
  const band = value as Partial<KiteBand>;
  return typeof band.min === 'number' && typeof band.max === 'number' && Number.isFinite(band.min) && Number.isFinite(band.max)
    && band.min >= 0 && band.max <= 100 && band.max > band.min;
}

export type KiteBandState = 'below' | 'inside' | 'above' | 'missing';

/** Integer knot printed in the sheet. Colour follows that glyph, so a gust that reads as the upper limit is inside. */
export function shownKnots(speed: number): number {
  return Number(speed.toFixed(0));
}

export function kiteBandState(speed: number | null, band: KiteBand): KiteBandState {
  if (speed == null || !Number.isFinite(speed) || speed < 0) return 'missing';
  const shown = shownKnots(speed);
  if (shown < band.min) return 'below';
  if (shown > band.max) return 'above';
  return 'inside';
}

export type RGB = [number, number, number];
export function kiteBandColor(state: KiteBandState): RGB | null {
  if (state === 'below') return [245, 158, 11];
  if (state === 'inside') return [34, 197, 94];
  if (state === 'above') return [239, 68, 68];
  return null;
}

export interface WindowSample { time: number; good: boolean }
export interface BestWindow { start: number; end: number }

/**
 * Returns the longest contiguous run of good observed samples. End is the
 * timestamp of the final observed sample (so a one-sample run has zero width);
 * this avoids inventing a forecast interval after the last sample.
 */
export function bestWindow(samples: WindowSample[], stepMs: number): BestWindow | null {
  if (!Number.isFinite(stepMs) || stepMs <= 0) return null;
  const ordered = samples.filter((sample) => Number.isFinite(sample.time)).slice().sort((a, b) => a.time - b.time);
  let best: BestWindow | null = null;
  let runStart: number | null = null;
  let previousTime: number | null = null;
  const finish = (lastTime: number | null) => {
    if (runStart == null || lastTime == null || lastTime <= runStart) return;
    const candidate = { start: runStart, end: lastTime };
    if (!best || candidate.end - candidate.start > best.end - best.start) best = candidate;
  };
  for (const sample of ordered) {
    const contiguous = previousTime != null && sample.time - previousTime === stepMs;
    if (!sample.good || (runStart != null && !contiguous)) {
      finish(previousTime);
      runStart = null;
    }
    if (sample.good && runStart == null) runStart = sample.time;
    previousTime = sample.time;
  }
  finish(previousTime);
  return best;
}
