/**
 * 3D linear mountain-wave solver (Smith 1980; Smith & Barstad 2004 style).
 * Pure and worker-safe. Steady, inviscid, Boussinesq flow with a uniform
 * background wind (U,V) and buoyancy frequency N over terrain h(x,y):
 *
 *   σ = U k + V l,   m² = (N²/σ² − 1)(k² + l²)
 *   m = sign(σ)·√m² where m² > 0 (upward energy radiation), else m = i√(−m²)
 *   η̂(k,l,z) = ĥ e^{imz},  ŵ = iσ η̂,  (û, v̂) = −(k, l) m ŵ /(k² + l²)
 *
 * so w = U ∂η/∂x + V ∂η/∂y and ∂u′/∂x + ∂v′/∂y + ∂w/∂z = 0. At z = 0 the
 * displacement is the terrain, so w there is the kinematic condition V·∇h.
 * Linear theory is approximate when Nh/U > 1: the result is then flagged
 * `blocked` and the terrain amplitude damped by U/(Nh).
 */

export interface MountainWaveBounds { west: number; east: number; south: number; north: number }
export interface MountainWaveInput {
  /** Terrain heights, metres AMSL, row-major ny×nx, row 0 south, column 0 west. */
  heights: ArrayLike<number>;
  nx: number;
  ny: number;
  bounds: MountainWaveBounds;
  /** Uniform background wind, m/s east and north. */
  U: number;
  V: number;
  /** Buoyancy frequency of the layer, 1/s. */
  N: number;
  /** Heights above the reference surface at which fields are evaluated, metres. */
  levels?: number[];
  /**
   * When false, sample() does not return null below this grid's own terrain
   * (the caller clips against a finer ground model). Default true.
   */
  clipGround?: boolean;
  /** Reserved for an anelastic amplitude correction; currently ignored. */
  densityScaleHeightM?: number;
}
export interface MountainWaveSample {
  /** Total horizontal wind: background plus perturbation, m/s. */
  u: number; v: number;
  /** Horizontal perturbation, m/s. */
  du: number; dv: number;
  /** Vertical velocity, m/s positive up. */
  w: number;
  /** Streamline displacement, metres. */
  eta: number;
  /** Displacement gradients at fixed undisturbed height (dimensionless). */
  etaX: number; etaY: number;
  /** Undisturbed height of this streamline above the reference surface, metres. */
  z0: number;
  /** Height the air came from: zAMSL − η. */
  sourceHeightM: number;
}
export interface MountainWaveField {
  U: number; V: number; N: number;
  levels: number[];
  /** Mean terrain height, metres AMSL. */
  baseM: number;
  maxM: number;
  /** Peak terrain above the reference plane, metres. */
  peakM: number;
  nondimensionalHeight: number;
  blocked: boolean;
  /** Amplitude factor applied to the terrain: min(1, U/(N h)). */
  damping: number;
  bounds: MountainWaveBounds;
  nx: number; ny: number; dx: number; dy: number;
  /** Ground height from the solver's own terrain grid, or null outside. */
  terrain(lat: number, lon: number): number | null;
  /** Fields at an AMSL height; null outside the grid, underground or above the top level. */
  sample(lat: number, lon: number, zAmslM: number): MountainWaveSample | null;
  /** Fields at a height above the reference surface (linear-theory coordinates). */
  sampleLinear(lat: number, lon: number, z0: number): MountainWaveSample | null;
}

/** 24 levels, 0–12 km: 250 m near the ground, 500 m through the wave layer. */
export const DEFAULT_WAVE_LEVELS = [
  0, 250, 500, 750, 1000,
  ...Array.from({ length: 16 }, (_, i) => 1500 + i * 500),
  10_000, 11_000, 12_000,
];
const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LON = 111_320;
const TAPER = 0.15;
const BLOCKED = 1;

export function mountainWaveGrid(bounds: MountainWaveBounds, nx: number, ny: number) {
  const midLat = ((bounds.south + bounds.north) / 2) * Math.PI / 180;
  return {
    dx: (bounds.east - bounds.west) / Math.max(1, nx - 1) * M_PER_DEG_LON * Math.cos(midLat),
    dy: (bounds.north - bounds.south) / Math.max(1, ny - 1) * M_PER_DEG_LAT,
  };
}

const nextPow2 = (n: number) => { let p = 1; while (p < n) p <<= 1; return p; };

/** In-place iterative radix-2 complex FFT on contiguous (re, im) at offset. sign −1 forward, +1 inverse (unscaled). */
function fft(re: Float64Array, im: Float64Array, n: number, offset: number, sign: number, t: FftTables) {
  const { cos, sin, bitrev } = t;
  for (let i = 0; i < n; i++) {
    const j = bitrev[i];
    if (j > i) {
      const a = offset + i, b = offset + j;
      let x = re[a]; re[a] = re[b]; re[b] = x;
      x = im[a]; im[a] = im[b]; im[b] = x;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let k = 0; k < half; k++) {
      const wr = cos[k * step], wi = sign * sin[k * step];
      for (let start = offset + k; start < offset + n; start += size) {
        const b = start + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[start] - xr; im[b] = im[start] - xi;
        re[start] += xr; im[start] += xi;
      }
    }
  }
}
interface FftTables { cos: Float64Array; sin: Float64Array; bitrev: Uint32Array; re: Float64Array; im: Float64Array }
function tables(n: number): FftTables {
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), bitrev = new Uint32Array(n);
  for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos(2 * Math.PI * k / n); sin[k] = Math.sin(2 * Math.PI * k / n); }
  const bits = Math.round(Math.log2(n));
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); bitrev[i] = r; }
  return { cos, sin, bitrev, re: new Float64Array(n), im: new Float64Array(n) };
}
/**
 * 2D transform. Rows (length px) are transformed for the first `rows` rows
 * only (the rest are zero on input), then the first `cols` columns.
 */
function fft2(re: Float64Array, im: Float64Array, px: number, py: number, sign: number, tx: FftTables, ty: FftTables, rows = py, cols = px) {
  for (let j = 0; j < rows; j++) fft(re, im, px, j * px, sign, tx);
  const cr = ty.re, ci = ty.im;
  for (let i = 0; i < cols; i++) {
    for (let j = 0, a = i; j < py; j++, a += px) { cr[j] = re[a]; ci[j] = im[a]; }
    fft(cr, ci, py, 0, sign, ty);
    for (let j = 0, a = i; j < py; j++, a += px) { re[a] = cr[j]; im[a] = ci[j]; }
  }
}

export function buildMountainWave(input: MountainWaveInput): MountainWaveField | null {
  const { nx, ny, bounds, heights } = input;
  const levels = (input.levels ?? DEFAULT_WAVE_LEVELS).slice().sort((a, b) => a - b);
  if (nx < 4 || ny < 4 || heights.length !== nx * ny || !levels.length || levels[0] < 0) return null;
  if (![bounds.west, bounds.east, bounds.south, bounds.north, input.U, input.V, input.N].every(Number.isFinite)) return null;
  if (bounds.east <= bounds.west || bounds.north <= bounds.south) return null;
  for (let i = 0; i < heights.length; i++) if (!Number.isFinite(heights[i])) return null;
  const { dx, dy } = mountainWaveGrid(bounds, nx, ny);
  const U = input.U, V = input.V, N = Math.max(0, input.N), speed = Math.hypot(U, V);

  // Remove the least-squares plane before tapering/padding: a ramp would
  // otherwise create artificial edge ridges. Restore its ascent analytically below.
  const xc = (nx - 1) / 2, yc = (ny - 1) / 2;
  let mean = 0, sxh = 0, syh = 0, sxx = 0, syy = 0, maxM = -Infinity;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const h = heights[j * nx + i]; mean += h; maxM = Math.max(maxM, h);
    sxh += (i - xc) * h; syh += (j - yc) * h; sxx += (i - xc) ** 2; syy += (j - yc) ** 2;
  }
  mean /= nx * ny;
  const cx = sxx > 0 ? sxh / sxx : 0, cy = syy > 0 ? syh / syy : 0;
  const plane = (fi: number, fj: number) => mean + cx * (fi - xc) + cy * (fj - yc);
  let peakM = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) peakM = Math.max(peakM, heights[j * nx + i] - plane(i, j));

  const nondimensionalHeight = speed > 1e-6 ? N * peakM / speed : (peakM > 0 && N > 0 ? Infinity : 0);
  const blocked = nondimensionalHeight > BLOCKED;
  const damping = blocked ? (Number.isFinite(nondimensionalHeight) ? 1 / nondimensionalHeight : 0) : 1;

  const px = nextPow2(2 * nx), py = nextPow2(2 * ny), size = px * py;
  const taper = (i: number, n: number) => {
    const edge = Math.max(1, TAPER * (n - 1)), d = Math.min(i, n - 1 - i);
    return d >= edge ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * d / edge);
  };
  const hr = new Float64Array(size), hi = new Float64Array(size);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
    hr[j * px + i] = damping * (heights[j * nx + i] - plane(i, j)) * taper(i, nx) * taper(j, ny);
  const tx = tables(px), ty = tables(py);
  fft2(hr, hi, px, py, -1, tx, ty, ny);

  const L = levels.length, plane2 = nx * ny;
  const W = new Float32Array(L * plane2), E = new Float32Array(L * plane2), DU = new Float32Array(L * plane2), DV = new Float32Array(L * plane2);
  const EX = new Float32Array(L * plane2), EY = new Float32Array(L * plane2);
  const gr = new Float64Array(size), gi = new Float64Array(size);
  const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size);
  const kOf = (i: number, n: number, d: number) => (i === n / 2 ? NaN : 2 * Math.PI * (i < n / 2 ? i : i - n) / (n * d));
  const N2 = N * N;
  // Per-wavenumber constants. kind: 0 none (Nyquist), 1 mean, 2 propagating,
  // 3 evanescent, 4 σ≈0 (only the surface value survives).
  const kind = new Uint8Array(size), mz = new Float64Array(size), msR = new Float64Array(size), msI = new Float64Array(size);
  const kx = new Float64Array(px), ly = new Float64Array(py);
  for (let i = 0; i < px; i++) kx[i] = kOf(i, px, dx);
  for (let j = 0; j < py; j++) ly[j] = kOf(j, py, dy);
  for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) {
    const idx = j * px + i, k = kx[i], l = ly[j];
    if (!Number.isFinite(k) || !Number.isFinite(l)) continue;
    const K2 = k * k + l * l;
    if (K2 === 0) { kind[idx] = 1; continue; }
    const K = Math.sqrt(K2), sigma = U * k + V * l, s2 = sigma * sigma;
    if (N2 > s2) {
      // m·σ = K√(N² − σ²) stays finite as σ → 0.
      msR[idx] = K * Math.sqrt(N2 - s2);
      if (Math.abs(sigma) < 1e-12) kind[idx] = 4;
      else { kind[idx] = 2; mz[idx] = Math.sign(sigma) * K * Math.sqrt(N2 / s2 - 1); }
    } else {
      kind[idx] = 3;
      mz[idx] = s2 > 0 ? K * Math.sqrt(Math.max(0, 1 - N2 / s2)) : K; // decay rate
      msI[idx] = Math.sign(sigma) * K * Math.sqrt(s2 - N2);
    }
  }
  // e^{imz} carried level to level by one complex multiply per bin.
  const curR = new Float64Array(size).fill(1), curI = new Float64Array(size), stepR = new Float64Array(size), stepI = new Float64Array(size);
  let stepDz = NaN;
  for (let level = 0; level < L; level++) {
    const z = levels[level], dz = level ? z - levels[level - 1] : z;
    if (dz !== stepDz) {
      stepDz = dz;
      for (let idx = 0; idx < size; idx++) {
        const kd = kind[idx];
        if (kd === 2) { stepR[idx] = Math.cos(mz[idx] * dz); stepI[idx] = Math.sin(mz[idx] * dz); }
        else if (kd === 3) { stepR[idx] = Math.exp(-mz[idx] * dz); stepI[idx] = 0; }
        else if (kd === 4) { stepR[idx] = dz > 0 ? 0 : 1; stepI[idx] = 0; }
        else { stepR[idx] = 1; stepI[idx] = 0; }
      }
    }
    for (let j = 0; j < py; j++) {
      const l = ly[j];
      for (let i = 0; i < px; i++) {
        const idx = j * px + i, kd = kind[idx];
        ar[idx] = ai[idx] = br[idx] = bi[idx] = gr[idx] = gi[idx] = 0;
        if (kd === 0) continue;
        const sr = stepR[idx], si = stepI[idx], cr = curR[idx], ci = curI[idx];
        const Er = cr * sr - ci * si, Ei = cr * si + ci * sr;
        curR[idx] = Er; curI[idx] = Ei;
        const Hr = hr[idx], Hi = hi[idx];
        // η̂z = Ĥ E
        const er = Hr * Er - Hi * Ei, ei = Hr * Ei + Hi * Er;
        if (kd === 1) { ai[idx] = er; continue; } // mean: uniform lift, no motion; A = ŵ + iη̂
        const k = kx[i], K2 = k * k + l * l, sigma = U * k + V * l;
        // Pack ∂η/∂x + i∂η/∂y, using ikη̂ and ilη̂, for local-wind advection.
        gr[idx] = -k * ei - l * er; gi[idx] = k * er - l * ei;
        // ŵ = iσ η̂z
        const wr = -sigma * ei, wi = sigma * er;
        // û = −i k (mσ) η̂z / K², v̂ likewise with l. Let q = −i (mσ) η̂z / K².
        const msr = msR[idx], msi = msI[idx];
        const tr = msr * er - msi * ei, ti = msr * ei + msi * er;
        const qr = ti / K2, qi = -tr / K2;
        // Pack two real fields per inverse transform: A = ŵ + iη̂, B = û + iv̂.
        ar[idx] = wr - ei; ai[idx] = wi + er;
        br[idx] = k * qr - l * qi; bi[idx] = k * qi + l * qr;
      }
    }
    fft2(ar, ai, px, py, 1, tx, ty, py, nx);
    fft2(br, bi, px, py, 1, tx, ty, py, nx);
    fft2(gr, gi, px, py, 1, tx, ty, py, nx);
    const scale = 1 / size, offset = level * plane2;
    // The regional plane uses a smoothstep envelope: f(0)=1, f(top)=0,
    // with zero endpoint derivatives. This finite-layer approximation is
    // not a radiating Fourier mode; it restores the omitted ground slope.
    const q = levels[L - 1] > 0 ? z / levels[L - 1] : 0;
    const fade = 1 - q * q * (3 - 2 * q);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const s = j * px + i, d = offset + j * nx + i;
      EX[d] = gr[s] * scale + cx / dx * fade; EY[d] = gi[s] * scale + cy / dy * fade;
      W[d] = ar[s] * scale + (U * cx / dx + V * cy / dy) * fade;
      E[d] = ai[s] * scale + (plane(i, j) - mean) * fade; DU[d] = br[s] * scale; DV[d] = bi[s] * scale;
    }
  }

  const position = (lat: number, lon: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const fx = (lon - bounds.west) / (bounds.east - bounds.west) * (nx - 1);
    const fy = (lat - bounds.south) / (bounds.north - bounds.south) * (ny - 1);
    if (fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) return null;
    const i0 = Math.min(nx - 2, Math.floor(fx)), j0 = Math.min(ny - 2, Math.floor(fy));
    return { fx, fy, i0, j0, tx: fx - i0, ty: fy - j0 };
  };
  type Pos = NonNullable<ReturnType<typeof position>>;
  const bilinear = (data: ArrayLike<number>, offset: number, p: Pos) => {
    const a = offset + p.j0 * nx + p.i0;
    return (data[a] * (1 - p.tx) + data[a + 1] * p.tx) * (1 - p.ty) + (data[a + nx] * (1 - p.tx) + data[a + nx + 1] * p.tx) * p.ty;
  };
  const at = (p: Pos, level: number, t: number, z0: number, base: number) => {
    const o0 = level * plane2, o1 = Math.min(L - 1, level + 1) * plane2;
    const mix = (f: Float32Array) => bilinear(f, o0, p) * (1 - t) + bilinear(f, o1, p) * t;
    const w = mix(W), eta = mix(E), du = mix(DU), dv = mix(DV);
    return { u: U + du, v: V + dv, du, dv, w, eta, etaX: mix(EX), etaY: mix(EY), z0, sourceHeightM: base + z0 };
  };
  const levelOf = (z0: number) => {
    if (z0 <= levels[0]) return { level: 0, t: 0 };
    for (let i = 0; i < L - 1; i++) if (z0 <= levels[i + 1]) return { level: i, t: (z0 - levels[i]) / (levels[i + 1] - levels[i]) };
    return null;
  };
  const terrain = (lat: number, lon: number) => { const p = position(lat, lon); return p ? bilinear(heights, 0, p) : null; };

  return {
    U, V, N, levels, baseM: mean, maxM, peakM, nondimensionalHeight, blocked, damping, bounds, nx, ny, dx, dy, terrain,
    sampleLinear(lat, lon, z0) {
      const p = position(lat, lon);
      if (!p || !Number.isFinite(z0)) return null;
      const where = levelOf(Math.max(0, z0));
      if (!where) return null;
      const base = mean, s = at(p, where.level, where.t, Math.max(0, z0), base);
      return { ...s, sourceHeightM: base + s.z0 };
    },
    sample(lat, lon, zAmslM) {
      const p = position(lat, lon);
      if (!p || !Number.isFinite(zAmslM)) return null;
      if (input.clipGround !== false && zAmslM < bilinear(heights, 0, p)) return null;
      const base = mean;
      // Find the undisturbed height z0 whose displaced streamline passes
      // through zAmsl: base + z0 + η(z0) = zAmsl (first crossing upward).
      let previous = base + levels[0] + bilinear(E, 0, p);
      if (zAmslM <= previous) return at(p, 0, 0, levels[0], base); // inside the lowest streamline: surface values
      for (let level = 0; level < L - 1; level++) {
        const next = base + levels[level + 1] + bilinear(E, (level + 1) * plane2, p);
        if (zAmslM <= next) {
          const t = next > previous ? (zAmslM - previous) / (next - previous) : 1;
          return at(p, level, t, levels[level] + t * (levels[level + 1] - levels[level]), base);
        }
        previous = Math.max(previous, next);
      }
      return null;
    },
  };
}
