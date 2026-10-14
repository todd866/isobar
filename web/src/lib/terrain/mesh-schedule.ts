import type { SurfaceMeshBox, SurfaceMeshFocus } from './surface-mesh';

/** The tessellation a terrain mesh was (or is being) built for. */
export interface MeshBuild { box: SurfaceMeshBox; focus: SurfaceMeshFocus; spacing: number }
/** What the current camera wants: the mesh footprint, the footprint that must
 * stay covered, the focus and the near-focus spacing bucket. */
export interface MeshWant extends MeshBuild { required: SurfaceMeshBox; halfHeightDeg: number }

/** Share of the view half-height the focus may drift from the mesh focus
 * before its fine near-focus cells are too far behind to keep. */
const FOCUS_DRIFT = .5;

const contains = (outer: SurfaceMeshBox, inner: SurfaceMeshBox) =>
  inner.west >= outer.west && inner.east <= outer.east && inner.south >= outer.south && inner.north <= outer.north;

/**
 * Rebuild only when the mesh no longer serves the view: no mesh, a different
 * spacing bucket, the focus has left the inner half of the mesh (or drifted
 * from its fine cells by half a view), or the visible terrain footprint is no
 * longer inside it. Orbit, tilt and short flights keep the existing mesh.
 */
export function meshNeedsRebuild(current: MeshBuild | null, want: MeshWant): boolean {
  if (!current) return true;
  if (current.spacing !== want.spacing) return true;
  const { box } = current;
  const lon = want.focus.lon + 360 * Math.round(((box.west + box.east) / 2 - want.focus.lon) / 360);
  const innerW = (box.east - box.west) / 4, innerH = (box.north - box.south) / 4;
  const midLon = (box.west + box.east) / 2, midLat = (box.south + box.north) / 2;
  if (Math.abs(lon - midLon) > innerW || Math.abs(want.focus.lat - midLat) > innerH) return true;
  const cos = Math.max(.05, Math.cos(want.focus.lat * Math.PI / 180));
  const drift = Math.hypot((lon - current.focus.lon) * cos, want.focus.lat - current.focus.lat);
  if (drift > FOCUS_DRIFT * want.halfHeightDeg) return true;
  const shift = 360 * Math.round((midLon - (want.required.west + want.required.east) / 2) / 360);
  return !contains(box, { ...want.required, west: want.required.west + shift, east: want.required.east + shift });
}
