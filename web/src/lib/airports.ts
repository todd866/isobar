/**
 * Large and medium airports with an ICAO code (OurAirports, public domain;
 * public/places/airports.json from scripts/pack-airports.mjs).
 * [icao, iata, name, lat, lon, city, rank] — rank 0 is large, 1 is medium.
 */

export type AirportRow = [string, string, string, number, number, string, number];

let loading: Promise<AirportRow[]> | null = null;

export function loadAirports(url = '/places/airports.json'): Promise<AirportRow[]> {
  if (!loading) {
    loading = fetch(url)
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: unknown) => (Array.isArray(rows) ? (rows as AirportRow[]) : []))
      .catch(() => {
        loading = null;
        return [];
      });
  }
  return loading;
}
