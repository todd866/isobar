import { tafGroups, type Group } from '../../../../training/src/taf';
import { profileAt } from '../sky/physics';
import type { ProfileSeries } from '../sky/physics';
import type { WeatherReport } from './model';

const MINUTE = 60_000;
const record = (x: unknown): Record<string, unknown> | null => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null;
const iso = (x: unknown): x is string => typeof x === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(x) && Number.isFinite(Date.parse(x));
const stationOf = (raw: string) => raw.trim().match(/^(?:(?:TAF|METAR|SPECI|AMD|COR)\s+)*([A-Z][A-Z0-9]{3})\b/)?.[1];

/** Pure adapter. The caller supplies already-published JSON and the capture
 * time; this module neither fetches nor substitutes invented weather. */
export function weatherFromPublished(input: {
  station: string; aviation?: unknown; apiReport?: unknown; profile?: ProfileSeries | null; capturedAt: string;
}): WeatherReport | null {
  if (!/^[A-Z][A-Z0-9]{3}$/.test(input.station) || !iso(input.capturedAt)) return null;
  const airports = record(input.aviation)?.airports;
  const collector = Array.isArray(airports) ? airports.map(record).find(r => r?.icao === input.station) : null;
  const api = record(input.apiReport);
  const row = collector ?? (api?.icao === input.station ? api : null);
  if (!row) return null;
  const m = record(row.metar), t = record(row.taf);
  const metar = m && typeof m.raw === 'string' && stationOf(m.raw) === input.station && iso(m.time) ? { raw: m.raw, time: m.time } : null;
  const taf = t && typeof t.raw === 'string' && stationOf(t.raw) === input.station && iso(t.issue) && iso(t.from) && iso(t.to)
    && Date.parse(t.to) > Date.parse(t.from) ? { raw: t.raw, issue: t.issue, from: t.from, to: t.to } : null;
  if (!metar && !taf) return null;
  const profile = input.profile?.icao === input.station ? structuredClone(input.profile) : null;
  return { station: input.station, source: collector ? '/data/aviation.json' : '/api/aviation', capturedAt: input.capturedAt, metar, taf, profile };
}

/** Routing data for the future loader; no I/O in the engine. */
export function weatherRequest(station: string, collectorStations: readonly string[]): string {
  if (!/^[A-Z][A-Z0-9]{3}$/.test(station)) throw new RangeError('Invalid station');
  return collectorStations.includes(station) ? '/data/aviation.json' : `/api/aviation?icao=${station}`;
}

/** Convert US statute miles only for the shared conservative parser. The
 * dossier's raw source is unchanged; partial/unsupported groups remain absent. */
export function forecastGroups(report: WeatherReport): Group[] | null {
  if (!report.taf || stationOf(report.taf.raw) !== report.station) return null;
  const raw = report.taf.raw.replace(/\b(P)?(?:(\d+) )?(\d+)(?:\/(\d+))?SM\b/g, (_all, plus, whole, n, denominator) => {
    const miles = (whole ? Number(whole) : 0) + Number(n) / (denominator ? Number(denominator) : 1);
    if (!Number.isFinite(miles)) return 'UNSUPPORTED_VIS';
    const metres=miles*1609.344;
    // Preserve exact SM thresholds (3 SM is 4828.032 m, not 4828 m).
    return `${String(Math.min(9999,Math.ceil(metres))).padStart(4,'0')} ODSM_${metres}_${plus?'P':'E'}`;
  });
  return tafGroups({ ...report.taf, raw })?.map(group=>{
    const marker=/\bODSM_([\d.]+)_([PE])\b/.exec(group.body);
    return marker?{...group,body:group.body.replace(marker[0],'').replace(/\s+/g,' ').trim(),cond:{...group.cond,visM:Number(marker[1]),visAtLeast:marker[2]==='P'}}:group;
  })??null;
}

/** Segment sweep: evaluate each forecast boundary, with no five-minute blind
 * spots. BECMG carries both states during its transition (conservative). */
export function forecastWindow(report: WeatherReport, fromMs: number, toMs: number): Group[] | null {
  const groups = forecastGroups(report);
  if (!groups || !report.taf || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs
    || fromMs < Date.parse(report.taf.from) || toMs >= Date.parse(report.taf.to)) return null;
  const points = [...new Set([fromMs, toMs, ...groups.flatMap(g => [g.start, g.end]).filter(t => t >= fromMs && t <= toMs)])].sort((a,b) => a-b);
  const found = new Set<Group>();
  for (const t of points) {
    const prevailing = groups.filter(g => ['base', 'FM', 'BECMG'].includes(g.kind) && g.start <= t);
    const last = prevailing.at(-1);
    if (last) {
      found.add(last);
      if (last.kind === 'BECMG' && t < last.end && prevailing.length > 1) found.add(prevailing.at(-2)!);
    }
    for (const g of groups) if (!['base','FM','BECMG'].includes(g.kind) && t >= g.start && t < g.end) found.add(g);
  }
  return [...found];
}
export function metarConditions(report: WeatherReport) {
  const raw = report.metar?.raw;
  if (!raw || stationOf(raw) !== report.station) return null;
  const wind = /\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/.exec(raw);
  const qnh = /\bQ(\d{4})\b/.exec(raw), alt = /\bA(\d{4})\b/.exec(raw);
  const temp = /\b(M?\d{2})\/(?:M?\d{2}|\/\/)\b/.exec(raw);
  if (!wind || !temp || (!qnh && !alt)) return null;
  return { windFromTrueDeg: wind[1] === 'VRB' ? null : Number(wind[1]), windKt: Math.max(Number(wind[2]), Number(wind[3] ?? 0)),
    temperatureC: Number(temp[1].replace('M','-')), qnhHpa: qnh ? Number(qnh[1]) : Number(alt![1]) / 100 * 33.86389 };
}
export function freezingLevelFt(report: WeatherReport, atMs: number): number | null {
  if (!report.profile || report.profile.icao !== report.station) return null;
  const p = profileAt(report.profile, atMs);
  if (!p) return null;
  for (let i=1; i<p.levels.length; i++) {
    const a=p.levels[i-1], b=p.levels[i];
    if (a.tC === null || b.tC === null) continue;
    if (a.tC === 0) return a.zM * 3.28084;
    if (a.tC > 0 && b.tC <= 0) return (a.zM + (b.zM-a.zM)*a.tC/(a.tC-b.tC))*3.28084;
  }
  return null;
}
export function covers(report: WeatherReport, etaMs: number, beforeMinutes: number, afterMinutes: number): boolean {
  return forecastWindow(report, etaMs-beforeMinutes*MINUTE, etaMs+afterMinutes*MINUTE) !== null;
}
export const weatherInternals = { stationOf };
