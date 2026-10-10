/** Evidence-bound lessons: statements about weather stay conditional; gaps stay visible. */
import type { AviationAirport } from './chart-store';
import type { PressureCentre } from './contour';
import type { GeoPoint, GradientEstimate, PressureAxis, teachingFeatures } from './chart-teaching';
import { ceilingFt, cloudLayers, hazards, distanceBearing } from './metar-view';
import { groupsInForce } from '../../../training/src/taf';

export type Features = ReturnType<typeof teachingFeatures>;
export interface Lesson {
  id: string;
  kind: 'H' | 'L' | 'trough' | 'ridge' | 'gradient' | 'airport' | 'rain' | 'route';
  anchor: GeoPoint;
  title: string;
  datum: string;
  question: string;
  choices: string[];
  correct: number;
  why: string;
  support: string;
  easier: { question: string; choices: string[]; correct: number };
  detail?: string;
  axis?: PressureAxis;
  wind?: { idealFrom: number | null; surfaceFrom: number | null; idealKt: number | null; surfaceKt: number | null };
}
const n = (value: number) => Math.round(value).toLocaleString('en-AU');
export function centreLesson(c: PressureCentre): Lesson {
  const low = c.kind === 'L';
  return {
    id: `${c.kind}-${c.lon.toFixed(1)}-${c.lat.toFixed(1)}`, kind: c.kind, anchor: c,
    title: low ? 'A low: air gathers and rises' : 'A high: air sinks and spreads',
    datum: `${c.hpa} hPa · ${Math.abs(c.lat).toFixed(0)}°S`,
    question: 'Picture air moving around this centre. Which way?',
    choices: ['Clockwise', 'Anticlockwise'], correct: low ? 0 : 1,
    why: low
      ? 'In the southern hemisphere, a low turns clockwise. Friction lets surface air spiral inward; rising moist air can form cloud and rain.'
      : 'In the southern hemisphere, a high turns anticlockwise. Sinking air warms and dries; light winds near the centre can still allow fog or low cloud.',
    support: 'Pressure pushes from high to low. Earth’s rotation deflects moving air to its left here. Face downwind: low pressure is on your right.',
    easier: { question: 'Downwind in the southern hemisphere, low pressure lies to your:', choices: ['Right', 'Left'], correct: 0 },
    detail: 'The ring shows circulation, not wind speed. Curvature and friction change the ideal balance.',
  };
}
export function axisLesson(axis: PressureAxis, index: number): Lesson {
  const low = axis.kind === 'trough';
  return { id: `axis-${index}`, kind: axis.kind, anchor: axis, axis,
    title: low ? 'A trough: an elongated pressure valley' : 'A ridge: an elongated pressure crest',
    datum: 'Inferred from MSLP curvature', question: 'Cross the dashed axis. Pressure locally:',
    choices: ['Falls then rises', 'Rises then falls'], correct: low ? 0 : 1,
    why: low ? 'A trough bends the isobars into a valley. Surface convergence can lift moist air: cloud, showers and sometimes storms, if the air is unstable.' : 'A ridge extends outward from higher pressure. Divergence and sinking air often suppress cloud; moisture and terrain still matter.',
    support: low ? 'Imagine walking across a valley: down to its axis, then up the other side.' : 'Imagine crossing a hill crest: up to its axis, then down the other side.',
    easier: { question: low ? 'Is the axis a local pressure valley?' : 'Is the axis a local pressure crest?', choices: ['Yes', 'No'], correct: 0 },
    detail: 'A curvature diagnostic, not an analysed front. Weak or ambiguous axes are omitted.',
  };
}
export function gradientLesson(g: GradientEstimate & { surfaceFromDeg?: number | null }, index = 0): Lesson {
  const vg = g.geostrophicKt;
  const turn = g.fromDeg != null && g.surfaceFromDeg != null ? ((g.surfaceFromDeg - g.fromDeg + 540) % 360) - 180 : null;
  const comparison = turn == null ? 'Surface direction unavailable.' : `The model ${Math.abs(turn) < 3 ? 'has nearly the same direction' : `${turn < 0 ? 'backs' : 'veers'} ${n(Math.abs(turn))}°`} here.`;
  const rounded = vg == null || vg < 2.5 ? null : Math.max(5, Math.round(vg / 5) * 5);
  return { id: `gradient-${index}`, kind: 'gradient', anchor: g, title: 'Tight isobars, stronger pressure push',
    wind: { idealFrom: g.fromDeg, surfaceFrom: g.surfaceFromDeg ?? null, idealKt: vg, surfaceKt: g.surfaceKt },
    datum: `${g.gradientHpaPer100Km.toFixed(1)} hPa / 100 km · ${Math.abs(g.lat).toFixed(0)}°S`,
    question: rounded == null ? 'Closer isobars usually mean:' : 'Estimate the wind above the friction layer.',
    choices: rounded == null ? ['Stronger wind', 'Weaker wind'] : [`${Math.max(1, Math.round(rounded / 3))} kt`, `${rounded} kt`, `${rounded * 3} kt`], correct: rounded == null ? 0 : 1,
    why: vg == null ? 'The pressure gradient accelerates the air. A geostrophic estimate is unreliable near the equator.' : `Geostrophic estimate ≈ ${n(vg)} kt; model 10 m wind ${g.surfaceKt == null ? 'unavailable' : `${n(g.surfaceKt)} kt`}. ${comparison} Friction usually slows surface wind and backs it (turns it anticlockwise) toward lower pressure here.`,
    support: `At this latitude, 1 hPa across 100 km gives about ${vg == null ? 'an uncertain number of' : n(vg / Math.max(0.001, g.gradientHpaPer100Km))} kt. Multiply by ${g.gradientHpaPer100Km.toFixed(1)}.`,
    easier: { question: 'Double the pressure difference over the same distance. The ideal wind:', choices: ['Doubles', 'Halves'], correct: 0 },
    detail: 'Vg = |∇p| / (ρ |f|), ρ = 1.225 kg/m³. Assumes steady, straight flow. Curvature, terrain and mixing can make the model differ; the local direction comparison uses the model vector where available.',
  };
}

function stationMatches(raw: string, icao: string): boolean {
  return raw.match(/\bY[A-Z]{3}\b/)?.[0] === icao;
}
function plainHazard(raw: string): string | null {
  if (/\b(?:\+|-)?(?:TS\w*|VCTS)\b/.test(raw) || /\b(?:FEW|SCT|BKN|OVC)\d{3}CB\b/.test(raw)) return /\bVCTS\b/.test(raw) ? 'Thunderstorms nearby' : 'Thunderstorm / cumulonimbus hazard';
  if (/\b(?:\+|-)?FZ(?:RA|DZ)\b/.test(raw)) return 'Freezing precipitation';
  if (/\b(?:\+|-)?(?:BC|PR|MI)?FG\b/.test(raw)) return 'Fog: reduced visibility';
  const ceiling = ceilingFt(cloudLayers(raw));
  if (ceiling != null && ceiling < 1500) return `Low ceiling: ${n(ceiling)} ft above aerodrome`;
  const visibility = raw.split(/\s+/).find((token) => /^\d{4}$/.test(token));
  if (visibility && Number(visibility) < 5000) return `Reduced visibility: ${Number(visibility) / 1000} km`;
  if (/\b\+(?:SH)?RA\b/.test(raw)) return 'Heavy rain';
  if (/\b-?SHRA\b/.test(raw)) return 'Rain showers';
  if (/\b-?RA\b/.test(raw)) return 'Rain';
  if (/\bBR\b/.test(raw)) return 'Mist';
  const gust = raw.match(/\b(?:\d{3}|VRB)\d{2,3}G(\d{2,3})KT\b/);
  if (gust && Number(gust[1]) >= 25) return `Gusts to ${Number(gust[1])} kt`;
  if (hazards(raw).length) return 'Precipitation or obscuration reported';
  return null;
}
function decodeConditions(raw: string): string {
  const out: string[] = [];
  if (/\bCAVOK\b/.test(raw)) out.push('Visibility at least 10 km; no significant weather or cloud below the CAVOK threshold');
  else {
    const vis = raw.split(/\s+/).find((token) => /^\d{4}$/.test(token));
    if (vis) out.push(`Visibility ${vis === '9999' ? 'at least 10 km' : `${Number(vis) / 1000} km`}`);
    const ceiling = ceilingFt(cloudLayers(raw));
    if (ceiling != null) out.push(`ceiling ${n(ceiling)} ft AGL`);
  }
  const wind = raw.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  if (wind) out.push(wind[1] === '000' && Number(wind[2]) === 0 ? 'calm' : `wind ${wind[1] === 'VRB' ? 'variable' : `from ${Number(wind[1])}° true`} at ${Number(wind[2])} kt${wind[3] ? `, gusting ${Number(wind[3])} kt` : ''}`);
  return out.length ? `${out.join('; ')}.` : 'Conditions could not be decoded.';
}
export function airportEvidence(a: AviationAirport, validMs: number, nowMs: number) {
  const raw = a.metar && stationMatches(a.metar.raw, a.icao) ? a.metar.raw.split(/\s+(?:RMK|TEMPO|BECMG|NOSIG)\b/)[0] : null;
  const time = a.metar?.time ? Date.parse(a.metar.time) : NaN;
  const age = Number.isFinite(time) ? Math.round((nowMs - time) / 60000) : null;
  const fresh = raw != null && age != null && age >= -5 && age <= 90;
  const issue = a.taf?.issue ? Date.parse(a.taf.issue) : NaN;
  const groups = a.taf && (!Number.isFinite(issue) || issue <= nowMs + 300_000) && stationMatches(a.taf.raw, a.icao) ? groupsInForce(a.taf, new Date(validMs).toISOString()) : [];
  const issueText = Number.isFinite(issue) ? `Issued ${a.taf!.issue!.replace('T', ' ').slice(0, 16)} UTC. ` : 'Issue time unavailable. ';
  const validity = a.taf?.from && a.taf?.to ? `Valid ${a.taf.from.replace('T', ' ').slice(0, 16)} to ${a.taf.to.replace('T', ' ').slice(0, 16)} UTC. ` : '';
  const tafText = groups?.map((g) => `${g.role === 'prevailing' ? 'Prevailing' : g.kind === 'INTER' ? 'Intermittent' : g.kind === 'TEMPO' ? 'Temporary' : g.kind}${g.kind.startsWith('PROB') ? ` (${g.kind.slice(4)}% chance${g.change ? `, ${g.change === 'TEMPO' ? 'temporary' : 'intermittent'}` : ''})` : ''}: ${plainHazard(g.body) ? `${plainHazard(g.body)}. ` : ''}${decodeConditions(g.body)}`).join(' ') || 'TAF unavailable or outside its validity at chart time.';
  const hazard = raw ? plainHazard(raw) : null;
  const tafHazard = groups?.map((g) => plainHazard(g.body)).find(Boolean);
  return {
    headline: `${!fresh ? 'Observation stale or unavailable. ' : ''}${hazard ?? tafHazard ?? 'No decoded hazard; check the full reports'}`,
    observation: raw ? `${age == null ? 'Time unknown' : `${Math.max(0, age)} min old`}: ${decodeConditions(raw)}` : 'Matching METAR unavailable.',
    forecast: issueText + validity + tafText, fresh, convective: !!((fresh && raw && /TS|\d{3}CB/.test(raw)) || groups?.some((g) => /TS|\d{3}CB/.test(g.body))),
  };
}
export function airportLesson(a: AviationAirport, validMs: number, nowMs: number): Lesson {
  const e = airportEvidence(a, validMs, nowMs);
  return { id: a.icao, kind: 'airport', anchor: a, title: `${a.icao} · ${a.name}`, datum: e.headline,
    question: 'Which report describes conditions observed at the aerodrome?', choices: ['METAR', 'TAF'], correct: 0,
    why: `METAR — ${e.observation}`, support: 'METAR is an observation. TAF is a forecast with a validity period and possible changes.',
    easier: { question: 'A TAF describes expected conditions. Is it an observation?', choices: ['No', 'Yes'], correct: 0 }, detail: `TAF at chart time — ${e.forecast}`,
  };
}
export function buildLessons(f: Features, centres: PressureCentre[], airports: AviationAirport[], validMs: number, nowMs: number): Lesson[] {
  return [...centres.map(centreLesson), ...f.axes.map(axisLesson), ...f.tight.slice(0, 4).map(gradientLesson), ...airports.slice(0, 12).map((a) => airportLesson(a, validMs, nowMs))];
}
export interface TourStep { lesson: Lesson; mode: 'Worked example' | 'Guided estimate' | 'Your turn'; field: 'none' | 'rain' | 'wind' }
export function buildTour(f: Features, centres: PressureCentre[], airports: AviationAirport[], validMs: number, nowMs: number): TourStep[] {
  const steps: TourStep[] = [];
  if (f.biggest) steps.push({ lesson: { ...centreLesson(f.biggest), datum: `${f.biggest.hpa} hPa · largest centre departure from 1013 hPa` }, mode: 'Worked example', field: 'none' });
  else if (f.axes[0]) steps.push({ lesson: axisLesson(f.axes[0], 0), mode: 'Worked example', field: 'none' });
  if (f.strongest) steps.push({ lesson: { ...gradientLesson(f.strongest), title: f.strongest.surfaceKt == null ? 'The strongest pressure gradient' : 'The strongest model surface wind' }, mode: 'Guided estimate', field: 'wind' });
  if (!f.strongest) steps.push({ mode: 'Guided estimate', field: 'none', lesson: {
    id: 'tour-wind-gap', kind: 'gradient', anchor: f.biggest ?? { lat: -30, lon: 135 }, title: 'What the wind field can tell us', datum: 'No usable wind maximum or tight gradient',
    question: 'If the wind field is missing, can we call conditions calm?', choices: ['No', 'Yes'], correct: 0,
    why: 'Missing wind is unknown wind. Isobar spacing can support an estimate only where pressure and latitude are valid.', support: 'A blank reading describes the data, not the atmosphere.',
    easier: { question: 'Unknown means:', choices: ['Check another source', 'Zero wind'], correct: 0 },
  } });
  const convective = airports.find((a) => airportEvidence(a, validMs, nowMs).convective);
  const wet = f.wettest;
  const rainAnchor = convective ?? wet ?? { lat: -30, lon: 135 };
  steps.push({ mode: 'Guided estimate', field: 'rain', lesson: {
    id: 'tour-rain', kind: 'rain', anchor: rainAnchor, title: 'Rain is a clue. CB needs more evidence.',
    datum: convective ? `${convective.icao} · thunder / CB in a valid report` : wet ? `Wettest model cell · ${n(wet.mm)} mm / 24 h` : 'Rain data unavailable',
    question: 'Can this 24-hour rain field prove there is a CB here now?', choices: ['No', 'Yes'], correct: 0,
    why: 'Rain needs moisture and lift. A low or trough can supply lift, but CB also needs instability. A 24-hour total cannot tell you storm timing or cloud type.',
    support: 'The colour adds up rain over 24 hours ending at chart time. It is not radar or a thunderstorm forecast.',
    easier: { question: 'Could steady layered cloud produce rain too?', choices: ['Yes', 'No'], correct: 0 },
    detail: convective ? `${convective.icao}: ${airportEvidence(convective, validMs, nowMs).headline}. Check report validity before applying it to your flight.` : 'No valid aerodrome thunder / CB evidence found in this export. That is not evidence of clear weather.',
  } });
  const perth = { lat: -31.9403, lon: 115.9672 }, sydney = { lat: -33.9461, lon: 151.1772 };
  const routeWet = wet && Array.from({ length: 37 }, (_, i) => distanceBearing(perth.lat + (sydney.lat - perth.lat) * i / 36, perth.lon + (sydney.lon - perth.lon) * i / 36, wet.lat, wet.lon).km).some((km) => km < 300);
  steps.push({ mode: 'Worked example', field: 'none', lesson: {
    id: 'tour-route', kind: 'route', anchor: { lat: -33, lon: 133.5 }, title: 'Perth → Sydney: turn the pattern into questions',
    datum: `${n(distanceBearing(perth.lat, perth.lon, sydney.lat, sydney.lon).km / 1.852)} NM direct · schematic route`,
    question: 'Can 10 m wind give the cruise headwind?', choices: ['No', 'Yes'], correct: 0,
    why: `${routeWet ? 'The wettest model area is near the broad route corridor: investigate cloud, icing and deviations. ' : 'Compare the route with the pressure pattern, then check cloud, icing and deviations. '}Use winds aloft for cruise; airport TAFs for departure and arrival times.`,
    support: 'Surface friction and the wind’s change with height make 10 m wind a poor cruise estimate.',
    easier: { question: 'For cruise fuel planning, choose:', choices: ['Wind at cruise level', 'Wind at 10 m'], correct: 0 },
    detail: `Exported endpoint reports: ${airports.some((a) => a.icao === 'YPPH') ? 'YPPH' : 'YPPH missing'} · ${airports.some((a) => a.icao === 'YSSY') ? 'YSSY' : 'YSSY missing'}. This is a chart-reading exercise, not a route briefing.`,
  } });
  const solo = centres.find((c) => c.kind !== f.biggest?.kind) ?? centres[0];
  const soloLesson = solo ? centreLesson(solo) : f.axes[0] ? axisLesson(f.axes[0], 0) : steps[steps.length - 1].lesson;
  steps.push({ mode: 'Your turn', field: 'none', lesson: { ...soloLesson, id: 'tour-solo', title: `Your turn · ${soloLesson.kind === 'H' ? 'read this high' : soloLesson.kind === 'L' ? 'read this low' : 'explain the mechanism'}` } });
  return steps;
}
