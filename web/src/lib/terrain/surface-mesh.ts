/** Focus-adaptive terrain mesh for the close tilted surface. */
export interface SurfaceMeshBox { west: number; south: number; east: number; north: number }
export interface SurfaceMeshFocus { lat: number; lon: number }
export interface SurfaceMeshInput { box: SurfaceMeshBox; focus: SurfaceMeshFocus; halfHeightDeg: number }
export interface SurfaceMesh { vertices: Float32Array; indices: Uint32Array; columns: number; rows: number; lons: number[]; lats: number[] }

const MAX_AXIS = 385;

/** Bounded to useful DEM resolution; buckets prevent rebuilding on every wheel tick. */
export function surfaceMeshSpacing(halfHeightDeg: number): number {
  return Math.max(30, Math.min(80, Math.round(halfHeightDeg * 111320 / 256 / 10) * 10));
}

function axis(west: number, east: number, focus: number, targetMetres: number): number[] {
  const left = Math.max(0, Math.min(east - west, focus - west));
  const right = Math.max(0, Math.min(east - west, east - focus));
  const values: number[] = [];
  const addSide = (distance: number, sign: number) => {
    if (!(distance > 0)) return;
    const target = targetMetres / 111320;
    let ratio = 1.017;
    // When the retained mosaic is wide, spend the full budget while preserving
    // the requested near-focus spacing instead of coarsening the destination.
    if (target * (Math.pow(ratio, 192) - 1) / (ratio - 1) < distance) {
      let low = ratio, high = 2;
      for (let i = 0; i < 32; i++) {
        const mid = (low + high) / 2;
        if (target * (Math.pow(mid, 192) - 1) / (mid - 1) < distance) low = mid;
        else high = mid;
      }
      ratio = high;
    }
    const count = Math.max(1, Math.min(192, Math.ceil(Math.log1p(distance * (ratio - 1) / target) / Math.log(ratio))));
    const first = distance * (ratio - 1) / (Math.pow(ratio, count) - 1);
    for (let i = 1; i <= count; i++) {
      const travelled = first * (Math.pow(ratio, i) - 1) / (ratio - 1);
      values.push(focus + sign * travelled);
    }
  };
  addSide(left, -1);
  values.push(focus);
  addSide(right, 1);
  values.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const value of values) if (!unique.length || value - unique[unique.length - 1] > 1e-10) unique.push(value);
  return unique;
}

export function buildSurfaceMesh(input: SurfaceMeshInput): SurfaceMesh | null {
  const { box, focus } = input;
  if (![box.west, box.south, box.east, box.north, focus.lat, focus.lon, input.halfHeightDeg].every(Number.isFinite)) return null;
  if (!(box.east > box.west && box.north > box.south) || box.south < -90 || box.north > 90 || box.east - box.west > 360 || input.halfHeightDeg <= 0 || input.halfHeightDeg > 180 || focus.lat < box.south || focus.lat > box.north) return null;
  const spacing = surfaceMeshSpacing(input.halfHeightDeg);
  const lons = axis(box.west, box.east, Math.max(box.west, Math.min(box.east, focus.lon)), spacing);
  const lats = axis(box.south, box.north, focus.lat, spacing);
  if (lons.length < 2 || lats.length < 2 || lons.length > MAX_AXIS || lats.length > MAX_AXIS) return null;
  lons[0] = box.west; lons[lons.length - 1] = box.east; lats[0] = box.south; lats[lats.length - 1] = box.north;
  for (let i = 1; i < lons.length; i++) if (Math.fround(lons[i]) <= Math.fround(lons[i - 1])) return null;
  for (let i = 1; i < lats.length; i++) if (Math.fround(lats[i]) <= Math.fround(lats[i - 1])) return null;
  const vertices = new Float32Array(lons.length * lats.length * 4);
  for (let y = 0; y < lats.length; y++) for (let x = 0; x < lons.length; x++) {
    const at = (y * lons.length + x) * 4; vertices[at] = lons[x]; vertices[at + 1] = lats[y];
  }
  const indices = new Uint32Array((lons.length - 1) * (lats.length - 1) * 6); let at = 0;
  for (let y = 0; y < lats.length - 1; y++) for (let x = 0; x < lons.length - 1; x++) {
    const i = y * lons.length + x, n = i + lons.length;
    indices[at++] = i; indices[at++] = n; indices[at++] = i + 1;
    indices[at++] = i + 1; indices[at++] = n; indices[at++] = n + 1;
  }
  return { vertices, indices, columns: lons.length, rows: lats.length, lons, lats };
}
