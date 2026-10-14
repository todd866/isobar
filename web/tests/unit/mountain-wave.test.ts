import { describe, expect, it } from 'vitest';
import { buildMountainWave, mountainWaveGrid, type MountainWaveInput } from '../../src/lib/mountain-wave';

// Local helpers: a geographic box around (lat0, lon0) with metre spacing dx,dy.
const LAT0 = 0, LON0 = 0, M_LAT = 111_132, M_LON = 111_320;
function grid(nx: number, ny: number, dx: number, dy: number, h: (x: number, y: number) => number) {
  const halfX = (nx - 1) * dx / 2, halfY = (ny - 1) * dy / 2;
  const bounds = { west: LON0 - halfX / M_LON, east: LON0 + halfX / M_LON, south: LAT0 - halfY / M_LAT, north: LAT0 + halfY / M_LAT };
  const heights = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = h(i * dx - halfX, j * dy - halfY);
  return { heights, nx, ny, bounds };
}
const lonAt = (x: number) => LON0 + x / M_LON;
const latAt = (y: number) => LAT0 + y / M_LAT;
function solve(g: ReturnType<typeof grid>, U: number, V: number, N: number, levels?: number[]) {
  const input: MountainWaveInput = { ...g, U, V, N, levels };
  const field = buildMountainWave(input);
  if (!field) throw new Error('no field');
  return field;
}
// Sample at a height z0 above the reference surface (linear-theory coordinates).
const at = (f: ReturnType<typeof solve>, x: number, y: number, z0: number) => f.sampleLinear(latAt(y), lonAt(x), z0)!;

describe('3D linear mountain-wave solver (Smith 1980)', { timeout: 30_000 }, () => {
  it('grid helper reports metre spacing for geographic bounds', () => {
    const g = mountainWaveGrid({ west: 0, east: 1, south: -0.5, north: 0.5 }, 101, 101);
    expect(g.dx).toBeCloseTo(M_LON * 0.01, -1);
    expect(g.dy).toBeCloseTo(M_LAT * 0.01, -1);
  });

  it('(a) surface w equals the kinematic terrain condition U dh/dx', () => {
    const a = 5000, h0 = 300, U = 12, N = 0.01;
    const hill = (x: number, y: number) => 500 + h0 * Math.exp(-(x * x + y * y) / (a * a));
    const f = solve(grid(128, 128, 500, 500, hill), U, 0, N);
    let checked = 0;
    for (const x of [-6000, -4000, -2500, -1000, 1000, 2500, 4000, 6000]) for (const y of [-2000, 0, 2000]) {
      const dhdx = (hill(x + 1, y) - hill(x - 1, y)) / 2;
      const expected = U * dhdx;
      const s = at(f, x, y, 0);
      if (Math.abs(expected) < 0.2 * U * h0 / a) continue;
      expect(Math.abs(s.w - expected) / Math.abs(expected)).toBeLessThan(0.1);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
    // And through the AMSL sampler: 2 m above the real ground, w follows the slope.
    const ground = hill(-3000, 0), s = f.sample(latAt(0), lonAt(-3000), ground + 2)!;
    expect(s.w).toBeGreaterThan(0);
    expect(Math.abs(s.w - U * (hill(-2999, 0) - hill(-3001, 0)) / 2) / Math.abs(s.w)).toBeLessThan(0.12);
    expect(f.sample(latAt(0), lonAt(-3000), ground - 20)).toBeNull();
  });

  it('restores the detrended ramp ascent and fades its displacement to the layer top', () => {
    const f = solve(grid(77, 77, 1000, 1000, (x) => 2500 + 0.04 * x), 20, 0, 0.01);
    for (const x of [-38000, -10000, 0, 10000, 38000]) {
      const surface = at(f, x, 0, 0);
      expect(Math.abs(surface.w - 0.8)).toBeLessThan(0.8 * 0.05);
      expect(surface.eta).toBeCloseTo(0.04 * x, 3);
      expect(surface.sourceHeightM).toBeCloseTo(2500, 3);
      expect(at(f, x, 0, 12000).eta).toBeCloseTo(0, 3);
      expect(at(f, x, 0, 12000).w).toBeCloseTo(0, 5);
      const ground = f.terrain(latAt(0), lonAt(x))!;
      expect(f.sample(latAt(0), lonAt(x), ground)!.w).toBeCloseTo(0.8, 3);
    }
  });

  it('retains the full surface slope everywhere on a Gaussian hill plus ramp', () => {
    const a = 5000, hill = (x: number, y: number) => 2500 + 0.04 * x + 200 * Math.exp(-(x * x + y * y) / (a * a));
    const f = solve(grid(153, 153, 500, 500, hill), 20, 0, 0.01, [0, 1000, 12000]);
    expect(f.blocked).toBe(false);
    for (let y = -38000; y <= 38000; y += 500) for (let x = -38000; x <= 38000; x += 500) {
      const expected = 20 * (0.04 - 400 * x / (a * a) * Math.exp(-(x * x + y * y) / (a * a)));
      expect(Math.abs(at(f, x, y, 0).w - expected) / Math.abs(expected)).toBeLessThan(0.1);
    }
  });

  it('(b) non-hydrostatic narrow ridge radiates its waves downstream, not upstream', () => {
    const a = 1000, U = 10, N = 0.01; // Na/U = 1
    const ridge = (x: number) => 200 * a * a / (x * x + a * a);
    const levels = Array.from({ length: 41 }, (_, i) => i * 125);
    const f = solve(grid(512, 32, 250, 2000, (x) => ridge(x)), U, 0, N, levels);
    let up = 0, down = 0;
    for (let x = 3000; x <= 25_000; x += 250) for (const z of [2000, 3000, 4000]) {
      up += Math.abs(at(f, -x, 0, z).w);
      down += Math.abs(at(f, x, 0, z).w);
    }
    expect(down / up).toBeGreaterThan(5);
  });

  it('(c) hydrostatic wide ridge: vertical wavelength 2πU/N and upstream phase tilt', () => {
    const a = 15_000, U = 10, N = 0.01, h0 = 100;
    const levels = Array.from({ length: 61 }, (_, i) => i * 200);
    const f = solve(grid(512, 64, 1000, 8000, (x) => h0 * a * a / (x * x + a * a)), U, 0, N, levels);
    const column = levels.map((z) => at(f, 0, 0, z).eta);
    const zeros: number[] = [];
    for (let i = 1; i < column.length; i++) if (Math.sign(column[i]) !== Math.sign(column[i - 1]))
      zeros.push(levels[i - 1] + (levels[i] - levels[i - 1]) * column[i - 1] / (column[i - 1] - column[i]));
    expect(zeros.length).toBeGreaterThanOrEqual(2);
    const lambda = 2 * (zeros[1] - zeros[0]), theory = 2 * Math.PI * U / N;
    expect(Math.abs(lambda - theory) / theory).toBeLessThan(0.1);
    // Queney: eta(x,z) = h a (a cos lz - x sin lz)/(x²+a²); the crest of eta
    // moves upstream (x<0) as height increases through the first quarter wave.
    const crestAt = (z: number) => {
      let best = -Infinity, bestX = 0;
      for (let x = -40_000; x <= 40_000; x += 500) { const e = at(f, x, 0, z).eta; if (e > best) { best = e; bestX = x; } }
      return bestX;
    };
    expect(Math.abs(crestAt(0))).toBeLessThanOrEqual(500);
    expect(crestAt(theory / 8)).toBeLessThan(-3000);
    // And the value itself matches the analytic hydrostatic solution.
    const l = N / U;
    for (const [x, z] of [[0, 1000], [-15_000, 2000], [15_000, 3000]]) {
      const analytic = h0 * a * (a * Math.cos(l * z) - x * Math.sin(l * z)) / (x * x + a * a);
      expect(Math.abs(at(f, x, 0, z).eta - analytic)).toBeLessThan(0.12 * h0);
    }
  });

  it('(d) perturbation wind is non-divergent', () => {
    const a = 6000, hill = (x: number, y: number) => 400 * Math.exp(-(x * x + y * y) / (a * a));
    const levels = Array.from({ length: 61 }, (_, i) => i * 100);
    const f = solve(grid(128, 128, 500, 500, hill), 8, 6, 0.01, levels);
    let worst = 0, scale = 0;
    for (const x of [-6000, -2000, 0, 3000, 7000]) for (const y of [-5000, 0, 4000]) for (const z of [500, 1500, 3000]) {
      const d = 500, dz = 100;
      const dudx = (at(f, x + d, y, z).du - at(f, x - d, y, z).du) / (2 * d);
      const dvdy = (at(f, x, y + d, z).dv - at(f, x, y - d, z).dv) / (2 * d);
      const dwdz = (at(f, x, y, z + dz).w - at(f, x, y, z - dz).w) / (2 * dz);
      worst = Math.max(worst, Math.abs(dudx + dvdy + dwdz));
      scale = Math.max(scale, Math.abs(dwdz));
    }
    expect(scale).toBeGreaterThan(1e-4);
    expect(worst / scale).toBeLessThan(0.05);
  });

  it('(e) surface u′ follows Queney: slower on the windward slope, faster on the lee slope, ~0 at the crest', () => {
    const a = 15_000, U = 10, N = 0.01, h0 = 100, l = N / U;
    const f = solve(grid(512, 64, 1000, 8000, (x) => h0 * a * a / (x * x + a * a)), U, 0, N);
    // Analytic hydrostatic Queney: u′(x,0) = -U ∂η/∂z = U h a l x / (x² + a²).
    const analytic = (x: number) => U * h0 * a * l * x / (x * x + a * a);
    const peak = analytic(a);
    for (const x of [-a, -a / 2, 0, a / 2, a, 2 * a]) expect(Math.abs(at(f, x, 0, 0).du - analytic(x))).toBeLessThan(0.15 * peak);
    expect(at(f, -a, 0, 0).du).toBeLessThan(0);
    expect(at(f, a, 0, 0).du).toBeGreaterThan(0);
  });

  it('(f) flat terrain gives zero perturbation and never NaN, even in calm air', () => {
    const flat = solve(grid(64, 64, 500, 500, () => 250), 10, -3, 0.012);
    const calm = solve(grid(64, 64, 500, 500, (x, y) => 300 * Math.exp(-(x * x + y * y) / 4e6)), 0, 0, 0.01);
    const neutral = solve(grid(64, 64, 500, 500, (x, y) => 300 * Math.exp(-(x * x + y * y) / 4e6)), 10, 0, 0);
    for (const x of [-10_000, -3000, 0, 2500, 9000]) for (const z of [0, 800, 5000]) {
      const s = at(flat, x, 0, z);
      expect([s.du, s.dv, s.w, s.eta].every((v) => Math.abs(v) < 1e-6)).toBe(true);
      for (const field of [calm, neutral]) {
        const c = at(field, x, 0, z);
        expect([c.du, c.dv, c.w, c.eta, c.u, c.v].every(Number.isFinite)).toBe(true);
      }
    }
    // Neutral air: evanescent only, so the disturbance decays aloft.
    expect(Math.abs(at(neutral, -2000, 0, 5000).w)).toBeLessThan(0.05 * Math.abs(at(neutral, -2000, 0, 0).w));
    expect(buildMountainWave({ ...grid(16, 16, 500, 500, () => 0), heights: new Float32Array(256).fill(NaN), U: 10, V: 0, N: 0.01 })).toBeNull();
  });

  it('(g) the field depends on geography and inputs only, not on sample density', () => {
    const hill = (x: number, y: number) => 600 * Math.exp(-(x * x + y * y) / 2.5e7);
    const g = grid(128, 128, 400, 400, hill);
    const a = solve(g, 12, 4, 0.01), b = solve(g, 12, 4, 0.01);
    const probe = () => a.sample(latAt(1234), lonAt(-2345), 1800)!;
    const first = probe();
    for (let i = 0; i < 2000; i++) a.sample(latAt((i % 50) * 300 - 7000), lonAt(Math.floor(i / 50) * 300 - 6000), 500 + (i % 7) * 400);
    expect(probe()).toEqual(first);
    expect(b.sample(latAt(1234), lonAt(-2345), 1800)).toEqual(first);
    // Coarse and fine lattices agree wherever they share a point.
    for (const x of [-4000, 0, 4000]) for (const y of [-4000, 0, 4000])
      expect(a.sample(latAt(y), lonAt(x), 2500)).toEqual(b.sample(latAt(y), lonAt(x), 2500));
  });

  it('(h) rotating the wind by 90° rotates the response', () => {
    const hill = (x: number, y: number) => 400 * Math.exp(-(x * x + y * y) / 1.6e7);
    const g = grid(128, 128, 400, 400, hill);
    const east = solve(g, 10, 0, 0.01), north = solve(g, 0, 10, 0.01);
    for (const [x, y] of [[-3000, 0], [2000, 1500], [6000, -2000], [0, 4000]]) for (const z of [0, 1500, 3500]) {
      const a = at(east, x, y, z), b = at(north, -y, x, z);
      expect(b.w).toBeCloseTo(a.w, 3);
      expect(b.eta).toBeCloseTo(a.eta, 2);
      // Perturbation vectors rotate too: (du,dv) → (-dv,du).
      expect(b.du).toBeCloseTo(-a.dv, 3);
      expect(b.dv).toBeCloseTo(a.du, 3);
    }
  });

  it('returns both spectral displacement gradients for oblique local advection', () => {
    const hill = (x: number, y: number) => 2500 + 0.01 * x - 0.02 * y + 200 * Math.exp(-(x * x + y * y) / 2.5e7);
    const f = solve(grid(128, 128, 500, 500, hill), 12, 8, 0.01);
    for (const [x, y] of [[-4000, 2000], [3000, -5000]]) for (const z of [0, 1500, 3500]) {
      const s = at(f, x, y, z), d = 250;
      const ex = (at(f, x + d, y, z).eta - at(f, x - d, y, z).eta) / (2 * d);
      const ey = (at(f, x, y + d, z).eta - at(f, x, y - d, z).eta) / (2 * d);
      expect(Math.abs(s.etaX - ex)).toBeLessThan(0.0005);
      expect(Math.abs(s.etaY - ey)).toBeLessThan(0.0005);
      expect(s.w).toBeCloseTo(12 * s.etaX + 8 * s.etaY, 5);
    }
  });

  it('flags blocked flow when Nh/U > 1 and damps the amplitude by U/(Nh)', () => {
    const hill = (x: number, y: number) => 2000 * Math.exp(-(x * x + y * y) / 6.4e7);
    const g = grid(128, 128, 500, 500, hill);
    const free = solve(g, 30, 0, 0.01), blocked = solve(g, 10, 0, 0.01);
    expect(free.blocked).toBe(false);
    expect(blocked.blocked).toBe(true);
    expect(blocked.nondimensionalHeight).toBeGreaterThan(1);
    expect(blocked.damping).toBeCloseTo(1 / blocked.nondimensionalHeight, 6);
    expect(Math.abs(at(blocked, 0, 0, 0).eta)).toBeLessThan(Math.abs(at(free, 0, 0, 0).eta) * blocked.damping * 1.01);
  });
});
