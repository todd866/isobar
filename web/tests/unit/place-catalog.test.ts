import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AirportRow } from '../../src/lib/airports';
import {
  FLY_RADIUS_KM, airportId, haversineKm, nearestAirports, nearestCatalogPlace, placeChoices, searchPlaces, townId,
  type ManifestPlace,
} from '../../src/lib/place-catalog';
import type { PlaceRow } from '../../src/lib/places';

const towns = JSON.parse(readFileSync('public/places/world-places.json', 'utf8')) as PlaceRow[];
const airports = JSON.parse(readFileSync('public/places/airports.json', 'utf8')) as AirportRow[];
const manifest: ManifestPlace[] = [
  { id: 'perth', name: 'Perth', lat: -31.95, lon: 115.86, zone: 'Australia/Perth' },
  { id: 'sydney', name: 'Sydney', lat: -33.87, lon: 151.21, zone: 'Australia/Sydney' },
];

describe('place catalog', () => {
  it('keeps one ICAO per large or medium airport', () => {
    const seen = new Set<string>();
    expect(airports.length).toBeGreaterThan(4000);
    for (const row of airports) {
      expect(row[0]).toMatch(/^[A-Z]{4}$/);
      expect(row[6] === 0 || row[6] === 1).toBe(true);
      expect(seen.has(row[0])).toBe(false);
      seen.add(row[0]);
    }
  });

  it('ranks an exact town name ahead of the airport, and resolves ICAO and IATA', () => {
    const seattle = searchPlaces('Seattle', towns, airports);
    expect(seattle[0]).toMatchObject({ name: 'Seattle', datum: 'WA', id: townId(47.572, -122.342) });
    expect(seattle.some((place) => place.id === airportId('KSEA'))).toBe(true);
    expect(searchPlaces('KSEA', towns, airports)[0].id).toBe('a.KSEA');
    expect(searchPlaces('SEA', towns, airports)[0].id).toBe('a.KSEA');
    expect(searchPlaces('CYYC', towns, airports)[0].id).toBe('a.CYYC');
    expect(searchPlaces('S', towns, airports)).toEqual([]);
  });

  it('prefers the collector place over the Natural Earth town of the same name', () => {
    const hits = searchPlaces('Perth', towns, airports, manifest);
    expect(hits[0].id).toBe('perth');
    // The Natural Earth Perth, WA folds into the collector's Perth; Perth, Scotland is another town.
    expect(hits.some((place) => place.name === 'Perth' && !place.manifest && place.kind === 'town' && place.lat < 0)).toBe(false);
  });

  it('lists saved places before collector places', () => {
    const choices = placeChoices(['a.KSEA'], manifest, towns, airports);
    expect(choices[0].id).toBe('a.KSEA');
    expect(choices.map((place) => place.id)).toEqual(expect.arrayContaining(['perth', 'sydney']));
  });

  it('picks the nearest catalogue town from a coarse fix', () => {
    expect(nearestCatalogPlace(-19.3, 146.8, towns, [])?.name).toBe('Townsville');
    expect(nearestCatalogPlace(-33.9, 151.2, towns, manifest)?.id).toBe('sydney');
    expect(nearestCatalogPlace(0, -150, towns, manifest)).toBeNull();
  });

  it('returns only aerodromes inside 50 km, nearest first', () => {
    const rows = nearestAirports(47.572, -122.342, airports);
    expect(rows[0][0]).toBe('KBFI');
    expect(rows.some((row) => row[0] === 'KSEA')).toBe(true);
    for (const row of rows) expect(haversineKm(47.572, -122.342, row[3], row[4])).toBeLessThanOrEqual(FLY_RADIUS_KM);
    expect(nearestAirports(-23.701, 133.88, [['KSEA', 'SEA', 'Seattle–Tacoma', 47.448, -122.31, 'Seattle', 0]])).toEqual([]);
  });
});
