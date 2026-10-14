/// <reference lib="webworker" />
import { buildCloudDensityTexture, type CloudDensityVector, type CloudDensityBounds } from './cloud-density';
import { sampleTeachingAtmosphere, type TeachingAtmosphereContext } from './atmosphere-teaching';
import { buildMountainStreamlines } from './mountain-streamlines';
import type { AtmosphereSlice } from './atmosphere-slice';
import { slicePoint } from './atmosphere-slice';
import { seaBreezeStreamlines } from './teaching-streamlines';
import { buildMountainWave, type MountainWaveField } from './mountain-wave';
import { createMountainWindField, geographicSeeds, layerBackground, uniformBackground, type LayerBackground, type WindProfileLevel } from './mountain-wind';

export interface GridTerrain { heights: Float32Array; nx: number; ny: number; bounds: { west: number; east: number; south: number; north: number } }
export interface AtmosphereWorkerInput {
  slice?: AtmosphereSlice;
  /** Displayed volume. */
  bounds: CloudDensityBounds;
  /** Ground for clipping, sampled from the drawn terrain over the displayed volume. */
  ground: GridTerrain;
  /** Fixed geographic solver tile from the same sampler (NaN where not loaded). */
  tile?: GridTerrain;
  timeSeconds: number;
  cloudEnabled: boolean;
  /** 'mountain': real wind over terrain; otherwise a teaching scenario. */
  mountain: boolean;
  teaching?: TeachingAtmosphereContext;
  /** Pressure-level profile at the tile centre for the selected time, or null when unavailable. */
  profile?: WindProfileLevel[] | null;
  /** Teaching seeds (vectors) for the analytic scenarios. */
  vectors: CloudDensityVector[];
}
export interface WaveSummary { label: string; blocked: boolean; nh: number; U: number; V: number; N: number; coverage: number; idealised: boolean }

// Teaching mountain wave: chosen speed and stability, direction from the real wind when known.
const TEACH_SPEED = 16, TEACH_N2 = 0.00035;
let cache: { key: string; wave: MountainWaveField } | null = null;

function gridSampler(g: GridTerrain) {
  const { heights, nx, ny, bounds } = g;
  return (lon: number, lat: number) => {
    if (!(lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north)) return null;
    const x = (lon - bounds.west) / (bounds.east - bounds.west) * (nx - 1), y = (lat - bounds.south) / (bounds.north - bounds.south) * (ny - 1);
    const x0 = Math.min(nx - 2, Math.floor(x)), y0 = Math.min(ny - 2, Math.floor(y)), tx = x - x0, ty = y - y0, a = y0 * nx + x0;
    const v = (heights[a] * (1 - tx) + heights[a + 1] * tx) * (1 - ty) + (heights[a + nx] * (1 - tx) + heights[a + nx + 1] * tx) * ty;
    return Number.isFinite(v) ? v : null;
  };
}

/** Unknown tile cells take the tile's known mean: terrain outside the loaded DEM is left out of the solution. */
function fillTile(tile: GridTerrain) {
  let sum = 0, known = 0, min = Infinity, max = -Infinity;
  for (const h of tile.heights) if (Number.isFinite(h)) { sum += h; known++; min = Math.min(min, h); max = Math.max(max, h); }
  if (!known) return null;
  const mean = sum / known, heights = Float32Array.from(tile.heights, (h) => (Number.isFinite(h) ? h : mean));
  return { heights, mean, min, max, coverage: known / tile.heights.length };
}

function teachingThermo(ground: number, profile: LayerBackground | null) {
  // Real temperature/humidity when the profile is known; otherwise the teaching column.
  return (z: number) => {
    const real = profile?.at(z);
    if (real) return { tC: real.tC, rh: real.rh, hPa: real.hPa };
    const t = 24 - 0.0065 * z, hPa = 1013.25 * Math.exp(-9.80665 * z / (287.05 * (t + 273.15)));
    return { tC: t, rh: Math.max(28, Math.min(96, 86 - 0.0018 * (z - ground))), hPa };
  };
}

self.onmessage = (event: MessageEvent<AtmosphereWorkerInput>) => {
  const { slice, bounds, ground: groundGrid, tile, timeSeconds, cloudEnabled, mountain, teaching, profile, vectors } = event.data;
  const started = performance.now();
  try {
    const elevation = gridSampler(groundGrid);
    let field: ((lat: number, lon: number, z: number) => { u: number; v: number; w: number; density: number } | null) | undefined;
    let wave: WaveSummary | null = null, missing: string | null = null, solveMs = 0, seedsTop = 0;
    const filled = tile ? fillTile(tile) : null;
    const solverMode = mountain || (teaching?.kind === 'mountain-wave' && !!filled && filled.max - filled.min >= 300);
    if (solverMode) {
      if (!filled || !tile) missing = 'terrain';
      else {
        const real = profile?.length ? layerBackground(profile, filled.mean, filled.max + 4000) : null;
        let bg: LayerBackground | null = real;
        if (!mountain) {
          const speed = real ? Math.hypot(real.U, real.V) : 0;
          const ux = speed > 0.5 ? real!.U / speed : 1, vy = speed > 0.5 ? real!.V / speed : 0;
          const from = Math.round((Math.atan2(-ux, -vy) * 180 / Math.PI + 360) % 360);
          bg = uniformBackground(TEACH_SPEED * ux, TEACH_SPEED * vy, TEACH_N2, teachingThermo(teaching!.groundM, real), `Idealised ${Math.round(TEACH_SPEED / 0.514444)} kt from ${String(from).padStart(3, '0')}°`);
        }
        if (!bg) missing = 'profile';
        else {
          const key = [tile.bounds.west, tile.bounds.south, tile.nx, tile.ny, bg.U.toFixed(3), bg.V.toFixed(3), bg.N.toFixed(6), filled.heights.reduce((h, v, i) => (h + Math.round(v) * (i + 1)) % 2147483647, 0)].join(':');
          if (cache?.key !== key) {
            const t = performance.now();
            const built = buildMountainWave({ heights: filled.heights, nx: tile.nx, ny: tile.ny, bounds: tile.bounds, U: bg.U, V: bg.V, N: bg.N, clipGround: false });
            solveMs = performance.now() - t;
            cache = built ? { key, wave: built } : null;
          }
          if (!cache) missing = 'terrain';
          else {
            const solved = cache.wave;
            field = createMountainWindField(solved, bg, elevation);
            seedsTop = Math.min(solved.maxM + 4000, bg.topM);
            wave = { label: `${bg.label} · linear wave theory${solved.blocked ? ' · blocked' : ''}`, blocked: solved.blocked, nh: solved.nondimensionalHeight, U: bg.U, V: bg.V, N: bg.N, coverage: filled.coverage, idealised: !mountain };
          }
        }
      }
    } else if (teaching) field = (lat, lon, z) => { const s = sampleTeachingAtmosphere(teaching, lat, lon, z); return { ...s, density: s.density }; };

    const cloud = cloudEnabled && field ? buildCloudDensityTexture([], { bounds, timeSeconds, terrain: (lat, lon) => elevation(lon, lat) ?? 0, flowSample: field }) : null;
    const spanM = (bounds.north - bounds.south) * 111_132;
    let streamlines: ReturnType<typeof buildMountainStreamlines> = [];
    if (teaching?.kind === 'sea-breeze' && !solverMode) streamlines = seaBreezeStreamlines(teaching, elevation, slice);
    else if (field) {
      const sample = (lat: number, lon: number, z: number) => { const f = field!(lat, lon, z); return f ? { u: f.u, v: f.v, w: f.w, cloudDensity: cloudEnabled ? f.density : 0 } : null; };
      const inside = (v: { lat: number; lon: number }) => v.lon > bounds.west && v.lon < bounds.east && v.lat > bounds.south && v.lat < bounds.north;
      let seeds: { lat: number; lon: number; heightM: number }[];
      if (!solverMode) seeds = vectors.filter(inside);
      else if (slice) {
        seeds = [];
        for (let x = -6; x <= 6; x++) {
          const p = slicePoint(slice, x / 7 * slice.halfWidthM, 0);
          const floor = p ? elevation(p.lon, p.lat) : null;
          if (p && floor != null) for (let h = 0; h <= seedsTop; h += 400) if (h >= floor + 80) seeds.push({ lat: p.lat, lon: p.lon, heightM: h });
        }
      } else seeds = geographicSeeds(bounds, elevation, seedsTop);
      streamlines = buildMountainStreamlines(seeds, sample, (lon, lat) => elevation(lon, lat) ?? (teaching && !solverMode ? teaching.groundM : null),
        solverMode ? { maxPaths: 80, steps: 24, stepM: Math.max(60, Math.min(600, spanM / 36)) } : { maxPaths: 64, steps: 24, stepM: Math.max(40, Math.min(teaching ? 500 : 220, spanM / 70)) });
    }
    self.postMessage({ scenario: mountain ? 'mountain' : teaching?.kind ?? 'mountain', cloud, streamlines, buildMs: performance.now() - started - solveMs, solveMs, wave, missing },
      { transfer: cloud ? [cloud.density.buffer, cloud.terrain.buffer] : [] });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Mountain atmosphere unavailable' }); }
};
