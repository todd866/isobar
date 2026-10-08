/** Live snapshot. Missing fields are null. Cards that need them are not invented. */

export interface MetarInstrument {
  raw: string;
  time: string | null;
  cloud: string;
  vis: string;
  wind: string;
  clock: string;
  age: string;
  aged: boolean;
  tip: string;
  /** "", "TS", "VCTS", "CB" or "TCU". Absent on a snapshot from before convective marks. */
  hazard?: string;
  hazardTip?: string;
}

export interface TafView {
  raw: string;
  issue: string | null;
  from: string | null;
  to: string | null;
  header: string;
  headerUtc: string;
  lines: { text: string; active: boolean }[];
}

export interface GridSample {
  mslpHpa: number | null;
  windFromDeg: number | null;
  windKt: number | null;
  t2mC: number | null;
  cloudCoverPct: number | null;
  mucapeJkg: number | null;
}

export interface AirportSnapshot {
  icao: string;
  name: string;
  zone: string;
  lat: number;
  lon: number;
  metar: MetarInstrument | null;
  taf: TafView | null;
  sample: GridSample | null;
}

export interface PointSample extends GridSample {
  id: string;
  lat: number;
  lon: number;
}

export interface SigmetSnapshot {
  fir: string;
  hazard: string;
  qualifier: string;
  base: number | null;
  top: number | null;
  raw: string;
  from: string | null;
  to: string | null;
}

export interface Snapshot {
  now: string;
  runTime: string | null;
  runError: string | null;
  gridSource: 'published' | 'legacy' | null;
  sampleTime: string | null;
  chartPng: string | null;
  gradient: {
    lat: number;
    lon: number;
    hpaPer100km: number;
    geostrophicKt?: number;
    fromDeg?: number;
    windKt?: number | null;
    mapX?: number;
    mapY?: number;
  } | null;
  /** Raw-grid maximum rejected as an MSLP-reduction spike. Null when the screened maximum is the raw one. */
  artefact?: {
    lat: number;
    lon: number;
    hpaPer100km: number;
    geostrophicKt?: number;
    fromDeg?: number;
    windKt?: number | null;
    mapX?: number;
    mapY?: number;
  } | null;
  sigmets: SigmetSnapshot[] | null;
  notamCount: number | null;
  airports: AirportSnapshot[];
  points: PointSample[];
}

export const PLAN_MINIMA = { ceilingFt: 1000, visM: 5000 };
export const SCENARIO = ['YPPH', 'YSSY'] as const;
