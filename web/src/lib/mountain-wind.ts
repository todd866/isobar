/**
 * Real mountain wind: a pressure-level profile (ECMWF via Open-Meteo) gives
 * the background wind with its shear and the layer's stability; the linear
 * mountain-wave solver adds the terrain perturbation. Worker-safe.
 * Missing data stays missing: no profile, no field.
 */
import type { MountainWaveField } from './mountain-wave';
import { sampleMountainCloud } from './mountain-cloud';

export interface WindProfileLevel {
  hPa: number;
  zM: number;
  tC: number | null;
  rh: number | null;
  windKt: number | null;
  windFrom: number | null;
}
export interface BackgroundAt { u: number; v: number; tC: number; rh: number | null; hPa: number }
export interface LayerBackground {
  /** Mass-weighted mean wind over the layer, m/s. */
  U: number; V: number;
  /** Bulk buoyancy frequency from θ across the layer. */
  N: number; N2: number;
  bottomM: number; topM: number;
  /** Pressure levels that fall inside the layer. */
  bottomHPa: number; topHPa: number;
  /** One short on-screen source line, e.g. "ECMWF 850–300 hPa". */
  label: string;
  /** Background state at a height AMSL; null outside the profile or in a missing-level gap. */
  at(zM: number): BackgroundAt | null;
}

const KT = 0.514444;
const G = 9.80665;
const KAPPA = 0.2857;

interface Row { index: number; z: number; u: number; v: number; tC: number; rh: number | null; lnP: number; hPa: number }

export function layerBackground(levels: readonly WindProfileLevel[], bottomM: number, topM: number, source = 'ECMWF'): LayerBackground | null {
  if (!Number.isFinite(bottomM) || !Number.isFinite(topM) || topM <= bottomM) return null;
  // Preserve pressure-order adjacency before discarding invalid rows, even
  // when the missing row has no height. Surviving neighbours cannot bridge it.
  const ordered = [...levels].sort((a, b) => b.hPa - a.hPa).map((l, index) => ({ ...l, index }));
  const rows: Row[] = ordered
    .filter((l) => [l.hPa, l.zM, l.tC, l.windKt, l.windFrom].every((x) => typeof x === 'number' && Number.isFinite(x)) && l.hPa > 0)
    .map((l) => {
      const r = (l.windFrom as number) * Math.PI / 180, speed = (l.windKt as number) * KT;
      return { index: l.index, z: l.zM, u: -speed * Math.sin(r), v: -speed * Math.cos(r), tC: l.tC as number, rh: typeof l.rh === 'number' && Number.isFinite(l.rh) ? l.rh : null, lnP: Math.log(l.hPa), hPa: l.hPa };
    })
    .sort((a, b) => a.z - b.z);
  if (rows.length < 2) return null;
  const zMax = rows[rows.length - 1].z;
  const top = Math.min(topM, zMax), bottom = Math.max(bottomM, rows[0].z);
  if (top - bottom < 500) return null;
  const interp = (z: number) => {
    if (!Number.isFinite(z) || z < rows[0].z || z > zMax) return null;
    let i = 0;
    while (i < rows.length - 2 && z > rows[i + 1].z) i++;
    const a = rows[i], b = rows[i + 1], t = Math.max(0, Math.min(1, (z - a.z) / (b.z - a.z)));
    if (t > 0 && t < 1 && b.index !== a.index + 1) return null;
    const lerp = (p: number, q: number) => p + (q - p) * t;
    return {
      u: lerp(a.u, b.u), v: lerp(a.v, b.v), tC: lerp(a.tC, b.tC),
      rh: a.rh != null && b.rh != null ? lerp(a.rh, b.rh) : null,
      hPa: Math.exp(lerp(a.lnP, b.lnP)),
    };
  };
  // Layer endpoints must be supported; integrate mass only over contiguous
  // valid pressure intervals, leaving discarded rows as unsampled gaps.
  if (!interp(bottom) || !interp(top)) return null;
  let su = 0, sv = 0, sw = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i + 1].index !== rows[i].index + 1) continue;
    const low = Math.max(bottom, rows[i].z), high = Math.min(top, rows[i + 1].z);
    if (!(high > low)) continue;
    const steps = Math.max(1, Math.ceil((high - low) / 50));
    for (let s = 0; s < steps; s++) {
      const z0 = low + (high - low) * s / steps, z1 = low + (high - low) * (s + 1) / steps;
      const a = interp(z0)!, b = interp(z1)!, mid = interp((z0 + z1) / 2)!;
      const dp = a.hPa - b.hPa;
      su += mid.u * dp; sv += mid.v * dp; sw += dp;
    }
  }
  if (!(sw > 0)) return null;
  const theta = (z: number) => { const s = interp(z)!; return (s.tC + 273.15) * (1000 / s.hPa) ** KAPPA; };
  const tb = theta(bottom), tt = theta(top);
  const N2 = G / ((tb + tt) / 2) * (tt - tb) / (top - bottom);
  const inside = rows.filter((r) => r.z >= bottom - 1e-6 && r.z <= top + 1e-6);
  const bottomHPa = inside.length ? inside[0].hPa : interp(bottom)!.hPa;
  const topHPa = inside.length ? inside[inside.length - 1].hPa : interp(top)!.hPa;
  return {
    U: su / sw, V: sv / sw, N2, N: Math.sqrt(Math.max(0, N2)), bottomM: bottom, topM: top,
    bottomHPa, topHPa, label: `${source} ${Math.round(bottomHPa)}–${Math.round(topHPa)} hPa`,
    at: interp,
  };
}

export interface MountainWindSample {
  u: number; v: number; w: number;
  /** Streamline displacement and the height the air came from. */
  eta: number; sourceHeightM: number;
  temperatureC: number;
  rhPct: number | null;
  pressureHPa: number;
  stabilityN2: number;
  /** Cloud optical density 0–1 from parcel condensation; 0 when humidity is missing. */
  density: number;
  cloudKnown: boolean;
}

/**
 * Total wind at (lat, lon, z AMSL): the background at the air's undisturbed
 * height plus the linear perturbation. Null outside the solver grid, below
 * `ground`, or above the profile.
 */
export function createMountainWindField(wave: MountainWaveField, background: LayerBackground, ground: (lon: number, lat: number) => number | null) {
  return (lat: number, lon: number, zM: number): MountainWindSample | null => {
    const floor = ground(lon, lat);
    if (floor == null || !Number.isFinite(floor) || !(zM >= floor)) return null;
    const s = wave.sample(lat, lon, zM);
    if (!s) return null;
    const b = background.at(s.sourceHeightM);
    if (!b) return null;
    const u = b.u + s.du, v = b.v + s.dv;
    // WKB-style approximation: η and u′ retain the uniform layer-mean
    // solution, but its spectral gradients are advected by the local profile
    // at the source height. This restores w = U_local η_x + V_local η_y
    // to linear order; it is not a full shear/critical-level solution.
    const w = b.u * s.etaX + b.v * s.etaY;
    let density = 0, temperatureC = b.tC + 0, cloudKnown = false;
    if (b.rh != null) try {
      const parcel = sampleMountainCloud({
        temperatureC: b.tC, rhPct: b.rh, pressureHPa: b.hPa, liftM: s.eta,
        stabilityN2: background.N2, heightAboveGroundM: zM - floor, windSpeedMs: Math.hypot(u, v),
      });
      density = parcel.density; temperatureC = parcel.liftedTemperatureC; cloudKnown = true;
    } catch { /* out-of-range thermodynamics: cloud stays unknown */ }
    return { u, v, w, eta: s.eta, sourceHeightM: s.sourceHeightM, temperatureC, rhPct: b.rh, pressureHPa: b.hPa, stabilityN2: background.N2, density, cloudKnown };
  };
}

/** A uniform background for teaching: chosen wind and N, thermodynamics supplied. */
export function uniformBackground(U: number, V: number, N2: number, thermo: (zM: number) => { tC: number; rh: number | null; hPa: number } | null, label: string): LayerBackground {
  return {
    U, V, N2, N: Math.sqrt(Math.max(0, N2)), bottomM: 0, topM: 20_000, bottomHPa: NaN, topHPa: NaN, label,
    at: (zM) => { const t = thermo(zM); return t ? { u: U, v: V, ...t } : null; },
  };
}

export interface MountainTile { lat: number; lon: number; west: number; east: number; south: number; north: number; key: string }
/** Fixed geographic solver tile: centre snapped to 0.25°, ±0.4° of latitude, square in metres. Never zoom-dependent. */
export function mountainTile(lat: number, lon: number): MountainTile {
  const step = 0.25, cLat = Math.max(-80, Math.min(80, Math.round(lat / step) * step)), cLon = Math.round(lon / step) * step;
  const halfLat = 0.4, halfLon = halfLat / Math.max(0.2, Math.cos(cLat * Math.PI / 180));
  return { lat: cLat, lon: cLon, west: cLon - halfLon, east: cLon + halfLon, south: cLat - halfLat, north: cLat + halfLat, key: `${cLat.toFixed(2)}:${cLon.toFixed(2)}` };
}

/**
 * Trail seeds on a fixed geographic lattice. The lattice is nested by powers
 * of two (a coarser step is a subset of a finer one), so zooming keeps the
 * existing seeds and their hashed phase. Heights are a fixed AMSL ladder.
 */
export function geographicSeeds(bounds: { west: number; east: number; south: number; north: number }, ground: (lon: number, lat: number) => number | null, topM: number, across = 8) {
  const span = Math.max(1e-4, bounds.north - bounds.south);
  const step = 0.32 / 2 ** Math.max(0, Math.min(8, Math.round(Math.log2(0.32 * across / span))));
  const cos = Math.max(0.2, Math.cos(Math.round((bounds.south + bounds.north) / 2) * Math.PI / 180));
  const stepLon = step / cos, seeds: { lat: number; lon: number; heightM: number }[] = [];
  for (let a = Math.ceil(bounds.south / step) * step; a <= bounds.north; a += step)
    for (let o = Math.ceil(bounds.west / stepLon) * stepLon; o <= bounds.east; o += stepLon) {
      const floor = ground(o, a);
      if (floor == null || !Number.isFinite(floor)) continue;
      for (let h = 0; h <= topM; h += 400) if (h >= floor + 80) seeds.push({ lat: +a.toFixed(6), lon: +o.toFixed(6), heightM: h });
    }
  return seeds;
}

/** Relief (max − min, metres) over a tile from a 17×17 sample; null when nothing is loaded. */
export function tileRelief(elevation: ((lon: number, lat: number) => number | null) | null | undefined, tile: MountainTile): number | null {
  if (!elevation) return null;
  let min = Infinity, max = -Infinity;
  for (let j = 0; j <= 16; j++) for (let i = 0; i <= 16; i++) {
    const h = elevation(tile.west + (tile.east - tile.west) * i / 16, tile.south + (tile.north - tile.south) * j / 16);
    if (h != null && Number.isFinite(h)) { min = Math.min(min, h); max = Math.max(max, h); }
  }
  return max >= min ? max - min : null;
}
/** Real mountain wind is shown over terrain with at least this relief in its tile. */
export const MOUNTAIN_RELIEF_M = 1500;
