/** Coarse visitor location from the platform, never an IP address. */

export interface CoarseGeo {
  lat: number;
  lon: number;
}

/** About 11 km. Enough to pick a town, not a street. */
export function coarseDegrees(value: number): number {
  return Math.round(value * 10) / 10;
}

export function parseCoarseGeo(latRaw: string | null, lonRaw: string | null): CoarseGeo | null {
  if (latRaw == null || lonRaw == null || latRaw.trim() === '' || lonRaw.trim() === '') return null;
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: coarseDegrees(lat), lon: coarseDegrees(lon) };
}

/**
 * Vercel fills `x-vercel-ip-latitude` / `x-vercel-ip-longitude` and overwrites
 * anything the client sent. Those headers are read only when `VERCEL` is set.
 * `x-isobar-test-latitude` / `x-isobar-test-longitude` are read only when the
 * server was started with `ISOBAR_ALLOW_TEST_GEO=1` (the Playwright server).
 * The city header and the IP are never returned.
 */
export function geoFromHeaders(headerList: { get(name: string): string | null }, env: { vercel?: string; allowTestGeo?: string } = {
  vercel: process.env.VERCEL,
  allowTestGeo: process.env.ISOBAR_ALLOW_TEST_GEO,
}): CoarseGeo | null {
  if (env.allowTestGeo === '1') {
    const test = parseCoarseGeo(headerList.get('x-isobar-test-latitude'), headerList.get('x-isobar-test-longitude'));
    if (test) return test;
  }
  if (env.vercel) {
    return parseCoarseGeo(headerList.get('x-vercel-ip-latitude'), headerList.get('x-vercel-ip-longitude'));
  }
  return null;
}
