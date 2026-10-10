import { sliceCoordinates, type AtmosphereSlice } from '../atmosphere-slice';
import route from '../terrain/everest-route.json';
import { everestTeamPosition, type EverestTeamPosition } from '../everest-timeline';

export interface SectionRoutePoint {
  acrossM: number;
  heightM: number;
  lat: number;
  lon: number;
  routeIndex: number;
}

export interface SectionRouteProjection {
  runs: SectionRoutePoint[][];
  marker: SectionRoutePoint | null;
}

const EMPTY: SectionRouteProjection = { runs: [], marker: null };

function point(slice: AtmosphereSlice, value: { lat: number; lon: number; elevation_m: number }, routeIndex: number): SectionRoutePoint | null {
  const { acrossM, depthM } = sliceCoordinates(slice, value.lat, value.lon);
  // The displayed section is a projection of the route onto the across axis;
  // retain a bounded local neighbourhood even when the map's slab is thin.
  const depthLimit = Math.max(slice.halfDepthM, slice.halfWidthM * 2);
  if (!Number.isFinite(acrossM) || !Number.isFinite(depthM) || Math.abs(acrossM) > slice.halfWidthM || Math.abs(depthM) > depthLimit) return null;
  return { acrossM, heightM: value.elevation_m, lat: value.lat, lon: value.lon, routeIndex };
}

function markerPoint(slice: AtmosphereSlice, team: EverestTeamPosition): SectionRoutePoint | null {
  const { acrossM, depthM } = sliceCoordinates(slice, team.lat, team.lon);
  const depthLimit = Math.max(slice.halfDepthM, slice.halfWidthM * 2);
  if (!Number.isFinite(acrossM) || !Number.isFinite(depthM) || Math.abs(acrossM) > slice.halfWidthM || Math.abs(depthM) > depthLimit) return null;
  return { acrossM, heightM: team.heightM, lat: team.lat, lon: team.lon, routeIndex: team.routeIndex };
}

/** Project the prepared Everest route onto a slice; heights remain approximate DEM heights. */
export function projectEverestSectionRoute(slice: AtmosphereSlice | null | undefined, timeMs: number, enabled = true): SectionRouteProjection {
  if (!enabled || !slice || !Number.isFinite(timeMs)) return EMPTY;
  const runs: SectionRoutePoint[][] = [];
  let run: SectionRoutePoint[] = [];
  route.points.forEach((value, index) => {
    const projected = point(slice, value, index);
    if (projected) run.push(projected);
    else if (run.length) { runs.push(run); run = []; }
  });
  if (run.length) runs.push(run);
  const team = everestTeamPosition(timeMs);
  return { runs, marker: team ? markerPoint(slice, team) : null };
}
