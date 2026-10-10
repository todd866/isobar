import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AirportRow } from '../../src/lib/airports';
import { describePoint, formatCoordinates, waterName, type NamedPlace } from '../../src/lib/place-name';
import type { PlaceRow } from '../../src/lib/places';

const towns = JSON.parse(readFileSync('public/places/world-places.json', 'utf8')) as PlaceRow[];
const airports = JSON.parse(readFileSync('public/places/airports.json', 'utf8')) as AirportRow[];

describe('place names', () => {
  it('names the Townsville fix as Townsville, not the aerodrome or bare coordinates', () => {
    const title = describePoint({ lat: -19.42, lon: 146.58 }, { towns, airports }).title;
    expect(title).toMatch(/of Townsville$/);
    expect(title).not.toMatch(/Airport|°[NS]/);
    expect(describePoint({ lat: -19.25, lon: 146.77 }, { towns, airports }).title).toBe('Townsville');
  });

  it('names open ocean, and leaves a far inland point as coordinates', () => {
    const ocean = describePoint({ lat: 0, lon: -150 }, { towns, airports, atSea: true });
    expect(ocean.title).toBe('Pacific Ocean');
    expect(ocean.detail).toBe(formatCoordinates(0, -150));
    const inland = describePoint({ lat: 40, lon: -106 }, { towns, airports, atSea: false });
    expect(inland.title).toBe('40.00°N 106.00°W');
    expect(inland.detail).toBe('');
    expect(waterName(40, -106)).toBeNull();
  });

  it('prefers the more important town when two are close', () => {
    const big: NamedPlace = { name: 'Bigton', lat: 0, lon: 0.04, rank: 2, kind: 'town' };
    const little: NamedPlace = { name: 'Littleton', lat: 0, lon: 0.02, rank: 6, kind: 'town' };
    expect(describePoint({ lat: 0, lon: 0 }, { places: [little, big] }).title).toBe('Bigton');

    const west: NamedPlace = { name: 'Bigton', lat: 0, lon: 0, rank: 2, kind: 'town' };
    const east: NamedPlace = { name: 'Littleton', lat: 0, lon: 0.2, rank: 6, kind: 'town' };
    const between = describePoint({ lat: 0, lon: 0.1 }, { places: [east, west] }).title;
    expect(between).toMatch(/of Bigton$/);
    expect(between).not.toMatch(/Littleton/);
  });

  it('prefixes a sea when the point is offshore of a town', () => {
    const title = describePoint({ lat: -19.25, lon: 147.15 }, {
      towns: [['Townsville', -19.25, 146.77, 5, 'QLD']],
      atSea: true,
    }).title;
    expect(title).toMatch(/^Coral Sea, \d+ km E of Townsville$/);
  });
});
