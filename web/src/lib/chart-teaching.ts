import type { ChartManifest } from './manifest';
import type { PressureCentre } from './contour';

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface PressureAxis {
  kind: 'trough' | 'ridge';
  points: GeoPoint[];
  lat: number;
  lon: number;
  strength: number;
}

export interface GradientEstimate {
  lat: number;
  lon: number;
  /** Magnitude of the MSLP gradient, in hPa per 100 km. */
  gradientHpaPer100Km: number;
  /** Geostrophic speed in knots, or null where latitude/data are invalid. */
  geostrophicKt: number | null;
  /** Meteorological direction the geostrophic wind comes from. */
  fromDeg: number | null;
  /** Scalar model 10 m wind speed in knots, when supplied. */
  surfaceKt: number | null;
  /** Meteorological model 10 m direction, added when vector components exist. */
  surfaceFromDeg?: number | null;
}

export interface TeachingFeatures {
  axes: PressureAxis[];
  tight: GradientEstimate[];
  strongest: GradientEstimate | null;
  wettest: { lat: number; lon: number; mm: number } | null;
  biggest: PressureCentre | null;
}

export type TeachingManifest = Pick<ChartManifest, 'nx' | 'ny' | 'west' | 'north' | 'east' | 'south'>;

const EARTH_RADIUS_M = 6_371_000;
const AIR_DENSITY = 1.225;
const KNOTS_PER_MS = 1.943844492;
const DEG = Math.PI / 180;

function validManifest(manifest: TeachingManifest): boolean {
  return Number.isInteger(manifest.nx) && Number.isInteger(manifest.ny)
    && manifest.nx >= 3 && manifest.ny >= 3
    && Number.isFinite(manifest.west) && Number.isFinite(manifest.east)
    && Number.isFinite(manifest.north) && Number.isFinite(manifest.south)
    && manifest.east > manifest.west && manifest.north > manifest.south;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function coordinate(manifest: TeachingManifest, i: number, j: number): GeoPoint {
  return {
    lon: manifest.west + (i / (manifest.nx - 1)) * (manifest.east - manifest.west),
    lat: manifest.north - (j / (manifest.ny - 1)) * (manifest.north - manifest.south),
  };
}

function nearestIndex(value: number, first: number, last: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(((value - first) / (last - first)) * (count - 1))));
}

function gradientAtIndex(mslp: Float32Array, manifest: TeachingManifest, i: number, j: number, wind?: Float32Array | null): GradientEstimate | null {
  const { nx, ny } = manifest;
  if (i < 0 || i >= nx || j < 0 || j >= ny || mslp.length < nx * ny) return null;
  const at = (x: number, y: number) => mslp[y * nx + x];
  const center = at(i, j);
  if (!finite(center)) return null;
  const west = i > 0 ? at(i - 1, j) : NaN;
  const east = i + 1 < nx ? at(i + 1, j) : NaN;
  const north = j > 0 ? at(i, j - 1) : NaN;
  const south = j + 1 < ny ? at(i, j + 1) : NaN;
  const dxDeg = (manifest.east - manifest.west) / (nx - 1);
  const dyDeg = (manifest.north - manifest.south) / (ny - 1);
  if (!(dxDeg > 0) || !(dyDeg > 0)) return null;
  const dxM = EARTH_RADIUS_M * Math.cos(coordinate(manifest, i, j).lat * DEG) * dxDeg * DEG;
  const dyM = EARTH_RADIUS_M * dyDeg * DEG;
  const dpdxHpa = finite(west) && finite(east) ? (east - west) / 2 : finite(east) ? east - center : finite(west) ? center - west : NaN;
  const dpdyHpa = finite(north) && finite(south) ? (north - south) / 2 : finite(north) ? north - center : finite(south) ? center - south : NaN;
  const point = coordinate(manifest, i, j);
  const gradientHpaPer100Km = finite(dpdxHpa) && finite(dpdyHpa)
    ? Math.hypot(dpdxHpa / dxM, dpdyHpa / dyM) * 100_000
    : NaN;
  const f = 2 * 7.2921159e-5 * Math.sin(point.lat * DEG);
  let geostrophicKt: number | null = null;
  let fromDeg: number | null = null;
  if (finite(dpdxHpa) && finite(dpdyHpa) && Math.abs(f) >= 1e-5) {
    const dpdxPaM = (dpdxHpa * 100) / dxM;
    const dpdyPaM = (dpdyHpa * 100) / dyM;
    const u = -dpdyPaM / (AIR_DENSITY * f);
    const v = dpdxPaM / (AIR_DENSITY * f);
    geostrophicKt = Math.hypot(u, v) * KNOTS_PER_MS;
    fromDeg = (Math.atan2(-u, -v) / DEG + 360) % 360;
  }
  const surfaceValue = wind && wind.length >= nx * ny && finite(wind[j * nx + i]) && wind[j * nx + i] >= 0 ? wind[j * nx + i] : null;
  return { ...point, gradientHpaPer100Km, geostrophicKt, fromDeg, surfaceKt: surfaceValue };
}

export function gradientAt(mslp: Float32Array, manifest: TeachingManifest, lat: number, lon: number, wind?: Float32Array | null): GradientEstimate | null {
  if (!validManifest(manifest) || !finite(lat) || !finite(lon)) return null;
  if (lon < manifest.west || lon > manifest.east || lat < manifest.south || lat > manifest.north) return null;
  return gradientAtIndex(mslp, manifest, nearestIndex(lon, manifest.west, manifest.east, manifest.nx), nearestIndex(lat, manifest.north, manifest.south, manifest.ny), wind);
}

interface AxisCandidate extends GeoPoint { kind: 'trough' | 'ridge'; strength: number; i: number; j: number; angle: number; dx100: number; dy100: number; }

export function detectAxes(mslp: Float32Array, manifest: TeachingManifest): PressureAxis[] {
  if (!validManifest(manifest) || mslp.length < manifest.nx * manifest.ny) return [];
  const candidates: AxisCandidate[] = [];
  const { nx, ny } = manifest;
  const at = (i: number, j: number) => i >= 0 && i < nx && j >= 0 && j < ny ? mslp[j * nx + i] : NaN;
  const smoothAt = (i: number, j: number): number | null => {
    let total = 0;
    for (let y = j - 1; y <= j + 1; y += 1) for (let x = i - 1; x <= i + 1; x += 1) {
      const value = at(x, y);
      if (!finite(value)) return null;
      total += value;
    }
    return total / 9;
  };
  for (let j = 1; j < ny - 1; j += 1) for (let i = 1; i < nx - 1; i += 1) {
    const c = smoothAt(i, j); const e = smoothAt(i + 1, j); const w = smoothAt(i - 1, j); const n = smoothAt(i, j - 1); const s = smoothAt(i, j + 1);
    const ne = smoothAt(i + 1, j - 1); const nw = smoothAt(i - 1, j - 1); const se = smoothAt(i + 1, j + 1); const sw = smoothAt(i - 1, j + 1);
    if (c == null || e == null || w == null || n == null || s == null || ne == null || nw == null || se == null || sw == null) continue;
    const point = coordinate(manifest, i, j);
    const dx100 = EARTH_RADIUS_M * Math.cos(point.lat * DEG) * ((manifest.east - manifest.west) / (nx - 1)) * DEG / 100_000;
    const dy100 = EARTH_RADIUS_M * ((manifest.north - manifest.south) / (ny - 1)) * DEG / 100_000;
    if (!(dx100 > 0) || !(dy100 > 0)) continue;
    const xx = (e - 2 * c + w) / (dx100 * dx100); const yy = (n - 2 * c + s) / (dy100 * dy100); const xy = ((se - sw - ne + nw) / 4) / (dx100 * dy100);
    const trace = xx + yy; const disc = Math.hypot(xx - yy, 2 * xy);
    const l1 = (trace + disc) / 2; const l2 = (trace - disc) / 2;
    const transverse = Math.abs(l1) >= Math.abs(l2) ? l1 : l2;
    const along = Math.abs(l1) >= Math.abs(l2) ? l2 : l1;
    const strength = Math.abs(transverse);
    if (strength < 0.02 || Math.abs(along) > strength * 0.4) continue;
    const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
    const normalAngle = Math.abs(l1) >= Math.abs(l2) ? theta : theta + Math.PI / 2;
    const gx = (e - w) / (2 * dx100); const gy = (s - n) / (2 * dy100);
    if (Math.abs(gx * Math.cos(normalAngle) + gy * Math.sin(normalAngle)) > Math.max(0.15, strength * 0.8)) continue;
    candidates.push({ ...point, kind: transverse > 0 ? 'trough' : 'ridge', strength, i, j, angle: normalAngle + Math.PI / 2, dx100, dy100 });
  }
  const groups: AxisCandidate[][] = [];
  const used = new Set<AxisCandidate>();
  const buckets = new Map<string, AxisCandidate>();
  for (const candidate of candidates) buckets.set(`${candidate.kind}:${candidate.i}:${candidate.j}`, candidate);
  for (const candidate of candidates) {
    if (used.has(candidate)) continue;
    const group: AxisCandidate[] = [candidate]; used.add(candidate);
    const queue = [candidate];
    while (queue.length > 0) {
      const item = queue.pop() as AxisCandidate;
      for (let dj = -1; dj <= 1; dj += 1) for (let di = -1; di <= 1; di += 1) {
        if (di === 0 && dj === 0) continue;
        const other = buckets.get(`${item.kind}:${item.i + di}:${item.j + dj}`);
        if (other && !used.has(other)) { used.add(other); group.push(other); queue.push(other); }
      }
    }
    if (group.length >= 3) groups.push(group);
  }
  // One ordered centreline per elongated component. Bin ALONG its principal
  // direction, then average across its width; local eigenvector signs cannot
  // reorder the chain or turn a three-cell stripe into a sawtooth.
  const axes: PressureAxis[] = [];
  for (const group of groups) {
    // A local tangent metric at the mean latitude orders the already detected
    // axis; the Hessian above uses each cell's own latitude.
    const meanLat = group.reduce((a, p) => a + p.lat, 0) / group.length;
    const dx = EARTH_RADIUS_M * Math.cos(meanLat * DEG) * ((manifest.east - manifest.west) / (nx - 1)) * DEG / 100_000;
    const dy = group[0].dy100;
    const mi = group.reduce((a, p) => a + p.i, 0) / group.length;
    const mj = group.reduce((a, p) => a + p.j, 0) / group.length;
    let xx = 0, yy = 0, xy = 0;
    for (const p of group) { const x = (p.i - mi) * dx, y = (p.j - mj) * dy; xx += x * x; yy += y * y; xy += x * y; }
    const disc = Math.hypot(xx - yy, 2 * xy), major = (xx + yy + disc) / 2, minor = (xx + yy - disc) / 2;
    if (major < 4 * minor) continue;
    const angle = .5 * Math.atan2(2 * xy, xx - yy), c = Math.cos(angle), t = Math.sin(angle);
    const binWidth = Math.max(dx, dy) * 1.5;
    const bins = new Map<number, AxisCandidate[]>();
    for (const p of group) {
      const k = Math.round(((p.i - mi) * dx * c + (p.j - mj) * dy * t) / binWidth);
      const bin = bins.get(k) ?? []; bin.push(p); bins.set(k, bin);
    }
    const points = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([, bin]) => ({
      lat: bin.reduce((a, p) => a + p.lat, 0) / bin.length,
      lon: bin.reduce((a, p) => a + p.lon, 0) / bin.length,
    }));
    if (points.length < 3) continue;
    const length100 = points.slice(1).reduce((sum, p, i) => sum + Math.hypot((p.lon - points[i].lon) * Math.cos(p.lat * DEG), p.lat - points[i].lat) * 1.112, 0);
    if (length100 < 2) continue;
    const middle = points[Math.floor(points.length / 2)];
    axes.push({ kind: group[0].kind, points, ...middle, strength: Math.max(...group.map((p) => p.strength)) });
  }
  return axes.sort((a, b) => b.strength - a.strength).slice(0, 6);
}

export function teachingFeatures(mslp: Float32Array, manifest: TeachingManifest, centres: PressureCentre[], wind?: Float32Array | null, rain?: Float32Array | null): TeachingFeatures {
  const axes = detectAxes(mslp, manifest);
  const tight: GradientEstimate[] = [];
  if (validManifest(manifest) && mslp.length >= manifest.nx * manifest.ny) {
    for (let j = 1; j < manifest.ny - 1; j += 3) for (let i = 1; i < manifest.nx - 1; i += 3) {
      const estimate = gradientAtIndex(mslp, manifest, i, j, wind);
      if (estimate && finite(estimate.gradientHpaPer100Km) && estimate.gradientHpaPer100Km >= 0.8) tight.push(estimate);
    }
  }
  tight.sort((a, b) => b.gradientHpaPer100Km - a.gradientHpaPer100Km);
  const separated: GradientEstimate[] = [];
  for (const estimate of tight) {
    if (separated.every((other) => Math.hypot(estimate.lat - other.lat, estimate.lon - other.lon) > 1.5)) separated.push(estimate);
    if (separated.length >= 6) break;
  }
  const windStrongest = validManifest(manifest) && wind && wind.length >= manifest.nx * manifest.ny ? (() => {
    let bestValue = -Infinity; let bestI = -1; let bestJ = -1;
    for (let j = 1; j < manifest.ny - 1; j += 1) for (let i = 1; i < manifest.nx - 1; i += 1) {
      const value = wind[j * manifest.nx + i];
      const k = j * manifest.nx + i;
      if (finite(value) && value >= 0 && value > bestValue && [mslp[k], mslp[k - 1], mslp[k + 1], mslp[k - manifest.nx], mslp[k + manifest.nx]].every(finite)) { bestValue = value; bestI = i; bestJ = j; }
    }
    if (bestI < 0) return null;
    const estimate = gradientAtIndex(mslp, manifest, bestI, bestJ, wind);
    return estimate && finite(estimate.gradientHpaPer100Km) ? estimate : null;
  })() : null;
  const strongest = windStrongest ?? separated[0] ?? null;
  let wettest: TeachingFeatures['wettest'] = null;
  if (rain && validManifest(manifest) && rain.length >= manifest.nx * manifest.ny) {
    let best = -Infinity; let bi = 0; let bj = 0;
    for (let j = 0; j < manifest.ny; j += 1) for (let i = 0; i < manifest.nx; i += 1) {
      const value = rain[j * manifest.nx + i];
      if (finite(value) && value >= 0 && value > best) { best = value; bi = i; bj = j; }
    }
    if (finite(best)) wettest = { ...coordinate(manifest, bi, bj), mm: best };
  }
  const biggest = centres.filter((centre) => finite(centre.hpa)).sort((a, b) => Math.abs(b.hpa - 1013) - Math.abs(a.hpa - 1013))[0] ?? null;
  return { axes, tight: separated, strongest, wettest, biggest };
}
