import { describe, expect, it } from 'vitest';
import { buildMountainWave } from '../../src/lib/mountain-wave';
import { createMountainWindField, layerBackground, type WindProfileLevel } from '../../src/lib/mountain-wind';

const KT = 0.514444;
// A standard-atmosphere-like sounding: 6.5 K/km lapse, given wind by height.
function sounding(windKt: (z: number) => number, from = 270, rh = 50): WindProfileLevel[] {
  return [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200].map((hPa) => {
    const zM = 44330 * (1 - (hPa / 1013.25) ** 0.1903);
    return { hPa, zM, tC: 15 - 0.0065 * zM, rh, windKt: windKt(zM), windFrom: from };
  });
}

describe('layer background from a pressure-level profile', () => {
  it('reduces a uniform westerly to U and the θ-profile N', () => {
    const bg = layerBackground(sounding(() => 20), 500, 6000)!;
    expect(bg.U).toBeCloseTo(20 * KT, 6);
    expect(Math.abs(bg.V)).toBeLessThan(1e-9);
    // N² = g/θ dθ/dz; for a 6.5 K/km lapse ≈ g/T (Γd − 6.5e-3) ≈ 1.2e-4.
    const T = 273.15 + 15 - 0.0065 * 3250;
    const theory = 9.80665 / T * (0.0098 - 0.0065);
    expect(Math.abs(bg.N2 - theory) / theory).toBeLessThan(0.1);
    expect(bg.N).toBeCloseTo(Math.sqrt(bg.N2), 9);
    expect(bg.label).toBe('ECMWF 925–500 hPa');
  });

  it('weights the mean wind by mass, so dense low air counts more', () => {
    const bg = layerBackground(sounding((z) => (z < 3000 ? 10 : 30)), 0, 9000)!;
    let sum = 0, n = 0;
    for (let z = bg.bottomM + 5; z < bg.topM; z += 10) { sum += bg.at(z)!.u; n++; }
    const heightMean = sum / n;
    expect(bg.U).toBeLessThan(heightMean - 0.5);
    expect(bg.U).toBeGreaterThan(10 * KT);
  });

  it('keeps real shear by level and has no wind above the profile', () => {
    const bg = layerBackground(sounding((z) => 10 + z / 500, 180), 0, 8000)!;
    const low = bg.at(1500)!, high = bg.at(7000)!;
    expect(high.v).toBeGreaterThan(low.v); // from the south: v positive, increasing
    expect(Math.abs(low.u)).toBeLessThan(1e-6);
    expect(bg.at(20_000)).toBeNull();
  });

  it('does not stretch an upper-only profile into valley wind or condensation', () => {
    const levels: WindProfileLevel[] = [
      { hPa: 500, zM: 5500, tC: -20, rh: 95, windKt: 40, windFrom: 270 },
      { hPa: 400, zM: 7000, tC: -30, rh: 95, windKt: 50, windFrom: 270 },
    ];
    const bg = layerBackground(levels, 1000, 8000)!;
    expect(bg).not.toBeNull();
    expect(bg.at(1000)).toBeNull();
    expect(bg.at(5499)).toBeNull();
    expect(bg.at(NaN)).toBeNull();
    expect(bg.at(5500)!.u).toBeCloseTo(40 * KT, 6);
    expect(bg.at(7000)!.u).toBeCloseTo(50 * KT, 6);
    const wave = buildMountainWave({ heights: new Float32Array(16).fill(1000), nx: 4, ny: 4,
      bounds: { west: -0.1, east: 0.1, south: -0.1, north: 0.1 }, U: bg.U, V: bg.V, N: bg.N })!;
    const field = createMountainWindField(wave, bg, () => 1000);
    expect(field(0, 0, 1500)).toBeNull(); // no trail or condensation sample
    expect(field(0, 0, 6000)).not.toBeNull();
  });

  it.each(['windKt', 'tC', 'zM'] as const)('keeps a missing %s pressure level as a gap', (key) => {
    const levels = sounding(() => 20);
    const missing = levels.findIndex((l) => l.hPa === 700);
    const z = levels[missing].zM;
    levels[missing] = { ...levels[missing], [key]: key === 'zM' ? NaN : null };
    const bg = layerBackground(levels, 500, 8000)!;
    expect(bg).not.toBeNull();
    expect(bg.at(z)).toBeNull();
    expect(bg.at((z + levels[missing - 1].zM) / 2)).toBeNull();
    expect(bg.at((z + levels[missing + 1].zM) / 2)).toBeNull();
    // Exact surviving rows and adjacent supported intervals remain usable.
    expect(bg.at(levels[missing - 1].zM)!.u).toBeCloseTo(20 * KT, 6);
    expect(bg.at(levels[missing + 1].zM)!.u).toBeCloseTo(20 * KT, 6);
    expect(bg.at(1000)).not.toBeNull();
    expect(bg.at(6000)).not.toBeNull();
    expect(bg.U).toBeCloseTo(20 * KT, 6);
    const wave = buildMountainWave({ heights: new Float32Array(16).fill(0), nx: 4, ny: 4,
      bounds: { west: -0.1, east: 0.1, south: -0.1, north: 0.1 }, U: bg.U, V: bg.V, N: bg.N })!;
    expect(createMountainWindField(wave, bg, () => 0)(0, 0, z)).toBeNull();
  });

  it('is missing when the profile cannot describe the layer', () => {
    expect(layerBackground([], 0, 5000)).toBeNull();
    expect(layerBackground(sounding(() => 20).map((l) => ({ ...l, windKt: null })), 0, 5000)).toBeNull();
    expect(layerBackground(sounding(() => 20).slice(0, 1), 0, 5000)).toBeNull();
  });
});

describe('total mountain wind = real background + linear perturbation', () => {
  const nx = 96, ny = 96, dx = 500, lat0 = 46, lon0 = 8;
  const mLon = 111_320 * Math.cos(lat0 * Math.PI / 180), mLat = 111_132;
  const half = (nx - 1) * dx / 2;
  const bounds = { west: lon0 - half / mLon, east: lon0 + half / mLon, south: lat0 - half / mLat, north: lat0 + half / mLat };
  const ridge = (x: number) => 1000 + 1200 * Math.exp(-((x / 5000) ** 2));
  const heights = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = ridge(i * dx - half);
  const ground = (lon: number) => ridge((lon - lon0) * mLon);
  const lonAt = (x: number) => lon0 + x / mLon;
  const build = (rh: number, terrain = heights) => {
    const bg = layerBackground(sounding(() => 30, 270, rh), 1000, 6200)!;
    const wave = buildMountainWave({ heights: terrain, nx, ny, bounds, U: bg.U, V: bg.V, N: bg.N, clipGround: false })!;
    return { bg, wave, field: createMountainWindField(wave, bg, (lon) => (Number.isFinite(lon) ? ground(lon) : null)) };
  };

  it('rises on the windward slope at the kinematic rate and is null underground', () => {
    const { field, bg } = build(50);
    const x = -4000, z = ground(lonAt(x)) + 5;
    const s = field(lat0, lonAt(x), z)!;
    const slope = (ground(lonAt(x + 1)) - ground(lonAt(x - 1))) / 2;
    expect(s.w).toBeGreaterThan(0);
    expect(Math.abs(s.w - bg.U * slope * buildDamping(build(50).wave)) / s.w).toBeLessThan(0.15);
    expect(field(lat0, lonAt(x), z - 30)).toBeNull();
    expect(field(lat0, lonAt(4000), ground(lonAt(4000)) + 50)!.w).toBeLessThan(0);
  });

  it('condenses wave cloud from moist air and leaves the same dry flow clear', () => {
    const wet = build(97).field, dry = build(15).field;
    let wetCloud = 0, dryCloud = 0, sameWind = true;
    for (let x = -8000; x <= 12_000; x += 500) for (let z = 2400; z <= 5000; z += 200) {
      const a = wet(lat0, lonAt(x), z), b = dry(lat0, lonAt(x), z);
      if (!a || !b) continue;
      wetCloud += a.density; dryCloud += b.density;
      if (Math.abs(a.u - b.u) > 1e-9 || Math.abs(a.w - b.w) > 1e-9) sameWind = false;
    }
    expect(wetCloud).toBeGreaterThan(1);
    expect(dryCloud).toBe(0);
    expect(sameWind).toBe(true);
  });

  it('advects displacement with the local sheared wind on a 400 m Gaussian ridge', () => {
    const terrain = new Float32Array(nx * ny);
    const hill = (x: number) => 1000 + 400 * Math.exp(-((x / 5000) ** 2));
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) terrain[j * nx + i] = hill(i * dx - half);
    const bg = layerBackground(sounding((z) => 10 + z / 150), 1000, 5400)!;
    const wave = buildMountainWave({ heights: terrain, nx, ny, bounds, U: bg.U, V: bg.V, N: bg.N, clipGround: false })!;
    const field = createMountainWindField(wave, bg, (lon) => hill((lon - lon0) * mLon));
    expect(wave.blocked).toBe(false);
    for (const x of [-5000, -4000, -3000]) for (const agl of [5, 250, 1000]) {
      const z = hill(x) + agl, s = wave.sample(lat0, lonAt(x), z)!;
      const b = bg.at(s.sourceHeightM)!;
      const etaX = (wave.sampleLinear(lat0, lonAt(x + dx / 2), s.z0)!.eta - wave.sampleLinear(lat0, lonAt(x - dx / 2), s.z0)!.eta) / dx;
      const expected = b.u * etaX;
      const actual = field(lat0, lonAt(x), z)!;
      expect(actual.u).toBeCloseTo(b.u + s.du, 6);
      expect(Math.abs(actual.w - expected) / Math.abs(expected)).toBeLessThan(0.05);
    }
  });

  it('is the real sheared profile, unperturbed, over flat ground', () => {
    const flat = new Float32Array(nx * ny).fill(1000);
    const bg = layerBackground(sounding((z) => 10 + z / 400), 1000, 6000)!;
    const wave = buildMountainWave({ heights: flat, nx, ny, bounds, U: bg.U, V: bg.V, N: bg.N, clipGround: false })!;
    const field = createMountainWindField(wave, bg, () => 1000);
    for (const z of [1500, 3000, 5000]) {
      const s = field(lat0, lon0, z)!;
      expect(s.u).toBeCloseTo(bg.at(z)!.u, 6);
      expect(s.w).toBeCloseTo(0, 9);
    }
  });
});

function buildDamping(wave: { damping: number }) { return wave.damping; }
