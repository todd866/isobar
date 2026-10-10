import type { AirportSnapshot, MetarInstrument, Snapshot, TafView } from '../../../training/src/snapshot.ts';
import { decodeFrameBytes } from './frame-codec';
import { convectiveCloud } from '../../../training/src/metar.ts';
import { readPoints, readingAt, type PointsFile } from './points';
import { readManifest, type ChartManifest } from './manifest';
import { AUS_UNITS, formatVisibilityMetres, type DisplayUnits } from './units';

export interface TrainingSnapshotFetchOptions {
  /** Wall clock used for the snapshot and point interpolation. */
  nowMs?: number;
  /** Injectable fetcher for tests and embedded callers. */
  fetchBytes?: (url: string, signal?: AbortSignal) => Promise<Uint8Array | null>;
  signal?: AbortSignal;
  /** Display units for decoded METAR visibility. Stored reports stay as written. */
  units?: DisplayUnits;
}

export interface TrainingSnapshotInputs {
  manifest: ChartManifest;
  points: PointsFile | null;
  aviation: AviationInput | null;
  /** Packed uint16 values for the first MSLP frame, in grid order. */
  mslp: Uint16Array | null;
}

export interface AviationInput {
  airports?: AviationAirportInput[];
  sigmets?: Snapshot['sigmets'];
}

interface AviationAirportInput {
  icao: string;
  name: string;
  zone: string;
  lat: number;
  lon: number;
  metar?: { raw: string; time?: string | null } | null;
  taf?: { raw: string; issue?: string | null; from?: string | null; to?: string | null } | null;
}

const decoder = new TextDecoder();
const FETCH_TIMEOUT_MS = 5000;

const defaultFetchBytes = async (url: string, signal?: AbortSignal): Promise<Uint8Array | null> => {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, { signal: combined });
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
};

function json(bytes: Uint8Array | null): unknown {
  if (!bytes) return null;
  try { return JSON.parse(decoder.decode(bytes)); } catch { return null; }
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function aviationInput(value: unknown): AviationInput | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const airports = Array.isArray(record.airports) ? record.airports.filter((item): item is AviationAirportInput => {
    if (!item || typeof item !== 'object') return false;
    const airport = item as Record<string, unknown>;
    return typeof airport.icao === 'string' && typeof airport.name === 'string'
      && typeof airport.zone === 'string' && typeof airport.lat === 'number' && Number.isFinite(airport.lat)
      && typeof airport.lon === 'number' && Number.isFinite(airport.lon);
  }).map((item) => ({
    ...item,
    metar: item.metar && typeof item.metar === 'object' && typeof item.metar.raw === 'string' ? item.metar : null,
    taf: item.taf && typeof item.taf === 'object' && typeof item.taf.raw === 'string' ? item.taf : null,
  })) : [];
  const sigmets = Array.isArray(record.sigmets) ? record.sigmets.filter((item): item is NonNullable<Snapshot['sigmets']>[number] => {
    if (!item || typeof item !== 'object') return false;
    const sigmet = item as Record<string, unknown>;
    return typeof sigmet.fir === 'string' && typeof sigmet.hazard === 'string'
      && typeof sigmet.qualifier === 'string' && typeof sigmet.raw === 'string'
      && (sigmet.base === null || typeof sigmet.base === 'number')
      && (sigmet.top === null || typeof sigmet.top === 'number')
      && (sigmet.from === null || typeof sigmet.from === 'string')
      && (sigmet.to === null || typeof sigmet.to === 'string');
  }) : null;
  return { airports, sigmets: sigmets && sigmets.length === (record.sigmets as unknown[]).length ? sigmets : null };
}

function tafRows(raw: string): { text: string; active: boolean }[] {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  return text.split(/\s+(?=(?:FM\d|TEMPO|INTER|BECMG|PROB\d{2}))/).filter(Boolean)
    .map((line) => ({ text: line, active: false }));
}

function utcStamp(iso: string | null): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '—';
  const date = new Date(iso);
  return `${String(date.getUTCDate()).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}Z`;
}

function ageLabel(nowMs: number, time: string | null): { age: string; aged: boolean } {
  const then = time ? Date.parse(time) : NaN;
  if (!Number.isFinite(then)) return { age: '—', aged: false };
  const minutes = Math.max(0, Math.round((nowMs - then) / 60000));
  const age = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return { age, aged: minutes > 90 };
}

function stationMatches(raw: string, icao: string): boolean {
  return raw.trim().match(/^(?:(?:METAR|SPECI|TAF|AMD|COR)\s+)*([A-Z][A-Z0-9]{3})\b/)?.[1] === icao;
}

function metarView(input: AviationAirportInput['metar'], nowMs: number, icao: string, units: DisplayUnits = AUS_UNITS): MetarInstrument | null {
  if (!input?.raw?.trim() || !stationMatches(input.raw, icao)) return null;
  const raw = input.raw.trim();
  const time = input.time ?? null;
  const windToken = raw.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  const wind = windToken ? `${windToken[1]}/${windToken[2]}${windToken[3] ? `G${windToken[3]}` : ''}` : '—';
  const visibility = raw.includes('CAVOK')
    ? 'CAVOK'
    : (() => {
      const token = raw.match(/\b\d{4}\b/)?.[0];
      if (!token) return '—';
      return formatVisibilityMetres(Number(token), units) ?? '—';
    })();
  const layers = [...raw.matchAll(/\b(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU)?\b/g)];
  const cloud = raw.match(/\b(CAVOK|NCD|NSC|SKC|CLR)\b/)?.[1]
    ?? (layers.map((match) => `${match[1]}${match[2]}`).join(' · ') || '—');
  const hazard = convectiveCloud(raw, cloud).hazard;
  const age = ageLabel(nowMs, input.time ?? null);
  return {
    raw,
    time: input.time ?? null,
    cloud,
    vis: visibility,
    wind,
    clock: utcStamp(input.time ?? null),
    age: age.age,
    aged: age.aged,
    tip: raw,
    hazard,
    hazardTip: hazard ? `Reported ${hazard}` : undefined,
  };
}

function tafView(input: AviationAirportInput['taf'], icao: string): TafView | null {
  if (!input?.raw?.trim() || !stationMatches(input.raw, icao)) return null;
  const raw = input.raw.trim();
  const parts = raw.split(/\s+/);
  const header = parts.slice(0, 3).join(' ');
  return {
    raw,
    issue: input.issue ?? null,
    from: input.from ?? null,
    to: input.to ?? null,
    header,
    headerUtc: parts[2] ?? '',
    lines: tafRows(raw),
  };
}

function sampleMslp(manifest: ChartManifest, frame: Uint16Array | null, lat: number, lon: number): number | null {
  if (!frame || lon < manifest.west || lon > manifest.east || lat < manifest.south || lat > manifest.north) return null;
  const spec = manifest.variables.mslp;
  const x = Math.max(0, Math.min(manifest.nx - 1, Math.round((lon - manifest.west) / manifest.step)));
  const y = Math.max(0, Math.min(manifest.ny - 1, Math.round((manifest.north - lat) / manifest.step)));
  const value = frame[y * manifest.nx + x];
  if (value == null || value === spec.fill) return null;
  return value * spec.scale + spec.offset;
}

/** An incomplete point product must not discard otherwise valid aviation. */
function pointReading(points: PointsFile | null, id: string, sampleMs: number) {
  const missing = { tempC: null, windKt: null, windFrom: null };
  const series = points?.places[id];
  if (!points || !series || !points.hours.length || !Number.isFinite(Date.parse(points.run))) return missing;
  if (!points.hours.every((hour, i) => Number.isFinite(hour) && (i === 0 || hour > points.hours[i - 1]))) return missing;
  for (const values of [series.t, series.wspd, series.wdir]) {
    if (!Array.isArray(values) || values.length !== points.hours.length || !values.every((value) => value === null || typeof value === 'number' && Number.isFinite(value))) return missing;
  }
  return readingAt(points, id, sampleMs);
}

function airportSnapshot(input: AviationAirportInput, sampleMs: number, nowMs: number, data: TrainingSnapshotInputs, units: DisplayUnits): AirportSnapshot {
  // A city's surface point is not its aerodrome's model sounding.
  const place = data.manifest.places.find((place) => place.lat === input.lat && place.lon === input.lon);
  const point = place ? pointReading(data.points, place.id, sampleMs) : null;
  return {
    icao: input.icao,
    name: input.name,
    zone: input.zone,
    lat: input.lat,
    lon: input.lon,
    metar: metarView(input.metar, nowMs, input.icao, units),
    taf: tafView(input.taf, input.icao),
    sample: {
      mslpHpa: sampleMslp(data.manifest, data.mslp, input.lat, input.lon),
      windFromDeg: point?.windFrom ?? null,
      windKt: point?.windKt ?? null,
      t2mC: point?.tempC ?? null,
      cloudCoverPct: null,
      mucapeJkg: null,
    },
  };
}

export function trainingSnapshotFromInputs(data: TrainingSnapshotInputs, nowMs = Date.now(), units: DisplayUnits = AUS_UNITS): Snapshot {
  const now = new Date(nowMs).toISOString();
  const runMs = Date.parse(data.manifest.run);
  const sampleMs = data.mslp && Number.isFinite(runMs)
    ? runMs + (data.manifest.forecastHours[0] ?? 0) * 3600000 : nowMs;
  const airports = (data.aviation?.airports ?? []).map((airport) => airportSnapshot(airport, sampleMs, nowMs, data, units));
  const points = data.manifest.places.map((place) => {
    const reading = pointReading(data.points, place.id, sampleMs);
    return {
      id: place.id, lat: place.lat, lon: place.lon,
      mslpHpa: sampleMslp(data.manifest, data.mslp, place.lat, place.lon),
      windFromDeg: reading.windFrom, windKt: reading.windKt, t2mC: reading.tempC,
      cloudCoverPct: null, mucapeJkg: null,
    };
  });
  return {
    now,
    runTime: data.manifest.run || null,
    runError: null,
    gridSource: data.mslp ? 'published' : null,
    sampleTime: data.mslp && Number.isFinite(Date.parse(data.manifest.run))
      ? new Date(Date.parse(data.manifest.run) + (data.manifest.forecastHours[0] ?? 0) * 3600000).toISOString() : null,
    chartPng: null,
    gradient: null,
    artefact: null,
    sigmets: data.aviation?.sigmets ?? null,
    notamCount: null,
    airports,
    points,
  };
}

function emptySnapshot(nowMs: number): Snapshot {
  return {
    now: new Date(nowMs).toISOString(), runTime: null, runError: null,
    gridSource: null, sampleTime: null, chartPng: null, gradient: null, artefact: null,
    sigmets: null, notamCount: null, airports: [], points: [],
  };
}

function aviationOnlySnapshot(value: AviationInput | null, nowMs: number, units: DisplayUnits = AUS_UNITS): Snapshot {
  const now = new Date(nowMs).toISOString();
  return {
    now, runTime: null, runError: null, gridSource: null, sampleTime: null,
    chartPng: null, gradient: null, artefact: null, sigmets: value?.sigmets ?? null,
    notamCount: null,
    airports: (value?.airports ?? []).map((item) => ({
      icao: item.icao, name: item.name, zone: item.zone, lat: item.lat, lon: item.lon,
      metar: metarView(item.metar, nowMs, item.icao, units), taf: tafView(item.taf, item.icao), sample: null,
    })),
    points: [],
  };
}

/** Load the trainer's small live snapshot. This never waits for the chart run. */
export async function loadTrainingSnapshot(options: TrainingSnapshotFetchOptions = {}): Promise<Snapshot> {
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const signal = options.signal;
  const nowMs = options.nowMs ?? Date.now();
  const units = options.units ?? AUS_UNITS;
  if (aborted(signal)) return emptySnapshot(nowMs);
  let manifest: ChartManifest;
  try {
    const bytes = await fetchBytes('/data/manifest.json', signal);
    if (aborted(signal)) return emptySnapshot(nowMs);
    if (!bytes) throw new Error('manifest unavailable');
    manifest = readManifest(json(bytes));
  } catch {
    // Aviation is a useful live deck even when the chart export is unavailable.
    if (aborted(signal)) return emptySnapshot(nowMs);
    const aviationBytes = await fetchBytes('/data/aviation.json', signal).catch(() => null);
    return aborted(signal) ? emptySnapshot(nowMs) : aviationOnlySnapshot(aviationInput(json(aviationBytes)), nowMs, units);
  }
  const pointsPath = manifest.points ?? 'points.json';
  const frameFile = manifest.variables.mslp.frames?.[0] ?? null;
  const mslpTask = frameFile ? fetchBytes(`/data/${frameFile}?run=${encodeURIComponent(manifest.run)}`, signal)
    .then((fetched) => (fetched ? decodeFrameBytes(fetched, manifest.variables.mslp.encoding) : null))
    .then((bytes) => {
      const expected = manifest.nx * manifest.ny * 2;
      if (!bytes || bytes.byteLength !== expected) return null;
      const aligned = bytes.byteOffset % 2 === 0 ? new Uint16Array(bytes.buffer, bytes.byteOffset, expected / 2) : new Uint16Array(bytes.slice().buffer);
      if (aligned.every((value) => value === manifest.variables.mslp.fill)) return null;
      return new Uint16Array(aligned);
    }).catch(() => null) : Promise.resolve(null);
  const [pointsBytes, aviationBytes, mslp] = await Promise.all([
    fetchBytes(`/data/${pointsPath}`, signal).catch(() => null),
    fetchBytes(`/data/${manifest.aviation}`, signal).catch(() => null),
    mslpTask,
  ]);
  if (aborted(signal)) return emptySnapshot(nowMs);
  return trainingSnapshotFromInputs({
    manifest,
    points: (() => {
      const points = readPoints(json(pointsBytes));
      return points && Date.parse(points.run) === Date.parse(manifest.run) ? points : null;
    })(),
    aviation: aviationInput(json(aviationBytes)),
    mslp,
  }, nowMs, units);
}
