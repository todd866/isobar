import { FT_PER_M, profileAt, skyState, type ProfileSeries, type SkyState } from './physics.ts';
import { reportAt, type SkyAirport } from './scene.ts';

/**
 * One point's feed: any place, not only an aerodrome. The profile is the
 * pressure-level series (ECMWF upper air today; any per-point source later);
 * the report (METAR/TAF) is optional and only an aerodrome has one.
 */
export interface SkyFeed {
  lat: number;
  lon: number;
  /** Shown on the ground line and used as the picture's seed, e.g. "YPPH". */
  name: string;
  /** Ground elevation, ft AMSL (AIP for an aerodrome). */
  elevationFt: number | null;
  /** Signed distance to the coast along the W–E section, km; null inland or unknown. */
  coastKm: number | null;
  profile: (Omit<ProfileSeries, 'elevationFt'> & { elevationFt: number | null }) | null;
  report: { metar: SkyAirport['metar']; taf: SkyAirport['taf'] } | null;
  nowMs: number;
  timeMs?: number;
}

/** A missing elevation is an unlocated ground, never a sea-level aerodrome. */
export function sceneForFeed(feed: SkyFeed, timeMs: number): { state: SkyState; groundKnown: boolean } {
  const groundKnown = feed.elevationFt != null && Number.isFinite(feed.elevationFt);
  const profile = profileAt(feed.profile ? { ...feed.profile, elevationFt: feed.elevationFt ?? 0 } : null, timeMs);
  const floorFt = groundKnown ? feed.elevationFt! : (profile?.levels[0]?.zM ?? 0) * FT_PER_M;
  // Reported cloud bases are AGL. Without terrain their AMSL heights are unknown.
  const report = feed.report && groundKnown
    ? reportAt({ icao: feed.name, lat: feed.lat, lon: feed.lon, ...feed.report }, timeMs, feed.nowMs)
    : { source: 'none' as const, groups: [] };
  const state = skyState({ icao: feed.name, elevationFt: floorFt, lat: feed.lat, lon: feed.lon,
    timeMs, source: report.source, groups: report.groups, profile });
  if (!groundKnown) {
    state.surface = null;
    state.parcel = null;
    // A first cold model level is not evidence of freezing at the surface.
    state.freezingAllFt = state.freezingAllFt.filter(ft => ft > floorFt);
    state.freezingFt = state.freezingAllFt[0] ?? null;
  }
  return { state, groundKnown };
}
