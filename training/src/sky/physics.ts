import { classifyLayer } from './cloud-rules.ts';
/**
 * Sky section physics: the air over one aerodrome at one time, as cloud
 * layers, precipitation, freezing level, icing bands, winds by level and a
 * surface parcel. Pure; no DOM. Spec: docs/design/sky-section.md.
 *
 * Authority, in order: the report (METAR now, the TAF group in force later),
 * then the ECMWF point profile (tops, mid/high cloud, freezing level, winds,
 * instability). Missing data stays missing: no profile means no model cloud,
 * no freezing level and unknown tops, never an ISA guess.
 */

export const FT_PER_M = 3.28084;
const G = 9.80665;
const RD = 287.04;
const CP = 1005.7;
const LV = 2.501e6;
const EPS = 0.622;
const HOUR = 3_600_000;

/* ---------- inputs ---------- */

/** One aerodrome's upper-air point series, as written by scripts/export-data.ts (sky.json). */
export interface ProfileSeries {
  icao: string;
  /** This profile's own cycle. Never another product's run (the map can be 12Z while this is 18Z). */
  run: string;
  /** Distributor of this series: "ECMWF" for the collector, "Open-Meteo" for a live point. */
  source?: string;
  /** Model id, e.g. ecmwf_ifs025. */
  model?: string;
  /** False when `run` is the fetch time because the source named no cycle. */
  runKnown?: boolean;
  lat: number;
  lon: number;
  /** Aerodrome elevation, ft AMSL (AIP). */
  elevationFt: number;
  /** Signed distance to the coast along the W–E section, km (negative = west). Null inland or unknown. */
  coastKm: number | null;
  /** Valid times, ms since epoch (UTC). */
  time: number[];
  levels: {
    hPa: number;
    /** Geopotential height, m. */
    z: (number | null)[];
    /** Temperature, °C. */
    t: (number | null)[];
    /** Relative humidity, %. */
    rh: (number | null)[];
    /** Wind speed, kt. */
    ws: (number | null)[];
    /** Direction the wind blows from, ° true. */
    wd: (number | null)[];
    /** Model cloud cover at the level, %. */
    cc: (number | null)[];
    /** Vertical velocity, m/s (positive up). */
    w: (number | null)[];
  }[];
}

export interface ProfileLevel {
  hPa: number;
  zM: number;
  tC: number | null;
  rh: number | null;
  windKt: number | null;
  windFrom: number | null;
  cloudPct: number | null;
  wMs: number | null;
}

export interface Profile {
  /** The valid time this profile represents. */
  timeMs: number;
  /** The sample times it was built from (one or two). */
  samples: number[];
  /** Levels with a height, sorted bottom-up. */
  levels: ProfileLevel[];
}

/* ---------- time interpolation ---------- */

const MAX_GAP = 3 * HOUR;

function lerp(a: number | null, b: number | null, f: number): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a + (b - a) * f;
}

function windLerp(s0: number | null, d0: number | null, s1: number | null, d1: number | null, f: number): [number | null, number | null] {
  if (s0 == null || d0 == null || s1 == null || d1 == null) return [null, null];
  const r = Math.PI / 180;
  const u = lerp(-s0 * Math.sin(d0 * r), -s1 * Math.sin(d1 * r), f) as number;
  const v = lerp(-s0 * Math.cos(d0 * r), -s1 * Math.cos(d1 * r), f) as number;
  const speed = Math.hypot(u, v);
  const from = (Math.atan2(-u, -v) / r + 360) % 360;
  return [speed, speed < 0.05 ? (f < 0.5 ? d0 : d1) : from];
}

function levelsAt(series: ProfileSeries, i0: number, i1: number, f: number): ProfileLevel[] {
  const out: ProfileLevel[] = [];
  for (const level of series.levels) {
    const z = lerp(level.z[i0], level.z[i1], f);
    if (z == null) continue;
    const [windKt, windFrom] = windLerp(level.ws[i0], level.wd[i0], level.ws[i1], level.wd[i1], f);
    out.push({
      hPa: level.hPa,
      zM: z,
      tC: lerp(level.t[i0], level.t[i1], f),
      rh: lerp(level.rh[i0], level.rh[i1], f),
      windKt,
      windFrom,
      cloudPct: lerp(level.cc[i0], level.cc[i1], f),
      wMs: lerp(level.w[i0], level.w[i1], f),
    });
  }
  return out.sort((a, b) => a.zM - b.zM);
}

/**
 * The profile at a time. Between two samples no more than 3 h apart it is
 * interpolated linearly (wind as vectors); otherwise the nearest sample within
 * 3 h is used; otherwise there is no profile.
 */
export function profileAt(series: ProfileSeries | null, timeMs: number): Profile | null {
  if (!series || !series.time.length || !Number.isFinite(timeMs)) return null;
  const times = series.time;
  let after = times.findIndex((t) => t >= timeMs);
  if (after === 0 || (after > 0 && times[after] === timeMs)) {
    if (times[after] - timeMs > MAX_GAP) return null;
    return { timeMs, samples: [times[after]], levels: levelsAt(series, after, after, 0) };
  }
  if (after < 0) {
    const last = times.length - 1;
    if (timeMs - times[last] > MAX_GAP) return null;
    return { timeMs, samples: [times[last]], levels: levelsAt(series, last, last, 0) };
  }
  const before = after - 1;
  const t0 = times[before];
  const t1 = times[after];
  if (t1 - t0 <= MAX_GAP) {
    const f = (timeMs - t0) / (t1 - t0);
    return { timeMs, samples: [t0, t1], levels: levelsAt(series, before, after, f) };
  }
  const nearest = timeMs - t0 <= t1 - timeMs ? before : after;
  if (Math.abs(times[nearest] - timeMs) > MAX_GAP) return null;
  return { timeMs, samples: [times[nearest]], levels: levelsAt(series, nearest, nearest, 0) };
}

/* ---------- thermodynamics ---------- */

/** Saturation vapour pressure over water, hPa (Bolton 1980). */
export function esWater(tC: number): number {
  return 6.112 * Math.exp((17.67 * tC) / (tC + 243.5));
}

/** Saturation vapour pressure over ice, hPa (Magnus, Alduchov & Eskridge). */
export function esIce(tC: number): number {
  return 6.1115 * Math.exp((22.452 * tC) / (tC + 272.55));
}

export function dewpoint(tC: number, rh: number): number {
  const e = esWater(tC) * Math.max(1, rh) / 100;
  const l = Math.log(e / 6.112);
  return (243.5 * l) / (17.67 - l);
}

/** Relative humidity with respect to ice, from RH with respect to water. */
export function rhIce(tC: number, rhWater: number): number {
  return tC >= 0 ? rhWater : rhWater * esWater(tC) / esIce(tC);
}

/** Wet-bulb temperature (Stull 2011), °C. Good to about 1 °C for ordinary surface air. */
export function wetBulb(tC: number, rh: number): number {
  return tC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(tC + rh) - Math.atan(rh - 1.676331)
    + 0.00391838 * rh ** 1.5 * Math.atan(0.023101 * rh) - 4.686035;
}

/** Saturated (pseudo-)adiabatic lapse rate, K per m. */
export function moistLapse(tC: number, pHa: number): number {
  const tK = tC + 273.15;
  const rs = (EPS * esWater(tC)) / Math.max(1, pHa - esWater(tC));
  return (G * (1 + (LV * rs) / (RD * tK))) / (CP + (LV * LV * rs * EPS) / (RD * tK * tK));
}

/** Linear interpolation of a level field by height, m. Null outside the levels or across a gap. */
export function atHeight(levels: ProfileLevel[], zM: number, field: 'tC' | 'rh' | 'cloudPct' | 'wMs'): number | null {
  for (let i = 0; i + 1 < levels.length; i++) {
    const a = levels[i];
    const b = levels[i + 1];
    if (zM < a.zM || zM > b.zM) continue;
    const va = a[field];
    const vb = b[field];
    if (va == null || vb == null) return null;
    return va + ((vb - va) * (zM - a.zM)) / Math.max(1e-6, b.zM - a.zM);
  }
  return null;
}

/** Pressure at a height, hPa, log-linear between levels. */
export function pressureAt(levels: ProfileLevel[], zM: number): number | null {
  if (levels.length < 2) return null;
  let i = 0;
  while (i + 2 < levels.length && zM > levels[i + 1].zM) i++;
  const a = levels[i];
  const b = levels[i + 1];
  const f = (zM - a.zM) / Math.max(1e-6, b.zM - a.zM);
  return Math.exp(Math.log(a.hPa) + (Math.log(b.hPa) - Math.log(a.hPa)) * f);
}

/** Every 0 °C crossing, m AMSL, bottom-up. If the surface is already freezing the first is the surface. */
export function isothermHeights(levels: ProfileLevel[], groundM: number, tC: number): number[] {
  const out: number[] = [];
  const usable = levels.filter((level) => level.tC != null && level.zM >= groundM - 1);
  if (!usable.length) return out;
  if ((usable[0].tC as number) <= tC) out.push(groundM);
  for (let i = 0; i + 1 < usable.length; i++) {
    const a = usable[i].tC as number;
    const b = usable[i + 1].tC as number;
    if ((a - tC) * (b - tC) < 0 || (b === tC && a !== tC)) {
      out.push(usable[i].zM + ((tC - a) / (b - a)) * (usable[i + 1].zM - usable[i].zM));
    }
  }
  return out;
}

export interface Parcel {
  /** Lifting condensation level, ft AMSL. */
  lclFt: number;
  /** Level of free convection, ft AMSL, or null if the parcel never becomes buoyant. */
  lfcFt: number | null;
  /** Equilibrium level, ft AMSL, or null when there is no buoyant layer. */
  elFt: number | null;
  /** Convective available potential energy, J/kg (LFC to EL). */
  capeJkg: number;
}

/**
 * Surface parcel: dry adiabat to the LCL (125 m per °C of dewpoint depression),
 * then the saturated adiabat in 50 m steps. CAPE integrates the virtual-
 * temperature-free buoyancy g·(Tp − Te)/Te from the LFC to the EL.
 */
export function surfaceParcel(levels: ProfileLevel[], groundM: number, tC: number, tdC: number): Parcel | null {
  const top = levels.length ? levels[levels.length - 1].zM : -Infinity;
  const lclM = groundM + 125 * Math.max(0, tC - tdC);
  if (!(lclM < top)) return null;
  let z = groundM;
  let tp = tC;
  let cape = 0;
  let lfc: number | null = null;
  let el: number | null = null;
  let positive = 0;
  const step = 50;
  while (z < Math.min(top, 20000)) {
    const te = atHeight(levels, z, 'tC');
    if (te != null && z > lclM) {
      const buoy = (G * (tp - te)) / (te + 273.15);
      if (buoy > 0) {
        if (lfc == null) lfc = z;
        positive += buoy * step;
        el = z;
      } else if (lfc != null) {
        // A shallow positive pocket followed by a deeper negative area still
        // counts; keep the CAPE and the last positive top.
        if (positive > 0) { cape += positive; positive = 0; }
      }
    }
    const p = pressureAt(levels, z);
    if (z < lclM) tp -= 0.0098 * step;
    else tp -= moistLapse(tp, p ?? 500) * step;
    z += step;
  }
  cape += positive;
  return {
    lclFt: lclM * FT_PER_M,
    lfcFt: lfc == null ? null : lfc * FT_PER_M,
    elFt: el == null ? null : el * FT_PER_M,
    capeJkg: Math.round(cape),
  };
}

/* ---------- reports ---------- */

export type Cover = 'FEW' | 'SCT' | 'BKN' | 'OVC' | 'VV';
export interface ReportLayer { cover: Cover; baseFtAgl: number; type: 'CB' | 'TCU' | null }

export interface ReportWeather {
  intensity: '-' | '' | '+';
  descriptor: string;
  phenomena: string[];
  vicinity: boolean;
  token: string;
}

export interface Report {
  layers: ReportLayer[];
  weather: ReportWeather[];
  visM: number | null;
  /** CAVOK, NSC, NCD, SKC or CLR: no significant cloud reported. */
  noCloud: 'CAVOK' | 'NSC' | 'NCD' | 'SKC' | 'CLR' | null;
  tC: number | null;
  tdC: number | null;
  auto: boolean;
}

const WX = /^(\+|-|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)+)?$/;

/** Parse the cloud, weather, visibility and temperature groups of a METAR or a TAF group body. */
export function parseReport(text: string): Report {
  const body = text.replace(/\s+(RMK|NOSIG)\b.*$/, '');
  const tokens = body.split(/\s+/).filter(Boolean);
  const layers: ReportLayer[] = [];
  const weather: ReportWeather[] = [];
  let visM: number | null = null;
  let tC: number | null = null;
  let tdC: number | null = null;
  let noCloud: Report['noCloud'] = null;
  for (const token of tokens) {
    const cloud = token.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
    if (cloud) {
      layers.push({ cover: cloud[1] as Cover, baseFtAgl: Number(cloud[2]) * 100, type: (cloud[3] as 'CB' | 'TCU' | undefined) ?? null });
      continue;
    }
    if (/^(CAVOK|NSC|NCD|SKC|CLR)$/.test(token)) { noCloud = token as Report['noCloud']; if (token === 'CAVOK') visM = 10000; continue; }
    if (visM == null && /^\d{4}$/.test(token) && !/^\d{4}\/\d{4}$/.test(token)) { visM = token === '9999' ? 10000 : Number(token); continue; }
    const td = token.match(/^(M?\d{2})\/(M?\d{2})$/);
    if (td) { tC = Number(td[1].replace('M', '-')); tdC = Number(td[2].replace('M', '-')); continue; }
    if (token.length >= 2 && token !== 'NSW') {
      const match = token.match(WX);
      if (match && (match[3] || match[2] === 'TS')) {
        const phenomena = (match[3] ?? '').match(/../g) ?? [];
        weather.push({
          intensity: match[1] === '+' ? '+' : match[1] === '-' ? '-' : '',
          descriptor: match[2] ?? '',
          phenomena,
          vicinity: match[1] === 'VC',
          token,
        });
      }
    }
  }
  return { layers, weather, visM, noCloud, tC, tdC, auto: tokens.includes('AUTO') };
}

/* ---------- the sky ---------- */

export type CloudType = 'cumulus' | 'towering' | 'cumulonimbus' | 'stratocumulus' | 'stratus'
  | 'altostratus' | 'altocumulus' | 'cirrus' | 'fog' | 'nimbostratus' | 'unknown';
export type Precip = 'rain' | 'showers' | 'drizzle' | 'snow' | 'virga' | 'none';

export interface SkyLayer {
  type: CloudType;
  reportedType?: 'CB' | 'TCU' | null;
  baseFtAmsl: number;
  /** Null when no profile can say where the cloud ends. */
  topFtAmsl: number | null;
  oktas: number;
  /** Cover word for the label: the report's, or the oktas' for model cloud. */
  cover: Cover;
  precip: Precip;
  /** Heavy (+, TS) precipitation: a darker, denser shaft. */
  heavy: boolean;
  /** Where the shaft ends, ft AMSL: the ground, or the bottom of the dry layer that evaporates virga. */
  precipBottomFtAmsl: number | null;
  /** Thunder from this cloud. */
  thunder: boolean;
  source: 'report' | 'model' | 'both';
  /** TAF TEMPO/INTER/BECMG/PROB state, drawn lighter. */
  secondary: boolean;
  /** Label prefix for a secondary state, e.g. "INTER". */
  change: string | null;
}

export interface Obscuration {
  kind: 'FG' | 'BR' | 'HZ' | 'FU' | 'DU' | 'SA' | 'VV';
  visM: number | null;
  topFtAmsl: number;
  secondary: boolean;
}

export interface WindLevel { ftAmsl: number; kt: number; fromDeg: number; hPa: number }

export interface SkyState {
  icao: string;
  timeMs: number;
  source: 'METAR' | 'TAF' | 'model' | 'none';
  elevationFt: number;
  layers: SkyLayer[];
  obscuration: Obscuration | null;
  /** Lowest 0 °C height, ft AMSL; null without a profile. */
  freezingFt: number | null;
  /** Every 0 °C crossing (inversions can give more than one). */
  freezingAllFt: number[];
  minus20Ft: number | null;
  /** Cloud between 0 and −20 °C, ft AMSL. */
  icing: { baseFt: number; topFt: number }[];
  winds: WindLevel[];
  surface: { tC: number; tdC: number; from: 'report' | 'model' } | null;
  parcel: Parcel | null;
  sun: { elevationDeg: number; azimuthDeg: number };
  hasProfile: boolean;
  /** Short state notes for the caption (missing profile, beyond TAF). */
  notes: string[];
}

export interface ReportGroup {
  body: string;
  /** null for the prevailing group; TEMPO/INTER/BECMG/PROB30… for the rest. */
  change: string | null;
}

export interface SkyInput {
  icao: string;
  elevationFt: number;
  lat: number;
  lon: number;
  timeMs: number;
  source: 'METAR' | 'TAF' | 'none';
  /** The report state(s) in force: the METAR, or the TAF groups at the time. */
  groups: ReportGroup[];
  profile: Profile | null;
}

const OKTAS: Record<Cover, number> = { FEW: 1.5, SCT: 3.5, BKN: 6, OVC: 8, VV: 8 };
const coverFor = (oktas: number): Cover => (oktas >= 8 ? 'OVC' : oktas >= 5 ? 'BKN' : oktas >= 3 ? 'SCT' : 'FEW');
/** What a ceilometer and an observer see: AUTO stations report to about 10,000 ft AGL. */
const REPORT_REACH_FT = 10000;

interface Column {
  groundM: number;
  levels: ProfileLevel[];
}

function tempAtFt(col: Column, ft: number): number | null {
  return atHeight(col.levels, ft / FT_PER_M, 'tC');
}

function saturated(col: Column, zM: number, threshold: number): boolean | null {
  const t = atHeight(col.levels, zM, 'tC');
  const rh = atHeight(col.levels, zM, 'rh');
  if (t == null || rh == null) return null;
  const value = t < 0 ? rhIce(t, rh) : rh;
  return value >= (t < 0 ? threshold - 10 : threshold);
}

/** Highest contiguous moist height above a base (RH ≥ 80 %, ≥ 70 % w.r.t. ice when freezing), ft AMSL. */
function moistTop(col: Column, baseFt: number): number | null {
  const step = 50;
  let z = baseFt / FT_PER_M;
  const top = col.levels[col.levels.length - 1]?.zM ?? -Infinity;
  if (!(z < top)) return null;
  let last = z;
  let seen = false;
  // Allow the base itself to sit just below the moist layer (the report sees the
  // condensed base; the model's 80 % may start a little higher).
  const searchTo = z + 600;
  while (z < top) {
    const wet = saturated(col, z, 80);
    if (wet == null) break;
    if (wet) { seen = true; last = z; } else if (seen || z > searchTo) break;
    z += step;
  }
  return seen ? last * FT_PER_M : null;
}

interface ModelLayer { baseFt: number; topFt: number; oktas: number; maxRh: number }

/** Contiguous levels at or above 25 % cloud cover (2 oktas). Edges sit halfway to the next level. */
function coverLayers(levels: ProfileLevel[], groundM: number): ModelLayer[] {
  const sorted = levels.filter((level) => level.zM >= groundM - 1).sort((a, b) => a.zM - b.zM);
  const out: ModelLayer[] = [];
  let i = 0;
  while (i < sorted.length) {
    const cover = sorted[i].cloudPct;
    if (cover == null || cover < 25) { i++; continue; }
    let j = i;
    let maxCc = cover;
    while (j + 1 < sorted.length && sorted[j + 1].cloudPct != null && (sorted[j + 1].cloudPct as number) >= 25) {
      j++;
      maxCc = Math.max(maxCc, sorted[j].cloudPct as number);
    }
    const below = sorted[i - 1];
    const above = sorted[j + 1];
    const baseM = Math.max(groundM, below ? (below.zM + sorted[i].zM) / 2 : sorted[i].zM);
    const topM = above ? (sorted[j].zM + above.zM) / 2 : sorted[j].zM;
    const oktas = Math.round((maxCc / 100) * 8);
    if (oktas >= 1 && topM > baseM + 30) out.push({ baseFt: baseM * FT_PER_M, topFt: topM * FT_PER_M, oktas, maxRh: 0 });
    i = j + 1;
  }
  return out;
}

/** Layer cloud the model holds: base where RH first reaches 90 % (ice-equivalent when freezing), up while ≥ 80 %. Cloud cover by level adds a layer the humidity does not. */
export function modelLayers(levels: ProfileLevel[], groundM: number): ModelLayer[] {
  const col: Column = { groundM, levels };
  const out: ModelLayer[] = [];
  if (levels.length < 2) return out;
  const top = levels[levels.length - 1].zM;
  const step = 50;
  let z = Math.max(groundM + 30, levels[0].zM);
  while (z < top) {
    if (saturated(col, z, 90)) {
      let lo = z;
      // Walk down to where the layer reaches 80 %, so the base is the cloud edge.
      while (lo - step > groundM && saturated(col, lo - step, 80)) lo -= step;
      let hi = z;
      let cc = 0;
      let maxRh = 0;
      while (hi + step < top && saturated(col, hi + step, 80)) {
        hi += step;
        cc = Math.max(cc, atHeight(levels, hi, 'cloudPct') ?? 0);
        maxRh = Math.max(maxRh, atHeight(levels, hi, 'rh') ?? 0);
      }
      cc = Math.max(cc, atHeight(levels, z, 'cloudPct') ?? 0);
      maxRh = Math.max(maxRh, atHeight(levels, z, 'rh') ?? 0);
      // Model cloud cover where it exists; otherwise the RH excess over 80 %.
      const anyCc = levels.some((level) => level.cloudPct != null);
      const oktas = anyCc ? Math.round((cc / 100) * 8) : Math.round(Math.min(8, Math.max(1, ((maxRh - 80) / 20) * 8)));
      if (oktas >= 1) out.push({ baseFt: lo * FT_PER_M, topFt: Math.max(hi, lo + 100) * FT_PER_M, oktas, maxRh });
      z = hi + step * 2;
      continue;
    }
    z += step;
  }
  const extra = coverLayers(levels, groundM).filter((layer) => !out.some((existing) => existing.baseFt <= layer.topFt && layer.baseFt <= existing.topFt));
  return [...out, ...extra].sort((a, b) => a.baseFt - b.baseFt);
}

function precipFor(weather: ReportWeather[]): { kind: Precip; heavy: boolean; thunder: boolean; convective: boolean } {
  const at = weather.filter((item) => !item.vicinity);
  const thunder = at.some((item) => item.descriptor === 'TS');
  const has = (code: string) => at.some((item) => item.phenomena.includes(code));
  const heavy = at.some((item) => item.intensity === '+' && item.phenomena.some((p) => ['RA', 'SN', 'DZ', 'GR', 'GS'].includes(p))) || thunder;
  const shower = at.some((item) => (item.descriptor === 'SH' || item.descriptor === 'TS') && item.phenomena.length);
  if (has('SN') || has('SG')) return { kind: 'snow', heavy, thunder, convective: shower || thunder };
  if (shower || (thunder && has('RA'))) return { kind: 'showers', heavy, thunder, convective: true };
  if (has('RA')) return { kind: 'rain', heavy, thunder, convective: thunder };
  if (has('DZ')) return { kind: 'drizzle', heavy, thunder, convective: false };
  return { kind: 'none', heavy: false, thunder, convective: thunder };
}

/** Stable lapse below the base? °C per 1000 ft from the surface to the base; null without data. */
function lapseBelow(col: Column, surfaceT: number | null, baseFt: number): number | null {
  const tb = tempAtFt(col, baseFt);
  if (tb == null || surfaceT == null) return null;
  const depth = baseFt - col.groundM * FT_PER_M;
  if (depth < 300) return null;
  return ((surfaceT - tb) / depth) * 1000;
}

/** Bottom of the evaporation: falling from a base, precipitation that meets RH < 60 % below becomes virga. */
function virgaBottom(col: Column, baseFt: number): number | null {
  let z = baseFt / FT_PER_M - 50;
  let dryFrom: number | null = null;
  let dryDepth = 0;
  while (z > col.groundM) {
    const rh = atHeight(col.levels, z, 'rh');
    if (rh != null && rh < 60) { if (dryFrom == null) dryFrom = z; dryDepth += 50; } else if (dryFrom != null && dryDepth < 300) { dryFrom = null; dryDepth = 0; }
    // A dry layer at least 1,000 ft deep evaporates light precipitation inside it.
    if (dryDepth >= 300) return Math.max(col.groundM, z - 300) * FT_PER_M;
    z -= 50;
  }
  return null;
}

function stratiformType(baseFtAmsl: number, depthFt: number | null, oktas: number, tBase: number | null, elevationFt: number): CloudType {
  const agl = baseFtAmsl - elevationFt;
  if (baseFtAmsl >= 20000 || (tBase != null && tBase <= -30 && baseFtAmsl >= 16000)) return 'cirrus';
  if (agl >= 6500) return depthFt != null && depthFt >= 3000 && oktas >= 6 ? 'altostratus' : 'altocumulus';
  return agl < 1500 ? 'stratus' : 'stratocumulus';
}

/** Build the sky from the report and the profile. */
export function skyState(input: SkyInput): SkyState {
  const { profile, elevationFt } = input;
  const groundM = elevationFt / FT_PER_M;
  const col: Column = { groundM, levels: profile?.levels ?? [] };
  const hasProfile = !!profile && profile.levels.filter((level) => level.tC != null).length >= 3;
  const notes: string[] = [];
  if (!hasProfile) notes.push('No model profile at this time');

  const prevailing = input.groups.find((group) => group.change == null) ?? null;
  const reports = input.groups.map((group) => ({ group, report: parseReport(group.body) }));
  const main = prevailing ? parseReport(prevailing.body) : null;

  // Surface temperature and dewpoint: the METAR's, else the model's lowest level above ground.
  let surface: SkyState['surface'] = null;
  if (main && main.tC != null && main.tdC != null) surface = { tC: main.tC, tdC: main.tdC, from: 'report' };
  else if (hasProfile) {
    const low = col.levels.find((level) => level.zM >= groundM - 50 && level.tC != null && level.rh != null);
    if (low) {
      // Bring the lowest level down to the ground on a dry adiabat; keep its dewpoint.
      const tSurf = (low.tC as number) + 0.0098 * Math.max(0, low.zM - groundM);
      surface = { tC: tSurf, tdC: Math.min(tSurf, dewpoint(low.tC as number, low.rh as number)), from: 'model' };
    }
  }

  const freezingAll = hasProfile ? isothermHeights(col.levels, groundM, 0).map((m) => m * FT_PER_M) : [];
  const freezingFt = freezingAll.length ? freezingAll[0] : null;
  const minus20 = hasProfile ? isothermHeights(col.levels, groundM, -20) : [];
  const minus20Ft = minus20.length ? minus20[0] * FT_PER_M : null;
  const parcel = hasProfile && surface ? surfaceParcel(col.levels, groundM, surface.tC, surface.tdC) : null;

  const layers: SkyLayer[] = [];
  let obscuration: Obscuration | null = null;
  const reported = reports.length > 0;

  for (const { group, report } of reports) {
    const secondary = group.change != null;
    const precip = precipFor(report.weather);
    const groupLayers: SkyLayer[] = [];
    for (const layer of report.layers) {
      const baseFt = elevationFt + layer.baseFtAgl;
      if (layer.cover === 'VV') {
        obscuration = { kind: 'VV', visM: report.visM, topFtAmsl: baseFt, secondary };
        continue;
      }
      const oktas = OKTAS[layer.cover];
      let type: CloudType;
      let top = hasProfile ? moistTop(col, baseFt) : null;
      if (layer.type === 'CB') {
        type = 'cumulonimbus';
        top = parcel?.elFt != null && parcel.elFt > baseFt + 10000 ? parcel.elFt : top != null && top > baseFt + 10000 ? top : null;
      } else if (layer.type === 'TCU') {
        type = 'towering';
        const el = parcel?.elFt ?? null;
        top = el != null && el > baseFt + 5000 ? Math.min(el, Math.max(top ?? 0, baseFt + 8000)) : top;
      } else {
        type = 'unknown';
      }
      if (top != null && top < baseFt + 200) top = baseFt + 200;
      groupLayers.push({
        type,
        reportedType: layer.type,
        baseFtAmsl: baseFt,
        topFtAmsl: top,
        oktas,
        cover: layer.cover,
        precip: 'none',
        heavy: false,
        precipBottomFtAmsl: null,
        thunder: false,
        source: top != null ? 'both' : 'report',
        secondary,
        change: group.change,
      });
    }
    // The precipitation falls from the cloud that makes it: CB/TCU first for
    // showers and thunder, else the lowest layer with cover ≥ SCT.
    if (precip.kind !== 'none' || precip.thunder) {
      const order = [...groupLayers].sort((a, b) => a.baseFtAmsl - b.baseFtAmsl);
      const pick = (precip.convective ? order.find((l) => l.type === 'cumulonimbus' || l.type === 'towering') : undefined)
        ?? order.find((l) => l.oktas >= 3)
        ?? order[0];
      if (pick) {
        const kind = precip.kind === 'none' ? 'showers' : precip.kind;
        pick.precip = kind;
        pick.heavy = precip.heavy;
        pick.thunder = precip.thunder;
        pick.precipBottomFtAmsl = elevationFt;
        if (precip.thunder && pick.type !== 'cumulonimbus') {
          pick.type = 'cumulonimbus';
          pick.topFtAmsl = parcel?.elFt != null && parcel.elFt > pick.baseFtAmsl + 10000 ? parcel.elFt : pick.topFtAmsl;
        }
      }
    }
    for (const item of report.weather) {
      const code = item.phenomena.find((p) => ['FG', 'BR', 'HZ', 'FU', 'DU', 'SA'].includes(p));
      if (!code || item.vicinity || item.descriptor === 'MI' || item.descriptor === 'BC' || item.descriptor === 'PR') continue;
      if (obscuration?.kind === 'VV' && code === 'FG') { obscuration.kind = 'FG'; continue; }
      if (obscuration && (!obscuration.secondary || secondary)) continue;
      // Fog top: the surface-based saturated layer in the profile, else a shallow 300 ft (FG) / 1,000 ft (BR, HZ) band.
      let topFt = elevationFt + (code === 'FG' ? 300 : 1000);
      if (hasProfile && code === 'FG') {
        const t = moistTop(col, elevationFt + 30);
        if (t != null && t < elevationFt + 2000) topFt = Math.max(elevationFt + 100, t);
      }
      obscuration = { kind: code as Obscuration['kind'], visM: report.visM, topFtAmsl: topFt, secondary };
    }
    layers.push(...groupLayers);
  }

  // Model cloud the reports cannot see: above the ceilometer's reach, or
  // everything when there is no report at all. Under CAVOK/NSC the report
  // rules out cloud below 5,000 ft AGL.
  if (hasProfile) {
    const reach = reported ? elevationFt + REPORT_REACH_FT : -Infinity;
    for (const model of modelLayers(col.levels, groundM)) {
      // Fill unknown tops of reported layers from the model layer they sit in.
      const host = layers.find((layer) => layer.topFtAmsl == null && layer.baseFtAmsl >= model.baseFt - 1500 && layer.baseFtAmsl <= model.topFt);
      if (host) { host.topFtAmsl = Math.max(host.baseFtAmsl + 200, model.topFt); host.source = 'both'; continue; }
      const overlaps = layers.some((layer) => !layer.secondary && layer.baseFtAmsl <= model.topFt && (layer.topFtAmsl ?? layer.baseFtAmsl + 1000) >= model.baseFt);
      if (overlaps || model.baseFt < reach) continue;
      const tBase = tempAtFt(col, model.baseFt);
      const depth = model.topFt - model.baseFt;
      const type = stratiformType(model.baseFt, depth, model.oktas, tBase, elevationFt);
      let precip: Precip = 'none';
      let bottom: number | null = null;
      // Deep mid-level cloud over a dry layer: trailing virga.
      if ((type === 'altostratus' || (type === 'altocumulus' && depth >= 5000)) && depth >= 6000) {
        const v = virgaBottom(col, model.baseFt);
        if (v != null) { precip = 'virga'; bottom = v; }
      }
      layers.push({
        type,
        baseFtAmsl: model.baseFt,
        topFtAmsl: model.topFt,
        oktas: model.oktas,
        cover: coverFor(model.oktas),
        precip,
        heavy: false,
        precipBottomFtAmsl: bottom,
        thunder: false,
        source: 'model',
        secondary: false,
        change: null,
      });
    }
  }

  // Reported light precipitation through a dry layer from a mid-level cloud is
  // still reported at the ground; only model-inferred precipitation becomes virga.
  for (const layer of layers) {
    if (layer.precip === 'none' || layer.precip === 'virga') continue;
    // Snow above a freezing level that melts on the way down: rain below.
    if (layer.precip !== 'snow' && freezingFt != null && layer.baseFtAmsl > freezingFt && surface) {
      const wb = wetBulb(surface.tC, Math.min(100, 100 * esWater(surface.tdC) / esWater(surface.tC)));
      if (wb <= 1) layer.precip = 'snow';
    }
  }

  // Classify after report precipitation and profile tops have been assigned.
  // Local layer lapse outranks parcel CAPE; depth alone never creates an anvil.
  const ruleProfile = hasProfile ? { levels: col.levels.map(l => ({ heightFt: l.zM * FT_PER_M, tempC: l.tC })), capeJkg: parcel?.capeJkg ?? null } : null;
  for (const layer of layers) {
    const levels = ruleProfile ? [...ruleProfile.levels] : [];
    for (const ft of [layer.baseFtAmsl, layer.topFtAmsl]) {
      if (ft == null || levels.some(l => l.heightFt === ft)) continue;
      const tempC = tempAtFt(col, ft);
      if (tempC != null) levels.push({ heightFt: ft, tempC });
    }
    const genus = classifyLayer({ baseFt: layer.baseFtAmsl, topFt: layer.topFtAmsl,
      cover: layer.cover, reportedType: layer.reportedType ?? (layer.thunder ? 'TS' : null),
      precipitating: layer.precip !== 'none' }, ruleProfile ? { ...ruleProfile, levels } : null).genus;
    // Retain the production model's cold high ice veil (including thick cirrostratus),
    // beyond the phase-1 study's high/thin FEW-SCT cases. No report is invented.
    if (layer.source === 'model' && layer.type === 'cirrus') continue;
    layer.type = genus === 'towering-cumulus' ? 'towering' : genus;
  }

  const winds: WindLevel[] = hasProfile
    ? col.levels.filter((level) => level.zM >= groundM - 10 && level.windKt != null && level.windFrom != null)
      .map((level) => ({ ftAmsl: level.zM * FT_PER_M, kt: level.windKt as number, fromDeg: level.windFrom as number, hPa: level.hPa }))
    : [];

  const icing: SkyState['icing'] = [];
  if (freezingFt != null) {
    const top20 = minus20Ft ?? Infinity;
    for (const layer of layers) {
      if (layer.type === 'fog' || layer.type === 'cirrus' || layer.type === 'unknown' || layer.topFtAmsl == null) continue;
      const lo = Math.max(layer.baseFtAmsl, freezingFt);
      const hi = Math.min(layer.topFtAmsl, top20);
      if (hi > lo) icing.push({ baseFt: lo, topFt: hi });
    }
  }

  if (obscuration) {
    layers.push({
      type: 'fog',
      baseFtAmsl: elevationFt,
      topFtAmsl: obscuration.topFtAmsl,
      oktas: obscuration.kind === 'FG' || obscuration.kind === 'VV' ? 8 : 4,
      cover: 'OVC',
      precip: 'none',
      heavy: false,
      precipBottomFtAmsl: null,
      thunder: false,
      source: 'report',
      secondary: obscuration.secondary,
      change: null,
    });
  }

  layers.sort((a, b) => Number(a.secondary) - Number(b.secondary) || a.baseFtAmsl - b.baseFtAmsl);
  return {
    icao: input.icao,
    timeMs: input.timeMs,
    source: input.source === 'none' ? (hasProfile ? 'model' : 'none') : input.source,
    elevationFt,
    layers,
    obscuration,
    freezingFt,
    freezingAllFt: freezingAll,
    minus20Ft,
    icing: mergeBands(icing),
    winds,
    surface,
    parcel,
    sun: solarPosition(input.lat, input.lon, input.timeMs),
    hasProfile,
    notes,
  };
}

function mergeBands(bands: { baseFt: number; topFt: number }[]) {
  const sorted = [...bands].sort((a, b) => a.baseFt - b.baseFt);
  const out: { baseFt: number; topFt: number }[] = [];
  for (const band of sorted) {
    const last = out[out.length - 1];
    if (last && band.baseFt <= last.topFt) last.topFt = Math.max(last.topFt, band.topFt);
    else out.push({ ...band });
  }
  return out;
}

/* ---------- which report, when ---------- */

export interface TafGroupLike { role: 'prevailing' | 'transition' | 'additional'; kind: string; body: string }

/**
 * The METAR is the sky within 90 min of its time and no later than an hour
 * past now; after that the TAF groups in force; beyond the TAF only the model.
 */
export function reportGroups(metar: { raw: string; timeMs: number } | null, taf: TafGroupLike[] | null, timeMs: number, nowMs: number): { source: SkyInput['source']; groups: ReportGroup[] } {
  if (metar && Math.abs(timeMs - metar.timeMs) <= 90 * 60_000 && timeMs <= nowMs + HOUR) {
    const body = metar.raw.replace(/\s+(RMK|TEMPO|BECMG|NOSIG)\b.*$/, '');
    return { source: 'METAR', groups: [{ body, change: null }] };
  }
  if (taf && taf.length) {
    return {
      source: 'TAF',
      groups: taf.map((group) => ({ body: group.body, change: group.role === 'prevailing' ? null : group.kind })),
    };
  }
  return { source: 'none', groups: [] };
}

/* ---------- sun ---------- */

/** Solar elevation and azimuth (° true, clockwise from north), NOAA low-precision algorithm. */
export function solarPosition(lat: number, lon: number, ms: number): { elevationDeg: number; azimuthDeg: number } {
  const r = Math.PI / 180;
  const jd = ms / 86_400_000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = Math.sin(m * r) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * m * r) * (0.019993 - 0.000101 * t) + Math.sin(3 * m * r) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * r);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * r);
  const decl = Math.asin(Math.sin(eps * r) * Math.sin(lambda * r));
  const y = Math.tan((eps / 2) * r) ** 2;
  const eqTime = 4 / r * (y * Math.sin(2 * l0 * r) - 2 * e * Math.sin(m * r) + 4 * e * y * Math.sin(m * r) * Math.cos(2 * l0 * r)
    - 0.5 * y * y * Math.sin(4 * l0 * r) - 1.25 * e * e * Math.sin(2 * m * r));
  const date = new Date(ms);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolar = (((minutes + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const hourAngle = trueSolar / 4 < 0 ? trueSolar / 4 + 180 : trueSolar / 4 - 180;
  const cosZen = Math.sin(lat * r) * Math.sin(decl) + Math.cos(lat * r) * Math.cos(decl) * Math.cos(hourAngle * r);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  const elevation = 90 - zenith / r;
  const azDen = Math.cos(lat * r) * Math.sin(zenith);
  let azimuth: number;
  if (Math.abs(azDen) < 1e-9) azimuth = lat > 0 ? 180 : 0;
  else {
    const cosAz = (Math.sin(lat * r) * Math.cos(zenith) - Math.sin(decl)) / azDen;
    const a = Math.acos(Math.max(-1, Math.min(1, cosAz))) / r;
    azimuth = hourAngle > 0 ? (a + 180) % 360 : (540 - a) % 360;
  }
  return { elevationDeg: elevation, azimuthDeg: azimuth };
}

/* ---------- determinism ---------- */

/** FNV-1a 32-bit. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Mulberry32: a small seeded generator; the same seed always gives the same cloud. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where a layer's cloud sits across the section: segments [x0, x1] in 0..1
 * whose total length is the cover fraction (oktas/8). Gaps fall
 * deterministically for the seed so playback does not reshuffle the sky.
 */
export function coverSegments(oktas: number, seed: number, pieces: number): [number, number][] {
  const fraction = Math.max(0, Math.min(1, oktas / 8));
  if (fraction <= 0) return [];
  if (fraction >= 0.999) return [[0, 1]];
  const random = rng(seed);
  const n = Math.max(1, pieces);
  const clouds = Array.from({ length: n }, () => 0.6 + random());
  const gaps = Array.from({ length: n + 1 }, (_, i) => (i === 0 || i === n ? 0.3 : 0.6) + random());
  const cloudSum = clouds.reduce((a, b) => a + b, 0);
  const gapSum = gaps.reduce((a, b) => a + b, 0);
  const out: [number, number][] = [];
  let x = (gaps[0] / gapSum) * (1 - fraction);
  for (let i = 0; i < n; i++) {
    const w = (clouds[i] / cloudSum) * fraction;
    out.push([x, x + w]);
    x += w + (gaps[i + 1] / gapSum) * (1 - fraction);
  }
  return out;
}
