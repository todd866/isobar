/** Licences named on every connector response. */
export const CONNECTOR_ATTRIBUTION = [
  { source: 'ECMWF', licence: 'CC BY 4.0' },
  { source: 'Open-Meteo', licence: 'CC BY 4.0' },
  { source: 'aviationweather.gov', licence: 'US public domain' },
] as const;

const RUN_STEP_MS = 12 * 60 * 60 * 1000;
const CACHE_CAP_S = 6 * 60 * 60;
const CACHE_FLOOR_S = 60;

/**
 * CDN lifetime of this published run. ECMWF open-data cycles are 12 h apart.
 * A run older than that is cached for a minute so a newer publish shows up.
 * The cap is 6 h so a hot deploy is not stuck behind a full cycle.
 */
export function runCacheSeconds(runIso: string | null | undefined, nowMs: number): number {
  const runMs = runIso ? Date.parse(runIso) : Number.NaN;
  if (!Number.isFinite(runMs)) return CACHE_FLOOR_S;
  const remain = Math.floor((runMs + RUN_STEP_MS - nowMs) / 1000);
  if (remain < CACHE_FLOOR_S) return CACHE_FLOOR_S;
  return Math.min(remain, CACHE_CAP_S);
}

export function cacheHeaders(seconds: number): { 'cache-control': string; 'vercel-cdn-cache-control': string } {
  return {
    'cache-control': `public, max-age=60, s-maxage=${seconds}`,
    'vercel-cdn-cache-control': `public, s-maxage=${seconds}`,
  };
}
