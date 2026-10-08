/**
 * One aerodrome's sky at one time: the report in force (METAR near now, TAF
 * groups later) plus the model profile at that time, through skyState().
 */
import { groupsInForce } from '../taf.ts';
import { parseReport, profileAt, reportGroups, skyState, type ProfileSeries, type ReportGroup, type SkyInput, type SkyState } from './physics.ts';

export interface SkyAirport {
  icao: string;
  lat: number;
  lon: number;
  metar: { raw: string; time: string | null } | null;
  taf: { raw: string; issue: string | null; from: string | null; to: string | null } | null;
}

export interface SkyFile { profiles: ProfileSeries[] }

/** The report state in force at a time: the METAR near now, else the TAF groups. */
export function reportAt(airport: SkyAirport, timeMs: number, nowMs: number): { source: SkyInput['source']; groups: ReportGroup[] } {
  const metarMs = airport.metar?.time ? Date.parse(airport.metar.time) : NaN;
  const metar = airport.metar && Number.isFinite(metarMs) ? { raw: airport.metar.raw, timeMs: metarMs } : null;
  let taf: { role: 'prevailing' | 'transition' | 'additional'; kind: string; body: string }[] | null = null;
  if (airport.taf) {
    const forced = groupsInForce({ raw: airport.taf.raw, issue: airport.taf.issue, from: airport.taf.from, to: airport.taf.to }, new Date(timeMs).toISOString());
    taf = forced && forced.length ? forced.map((group) => ({ role: group.role, kind: group.kind, body: group.body })) : null;
  }
  return reportGroups(metar, taf, timeMs, nowMs);
}

export function sceneFor(airport: SkyAirport, series: ProfileSeries | null, timeMs: number, nowMs: number): SkyState {
  const { source, groups } = reportAt(airport, timeMs, nowMs);
  return skyState({
    icao: airport.icao,
    elevationFt: series?.elevationFt ?? 0,
    lat: airport.lat,
    lon: airport.lon,
    timeMs,
    source,
    groups,
    profile: profileAt(series, timeMs),
  });
}

export interface Readout {
  source: SkyInput['source'];
  /** Lowest BKN/OVC/VV as reported, ft AGL; null when there is none. */
  ceilingFt: number | null;
  /** The lowest reported layer when there is no ceiling, e.g. "SCT030"; or CAVOK/NSC/NCD. */
  cloud: string | null;
  vis: string | null;
  wind: string | null;
  hazards: { text: string; severe: boolean }[];
}

export function visText(visM: number | null, cavok: boolean): string | null {
  if (cavok) return 'CAVOK';
  if (visM == null) return null;
  if (visM >= 9999) return '10+ km';
  return visM >= 5000 ? `${visM / 1000} km` : `${visM.toLocaleString('en-AU')} m`;
}

/** The instrument row: ceiling, visibility, wind and weather from the report in force. */
export function readout(source: SkyInput['source'], groups: ReportGroup[]): Readout {
  const main = groups.find((group) => group.change == null);
  if (!main) return { source, ceilingFt: null, cloud: null, vis: null, wind: null, hazards: [] };
  const report = parseReport(main.body);
  const ceiling = report.layers.filter((l) => l.cover === 'BKN' || l.cover === 'OVC' || l.cover === 'VV').map((l) => l.baseFtAgl);
  const lowest = [...report.layers].sort((a, b) => a.baseFtAgl - b.baseFtAgl)[0];
  const windMatch = main.body.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  const hazards: Readout['hazards'] = [];
  for (const group of groups) {
    for (const item of parseReport(group.body).weather) {
      const text = group.change ? `${group.change} ${item.token}` : item.token;
      if (!hazards.some((h) => h.text === text)) hazards.push({ text, severe: /TS|FG|SQ|FC|VA|GR|DS|SS/.test(item.token) || item.intensity === '+' });
    }
    for (const layer of parseReport(group.body).layers) if (layer.type) hazards.push({ text: `${group.change ? `${group.change} ` : ''}${layer.type}`, severe: layer.type === 'CB' });
  }
  hazards.sort((a, b) => Number(b.severe) - Number(a.severe));
  return {
    source,
    ceilingFt: ceiling.length ? Math.min(...ceiling) : null,
    cloud: lowest ? `${lowest.cover}${String(lowest.baseFtAgl / 100).padStart(3, '0')}` : report.noCloud,
    vis: visText(report.visM, report.noCloud === 'CAVOK'),
    wind: windMatch ? `${windMatch[1]}/${windMatch[2]}${windMatch[3] ? `G${windMatch[3]}` : ''}` : null,
    hazards,
  };
}
