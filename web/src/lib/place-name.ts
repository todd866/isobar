/**
 * Offline name for a tapped point. Towns are Natural Earth populated places
 * (rank is min_zoom; lower is more important). Aerodromes and the collector
 * catalogue are the other names we already ship. A sea name is used only when
 * the caller already knows the point is off the coastline.
 */
import type { AirportRow } from './airports';
import { distanceBearing } from './metar-view';
import type { PlaceRow } from './places';

export const NEAR_PLACE_KM = 5;
export const RELATIVE_PLACE_KM = 60;
/** A more important place can win when it is only this much farther. */
const CLOSE_KM = 12;

export interface NamedPlace {
  name: string;
  lat: number;
  lon: number;
  /** Lower wins. Collector places use -1, towns use min_zoom, aerodromes sit behind towns. */
  rank: number;
  kind: 'town' | 'airport' | 'manifest';
}

export interface PlaceTitle {
  title: string;
  /** Coordinates on the secondary line. Empty when the title is already coordinates. */
  detail: string;
  km: number | null;
  hit: NamedPlace | null;
}

interface WaterBox {
  name: string;
  south: number;
  north: number;
  west: number;
  east: number;
}

/** Smaller seas before oceans. Boxes are coarse; they apply only off the coast. */
const WATERS: readonly WaterBox[] = [
  { name: 'Coral Sea', south: -24, north: -10, west: 146, east: 160 },
  { name: 'Tasman Sea', south: -45, north: -30, west: 150, east: 175 },
  { name: 'Great Australian Bight', south: -38, north: -32, west: 120, east: 145 },
  { name: 'Timor Sea', south: -15, north: -8, west: 124, east: 132 },
  { name: 'Arafura Sea', south: -12, north: -6, west: 132, east: 142 },
  { name: 'Indian Ocean', south: -50, north: 25, west: 20, east: 115 },
  { name: 'Atlantic Ocean', south: -55, north: 70, west: -70, east: 20 },
  // East edge stops offshore of the Americas so inland longitudes stay unnamed.
  { name: 'Pacific Ocean', south: -60, north: 60, west: 145, east: -130 },
  { name: 'Southern Ocean', south: -80, north: -55, west: -180, east: 180 },
  { name: 'Arctic Ocean', south: 70, north: 90, west: -180, east: 180 },
];

export function formatCoordinates(lat: number, lon: number): string {
  const ns = lat < 0 ? 'S' : 'N';
  const ew = lon < 0 ? 'W' : 'E';
  return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
}

function inLon(lon: number, west: number, east: number): boolean {
  if (west <= east) return lon >= west && lon <= east;
  return lon >= west || lon <= east;
}

export function waterName(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const box of WATERS) {
    if (lat < box.south || lat > box.north) continue;
    if (inLon(lon, box.west, box.east)) return box.name;
  }
  return null;
}

function lonDelta(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

type Measured = NamedPlace & { km: number };

function measured(place: NamedPlace, lat: number, lon: number): Measured {
  return { ...place, km: distanceBearing(lat, lon, place.lat, place.lon).km };
}

function better(a: Measured, b: Measured): number {
  return a.rank - b.rank || a.km - b.km || a.name.localeCompare(b.name);
}

export function describePoint(point: { lat: number; lon: number }, input: {
  places?: readonly NamedPlace[];
  towns?: readonly PlaceRow[];
  airports?: readonly AirportRow[];
  manifest?: readonly { name: string; lat: number; lon: number }[];
  atSea?: boolean;
} = {}): PlaceTitle {
  const lat = point.lat;
  const lon = point.lon;
  const cos = Math.max(0.05, Math.cos(lat * Math.PI / 180));
  const latPad = 1.2;
  const lonPad = 1.2 / cos;
  const pool: Measured[] = [];
  const push = (place: NamedPlace) => {
    if (Math.abs(place.lat - lat) > latPad || lonDelta(place.lon, lon) > lonPad) return;
    const row = measured(place, lat, lon);
    if (row.km <= RELATIVE_PLACE_KM) pool.push(row);
  };
  for (const place of input.places ?? []) push(place);
  for (const place of input.manifest ?? []) push({ name: place.name, lat: place.lat, lon: place.lon, rank: -1, kind: 'manifest' });
  for (const row of input.towns ?? []) push({ name: row[0], lat: row[1], lon: row[2], rank: row[3], kind: 'town' });
  for (const row of input.airports ?? []) push({ name: row[2], lat: row[3], lon: row[4], rank: 100 + row[6], kind: 'airport' });

  const near = pool.filter((place) => place.km <= NEAR_PLACE_KM).sort(better)[0] ?? null;
  let chosen: Measured | null = near;
  if (!chosen && pool.length) {
    const nearest = pool.reduce((best, place) => (place.km < best.km ? place : best));
    chosen = pool.filter((place) => place.km <= nearest.km + CLOSE_KM).sort(better)[0] ?? nearest;
  }

  const coords = formatCoordinates(lat, lon);
  const water = input.atSea ? waterName(lat, lon) : null;
  let title = coords;
  if (chosen && chosen.km <= NEAR_PLACE_KM) title = chosen.name;
  else if (chosen) {
    const from = distanceBearing(chosen.lat, chosen.lon, lat, lon);
    const relative = `${Math.max(1, Math.round(chosen.km))} km ${from.bearing} of ${chosen.name}`;
    title = water ? `${water}, ${relative}` : relative;
  } else if (water) title = water;

  return {
    title,
    detail: title === coords ? '' : coords,
    km: chosen?.km ?? null,
    hit: chosen ? { name: chosen.name, lat: chosen.lat, lon: chosen.lon, rank: chosen.rank, kind: chosen.kind } : null,
  };
}
