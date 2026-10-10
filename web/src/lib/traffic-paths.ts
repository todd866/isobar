import type { TrafficAircraft, TrafficTrailPoint, TrafficTrail } from './traffic';

export type { TrafficTrailPoint };

export interface RouteAirport {
  icao: string;
  iata?: string;
  name?: string;
  latitude: number;
  longitude: number;
}

export interface FlightRoute {
  callsign: string;
  origin: RouteAirport;
  destination: RouteAirport;
}

export const MAX_TRACKS = 8;
// Web polling is 10 s. 1441 points retain four hours at that cadence while
// remaining a bounded per-aircraft buffer (this is local observation replay,
// not a historical provider/archive).
export const MAX_TRACK_POINTS = 1441;
export const MAX_TRACK_AGE_MS = 4 * 60 * 60_000;
export const MAX_REPLAY_GAP_MS = 2 * 60_000;
const PALETTE = ['#35d6c7', '#ffca5c', '#ff718d', '#8da7ff', '#c792ff', '#8ee06e', '#ff976b', '#61b9ff'] as const;
export const TRACK_COLORS = PALETTE;

/** Live ADS-B is reserved for an explicit Now-following, playing clock. */
export function liveTrafficAtTime(followNow: boolean | undefined, playing: boolean, selectedMs: number, nowMs: number): boolean {
  return followNow === true && playing && Number.isFinite(selectedMs) && Number.isFinite(nowMs) && Math.abs(selectedMs - nowMs) < 90_000;
}

function validPoint(point: TrafficTrailPoint): boolean {
  if (!point || typeof point !== 'object') return false;
  return Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 && Number.isFinite(point.longitude) &&
    Math.abs(point.longitude) <= 180 && Number.isFinite(point.timeMs);
}

/** Merge observations without changing old points, duplicate timestamps, or the four-hour bound. */
export function mergeTrackPoints(
  previous: readonly TrafficTrailPoint[],
  incoming: readonly TrafficTrailPoint[],
  nowMs: number,
  maxPoints = MAX_TRACK_POINTS,
): TrafficTrailPoint[] {
  const byTime = new Map<number, TrafficTrailPoint>();
  for (const point of [...previous, ...incoming]) {
    if (!validPoint(point) || point.timeMs > nowMs + 15_000 || nowMs - point.timeMs > MAX_TRACK_AGE_MS) continue;
    const prior = byTime.get(point.timeMs);
    if (!prior || (point.pressureAltitudeFt != null && prior.pressureAltitudeFt == null)) byTime.set(point.timeMs, { latitude: point.latitude, longitude: point.longitude, timeMs: point.timeMs, ...(Number.isFinite(point.pressureAltitudeFt) && point.pressureAltitudeFt! >= 0 && point.pressureAltitudeFt! <= 65600 ? { pressureAltitudeFt: point.pressureAltitudeFt } : {}) });
  }
  return [...byTime.values()].sort((a, b) => a.timeMs - b.timeMs).slice(-Math.max(1, maxPoints));
}

export function accumulateTracks(
  previous: ReadonlyMap<string, TrafficTrail>,
  aircraft: readonly TrafficAircraft[],
  nowMs: number,
  selectedHexes: readonly string[] = [],
): Map<string, TrafficTrail> {
  const next = new Map<string, TrafficTrail>();
  for (const row of aircraft) {
    const prior = previous.get(row.hex);
    const points = mergeTrackPoints(prior?.points ?? [], [{ latitude: row.latitude, longitude: row.longitude, timeMs: row.positionTimeMs, pressureAltitudeFt: row.pressureAltitudeFt }], nowMs);
    if (points.length) next.set(row.hex, { aircraft: prior && prior.aircraft.positionTimeMs > row.positionTimeMs ? prior.aircraft : row, points });
  }
  for (const [hex, trail] of previous) {
    if (next.has(hex)) continue;
    const points = mergeTrackPoints(trail.points, [], nowMs);
    if (points.length) next.set(hex, { ...trail, points });
  }
  const pinned = selectedHexes.slice(0, MAX_TRACKS).flatMap((hex) => next.has(hex) ? [[hex, next.get(hex)!] as const] : []);
  const selected = new Set(selectedHexes);
  return new Map([...pinned, ...[...next].filter(([hex]) => !selected.has(hex))].slice(0, 512));
}

function wrappedLongitude(from: number, to: number, fraction: number): number {
  let delta = to - from;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return ((from + delta * fraction + 540) % 360) - 180;
}

function bearing(from: TrafficTrailPoint, to: TrafficTrailPoint): number | undefined {
  if (from.latitude === to.latitude && from.longitude === to.longitude) return undefined;
  const r = Math.PI / 180;
  const y = Math.sin((to.longitude - from.longitude) * r) * Math.cos(to.latitude * r);
  const x = Math.cos(from.latitude * r) * Math.sin(to.latitude * r) - Math.sin(from.latitude * r) * Math.cos(to.latitude * r) * Math.cos((to.longitude - from.longitude) * r);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Sample a locally captured trail without inventing coverage across long gaps. */
export function sampleTrafficAtTime(trail: TrafficTrail, timeMs: number, maxGapMs = MAX_REPLAY_GAP_MS): TrafficAircraft | null {
  if (!Number.isFinite(timeMs) || !trail.points.length) return null;
  const points = trail.points;
  let low = 0, right = points.length;
  while (low < right) { const mid = (low + right) >>> 1; if (points[mid].timeMs < timeMs) low = mid + 1; else right = mid; }
  const left = right - 1;
  let point: TrafficTrailPoint;
  let heading: number | undefined;
  if (right < points.length && points[right].timeMs === timeMs) {
    point = points[right];
    if (right > 0 && points[right].timeMs - points[right - 1].timeMs <= maxGapMs) heading = bearing(points[right - 1], points[right]);
  } else if (left >= 0 && right < points.length && points[right].timeMs > points[left].timeMs && points[right].timeMs - points[left].timeMs <= maxGapMs) {
    const a = points[left], b = points[right];
    const fraction = (timeMs - a.timeMs) / (b.timeMs - a.timeMs);
    point = { latitude: a.latitude + (b.latitude - a.latitude) * fraction, longitude: wrappedLongitude(a.longitude, b.longitude, fraction), timeMs,
      ...(a.pressureAltitudeFt != null && b.pressureAltitudeFt != null ? { pressureAltitudeFt: a.pressureAltitudeFt + (b.pressureAltitudeFt - a.pressureAltitudeFt) * fraction } : {}) };
    heading = bearing(a, b);
  } else return null;
  const aircraft: TrafficAircraft = { ...trail.aircraft, latitude: point.latitude, longitude: point.longitude,
    distanceNm: Number.NaN, positionTimeMs: timeMs };
  delete aircraft.groundSpeedKt; delete aircraft.verticalRateFtMin; delete aircraft.squawk;
  aircraft.pressureAltitudeFt = point.pressureAltitudeFt ?? Number.NaN;
  if (heading != null) aircraft.trackDegrees = heading; else delete aircraft.trackDegrees;
  return aircraft;
}

/** Sample every captured aircraft at a replay timestamp; missing trails stay absent. */
export function trafficAtTime(trails: ReadonlyMap<string, TrafficTrail>, timeMs: number, maxGapMs = MAX_REPLAY_GAP_MS): TrafficAircraft[] {
  return [...trails.values()].flatMap((trail) => { const aircraft = sampleTrafficAtTime(trail, timeMs, maxGapMs); return aircraft ? [aircraft] : []; });
}

function hash(text: string): number { let n = 2166136261; for (let i = 0; i < text.length; i += 1) n = Math.imul(n ^ text.charCodeAt(i), 16777619); return n >>> 0; }

/** Stable palette assignment. The selected set is capped and gets collision-free slots. */
export function assignTrackColors(hexes: readonly string[]): Map<string, string> {
  const unique = [...new Set(hexes)].slice(0, MAX_TRACKS);
  const used = new Set<number>();
  const out = new Map<string, string>();
  for (const hex of unique) {
    let slot = hash(hex) % PALETTE.length;
    while (used.has(slot)) slot = (slot + 1) % PALETTE.length;
    used.add(slot); out.set(hex, PALETTE[slot]);
  }
  return out;
}

export function greatCirclePoints(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }, count = 24): Array<{ latitude: number; longitude: number }> {
  const n = Math.max(2, Math.min(128, Math.floor(count)));
  const r = Math.PI / 180;
  const a = [Math.cos(from.latitude * r) * Math.cos(from.longitude * r), Math.cos(from.latitude * r) * Math.sin(from.longitude * r), Math.sin(from.latitude * r)];
  const b = [Math.cos(to.latitude * r) * Math.cos(to.longitude * r), Math.cos(to.latitude * r) * Math.sin(to.longitude * r), Math.sin(to.latitude * r)];
  const omega = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1); const s = Math.sin(omega);
    const k1 = s < 1e-8 ? 1 - t : Math.sin((1 - t) * omega) / s; const k2 = s < 1e-8 ? t : Math.sin(t * omega) / s;
    const x = k1 * a[0] + k2 * b[0]; const y = k1 * a[1] + k2 * b[1]; const z = k1 * a[2] + k2 * b[2];
    return { latitude: Math.atan2(z, Math.hypot(x, y)) / r, longitude: Math.atan2(y, x) / r };
  });
}

export const greatCircle = greatCirclePoints;

function airport(raw: unknown): RouteAirport | null {
  if (!raw || typeof raw !== 'object') return null; const row = raw as Record<string, unknown>;
  const icaoValue = row.icao ?? row.airport_icao;
  const icao = typeof icaoValue === 'string' ? icaoValue.trim().toUpperCase() : '';
  const latitude = row.latitude ?? row.lat; const longitude = row.longitude ?? row.lon;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (!/^[A-Z0-9]{4}$/.test(icao) || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const out: RouteAirport = { icao, latitude, longitude };
  const iata = row.iata ?? row.airport_iata;
  if (typeof iata === 'string' && iata.trim()) out.iata = iata.trim().toUpperCase().slice(0, 3);
  if (typeof row.name === 'string' && row.name.trim()) out.name = row.name.trim().slice(0, 120);
  return out;
}

/** Parse the adsbdb response shape, rejecting malformed or partial routes. */
export function parseFlightRoute(payload: unknown, callsign: string): FlightRoute | null {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const response = root.response && typeof root.response === 'object' ? root.response as Record<string, unknown> : root;
  const route = response.flightroute && typeof response.flightroute === 'object' ? response.flightroute as Record<string, unknown> : response;
  const origin = airport(route.origin); const destination = airport(route.destination);
  if (!origin || !destination) return null; return { callsign: callsign.trim().toUpperCase().slice(0, 12), origin, destination };
}

export interface TrafficSelection { hex: string; colorIndex: number; }
/** Retain existing colours when any peer is removed; reuse only a freed slot. */
export function toggleTrafficSelection(current: readonly TrafficSelection[], hex: string): TrafficSelection[] {
  if (current.some((item) => item.hex === hex)) return current.filter((item) => item.hex !== hex);
  if (current.length >= MAX_TRACKS) return [...current];
  const used = new Set(current.map((item) => item.colorIndex));
  let colorIndex = hash(hex) % MAX_TRACKS;
  while (used.has(colorIndex)) colorIndex = (colorIndex + 1) % MAX_TRACKS;
  return [...current, { hex, colorIndex }];
}
