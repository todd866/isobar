import { mapProject, mapUnproject } from './lambert';
/**
 * ADS-B traffic from ADSB.lol. Pressure altitude stays in feet and is shown
 * as a flight level. It is not a model height and not geometric altitude
 * (`alt_geom` is ignored). Positions older than 60 s fade and are gone after
 * 90 s. The browser polls `/api/traffic`; it does not call ADSB.lol itself.
 */

import { REGIONAL_SPAN_DEG } from './map-generalise';
import { project, unproject, type Camera, type Lambert } from './lambert';
import { aircraftClass, vesselClass, altitudeBand, TRAFFIC_SHAPES, type TrafficSymbolClass } from './traffic-symbols';
export { paintTraffic } from './traffic-render';

/** Planform, nose toward −Y. The map glyph and the Traffic control share it. */
export const TRAFFIC_GLYPH_PATH = TRAFFIC_SHAPES.narrowbody.map(([x, y], i) => `${i ? 'L' : 'M'}${x * 9} ${y * 9}`).join(' ') + ' Z';

export const TRAFFIC_POLL_MS = 10_000;
export const TRAFFIC_KICK_MS = 5_000;
export const TRAFFIC_CACHE_MS = 5_000;
export const TRAFFIC_FADE_S = 60;
export const TRAFFIC_MAX_AGE_S = 90;
export const TRAFFIC_FUTURE_S = 15;
/** Drawn marks. One transform each, and not on every idle frame. */
export const TRAFFIC_MAX_GLYPHS = 120;
/** Density is much cheaper than silhouettes and must cover the whole world. */
export const TRAFFIC_MAX_DOTS = 600;
export const TRAFFIC_LABEL_SPAN_DEG = 10;
export const TRAFFIC_MAX_LABELS = 16;
export const TRAFFIC_TILE_DEG = 0.5;
export const TRAFFIC_RADIUS_MAX_NM = 250;
export const TRAFFIC_RESPONSE_CAP = 400;
export const ADSB_MAX_BYTES = 2 * 1024 * 1024;
export const ADSB_USER_AGENT = 'Isobar/web (https://github.com/todd866/isobar)';

const EARTH_NM = 3440.065;

export interface TrafficAircraft {
  hex: string;
  callsign: string;
  registration: string;
  type: string;
  latitude: number;
  longitude: number;
  /** Pressure altitude, feet. Not a geometric or model AMSL height. */
  pressureAltitudeFt: number;
  distanceNm: number;
  positionTimeMs: number;
  groundSpeedKt?: number;
  trackDegrees?: number;
  verticalRateFtMin?: number;
  squawk?: string;
}

export interface TrafficSnapshot {
  timeMs: number;
  aircraft: TrafficAircraft[];
  source: 'ADSB.lol';
  radiusNm: number;
  routeLookupEnabled?: boolean;
}

/** Renderer input for AIS adapters. No vessel feed is enabled by the ADS-B API. */
export interface TrafficVessel {
  id: string;
  name: string;
  /** AIS ship/cargo type, not an ICAO aircraft designator. */
  shipType?: number;
  latitude: number;
  longitude: number;
  positionTimeMs: number;
  groundSpeedKt?: number;
  trackDegrees?: number;
}

export interface TrafficTrailPoint {
  latitude: number;
  longitude: number;
  timeMs: number;
  pressureAltitudeFt?: number;
}

export interface TrafficTrail {
  aircraft: TrafficAircraft;
  points: TrafficTrailPoint[];
}

export interface TrafficGlyph {
  hex: string;
  x: number;
  y: number;
  trackDeg: number | null;
  opacity: number;
  label: string | null;
  tail: { x: number; y: number }[];
  aircraft: TrafficAircraft | null;
  vessel: TrafficVessel | null;
  symbolClass: TrafficSymbolClass;
  altitudeBand: 0 | 1 | 2 | 3 | null;
  /** Fixed per zoom tier; altitude and speed never scale the silhouette. */
  size: number;
  vector: { x: number; y: number } | null;
  labelOrigin: { x: number; y: number } | null;
  selected: boolean;
  /** Wide views show bounded density dots, without tails or heading. */
  densityDot: boolean;
  color?: string;
}

export interface TrafficTile {
  lat: number;
  lon: number;
  radiusNm: number;
  key: string;
}

export interface TrafficCacheEntry<T> {
  at: number;
  value: T;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.slice(0, 40);
}

function hasAlphanumeric(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

/** Great-circle distance in nautical miles. Same constants as the Mac parser. */
export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const x = Math.sin(((lat2 - lat1) * r) / 2);
  const y = Math.sin(((lon2 - lon1) * r) / 2);
  const h = x * x + Math.cos(lat1 * r) * Math.cos(lat2 * r) * y * y;
  return EARTH_NM * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function flightLevelLabel(pressureAltitudeFt: number): string {
  if (!Number.isFinite(pressureAltitudeFt)) return '—';
  const level = Math.round(pressureAltitudeFt / 100);
  return `FL${String(level).padStart(3, '0')}`;
}

export function trafficLabel(aircraft: TrafficAircraft): string {
  const name = aircraft.callsign.length > 10 ? aircraft.callsign.slice(0, 10) : aircraft.callsign;
  const altitude = Number.isFinite(aircraft.pressureAltitudeFt) ? String(Math.round(aircraft.pressureAltitudeFt / 100)).padStart(3, '0') : '—';
  const speed = aircraft.groundSpeedKt != null && Number.isFinite(aircraft.groundSpeedKt) ? String(Math.round(aircraft.groundSpeedKt)).padStart(3, '0') : '—';
  return `${name} ${altitude} ${speed}`;
}

/** One line: callsign · type · FL · GS kt · age s. Missing speed or type stays missing. */
export function trafficCardLine(aircraft: TrafficAircraft, nowMs: number): string {
  const type = aircraft.type || '—';
  const speed = aircraft.groundSpeedKt == null ? '—' : `${Math.round(aircraft.groundSpeedKt)} kt`;
  const age = Math.max(0, Math.round((nowMs - aircraft.positionTimeMs) / 1000));
  return `${aircraft.callsign} · ${type} · ${flightLevelLabel(aircraft.pressureAltitudeFt)} · ${speed} · ${age} s`;
}

/**
 * 1 until 60 s, then a linear fade, 0 outside [−15 s, 90 s].
 * Age 90 is fully gone. Clock skew up to 15 s ahead still counts.
 */
export function trafficOpacity(ageS: number): number {
  if (!(ageS >= -TRAFFIC_FUTURE_S && ageS <= TRAFFIC_MAX_AGE_S)) return 0;
  if (ageS <= TRAFFIC_FADE_S) return 1;
  return (TRAFFIC_MAX_AGE_S - ageS) / (TRAFFIC_MAX_AGE_S - TRAFFIC_FADE_S);
}

/**
 * Parse one ADSB.lol `/v2/point` payload. `now` on the payload is milliseconds.
 * Ground, unknown, stale and out-of-radius reports are dropped. A duplicate
 * hex keeps the newer position. The snapshot itself is rejected when the
 * response stamp is outside [−15 s, 90 s] or the query point is unusable.
 */
export function parseTraffic(
  payload: unknown,
  nowMs: number,
  latitude: number,
  longitude: number,
  radiusNm = 80,
): TrafficSnapshot | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  if (!finiteNumber(body.now) || !Array.isArray(body.ac)) return null;
  if (!Number.isFinite(nowMs) || !Number.isFinite(latitude) || Math.abs(latitude) > 90) return null;
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  if (!Number.isFinite(radiusNm) || radiusNm <= 0) return null;
  const stamp = body.now;
  const age = (nowMs - stamp) / 1000;
  if (age < -TRAFFIC_FUTURE_S || age > TRAFFIC_MAX_AGE_S) return null;
  const byAddress = new Map<string, TrafficAircraft>();
  for (const item of body.ac) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (!finiteNumber(row.alt_baro) || !finiteNumber(row.lat) || !finiteNumber(row.lon) || !finiteNumber(row.seen_pos)) continue;
    const alt = row.alt_baro;
    const lat = row.lat;
    const lon = row.lon;
    const seen = row.seen_pos;
    if (alt <= 0 || alt > 65600 || Math.abs(lat) > 90 || Math.abs(lon) > 180 || seen < 0 || age + seen > TRAFFIC_MAX_AGE_S) continue;
    const hex = text(row.hex);
    if (!hex) continue;
    const distance = distanceNm(latitude, longitude, lat, lon);
    if (distance > radiusNm) continue;
    const positionTimeMs = stamp - seen * 1000;
    const previous = byAddress.get(hex);
    if (previous && previous.positionTimeMs >= positionTimeMs) continue;
    let callsign = text(row.flight);
    const registration = text(row.r);
    const type = text(row.t);
    if (!hasAlphanumeric(callsign)) callsign = '';
    const aircraft: TrafficAircraft = {
      hex,
      callsign: callsign || registration || hex.toUpperCase(),
      registration,
      type,
      latitude: lat,
      longitude: lon,
      pressureAltitudeFt: alt,
      distanceNm: distance,
      positionTimeMs,
    };
    if (finiteNumber(row.gs) && row.gs >= 0 && row.gs <= 1500) aircraft.groundSpeedKt = row.gs;
    if (finiteNumber(row.track) && row.track >= 0 && row.track < 360) aircraft.trackDegrees = row.track;
    if (finiteNumber(row.baro_rate) && Math.abs(row.baro_rate) <= 20000) aircraft.verticalRateFtMin = row.baro_rate;
    if (typeof row.squawk === 'string' && /^[0-7]{4}$/.test(row.squawk)) aircraft.squawk = row.squawk;
    byAddress.set(hex, aircraft);
  }
  const aircraft = [...byAddress.values()].sort((a, b) => a.pressureAltitudeFt - b.pressureAltitudeFt || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
  return { timeMs: stamp, aircraft, source: 'ADSB.lol', radiusNm };
}

/** Our `/api/traffic` JSON. A bad body is null so the client keeps the last good picture. */
export function trafficResponse(body: unknown): TrafficSnapshot | null {
  if (!body || typeof body !== 'object') return null;
  const row = body as Record<string, unknown>;
  if (row.source !== 'ADSB.lol' || !finiteNumber(row.time) || !Array.isArray(row.aircraft)) return null;
  const aircraft: TrafficAircraft[] = [];
  for (const item of row.aircraft) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.hex !== 'string' || !raw.hex || typeof raw.callsign !== 'string') continue;
    if (!finiteNumber(raw.latitude) || !finiteNumber(raw.longitude) || !finiteNumber(raw.pressureAltitudeFt) || !finiteNumber(raw.positionTimeMs)) continue;
    if (Math.abs(raw.latitude) > 90 || Math.abs(raw.longitude) > 180) continue;
    const aircraftRow: TrafficAircraft = {
      hex: raw.hex,
      callsign: raw.callsign,
      registration: typeof raw.registration === 'string' ? raw.registration : '',
      type: typeof raw.type === 'string' ? raw.type : '',
      latitude: raw.latitude,
      longitude: raw.longitude,
      pressureAltitudeFt: raw.pressureAltitudeFt,
      distanceNm: finiteNumber(raw.distanceNm) ? raw.distanceNm : 0,
      positionTimeMs: raw.positionTimeMs,
    };
    if (finiteNumber(raw.groundSpeedKt)) aircraftRow.groundSpeedKt = raw.groundSpeedKt;
    if (finiteNumber(raw.trackDegrees)) aircraftRow.trackDegrees = raw.trackDegrees;
    if (finiteNumber(raw.verticalRateFtMin) && Math.abs(raw.verticalRateFtMin) <= 20000) aircraftRow.verticalRateFtMin = raw.verticalRateFtMin;
    if (typeof raw.squawk === 'string' && /^[0-7]{4}$/.test(raw.squawk)) aircraftRow.squawk = raw.squawk;
    aircraft.push(aircraftRow);
  }
  const radiusNm = finiteNumber(row.radiusNm) && row.radiusNm > 0 ? row.radiusNm : 80;
  return { timeMs: row.time, aircraft, source: 'ADSB.lol', radiusNm, routeLookupEnabled: row.routeLookupEnabled === true };
}

/** Half-degree tile. Radius is padded so a query anywhere in the tile is covered, then capped at 250 nm. */
export function trafficTile(lat: number, lon: number, radiusNm: number): TrafficTile | null {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) return null;
  if (!Number.isFinite(radiusNm) || radiusNm <= 0) return null;
  const latTile = Math.max(-90, Math.min(90, Math.round(lat / TRAFFIC_TILE_DEG) * TRAFFIC_TILE_DEG));
  let lonTile = Math.round(lon / TRAFFIC_TILE_DEG) * TRAFFIC_TILE_DEG;
  if (lonTile >= 180) lonTile -= 360;
  if (lonTile < -180) lonTile += 360;
  const padded = Math.min(TRAFFIC_RADIUS_MAX_NM, radiusNm + 30);
  const radius = Math.min(TRAFFIC_RADIUS_MAX_NM, Math.ceil(padded / 25) * 25);
  return {
    lat: latTile,
    lon: lonTile,
    radiusNm: radius,
    key: `${latTile.toFixed(1)}:${lonTile.toFixed(1)}:${radius}`,
  };
}

export function adsbPointUrl(lat: number, lon: number, radiusNm: number): string {
  return `https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${Math.round(radiusNm)}`;
}

export function cacheGet<T>(map: Map<string, TrafficCacheEntry<T>>, key: string, now: number): T | undefined {
  const hit = map.get(key);
  if (!hit || now - hit.at >= TRAFFIC_CACHE_MS) return undefined;
  return hit.value;
}

export function cacheSet<T>(map: Map<string, TrafficCacheEntry<T>>, key: string, value: T, now: number, max = 64): void {
  map.delete(key);
  map.set(key, { at: now, value });
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest == null) break;
    map.delete(oldest);
  }
}

export function closestAircraft(rows: readonly TrafficAircraft[], lat: number, lon: number, limit: number): TrafficAircraft[] {
  return [...rows].sort((a, b) => distanceNm(lat, lon, a.latitude, a.longitude) - distanceNm(lat, lon, b.latitude, b.longitude)).slice(0, limit);
}

/**
 * One upstream read of the tile that contains this query. Failures are null.
 * Callers cache the result; the browser never uses this URL.
 */
export async function fetchAdsbSnapshot(
  lat: number,
  lon: number,
  radiusNm: number,
  nowMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TrafficSnapshot | null> {
  const tile = trafficTile(lat, lon, radiusNm);
  if (!tile) return null;
  try {
    const response = await fetchImpl(adsbPointUrl(tile.lat, tile.lon, tile.radiusNm), {
      headers: { accept: 'application/json', 'user-agent': ADSB_USER_AGENT },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    const payload = await readTrafficJson(response, ADSB_MAX_BYTES);
    return parseTraffic(payload, nowMs, tile.lat, tile.lon, tile.radiusNm);
  } catch {
    return null;
  }
}

export function updateTrails(
  previous: ReadonlyMap<string, TrafficTrail>,
  aircraft: readonly TrafficAircraft[],
  nowMs: number,
): Map<string, TrafficTrail> {
  const next = new Map<string, TrafficTrail>();
  const seen = new Set<string>();
  const maxAgeMs = TRAFFIC_MAX_AGE_S * 1000;
  for (const row of aircraft) {
    seen.add(row.hex);
    const prior = previous.get(row.hex)?.points ?? [];
    const last = prior[prior.length - 1];
    const moved = !last || Math.abs(last.latitude - row.latitude) > 1e-4 || Math.abs(last.longitude - row.longitude) > 1e-4;
    const points = (moved ? [...prior, { latitude: row.latitude, longitude: row.longitude, timeMs: row.positionTimeMs }] : prior)
      .filter((point) => nowMs - point.timeMs <= maxAgeMs)
      .slice(-8);
    next.set(row.hex, { aircraft: row, points });
  }
  for (const [hex, trail] of previous) {
    if (seen.has(hex)) continue;
    const points = trail.points.filter((point) => nowMs - point.timeMs <= maxAgeMs);
    if (points.length) next.set(hex, { aircraft: trail.aircraft, points });
  }
  return next;
}

export function trafficInPicture(
  snapshot: TrafficSnapshot | null,
  trails: ReadonlyMap<string, TrafficTrail>,
  nowMs: number,
): TrafficAircraft[] {
  const rows = new Map<string, TrafficAircraft>();
  for (const row of snapshot?.aircraft ?? []) {
    if (trafficOpacity((nowMs - row.positionTimeMs) / 1000) > 0) rows.set(row.hex, row);
  }
  for (const [hex, trail] of trails) {
    if (rows.has(hex)) continue;
    if (trafficOpacity((nowMs - trail.aircraft.positionTimeMs) / 1000) > 0) rows.set(hex, trail.aircraft);
  }
  return [...rows.values()];
}

export function viewRadiusNm(geo: Lambert, camera: Camera): number {
  const centre = unproject(geo, camera.centerX, camera.centerY);
  if (!centre) return 80;
  let max = 15;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const corner = unproject(geo, camera.centerX + sx * camera.halfWidth, camera.centerY + sy * camera.halfHeight);
      if (corner) max = Math.max(max, distanceNm(centre.lat, centre.lon, corner.lat, corner.lon));
    }
  }
  return Math.min(TRAFFIC_RADIUS_MAX_NM, Math.max(15, Math.ceil(max)));
}

export function viewLatSpanDeg(geo: Lambert, camera: Camera): number {
  const south = unproject(geo, camera.centerX, camera.centerY - camera.halfHeight);
  const north = unproject(geo, camera.centerX, camera.centerY + camera.halfHeight);
  if (!south || !north) return 180;
  return Math.abs(north.lat - south.lat);
}

export function trafficScreen(
  geo: Lambert,
  camera: Camera,
  width: number,
  height: number,
  lat: number,
  lon: number,
): { x: number; y: number } | null {
  if (camera.surface) {
    const p = mapProject(geo, camera, lat, lon);
    return p && { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 };
  }
  const projected = project(geo, lat, lon);
  if (!projected) return null;
  if (geo.projection === 'equirectangular') {
    const period = 360 * geo.F;
    projected.x += Math.round((camera.centerX - projected.x) / period) * period;
  }
  return {
    x: (1 + (projected.x - camera.centerX) / camera.halfWidth) * width / 2,
    y: (1 - (projected.y - camera.centerY) / camera.halfHeight) * height / 2,
  };
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function onScreen(point: { x: number; y: number }, width: number, height: number): boolean {
  return point.x >= -24 && point.y >= -24 && point.x <= width + 24 && point.y <= height + 24;
}

export interface TrafficAvoid {
  x: number;
  y: number;
  w: number;
  h: number;
}

function hitsAvoid(left: number, top: number, right: number, bottom: number, zones: readonly TrafficAvoid[] | undefined): boolean {
  return !!zones?.some((zone) => left < zone.x + zone.w && right > zone.x && top < zone.y + zone.h && bottom > zone.y);
}

/** Spherical endpoint at the initial true track; knots × minutes / 60 is nautical miles. */
export function trafficDestination(latitude: number, longitude: number, track: number, nm: number): { latitude: number; longitude: number } {
  const r = Math.PI / 180, p = latitude * r, b = track * r, d = nm / EARTH_NM;
  const q = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(b));
  const lon = longitude * r + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(q));
  return { latitude: q / r, longitude: ((lon / r + 540) % 360) - 180 };
}

export function layoutTraffic(input: {
  aircraft: readonly TrafficAircraft[];
  vessels?: readonly TrafficVessel[];
  trails: ReadonlyMap<string, TrafficTrail>;
  nowMs: number;
  geo: Lambert;
  camera: Camera;
  width: number;
  height: number;
  selectedHex?: string | null;
  selectedColors?: ReadonlyMap<string, string>;
  showLabels?: boolean;
  /** Map controls and legends, in CSS pixels. Labels stay off them. */
  avoid?: readonly TrafficAvoid[];
}): TrafficGlyph[] {
  if (!(input.width > 0 && input.height > 0)) return [];
  const span = viewLatSpanDeg(input.geo, input.camera);
  const densityDot = span > REGIONAL_SPAN_DEG;
  const close = span <= TRAFFIC_LABEL_SPAN_DEG;
  const size = close ? 9 : 6;
  const screenAt = (lat: number, lon: number) => trafficScreen(input.geo, input.camera, input.width, input.height, lat, lon);
  // Keep a vector's endpoint on the same world copy as its origin at the dateline.
  const nearby = (point: { x: number; y: number }, origin: { x: number; y: number }) => {
    if (input.geo.projection === 'equirectangular') {
      const period = 360 * input.geo.F / input.camera.halfWidth * input.width / 2;
      point.x += Math.round((origin.x - point.x) / period) * period;
    }
    return point;
  };
  const glyphs: TrafficGlyph[] = [];
  const append = (aircraft: TrafficAircraft | null, vessel: TrafficVessel | null) => {
    const contact = (aircraft ?? vessel)!;
    const opacity = trafficOpacity((input.nowMs - contact.positionTimeMs) / 1000);
    if (!(opacity > 0)) return;
    const screen = screenAt(contact.latitude, contact.longitude);
    if (!screen || !onScreen(screen, input.width, input.height)) return;
    const hex = aircraft ? aircraft.hex : `ship:${vessel!.id}`;
    const selected = input.selectedHex === hex || !!input.selectedColors?.has(hex);
    const history = aircraft ? input.trails.get(hex)?.points ?? [] : [];
    let track = contact.trackDegrees;
    if (track == null && history.length >= 2) {
      const from = history[history.length - 2], to = history[history.length - 1];
      if (to.timeMs > from.timeMs && to.timeMs - from.timeMs <= 300_000 && (from.latitude !== to.latitude || from.longitude !== to.longitude)) {
        track = bearingDeg(from.latitude, from.longitude, to.latitude, to.longitude);
      }
    }
    const knownTrack = track != null && Number.isFinite(track) && track >= 0 && track < 360;
    let trackDeg: number | null = null;
    let vector: { x: number; y: number } | null = null;
    if (!densityDot && knownTrack) {
      const ahead = trafficDestination(contact.latitude, contact.longitude, track!, 1);
      const projected = screenAt(ahead.latitude, ahead.longitude);
      if (projected) {
        const local = nearby(projected, screen);
        trackDeg = (Math.atan2(local.x - screen.x, screen.y - local.y) * 180 / Math.PI + 360) % 360;
      }
      const speed = contact.groundSpeedKt;
      if (speed != null && Number.isFinite(speed) && speed > 0) {
        const end = trafficDestination(contact.latitude, contact.longitude, track!, speed * (vessel ? 30 : 2) / 60);
        const projectedEnd = screenAt(end.latitude, end.longitude);
        if (projectedEnd) vector = nearby(projectedEnd, screen);
      }
    }
    glyphs.push({
      hex, x: screen.x, y: screen.y, trackDeg, opacity, label: null, labelOrigin: null,
      // Historic observations belong to the selected path underlay, not a second short tail.
      tail: [], densityDot, aircraft, vessel, selected, color: input.selectedColors?.get(hex),
      symbolClass: aircraft ? aircraftClass(aircraft.type) : vesselClass(vessel!.shipType),
      altitudeBand: aircraft ? altitudeBand(aircraft.pressureAltitudeFt) : null,
      size, vector,
    });
  };
  for (const aircraft of input.aircraft) append(aircraft, null);
  for (const vessel of input.vessels ?? []) append(null, vessel);
  glyphs.sort((a, b) => Number(b.selected) - Number(a.selected) || Math.hypot(a.x - input.width / 2, a.y - input.height / 2) - Math.hypot(b.x - input.width / 2, b.y - input.height / 2));
  // Separate aircraft/vessel bins; a co-located ship must not erase an aircraft.
  const cells = new Set<string>();
  const drawn = (densityDot ? glyphs.filter((mark) => {
    const key = `${mark.vessel ? 'ship' : 'air'}:${Math.floor(mark.x / 3)}:${Math.floor(mark.y / 3)}`;
    if (cells.has(key) && !mark.selected) return false;
    cells.add(key);
    return true;
  }) : glyphs).slice(0, densityDot ? TRAFFIC_MAX_DOTS : TRAFFIC_MAX_GLYPHS);
  const placed: { left: number; top: number; right: number; bottom: number }[] = [];
  if (input.showLabels !== false) {
    let labelled = 0;
    for (const glyph of drawn) {
      if (labelled >= TRAFFIC_MAX_LABELS) break;
      if (!close && !glyph.selected) continue;
      const vessel = glyph.vessel;
      const label = glyph.aircraft ? trafficLabel(glyph.aircraft) : `${vessel!.name.slice(0, 18)} ${vessel!.groundSpeedKt != null && Number.isFinite(vessel!.groundSpeedKt) ? Math.round(vessel!.groundSpeedKt) : '—'}kt`;
      const w = label.length * 7.2, h = 16, offset = size + 9;
      // One row per target. Try either side, above then below; omit when covered.
      const origins = [
        { x: glyph.x + offset, y: glyph.y - 10 }, { x: glyph.x - offset - w, y: glyph.y - 10 },
        { x: glyph.x + offset, y: glyph.y + 14 }, { x: glyph.x - offset - w, y: glyph.y + 14 },
      ];
      // A selected block can step outside a dense group, with a short leader.
      if (glyph.selected) for (const dy of [-28, 32, -44, 48]) {
        origins.push({ x: glyph.x + offset, y: glyph.y + dy }, { x: glyph.x - offset - w, y: glyph.y + dy });
      }
      for (const origin of origins) {
        const box = { left: origin.x - 2, top: origin.y - h / 2, right: origin.x + w + 2, bottom: origin.y + h / 2 };
        if (box.left < 4 || box.top < 4 || box.right > input.width - 4 || box.bottom > input.height - 4) continue;
        if (hitsAvoid(box.left, box.top, box.right, box.bottom, input.avoid)) continue;
        if (placed.some((other) => other.left < box.right && other.right > box.left && other.top < box.bottom && other.bottom > box.top)) continue;
        if (drawn.some((other) => other !== glyph && other.x + other.size + 5 > box.left && other.x - other.size - 2 < box.right && other.y + other.size > box.top && other.y - other.size < box.bottom)) continue;
        glyph.label = label; glyph.labelOrigin = origin;
        placed.push(box); labelled += 1; break;
      }
    }
  }
  return drawn;
}

export function trafficHit(glyphs: readonly TrafficGlyph[], x: number, y: number, slop = 14): TrafficGlyph | null {
  let best: TrafficGlyph | null = null;
  let bestD = slop * slop;
  for (const glyph of glyphs) {
    const d = (glyph.x - x) ** 2 + (glyph.y - y) ** 2;
    if (d <= bestD) {
      best = glyph;
      bestD = d;
    }
  }
  return best;
}

/** Keep the one-line card inside the map, beside the glyph, clear of controls. */
export function trafficCardOrigin(
  x: number,
  y: number,
  cardWidth: number,
  cardHeight: number,
  viewWidth: number,
  viewHeight: number,
  avoid?: readonly TrafficAvoid[],
): { left: number; top: number } {
  const clear = (left: number, top: number) => left >= 8 && top >= 8
    && left + cardWidth <= viewWidth - 8 && top + cardHeight <= viewHeight - 8
    && !hitsAvoid(left, top, left + cardWidth, top + cardHeight, avoid);
  const candidates = [
    { left: x + 12, top: y - cardHeight - 8 },
    { left: x - cardWidth - 12, top: y - cardHeight - 8 },
    { left: x + 12, top: y + 12 },
    { left: x - cardWidth - 12, top: y + 12 },
  ];
  for (const candidate of candidates) {
    if (clear(candidate.left, candidate.top)) return candidate;
  }
  let left = x + 12;
  let top = y - cardHeight - 8;
  if (top < 8) top = y + 12;
  if (left + cardWidth > viewWidth - 8) left = Math.max(8, x - cardWidth - 12);
  if (left < 8) left = 8;
  if (top + cardHeight > viewHeight - 8) top = Math.max(8, viewHeight - cardHeight - 8);
  for (const zone of avoid ?? []) {
    if (!hitsAvoid(left, top, left + cardWidth, top + cardHeight, [zone])) continue;
    const leftOf = zone.x - cardWidth - 4;
    if (leftOf >= 8) left = leftOf;
    else if (zone.y + zone.h + 4 + cardHeight <= viewHeight - 8) top = zone.y + zone.h + 4;
  }
  return { left, top };
}

/**
 * Fetch immediately, then every 10 s, and only while `visible` is true.
 * `kick` refetches after a tile change, but not twice inside 5 s.
 */
export function bindTrafficPoll(deps: {
  visible: () => boolean;
  pull: () => Promise<void>;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  now?: () => number;
}): { start: () => void; stop: () => void; kick: () => void; onVisibility: () => void } {
  let handle: unknown = null;
  let stopped = true;
  let pulling = false;
  let lastPull = Number.NEGATIVE_INFINITY;
  const now = () => deps.now?.() ?? Date.now();
  const clear = () => {
    if (handle != null) deps.cancel(handle);
    handle = null;
  };
  const arm = () => {
    clear();
    if (stopped || !deps.visible()) return;
    handle = deps.schedule(() => {
      handle = null;
      void run();
    }, TRAFFIC_POLL_MS);
  };
  const run = async () => {
    if (stopped || !deps.visible() || pulling) return;
    pulling = true;
    lastPull = now();
    try {
      await deps.pull();
    } catch {
      /* keep the last picture */
    }
    pulling = false;
    if (!stopped && deps.visible()) arm();
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void run();
    },
    stop() {
      stopped = true;
      clear();
    },
    kick() {
      if (stopped || !deps.visible() || pulling) return;
      if (now() - lastPull < TRAFFIC_KICK_MS) return;
      clear();
      void run();
    },
    onVisibility() {
      if (stopped) return;
      if (!deps.visible()) clear();
      else if (handle == null && !pulling) void run();
    },
  };
}

/** Enforce the byte cap while reading, including chunked upstream responses. */
export async function readTrafficJson(response: Response, maxBytes: number): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > maxBytes || !response.body) { await response.body?.cancel(); return null; }
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = '', size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally { reader.releaseLock(); }
}

/** Bbox queries use a circumscribed, capped source circle. Centre/radius remains compatible. */
export function trafficQuery(params: URLSearchParams): { lat: number; lon: number; radiusNm: number } | null {
  if (params.has('bbox')) {
    const raw = params.get('bbox')!.split(',');
    if (raw.length !== 4 || raw.some((n) => !n.trim())) return null;
    const [west, south, east, north] = raw.map(Number);
    if (![west, south, east, north].every(Number.isFinite) || Math.abs(west) > 180 || Math.abs(east) > 180 || south < -90 || north > 90 || south >= north) return null;
    const span = (east - west + 360) % 360;
    if (span === 0) return null;
    const lat = (north + south) / 2, lon = ((west + span / 2 + 540) % 360) - 180;
    const radiusNm = Math.min(TRAFFIC_RADIUS_MAX_NM, Math.max(15, ...[south, north].flatMap((y) => [west, east].map((x) => distanceNm(lat, lon, y, x)))));
    return { lat, lon, radiusNm };
  }
  if (['lat', 'lon', 'radiusNm'].some((key) => !params.get(key)?.trim())) return null;
  const lat = Number(params.get('lat')), lon = Number(params.get('lon')), radiusNm = Number(params.get('radiusNm'));
  return trafficTile(lat, lon, radiusNm) ? { lat, lon, radiusNm } : null;
}
