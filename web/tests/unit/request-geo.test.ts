import { describe, expect, it } from 'vitest';
import { coarseDegrees, geoFromHeaders, parseCoarseGeo } from '../../src/lib/request-geo';

function headers(rows: Record<string, string>): { get(name: string): string | null } {
  const map = new Map(Object.entries(rows).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

describe('request geo', () => {
  it('coarsens a fix to a tenth of a degree and rejects a bad pair', () => {
    expect(coarseDegrees(-33.8688)).toBe(-33.9);
    expect(parseCoarseGeo('-33.8688', '151.2093')).toEqual({ lat: -33.9, lon: 151.2 });
    expect(parseCoarseGeo('91', '0')).toBeNull();
    expect(parseCoarseGeo('', '1')).toBeNull();
    expect(parseCoarseGeo(null, null)).toBeNull();
  });

  it('reads Vercel headers only on Vercel, and the test override only when allowed', () => {
    const both = headers({
      'x-vercel-ip-latitude': '-33.87',
      'x-vercel-ip-longitude': '151.21',
      'x-vercel-ip-city': 'Sydney',
      'x-isobar-test-latitude': '-31.95',
      'x-isobar-test-longitude': '115.86',
    });
    expect(geoFromHeaders(both, {})).toBeNull();
    expect(geoFromHeaders(both, { vercel: '1' })).toEqual({ lat: -33.9, lon: 151.2 });
    expect(geoFromHeaders(both, { vercel: '1', allowTestGeo: '1' })).toEqual({ lat: -31.9, lon: 115.9 });
    expect(geoFromHeaders(headers({ 'x-isobar-test-latitude': '-19.26', 'x-isobar-test-longitude': '146.82' }), { allowTestGeo: '1' })).toEqual({ lat: -19.3, lon: 146.8 });
    expect(geoFromHeaders(headers({ 'x-isobar-test-latitude': '-19.26', 'x-isobar-test-longitude': '146.82' }), { vercel: '1' })).toBeNull();
  });
});
