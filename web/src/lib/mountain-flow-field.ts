import {
  sampleMountainCloud,
  terrainDisplacement,
  type MountainCloudResult,
} from "./mountain-cloud";

export interface MountainFlowVector {
  lat: number;
  lon: number;
  heightM: number;
  u: number;
  v: number;
  w?: number | null;
  temperatureC?: number;
  rhPct?: number;
  pressureHPa?: number;
  stabilityN2?: number;
  cloudPct?: number;
}
export interface MountainFlowSample extends MountainCloudResult {
  u: number;
  v: number;
  w: number;
  temperatureC: number;
  rhPct: number;
  pressureHPa: number;
  stabilityN2: number;
  liftM: number;
}
export type MountainTerrain = (lon: number, lat: number) => number | null;
const MAX_CACHE = 8192,
  MAX_COLUMNS = 4,
  TRACE_M = 6000,
  TRACE_STEP = 500,
  MAX_HORIZONTAL_M = 20000;
const finite = (n: number) => Number.isFinite(n),
  clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
function distanceM(a: MountainFlowVector, b: { lat: number; lon: number }) {
  const lat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  return Math.hypot(
    (a.lat - b.lat) * 111132,
    (a.lon - b.lon) * 111320 * Math.cos(lat),
  );
}
function columnKey(lat: number, lon: number) {
  return `${lat.toFixed(5)}:${lon.toFixed(5)}`;
}
function columnsOf(vectors: readonly MountainFlowVector[]) {
  const map = new Map<string, MountainFlowVector[]>();
  for (const v of vectors)
    if (
      [
        v.lat,
        v.lon,
        v.heightM,
        v.u,
        v.v,
        v.w,
        v.temperatureC,
        v.rhPct,
        v.pressureHPa,
        v.stabilityN2,
      ].every((value) => typeof value === "number" && finite(value))
    ) {
      const k = columnKey(v.lat, v.lon);
      const list = map.get(k) ?? [];
      list.push(v);
      map.set(k, list);
    }
  for (const list of map.values()) list.sort((a, b) => a.heightM - b.heightM);
  return [...map.values()];
}
function cacheSet<K, V>(map: Map<K, V>, key: K, value: V) {
  if (map.size >= MAX_CACHE) map.delete(map.keys().next().value!);
  map.set(key, value);
}
function interpolate(column: MountainFlowVector[], height: number) {
  if (!column.length) return null;
  const fields = (key: keyof MountainFlowVector) =>
    column
      .map((v) => v[key])
      .every((value) => typeof value === "number" && finite(value as number));
  if (!fields("u") || !fields("v") || !fields("w")) return null;
  let low = column[0],
    high = column[column.length - 1];
  for (let i = 0; i < column.length - 1; i += 1)
    if (height >= column[i].heightM && height <= column[i + 1].heightM) {
      low = column[i];
      high = column[i + 1];
      break;
    }
  const outside =
    height < low.heightM
      ? low.heightM - height
      : height > high.heightM
        ? height - high.heightM
        : 0;
  if (outside > 500) return null;
  const span = Math.max(1, high.heightM - low.heightM),
    t = clamp((height - low.heightM) / span, 0, 1),
    value = (key: keyof MountainFlowVector) => {
      const a = low[key],
        b = high[key];
      if (
        typeof a !== "number" ||
        typeof b !== "number" ||
        !finite(a) ||
        !finite(b)
      )
        return null;
      return a + (b - a) * t;
    };
  const temperature = value("temperatureC"),
    pressure = value("pressureHPa"),
    rh = value("rhPct"),
    stability = value("stabilityN2"),
    u = value("u"),
    v = value("v"),
    w = value("w");
  if ([temperature, pressure, rh, stability, u, v].some((x) => x == null))
    return null;
  return {
    u,
    v,
    w: w as number,
    temperatureC: temperature,
    rhPct: clamp(rh as number, 0, 100),
    pressureHPa: Math.max(50, pressure as number),
    stabilityN2: stability as number,
  };
}

export function createMountainFlowField(
  vectors: readonly MountainFlowVector[],
  terrain: MountainTerrain,
  experiment?: { moistLayerM: number; moistLayerDepthM: number },
) {
  const columns = columnsOf(vectors),
    selectionCache = new Map<string, MountainFlowVector[][]>(),
    terrainCache = new Map<string, number | null>(),
    traceCache = new Map<
      string,
      { ground: number; crest: number; baseline: number; crestDistance: number }
    >();
  const sampledTerrain = (lon: number, lat: number) => {
    const k = `${lat.toFixed(3)}:${lon.toFixed(3)}`;
    if (terrainCache.has(k)) return terrainCache.get(k)!;
    const value = terrain(lon, lat);
    cacheSet(terrainCache, k, value);
    return value;
  };
  const select = (lat: number, lon: number) => {
    const k = `${lat.toFixed(3)}:${lon.toFixed(3)}`,
      cached = selectionCache.get(k);
    if (cached) return cached;
    const selected = columns
      .slice()
      .sort(
        (a, b) => distanceM(a[0], { lat, lon }) - distanceM(b[0], { lat, lon }),
      )
      .slice(0, MAX_COLUMNS);
    cacheSet(selectionCache, k, selected);
    return selected;
  };
  return (
    lat: number,
    lon: number,
    heightM: number,
  ): MountainFlowSample | null => {
    if (
      ![lat, lon, heightM].every(
        (value) => typeof value === "number" && finite(value),
      )
    )
      return null;
    const candidates = select(lat, lon)
      .map((column) => ({
        column,
        value: interpolate(column, heightM),
        distance: distanceM(column[0], { lat, lon }),
      }))
      .filter(
        (item) => item.value !== null && item.distance <= MAX_HORIZONTAL_M,
      );
    if (!candidates.length) return null;
    const total = candidates.reduce(
      (sum, item) => sum + 1 / Math.max(250, item.distance) ** 2,
      0,
    );
    const blended = (
      key:
        | "u"
        | "v"
        | "w"
        | "temperatureC"
        | "rhPct"
        | "pressureHPa"
        | "stabilityN2",
    ) =>
      candidates.reduce(
        (sum, item) =>
          sum +
          (item.value![key] as number) / Math.max(250, item.distance) ** 2,
        0,
      ) / total;
    const base = {
      u: blended("u"),
      v: blended("v"),
      w: blended("w"),
      temperatureC: blended("temperatureC"),
      rhPct: blended("rhPct"),
      pressureHPa: blended("pressureHPa"),
      stabilityN2: blended("stabilityN2"),
    };
    if (!Object.values(base).every(finite) || base.pressureHPa <= 0)
      return null;
    const ground = sampledTerrain(lon, lat);
    if (ground == null || heightM - ground < 50) return null;
    const speed = Math.hypot(base.u, base.v),
      stepLon =
        speed > 0
          ? ((base.u / speed) * TRACE_STEP) /
            (111320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)))
          : 0,
      stepLat = speed > 0 ? ((base.v / speed) * TRACE_STEP) / 111132 : 0,
      directionBin = Math.round(
        (Math.atan2(stepLat, stepLon) / (Math.PI * 2)) * 16,
      ),
      traceKey = `${lat.toFixed(3)}:${lon.toFixed(3)}:${directionBin}`;
    let trace = traceCache.get(traceKey);
    if (!trace) {
      const groundValue = sampledTerrain(lon, lat);
      if (groundValue == null) return null;
      const samples: Array<{ distance: number; terrain: number }> = [
        { distance: 0, terrain: groundValue },
      ];
      for (
        let distance = TRACE_STEP;
        distance <= TRACE_M;
        distance += TRACE_STEP
      ) {
        const sampleGround = sampledTerrain(
          lon - stepLon * (distance / TRACE_STEP),
          lat - stepLat * (distance / TRACE_STEP),
        );
        if (sampleGround == null) return null;
        samples.push({ distance, terrain: sampleGround });
      }
      let crestIndex = 0;
      for (let index = 1; index < samples.length; index += 1)
        if (samples[index].terrain > samples[crestIndex].terrain)
          crestIndex = index;
      const crestPoint = samples[crestIndex],
        previous = samples[crestIndex - 1],
        next = samples[crestIndex + 1];
      let crestDistance = crestPoint.distance;
      if (previous && next) {
        const curvature =
          previous.terrain - 2 * crestPoint.terrain + next.terrain;
        if (curvature < 0)
          crestDistance += clamp(
            (0.5 * TRACE_STEP * (previous.terrain - next.terrain)) / curvature,
            -TRACE_STEP / 2,
            TRACE_STEP / 2,
          );
      }
      trace = {
        ground: groundValue,
        crest: crestPoint.terrain,
        baseline: Math.min(...samples.map((sample) => sample.terrain)),
        crestDistance,
      };
      cacheSet(traceCache, traceKey, trace);
    }
    if (heightM - trace.ground < 50) return null;
    const displacement = terrainDisplacement({
      upwindBaselineM: trace.baseline,
      crestM: trace.crest,
      currentDownwindM: trace.ground,
      distanceLeeM: trace.crestDistance,
      windSpeedMs: Math.max(1, speed),
      stabilityN2: base.stabilityN2,
      heightAboveGroundM: heightM - trace.ground,
    });
    const sourceHeight = heightM - displacement.totalM;
    const sourceCandidates = candidates
      .map((candidate) => ({
        ...candidate,
        value: interpolate(candidate.column, sourceHeight),
      }))
      .filter((candidate) => candidate.value !== null);
    if (!sourceCandidates.length) return null;
    const sourceTotal = sourceCandidates.reduce(
      (sum, item) => sum + 1 / Math.max(250, item.distance) ** 2,
      0,
    );
    const sourceBlend = (
      key: "temperatureC" | "rhPct" | "pressureHPa" | "stabilityN2",
    ) =>
      sourceCandidates.reduce(
        (sum, item) =>
          sum +
          (item.value![key] as number) / Math.max(250, item.distance) ** 2,
        0,
      ) / sourceTotal;
    const source = {
      temperatureC: sourceBlend("temperatureC"),
      rhPct: experiment
        ? 30 +
          66 *
            Math.exp(
              -(
                ((sourceHeight - experiment.moistLayerM) /
                  experiment.moistLayerDepthM) **
                2
              ),
            )
        : sourceBlend("rhPct"),
      pressureHPa: sourceBlend("pressureHPa"),
      stabilityN2: sourceBlend("stabilityN2"),
    };
    if (!Object.values(source).every(finite)) return null;
    const cloud = sampleMountainCloud({
      ...source,
      liftM: displacement.totalM,
      heightAboveGroundM: heightM - trace.ground,
      windSpeedMs: Math.max(0, speed),
    });
    return {
      ...base,
      w: clamp(base.w + displacement.waveVerticalVelocityMs, -12, 12),
      liftM: displacement.liftM,
      condensateGKg: cloud.condensateGKg,
      density: cloud.density,
      kind: cloud.kind,
      saturated: cloud.saturated,
      lclM: cloud.lclM,
      liftedTemperatureC: cloud.liftedTemperatureC,
      mixingRatioGKg: cloud.mixingRatioGKg,
    };
  };
}
