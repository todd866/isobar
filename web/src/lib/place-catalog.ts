/**
 * One place the header can hold: a Natural Earth town, an OurAirports
 * aerodrome, or a point from "My location". Ids match the account settings
 * token (`^[A-Za-z0-9_.:-]+$`, at most 64 characters).
 */
import type { AirportRow } from './airports';
import { describePoint, formatCoordinates } from './place-name';
import type { PlaceRow } from './places';

export const FLY_RADIUS_KM = 50;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const NEAR_MANIFEST_KM = 40;

export interface CatalogPlace {
  id: string;
  name: string;
  /** Region code or ICAO, the right-hand column. */
  datum: string;
  lat: number;
  lon: number;
  kind: 'town' | 'airport';
  zone: string;
  manifest: boolean;
  /** IATA, when the row is an airport that has one. */
  iata: string;
}

export interface ManifestPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  zone: string;
}

export function isPlaceId(id: string): boolean {
  return ID_RE.test(id);
}

export function townId(lat: number, lon: number): string {
  return `t.${Math.round(lat * 1000)}.${Math.round(lon * 1000)}`;
}

export function airportId(icao: string): string {
  return `a.${icao.toUpperCase()}`;
}

export function geoId(lat: number, lon: number): string {
  return `g.${Math.round(lat * 1000)}.${Math.round(lon * 1000)}`;
}

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function coordLabel(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew}`;
}

function parseCoordId(id: string, prefix: 't' | 'g'): { lat: number; lon: number } | null {
  const match = new RegExp(`^${prefix}\\.(-?\\d+)\\.(-?\\d+)$`).exec(id);
  if (!match) return null;
  const lat = Number(match[1]) / 1000;
  const lon = Number(match[2]) / 1000;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function manifestCatalog(place: ManifestPlace): CatalogPlace {
  return {
    id: place.id, name: place.name, datum: '', lat: place.lat, lon: place.lon,
    kind: 'town', zone: place.zone, manifest: true, iata: '',
  };
}

function townCatalog(row: PlaceRow): CatalogPlace {
  const [name, lat, lon, , region] = row;
  return {
    id: townId(lat, lon), name, datum: region ?? '', lat, lon,
    kind: 'town', zone: '', manifest: false, iata: '',
  };
}

function airportCatalog(row: AirportRow): CatalogPlace {
  const [icao, iata, name, lat, lon] = row;
  return {
    id: airportId(icao), name, datum: icao, lat, lon,
    kind: 'airport', zone: '', manifest: false, iata,
  };
}

function nearestTown(lat: number, lon: number, towns: readonly PlaceRow[], withinKm: number): PlaceRow | null {
  let best: PlaceRow | null = null;
  let bestKm = withinKm;
  for (const row of towns) {
    const km = haversineKm(lat, lon, row[1], row[2]);
    if (km < bestKm) { bestKm = km; best = row; }
  }
  return best;
}

export function resolvePlace(
  id: string,
  manifest: readonly ManifestPlace[],
  towns: readonly PlaceRow[],
  airports: readonly AirportRow[],
  options?: { atSea?: boolean },
): CatalogPlace | null {
  if (!isPlaceId(id)) return null;
  const known = manifest.find((place) => place.id === id);
  if (known) return manifestCatalog(known);
  if (id.startsWith('a.')) {
    const icao = id.slice(2).toUpperCase();
    const row = airports.find((item) => item[0] === icao);
    return row ? airportCatalog(row) : null;
  }
  const prefix = id.startsWith('g.') ? 'g' : id.startsWith('t.') ? 't' : null;
  if (!prefix) return null;
  const coord = parseCoordId(id, prefix);
  if (!coord) return null;
  if (prefix === 'g') {
    const named = placeForPoint(coord.lat, coord.lon, manifest, towns, airports, options);
    return named.id.startsWith('g.') ? { ...named, id } : named;
  }
  const exact = towns.find((row) => townId(row[1], row[2]) === id);
  const town = exact ?? nearestTown(coord.lat, coord.lon, towns, 1);
  if (town && haversineKm(coord.lat, coord.lon, town[1], town[2]) <= 1) {
    return { ...townCatalog(town), id, lat: coord.lat, lon: coord.lon };
  }
  return {
    id, name: coordLabel(coord.lat, coord.lon), datum: '',
    lat: coord.lat, lon: coord.lon, kind: 'town', zone: '', manifest: false, iata: '',
  };
}

/**
 * The place a tap or a geolocation fix becomes. Within 5 km that is the
 * catalogue town, aerodrome or collector place. Farther away the name is the
 * relative title (or coordinates) and the id stays on the fix.
 */
export function placeForPoint(
  lat: number,
  lon: number,
  manifest: readonly ManifestPlace[],
  towns: readonly PlaceRow[],
  airports: readonly AirportRow[],
  options?: { atSea?: boolean },
): CatalogPlace {
  const described = describePoint({ lat, lon }, { towns, airports, manifest, atSea: options?.atSea });
  const hit = described.hit;
  if (hit && described.km != null && described.km <= 5) {
    if (hit.kind === 'manifest') {
      const found = manifest.find((place) => place.name === hit.name && haversineKm(place.lat, place.lon, hit.lat, hit.lon) < 1);
      if (found) return manifestCatalog(found);
    }
    if (hit.kind === 'airport') {
      const row = airports.find((item) => haversineKm(item[3], item[4], hit.lat, hit.lon) < 1);
      if (row) return airportCatalog(row);
    }
    if (hit.kind === 'town') {
      const row = towns.find((item) => item[0] === hit.name && haversineKm(item[1], item[2], hit.lat, hit.lon) < 1);
      if (row) return townCatalog(row);
    }
  }
  const roundedLat = Math.round(lat * 1000) / 1000;
  const roundedLon = Math.round(lon * 1000) / 1000;
  const coords = formatCoordinates(roundedLat, roundedLon);
  return {
    id: geoId(roundedLat, roundedLon),
    name: described.title,
    datum: described.title === coords ? '' : coords,
    lat: roundedLat,
    lon: roundedLon,
    kind: 'town',
    zone: '',
    manifest: false,
    iata: '',
  };
}

/** Nearest catalogue town for a coarse fix. Null when the nearest is farther than `maxKm`. */
export function nearestCatalogPlace(
  lat: number,
  lon: number,
  towns: readonly PlaceRow[],
  manifest: readonly ManifestPlace[],
  maxKm = 200,
): CatalogPlace | null {
  let bestTown: { row: PlaceRow; km: number } | null = null;
  for (const row of towns) {
    const km = haversineKm(lat, lon, row[1], row[2]);
    if (!bestTown || km < bestTown.km) bestTown = { row, km };
  }
  let bestManifest: { place: ManifestPlace; km: number } | null = null;
  for (const place of manifest) {
    const km = haversineKm(lat, lon, place.lat, place.lon);
    if (!bestManifest || km < bestManifest.km) bestManifest = { place, km };
  }
  let chosen: CatalogPlace | null = null;
  let chosenKm = Infinity;
  if (bestManifest && bestTown) {
    const same = bestManifest.place.name.toLowerCase() === bestTown.row[0].toLowerCase();
    if (bestManifest.km <= bestTown.km || (same && bestManifest.km <= 40)) {
      chosen = manifestCatalog(bestManifest.place);
      chosenKm = bestManifest.km;
    } else {
      chosen = townCatalog(bestTown.row);
      chosenKm = bestTown.km;
    }
  } else if (bestTown) {
    chosen = townCatalog(bestTown.row);
    chosenKm = bestTown.km;
  } else if (bestManifest) {
    chosen = manifestCatalog(bestManifest.place);
    chosenKm = bestManifest.km;
  }
  return chosen && chosenKm <= maxKm ? chosen : null;
}

export function herePlace(lat: number, lon: number, towns: readonly PlaceRow[]): CatalogPlace {
  return placeForPoint(lat, lon, [], towns, []);
}

/** Saved places first, then collector places not already saved. */
export function placeChoices(
  savedIds: readonly string[],
  manifest: readonly ManifestPlace[],
  towns: readonly PlaceRow[],
  airports: readonly AirportRow[],
  limit = 8,
): CatalogPlace[] {
  const out: CatalogPlace[] = [];
  const seen = new Set<string>();
  const push = (place: CatalogPlace | null) => {
    if (!place || seen.has(place.id) || out.length >= limit) return;
    seen.add(place.id);
    out.push(place);
  };
  for (const id of savedIds) push(resolvePlace(id, manifest, towns, airports));
  for (const place of manifest) push(manifestCatalog(place));
  return out;
}

function townScore(query: string, name: string, rank: number): number | null {
  const n = name.toLowerCase();
  let tier: number | null = null;
  if (n === query) tier = 1;
  else if (n.startsWith(query)) tier = 2;
  else if (n.split(/[\s,.-]+/).some((word) => word.startsWith(query))) tier = 3;
  else if (n.includes(query)) tier = 4;
  else return null;
  return tier * 1000 + rank;
}

function airportScore(query: string, row: AirportRow): number | null {
  const [icao, iata, name, , , city, rank] = row;
  const n = name.toLowerCase();
  const c = city.toLowerCase();
  const code = icao.toLowerCase();
  const ata = iata.toLowerCase();
  let tier: number | null = null;
  if (code === query || (ata && ata === query)) tier = 0;
  else if (n === query) tier = 1;
  else if (n.startsWith(query) || code.startsWith(query)) tier = 2;
  else if (c === query || c.startsWith(query) || n.split(/[\s-]+/).some((word) => word.startsWith(query))) tier = 3;
  else if (n.includes(query) || c.includes(query)) tier = 4;
  else return null;
  return tier * 1000 + rank * 20;
}

function sameNameNear(name: string, lat: number, lon: number, manifest: readonly ManifestPlace[]): boolean {
  const wanted = name.toLowerCase();
  return manifest.some((place) => place.name.toLowerCase() === wanted && haversineKm(place.lat, place.lon, lat, lon) < NEAR_MANIFEST_KM);
}

/**
 * Ranked matches. Exact ICAO or IATA, then exact name, then prefix, then a
 * word or city, then a substring. A collector place wins over the Natural
 * Earth town of the same name within 40 km.
 */
export function searchPlaces(
  query: string,
  towns: readonly PlaceRow[],
  airports: readonly AirportRow[],
  manifest: readonly ManifestPlace[] = [],
  limit = 8,
): CatalogPlace[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: { place: CatalogPlace; score: number }[] = [];
  const seen = new Set<string>();
  const push = (place: CatalogPlace, score: number) => {
    if (seen.has(place.id)) return;
    seen.add(place.id);
    hits.push({ place, score });
  };
  for (const place of manifest) {
    const score = townScore(q, place.name, -1);
    if (score != null) push(manifestCatalog(place), score);
  }
  for (const row of towns) {
    if (sameNameNear(row[0], row[1], row[2], manifest)) continue;
    const score = townScore(q, row[0], row[3] * 10);
    if (score != null) push(townCatalog(row), score);
  }
  for (const row of airports) {
    const score = airportScore(q, row);
    if (score != null) push(airportCatalog(row), score);
  }
  hits.sort((a, b) => a.score - b.score || a.place.name.localeCompare(b.place.name) || a.place.id.localeCompare(b.place.id));
  return hits.slice(0, limit).map((hit) => hit.place);
}

export function nearestAirports(lat: number, lon: number, airports: readonly AirportRow[], radiusKm = FLY_RADIUS_KM, limit = 4): AirportRow[] {
  const scored: { row: AirportRow; km: number }[] = [];
  for (const row of airports) {
    const km = haversineKm(lat, lon, row[3], row[4]);
    if (km <= radiusKm) scored.push({ row, km });
  }
  scored.sort((a, b) => a.km - b.km || a.row[0].localeCompare(b.row[0]));
  return scored.slice(0, limit).map((item) => item.row);
}

export function nearestReported<T extends { lat: number; lon: number; metar: unknown; taf: unknown }>(
  lat: number,
  lon: number,
  airports: readonly T[],
  radiusKm = FLY_RADIUS_KM,
): T | null {
  let best: T | null = null;
  let bestKm = radiusKm;
  for (const airport of airports) {
    if (!airport.metar && !airport.taf) continue;
    const km = haversineKm(lat, lon, airport.lat, airport.lon);
    if (km <= bestKm) { bestKm = km; best = airport; }
  }
  return best;
}
