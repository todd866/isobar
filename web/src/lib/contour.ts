/** Marching-squares isobars on a regular lat/lon grid. Row 0 is north. */

export interface Polyline {
  level: number;
  closed: boolean;
  lon: Float32Array;
  lat: Float32Array;
}

export interface PressureCentre {
  kind: 'H' | 'L';
  lon: number;
  lat: number;
  hpa: number;
  /** Absolute depth relative to the surrounding 4° ring, in hPa. */
  prominence: number;
}

interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

function edgePoint(
  level: number,
  x0: number,
  y0: number,
  v0: number,
  x1: number,
  y1: number,
  v1: number,
): { x: number; y: number } {
  const span = v1 - v0;
  const t = span === 0 ? 0.5 : (level - v0) / span;
  const clamped = Math.min(1, Math.max(0, t));
  return { x: x0 + (x1 - x0) * clamped, y: y0 + (y1 - y0) * clamped };
}

/**
 * One cell. Corners are NW, NE, SE, SW in column/row space (row increases south).
 * Returns 0, 1 or 2 segments. Saddle cases follow the centre average.
 */
function cellSegments(
  level: number,
  i: number,
  j: number,
  nw: number,
  ne: number,
  se: number,
  sw: number,
): Segment[] {
  const bit = (value: number) => (value >= level ? 1 : 0);
  let mask = bit(sw) | (bit(se) << 1) | (bit(ne) << 2) | (bit(nw) << 3);
  if (mask === 0 || mask === 15) return [];
  const bottom = () => edgePoint(level, i, j + 1, sw, i + 1, j + 1, se);
  const right = () => edgePoint(level, i + 1, j + 1, se, i + 1, j, ne);
  const top = () => edgePoint(level, i + 1, j, ne, i, j, nw);
  const left = () => edgePoint(level, i, j, nw, i, j + 1, sw);
  const seg = (a: { x: number; y: number }, b: { x: number; y: number }): Segment => ({
    ax: a.x, ay: a.y, bx: b.x, by: b.y,
  });
  if (mask === 5 || mask === 10) {
    const centreHigh = (nw + ne + se + sw) / 4 >= level;
    // Mask 5: SW and NE are on the high side of the level. Mask 10 is the other diagonal.
    if ((mask === 5) === centreHigh) return [seg(top(), left()), seg(bottom(), right())];
    return [seg(left(), bottom()), seg(right(), top())];
  }
  const pairs: Record<number, [() => { x: number; y: number }, () => { x: number; y: number }]> = {
    1: [left, bottom],
    2: [bottom, right],
    3: [left, right],
    4: [right, top],
    6: [bottom, top],
    7: [left, top],
    8: [top, left],
    9: [top, bottom],
    11: [top, right],
    12: [right, left],
    13: [right, bottom],
    14: [bottom, left],
  };
  const pair = pairs[mask];
  if (!pair) return [];
  return [seg(pair[0](), pair[1]())];
}

function keyOf(x: number, y: number): string {
  return `${Math.round(x * 1000)}:${Math.round(y * 1000)}`;
}

function stitch(segments: Segment[]): { points: { x: number; y: number }[]; closed: boolean }[] {
  const unused = new Set<number>(segments.map((_, index) => index));
  const starts = new Map<string, number[]>();
  const ends = new Map<string, number[]>();
  const push = (map: Map<string, number[]>, key: string, index: number) => {
    const list = map.get(key);
    if (list) list.push(index);
    else map.set(key, [index]);
  };
  segments.forEach((segment, index) => {
    push(starts, keyOf(segment.ax, segment.ay), index);
    push(ends, keyOf(segment.bx, segment.by), index);
  });

  const take = (map: Map<string, number[]>, key: string): number | null => {
    const list = map.get(key);
    if (!list) return null;
    while (list.length) {
      const index = list.pop() as number;
      if (unused.has(index)) return index;
    }
    return null;
  };

  const lines: { points: { x: number; y: number }[]; closed: boolean }[] = [];
  while (unused.size) {
    const first = unused.values().next().value as number;
    unused.delete(first);
    const segment = segments[first];
    const points = [{ x: segment.ax, y: segment.ay }, { x: segment.bx, y: segment.by }];
    let guard = 0;
    while (guard < segments.length + 2) {
      guard += 1;
      const tail = points[points.length - 1];
      const tailKey = keyOf(tail.x, tail.y);
      const forward = take(starts, tailKey);
      if (forward != null) {
        unused.delete(forward);
        points.push({ x: segments[forward].bx, y: segments[forward].by });
        continue;
      }
      const backward = take(ends, tailKey);
      if (backward != null) {
        unused.delete(backward);
        points.push({ x: segments[backward].ax, y: segments[backward].ay });
        continue;
      }
      break;
    }
    guard = 0;
    while (guard < segments.length + 2) {
      guard += 1;
      const head = points[0];
      const headKey = keyOf(head.x, head.y);
      const into = take(ends, headKey);
      if (into != null) {
        unused.delete(into);
        points.unshift({ x: segments[into].ax, y: segments[into].ay });
        continue;
      }
      const out = take(starts, headKey);
      if (out != null) {
        unused.delete(out);
        points.unshift({ x: segments[out].bx, y: segments[out].by });
        continue;
      }
      break;
    }
    const closed = points.length > 2 && keyOf(points[0].x, points[0].y) === keyOf(points[points.length - 1].x, points[points.length - 1].y);
    if (points.length >= 2) lines.push({ points, closed });
  }
  return lines;
}

export function marchIsobars(
  grid: ArrayLike<number>,
  nx: number,
  ny: number,
  level: number,
  west: number,
  north: number,
  dlon: number,
  dlat: number,
): Polyline[] {
  const segments: Segment[] = [];
  for (let j = 0; j < ny - 1; j += 1) {
    for (let i = 0; i < nx - 1; i += 1) {
      const nw = grid[j * nx + i];
      const ne = grid[j * nx + i + 1];
      const sw = grid[(j + 1) * nx + i];
      const se = grid[(j + 1) * nx + i + 1];
      if (![nw, ne, se, sw].every((value) => Number.isFinite(value))) continue;
      segments.push(...cellSegments(level, i, j, nw, ne, se, sw));
    }
  }
  return stitch(segments).map((line) => {
    const lon = new Float32Array(line.points.length);
    const lat = new Float32Array(line.points.length);
    line.points.forEach((point, index) => {
      lon[index] = west + point.x * dlon;
      lat[index] = north + point.y * dlat;
    });
    return { level, closed: line.closed, lon, lat };
  });
}

export function smoothGrid(grid: Float32Array, nx: number, ny: number, wraps = false): Float32Array {
  const out = new Float32Array(grid.length);
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      let sum = 0;
      let count = 0;
      for (let dj = -1; dj <= 1; dj += 1) {
        for (let di = -1; di <= 1; di += 1) {
          const x = wraps ? ((i + di) % nx + nx) % nx : i + di;
          const y = j + dj;
          if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
          const value = grid[y * nx + x];
          if (!Number.isFinite(value)) continue;
          sum += value;
          count += 1;
        }
      }
      out[j * nx + i] = count ? sum / count : NaN;
    }
  }
  return out;
}

export interface CentreOptions {
  /** Legacy caller compatibility. Elevation is sampled from the DEM at draw time. */
  land?: ArrayLike<number> | null;
  /** Legacy caller compatibility; candidates use a minimum 2 hPa ring depth. */
  interval?: number;
  wraps?: boolean;
}

export function contourPressure(
  mslp: Float32Array,
  nx: number,
  ny: number,
  west: number,
  north: number,
  dlon: number,
  dlat: number,
  interval = 4,
  _land: ArrayLike<number> | null = null,
): { lines: Polyline[]; centres: PressureCentre[] } {
  const wraps = Math.abs(nx * dlon - 360) < 1e-6;
  const field = smoothGrid(smoothGrid(mslp, nx, ny, wraps), nx, ny, wraps);
  // A ghost column traces the last half-degree cell through the dateline.
  const columns = wraps ? nx + 1 : nx;
  const traced = wraps ? new Float32Array(columns * ny) : field;
  if (wraps) for (let j = 0; j < ny; j++) {
    traced.set(field.subarray(j * nx, (j + 1) * nx), j * columns);
    traced[j * columns + nx] = field[j * nx];
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < field.length; i += 1) {
    const value = field[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const lines: Polyline[] = [];
  // Trace the 2 hPa ladder once. The overlay fades intermediate levels for
  // the 8/4/2 hPa display bands without retracing when the camera moves.
  const step = interval / 2;
  if (Number.isFinite(min) && Number.isFinite(max)) {
    const start = Math.ceil(min / step) * step;
    for (let level = start; level <= max; level += step) {
      lines.push(...marchIsobars(traced, columns, ny, level, west, north, dlon, dlat).filter((line) => line.lon.length >= 4));
    }
  }
  return {
    lines,
    centres: pressureCentres(mslp, field, nx, ny, west, north, dlon, dlat,
      [], { wraps }),
  };
}

function bilinear(grid: ArrayLike<number>, nx: number, ny: number, gx: number, gy: number, wraps = false): number {
  if (wraps) gx = ((gx % nx) + nx) % nx;
  if (!(gx >= 0 && gy >= 0 && gx <= (wraps ? nx : nx - 1) && gy <= ny - 1)) return NaN;
  const x0 = wraps ? Math.floor(gx) : Math.min(nx - 2, Math.floor(gx));
  const x1 = (x0 + 1) % nx;
  const y0 = Math.min(ny - 2, Math.floor(gy));
  const tx = gx - x0;
  const ty = gy - y0;
  const a = grid[y0 * nx + x0];
  const b = grid[y0 * nx + x1];
  const c = grid[(y0 + 1) * nx + x0];
  const d = grid[(y0 + 1) * nx + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

const RING_DEG = 4;
const MERGE_KM = 860;

/** Local extrema with complete 4° rings, ranked by ring depth. View-scale
 * prominence, screen spacing and measured terrain suppression live in the overlay. */
export function pressureCentres(
  raw: ArrayLike<number>,
  smooth: ArrayLike<number>,
  nx: number,
  ny: number,
  west: number,
  north: number,
  dlon: number,
  dlat: number,
  _lines: Polyline[] = [],
  options: CentreOptions = {},
): PressureCentre[] {
  const wraps = options.wraps ?? Math.abs(nx * dlon - 360) < 1e-6;
  const ix = (x: number) => wraps ? ((x % nx) + nx) % nx : x;
  const step = Math.abs(dlon);
  const ring = Math.max(2, Math.round(RING_DEG / step));
  const disk = ring * ring;
  const candidates: { kind: 'H' | 'L'; lon: number; lat: number; value: number; prom: number }[] = [];
  for (let j = ring; j < ny - ring; j += 1) {
    for (let i = wraps ? 0 : ring; i < (wraps ? nx : nx - ring); i += 1) {
      const z = smooth[j * nx + i];
      if (!Number.isFinite(z)) continue;
      let high = true;
      let low = true;
      for (let dj = -1; dj <= 1 && (high || low); dj += 1) {
        for (let di = -1; di <= 1; di += 1) {
          if (!di && !dj) continue;
          const v = smooth[(j + dj) * nx + ix(i + di)];
          if (!Number.isFinite(v)) { high = false; low = false; break; }
          if (v > z) high = false;
          if (v < z) low = false;
        }
      }
      if (!high && !low) continue;
      for (let dj = -ring; dj <= ring && (high || low); dj += 1) {
        for (let di = -ring; di <= ring; di += 1) {
          if (di * di + dj * dj > disk || (!di && !dj)) continue;
          const v = smooth[(j + dj) * nx + ix(i + di)];
          if (!Number.isFinite(v)) { high = false; low = false; break; }
          if (v > z + 0.05) high = false;
          if (v < z - 0.05) low = false;
        }
      }
      if (!high && !low) continue;
      let sum = 0;
      let seen = 0;
      for (let k = 0; k < 32; k += 1) {
        const angle = (k / 32) * Math.PI * 2;
        const x = i + Math.cos(angle) * ring;
        const y = j + Math.sin(angle) * ring;
        const v = bilinear(smooth, nx, ny, x, y, wraps);
        if (!Number.isFinite(v)) continue;
        sum += v;
        seen += 1;
      }
      if (seen < 32) continue;
      const prom = z - sum / seen;
      if (high ? prom <= 0 : prom >= 0) continue;
      const kind = high ? 'H' : 'L';
      const lon = west + i * dlon;
      const lat = north + j * dlat;
      const strength = Math.abs(prom);
      if (strength < 2) continue;
      const value = raw[j * nx + i];
      if (!Number.isFinite(value)) continue;
      candidates.push({ kind, lon, lat, value, prom: strength });
    }
  }
  candidates.sort((a, b) => b.prom - a.prom);
  const km = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) => {
    const mid = ((a.lat + b.lat) / 2) * (Math.PI / 180);
    const lonDistance = wraps ? ((a.lon - b.lon + 540) % 360) - 180 : a.lon - b.lon;
    return Math.hypot(lonDistance * Math.cos(mid), a.lat - b.lat) * 111.2;
  };
  const found: (typeof candidates)[number][] = [];
  for (const centre of candidates) {
    const twin = found.find((kept) => kept.kind === centre.kind && km(kept, centre) < MERGE_KM);
    if (twin) continue;
    if (found.some((kept) => km(kept, centre) < 300)) continue;
    found.push(centre);
  }
  return found.map((centre) => ({ kind: centre.kind, lon: centre.lon, lat: centre.lat, hpa: Math.round(centre.value), prominence: centre.prom }));
}
