export interface StreamlineSeed {
  lat: number;
  lon: number;
  heightM: number;
  u?: number;
  v?: number;
  w?: number;
}
export interface WindSample {
  cloudDensity?: number;
  u: number | null;
  v: number | null;
  w: number | null;
}
export interface StreamlinePoint {
  cloudDensity: number;
  lat: number;
  lon: number;
  heightM: number;
  speedMs: number;
  w: number;
}
export interface MountainStreamline {
  points: StreamlinePoint[];
  phase: number;
}
export interface MountainStreamlineOptions {
  maxPaths?: number;
  steps?: number;
  stepM?: number;
}

const MAX_PATHS = 96,
  MAX_STEPS = 24,
  DEFAULT_STEP = 100;
const finite = (n: number) => Number.isFinite(n);
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
function key(seed: StreamlineSeed) {
  return `${seed.lat.toFixed(6)}:${seed.lon.toFixed(6)}:${seed.heightM.toFixed(1)}`;
}
function validSeed(seed: StreamlineSeed) {
  return finite(seed.lat) && finite(seed.lon) && finite(seed.heightM);
}
function selectSeeds(seeds: readonly StreamlineSeed[], limit: number) {
  const sorted = seeds
    .filter(validSeed)
    .slice()
    .sort((a, b) => key(a).localeCompare(key(b)));
  if (sorted.length <= limit) return sorted;
  const bins: Array<StreamlineSeed[]> = Array.from({ length: 8 }, () => []);
  const heights = sorted.map((seed) => seed.heightM),
    low = Math.min(...heights),
    span = Math.max(1, Math.max(...heights) - low);
  for (const seed of sorted)
    bins[clamp(Math.floor(((seed.heightM - low) / span) * 8), 0, 7)].push(seed);
  for (const bin of bins) bin.sort((a, b) => hash(key(a)) - hash(key(b)));
  const selected: StreamlineSeed[] = [];
  for (let index = 0; selected.length < limit; index += 1)
    for (const bin of bins)
      if (bin[index]) {
        selected.push(bin[index]);
        if (selected.length === limit) break;
      }
  return selected;
}
function terrainHeight(
  terrain: (lon: number, lat: number) => number | null,
  lon: number,
  lat: number,
) {
  const value = terrain(lon, lat);
  return value != null && finite(value) ? value : null;
}
function pointAt(
  state: { lat: number; lon: number; heightM: number },
  field: WindSample,
  stepM: number,
  sign: number,
) {
  const east = field.u ?? 0,
    north = field.v ?? 0,
    up = field.w ?? 0,
    speed = Math.hypot(east, north, up);
  if (!finite(speed) || speed < 1e-6) return null;
  return {
    lat: state.lat + (sign * north * stepM) / (111132 * speed),
    lon:
      state.lon +
      (sign * east * stepM) /
        (111320 * Math.max(0.1, Math.cos((state.lat * Math.PI) / 180)) * speed),
    heightM: state.heightM + (sign * up * stepM) / speed,
  };
}
function integrate(
  seed: StreamlineSeed,
  sign: number,
  sample: (lat: number, lon: number, height: number) => WindSample | null,
  terrain: (lon: number, lat: number) => number | null,
  steps: number,
  stepM: number,
) {
  const points: StreamlinePoint[] = [];
  let state = { lat: seed.lat, lon: seed.lon, heightM: seed.heightM };
  for (let index = 0; index < steps; index += 1) {
    const field = sample(state.lat, state.lon, state.heightM);
    if (
      !field ||
      ![field.u, field.v, field.w].every(
        (value) => value != null && finite(value),
      )
    )
      break;
    const clean = {
        u: field.u as number,
        v: field.v as number,
        w: field.w as number,
      },
      speed = Math.hypot(clean.u, clean.v, clean.w);
    if (speed < 1e-6) break;
    const ground = terrainHeight(terrain, state.lon, state.lat);
    if (ground == null || state.heightM - ground < 50) break;
    points.push({
      lat: state.lat,
      lon: state.lon,
      heightM: state.heightM,
      speedMs: speed,
      w: clean.w,
      cloudDensity:clamp(field.cloudDensity??0,0,1),
    });
    const half = pointAt(state, clean, stepM / 2, sign);
    if (!half) break;
    const midpoint = sample(half.lat, half.lon, half.heightM);
    if (
      !midpoint ||
      ![midpoint.u, midpoint.v, midpoint.w].every(
        (value) => value != null && finite(value),
      )
    )
      break;
    const midpointGround = terrainHeight(terrain, half.lon, half.lat);
    if (midpointGround == null || half.heightM - midpointGround < 50) break;
    const next = pointAt(
      state,
      {
        u: midpoint.u as number,
        v: midpoint.v as number,
        w: midpoint.w as number,
      },
      stepM,
      sign,
    );
    if (!next) break;
    const nextGround = terrainHeight(terrain, next.lon, next.lat);
    if (nextGround == null || next.heightM - nextGround < 50) break;
    state = next;
  }
  return points;
}

/** Build bounded, deterministic 3D wind streamlines around sampled terrain. */
export function buildMountainStreamlines(
  seeds: readonly StreamlineSeed[],
  sample: (lat: number, lon: number, height: number) => WindSample | null,
  terrain: (lon: number, lat: number) => number | null,
  options: MountainStreamlineOptions = {},
): MountainStreamline[] {
  const requestedPaths = options.maxPaths ?? MAX_PATHS,
    requestedSteps = options.steps ?? MAX_STEPS,
    requestedStepM = options.stepM ?? DEFAULT_STEP;
  if (![requestedPaths, requestedSteps, requestedStepM].every(finite))
    throw new Error("streamline options must be finite");
  const maxPaths = clamp(Math.floor(requestedPaths), 1, MAX_PATHS),
    steps = clamp(Math.floor(requestedSteps), 1, MAX_STEPS),
    stepM = clamp(requestedStepM, 25, 500),
    paths: MountainStreamline[] = [];
  for (const seed of selectSeeds(seeds, maxPaths)) {
    const forward = integrate(seed, 1, sample, terrain, steps, stepM),
      backward = integrate(seed, -1, sample, terrain, steps, stepM);
    const points = [...backward.reverse(), ...forward.slice(1)];
    if (points.length >= 2) paths.push({ points, phase: hash(key(seed)) });
  }
  return paths;
}
export const mountainStreamlineLimits = {
  maxPaths: MAX_PATHS,
  maxSteps: MAX_STEPS,
  defaultStepM: DEFAULT_STEP,
} as const;
