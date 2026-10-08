/** Live cards: today's TAFs, METARs, SIGMETs and chart, asked the way an
 * instructor would. The stem is the question. The figure holds the raw text
 * the answer depends on, so a pilot is not asked to parse a whole product
 * inside the question. A template with nothing worth deciding returns null.
 */
export { convectiveCloud } from './metar.ts';
import type { Card } from './model.ts';
import type { AirportSnapshot, SigmetSnapshot, Snapshot } from './snapshot.ts';
import { PLAN_MINIMA } from './snapshot.ts';
import {
  alternateDecision, chooseEta, etaClockUtc, groupsInForce, localClock, tafGroups,
  type Group, type TafForce, type TafProduct,
} from './taf.ts';

function num(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function airport(snapshot: Snapshot, icao: string): AirportSnapshot | null {
  return snapshot.airports.find((item) => item.icao === icao) ?? null;
}

function tafOf(item: AirportSnapshot): TafProduct | null {
  if (!item.taf?.raw || !item.taf.from || !item.taf.to) return null;
  return { raw: item.taf.raw, issue: item.taf.issue, from: item.taf.from, to: item.taf.to };
}

/** "Perth" from "Perth Airport". */
function city(item: AirportSnapshot): string {
  return item.name.replace(/\s+Airport$/i, '');
}

function clockPair(iso: string, item: AirportSnapshot): string {
  return `${etaClockUtc(iso)} (${localClock(iso, item.zone)} ${city(item)} time)`;
}

/** "23:00Z (10:00 Sydney time)" for a METAR, from its time or its raw stamp. */
function metarWhen(item: AirportSnapshot): string {
  const time = item.metar?.time;
  if (time && Number.isFinite(Date.parse(time))) return clockPair(time, item);
  const stamp = /\b\d{2}(\d{2})(\d{2})Z\b/.exec(item.metar?.raw ?? '');
  return stamp ? `${stamp[1]}:${stamp[2]}Z` : 'latest';
}

/** Correct answer first, then three distractors, rotated by a seed so the key moves. */
function arrange(correct: string, distractors: string[], seed: number): { options: string[]; correct: number } {
  const picked = [correct];
  for (const text of distractors) {
    if (picked.length === 4) break;
    if (!picked.includes(text)) picked.push(text);
  }
  const shift = Math.abs(Math.round(seed)) % picked.length;
  const options = picked.map((_, index) => picked[(index + shift) % picked.length]);
  return { options, correct: options.indexOf(correct) };
}

function card(
  id: string,
  conceptIds: string[],
  stem: string,
  arranged: { options: string[]; correct: number },
  explanation: string,
  citation: { sourceId: string; section: string },
  figure: NonNullable<Card['figure']>,
  planStep: number | null = null,
  focus: Card['focus'] = undefined,
): Card {
  return {
    id,
    conceptIds,
    subject: 'live',
    kind: 'mcq',
    planStep,
    stem,
    options: arranged.options.map((text, index) => ({ id: String(index + 1), text })),
    correctId: String(arranged.correct + 1),
    explanation,
    citations: [citation],
    complexity: 2,
    topics: ['live'],
    figure,
    focus,
  };
}

const mos91 = (section: string) => ({ sourceId: 'casa-91-mos', section });
const bom = (section: string) => ({ sourceId: 'bom-aviation', section });
const mam = (section: string) => ({ sourceId: 'bom-mam', section });

function tafLines(item: AirportSnapshot): string[] {
  const lines = item.taf?.lines.map((line) => line.text) ?? [];
  return lines.length ? lines : [item.taf?.raw ?? ''];
}

function tafTitle(item: AirportSnapshot): string {
  const header = item.taf?.headerUtc ? ` ${item.taf.headerUtc}` : '';
  return `${item.icao} TAF${header}`;
}

/** "FM070700", "INTER 0707/0721" or "the base group 0621/0800". */
function label(group: Group | TafForce, validity: string): string {
  if (group.kind === 'base') return `the base group ${validity}`;
  return 'marker' in group ? group.marker : group.needle;
}

function validityOf(taf: TafProduct): string {
  return /\b\d{4}\/\d{4}\b/.exec(taf.raw)?.[0] ?? '';
}

function minimaText(): string {
  return `a ceiling of ${PLAN_MINIMA.ceilingFt.toLocaleString('en-AU').replace(',', ' ')} ft and visibility ${PLAN_MINIMA.visM.toLocaleString('en-AU').replace(',', ' ')} m`;
}

/** Destination alternate: what today's TAF requires at an ETA chosen inside its first deterioration. */
function alternateCard(snapshot: Snapshot, destIcao: string, originIcao: string, planStep: number | null): Card | null {
  const dest = airport(snapshot, destIcao);
  const origin = airport(snapshot, originIcao);
  const taf = dest ? tafOf(dest) : null;
  if (!dest || !origin || !taf) return null;
  const groups = tafGroups(taf);
  if (!groups || groups.length < 2) return null;
  const eta = chooseEta(taf, snapshot.now, PLAN_MINIMA);
  if (!eta) return null;
  const decision = alternateDecision(taf, eta, PLAN_MINIMA, 0);
  if (!decision) return null;
  const force = groupsInForce(taf, eta) ?? [];
  const validity = validityOf(taf);
  const inForce = force.map((group) => (group.kind === 'base' ? `${label(group, validity)} (${group.body})` : `${group.needle} ${group.body}`));
  const stem = `You are planning ${city(origin)} to ${city(dest)}, arriving ${clockPair(eta, dest)}. `
    + `The ${destIcao} TAF groups in force at your ETA are ${inForce.join(', with ')}. `
    + `The alternate minima for the approach you will fly are ${minimaText()}, and no holding fuel is on the plan yet. `
    + 'Under the Part 91 rules, what does this forecast require of you?';
  const clear = 'Nothing more, because the forecast at your ETA is at or above the alternate minima';
  const inter = 'An alternate, or 30 min of holding fuel for the INTER deterioration';
  const tempo = 'An alternate, or 60 min of holding fuel for the TEMPO deterioration';
  const until = 'An alternate, or fuel to hold until 30 min after the deterioration ends';
  const alternateOnly = 'An alternate, because the deterioration is not forecast to end within the TAF';
  const uncovered = 'An alternate, because the TAF does not cover 30 min before to 60 min after your ETA';
  const ignoreProb = 'Nothing more, because a PROB30 or PROB40 group is below the planning threshold';
  // On a TAF3 the PROB really may be disregarded, so the PROB distractor would be a second right answer.
  const distractors = [tempo, inter, until, clear, alternateOnly, uncovered, ...(decision.taf3 ? [] : [ignoreProb])];
  const driver = groups.find((group) => group.marker === decision.group);
  const quoted = driver ? `${driver.marker} ${driver.body}` : '';
  const limits = `${minimaText()}`;
  const overlap = decision.taf3 ? 'covers your ETA' : 'overlaps your ETA ±30 min';
  const why = decision.thunderstorm
    ? 'forecasts a thunderstorm, which is relevant weather whatever the cloud and visibility'
    : `is below ${limits}`;
  const taf3Note = decision.taf3
    ? ' This is a TAF3 and your ETA is in its first 3 hours, so PROB groups may be disregarded and the window is your ETA itself, not ±30 min.'
    : '';
  const taf3Rule = decision.taf3 ? ', 8.02 (2) and 8.04 (2)' : '';
  let correct = clear;
  let explanation = '';
  switch (decision.reason) {
    case 'inter':
      correct = inter;
      explanation = `${quoted} ${overlap} and ${why}. A deterioration forecast on an intermittent basis is covered by 30 min of holding fuel, or by nominating an alternate.${taf3Note} Part 91 MOS 2020 s 8.02 (1) and 8.04 (6)${taf3Rule}.`;
      break;
    case 'tempo':
      correct = tempo;
      explanation = `${quoted} ${overlap} and ${why}. A deterioration forecast on a temporary basis is covered by 60 min of holding fuel, or by nominating an alternate.${taf3Note} Part 91 MOS 2020 s 8.02 (1) and 8.04 (6)${taf3Rule}.`;
      break;
    case 'prob':
      correct = until;
      explanation = `${quoted} ${overlap}, and a 30% or 40% probability of a thunderstorm or of fog, mist or dust below the minima is relevant weather. The 30 and 60 min holding cases apply only to INTER and TEMPO, so carry fuel to hold until 30 min after the PROB period ends (about ${decision.holdMinutes} min from your ETA) or nominate an alternate. Part 91 MOS 2020 s 8.02 (1) (b) (ii) and (d), 8.04 (5) and (6).`;
      break;
    case 'prevailing':
      correct = decision.holdMinutes == null ? alternateOnly : until;
      explanation = decision.holdMinutes == null
        ? `The prevailing conditions at your ETA ${decision.thunderstorm ? 'include a thunderstorm' : `are below ${limits}`} and the TAF does not forecast them ending, so no amount of holding fuel substitutes: nominate an alternate. Part 91 MOS 2020 s 8.04 (1) and (5).`
        : `The prevailing conditions at your ETA ${decision.thunderstorm ? 'include a thunderstorm' : `are below ${limits}`}. An alternate is required unless you carry fuel to hold until ${decision.taf3 ? 'they end' : '30 min after they end'}, about ${decision.holdMinutes} min from your ETA.${taf3Note} Part 91 MOS 2020 s 8.04 (1) and (5)${taf3Rule}.`;
      break;
    case 'uncovered':
      correct = uncovered;
      explanation = `The TAF must be valid from 30 min before to 60 min after your ETA; this one does not cover that period, so the destination has no usable forecast and an alternate is required. Part 91 MOS 2020 s 7.02 (6) and 8.04 (3).`;
      break;
    default: {
      correct = clear;
      const overlays = force.filter((group) => group.role !== 'prevailing').map((group) => `${group.needle} ${group.body}`);
      const edge = overlays.length
        ? ` ${overlays.join(' and ')} must be read against the minima: a value equal to the minimum is not below it.`
        : '';
      explanation = decision.taf3
        ? `Nothing in force at your ETA is below ${limits} or has a thunderstorm, so the weather does not require an alternate or holding fuel.${edge}${taf3Note} Part 91 MOS 2020 s 8.02 (1) and (2), 8.04 (2).`
        : `Nothing in force at your ETA, or within 30 min either side, is below ${limits}, has a thunderstorm, or carries a PROB, so the weather does not require an alternate or holding fuel.${edge} Part 91 MOS 2020 s 8.02 (1) and 8.04 (1).`;
    }
  }
  const seed = new Date(eta).getUTCHours() + new Date(eta).getUTCMinutes() / 5;
  const highlight = force.map((group) => group.needle);
  return card(`live.alternate.${destIcao}`, ['fp.holding', 'live.today'], stem, arrange(correct, distractors, seed), explanation,
    mos91('Chapter 8, destination alternate aerodromes'), { title: tafTitle(dest), lines: tafLines(dest), highlight }, planStep, {
      icao: destIcao,
      marks: force.map((group) => ({ icao: destIcao, needle: group.needle })),
    });
}

/** Which TAF groups a pilot must read together at the ETA. */
function groupsCard(snapshot: Snapshot, destIcao: string, originIcao: string, planStep: number | null): Card | null {
  const dest = airport(snapshot, destIcao);
  const origin = airport(snapshot, originIcao);
  const taf = dest ? tafOf(dest) : null;
  if (!dest || !origin || !taf) return null;
  const groups = tafGroups(taf);
  if (!groups || groups.length < 3) return null;
  const eta = chooseEta(taf, snapshot.now);
  if (!eta) return null;
  const at = Date.parse(eta);
  const force = groupsInForce(taf, eta);
  if (!force?.length) return null;
  const validity = validityOf(taf);
  const prevailing = force.find((group) => group.role === 'prevailing');
  if (!prevailing) return null;
  const extras = force.filter((group) => group.role !== 'prevailing');
  const join = (head: string, tail: string[]) => {
    const text = tail.length ? `${head} with ${tail.join(' and ')}` : `${head} alone`;
    return text.charAt(0).toUpperCase() + text.slice(1);
  };
  const correct = join(label(prevailing, validity), extras.map((group) => group.needle));
  const permanent = groups.filter((group) => group.kind === 'FM' || group.kind === 'BECMG' || group.kind === 'base');
  const others = permanent.filter((group) => label(group, validity) !== label(prevailing, validity));
  const next = others.find((group) => group.start > at);
  const idle = groups.find((group) => group.kind !== 'FM' && group.kind !== 'BECMG' && group.kind !== 'base'
    && !extras.some((extra) => extra.needle === group.marker));
  // Misreadings: the wrong permanent group, the fluctuation ignored, or a fluctuation outside its period.
  const distractors = [
    next ? join(label(next, validity), extras.map((group) => group.needle)) : '',
    extras.length ? join(label(prevailing, validity), []) : (idle ? join(label(prevailing, validity), [idle.marker]) : ''),
    ...others.filter((group) => group !== next).reverse().map((group) => join(label(group, validity), extras.map((extra) => extra.needle))),
    idle && extras.length ? join(label(prevailing, validity), [idle.marker]) : '',
    next && idle ? join(label(next, validity), [idle.marker]) : '',
  ].filter((text) => text && text !== correct);
  if (new Set(distractors).size < 3) return null;
  const stem = `You are planning ${city(origin)} to ${city(dest)}, arriving ${clockPair(eta, dest)}. `
    + `Which groups of the ${destIcao} TAF are in force at your ETA and must be read together?`;
  const reading = extras.length
    ? `${extras.map((group) => `${group.needle} ${group.body}`).join('; ')} ${extras.length > 1 ? 'are' : 'is a'} variation${extras.length > 1 ? 's' : ''} laid over it for that period.`
    : 'No TEMPO, INTER or PROB period covers that time.';
  const explanation = `At ${etaClockUtc(eta)} the prevailing conditions come from ${label(prevailing, validity)} (${prevailing.body}). ${reading} `
    + 'An FM group replaces everything before it, and a BECMG has become the prevailing conditions by the end of its period; either lasts until the next FM or BECMG. TEMPO, INTER and PROB groups are variations on the prevailing group and apply only within their own period. '
    + 'BoM aviation TAF guide, significant changes and variations.';
  const seed = new Date(eta).getUTCHours() + 1;
  return card(`live.groups.${destIcao}`, ['met.taf-change', 'live.today'], stem, arrange(correct, distractors, seed), explanation,
    bom('TAF guide, significant changes and variations (FM, BECMG, INTER, TEMPO)'),
    { title: tafTitle(dest), lines: tafLines(dest), highlight: force.map((group) => group.needle) }, planStep, {
      icao: destIcao,
      marks: force.map((group) => ({ icao: destIcao, needle: group.needle })),
    });
}

const HAZARD: Record<string, string> = {
  TS: 'thunderstorms', TSGR: 'thunderstorms with hail', TURB: 'turbulence', ICE: 'icing', MTW: 'mountain waves',
  VA: 'volcanic ash', TC: 'a tropical cyclone', DS: 'a duststorm', SS: 'a sandstorm', 'RDOACT CLD': 'a radioactive cloud',
};
const QUALIFIER: Record<string, string> = {
  SEV: 'Severe', FRQ: 'Frequent', EMBD: 'Embedded', OBSC: 'Obscured', SQL: 'Squall-line', HVY: 'Heavy',
};
const FIR: Record<string, string> = { YMMM: 'Melbourne', YBBB: 'Brisbane' };

/** "FL250" stays a flight level and "8000FT" stays feet: the SIGMET's own datum, never inferred from magnitude. */
function levelText(token: string): string {
  if (token.startsWith('FL')) return token;
  const feet = Number(token.replace(/FT$/, ''));
  return `${feet.toLocaleString('en-AU').replace(',', ' ')} ft`;
}

const LEVEL = String.raw`(FL\d{3}|\d{3,5}FT)`;

/** The level group of a SIGMET, as the BoM SIGMET guide lists its formats, read from the raw text.
 * Returns the vertical extent and a misreading of it, or null when no level group is found. */
export function sigmetLevel(raw: string): { span: string; wrong: string } | null {
  const text = raw.replace(/\s+/g, ' ');
  let m = new RegExp(String.raw`\bTOP (ABV|BLW) ${LEVEL}`).exec(text);
  if (m) {
    const at = levelText(m[2]);
    return m[1] === 'ABV'
      ? { span: `with tops above ${at}`, wrong: `with tops below ${at}` }
      : { span: `with tops below ${at}`, wrong: `with tops above ${at}` };
  }
  m = new RegExp(String.raw`\bTOP ${LEVEL}`).exec(text);
  if (m) return { span: `with tops at ${levelText(m[1])}`, wrong: `above ${levelText(m[1])}` };
  m = new RegExp(String.raw`\bABV ${LEVEL}`).exec(text);
  if (m) return { span: `above ${levelText(m[1])}`, wrong: `below ${levelText(m[1])}` };
  m = new RegExp(String.raw`\bSFC\/${LEVEL}`).exec(text);
  if (m) return { span: `from the surface to ${levelText(m[1])}`, wrong: `above ${levelText(m[1])}` };
  m = /\bFL(\d{3})\/(?:FL)?(\d{3})\b/.exec(text);
  if (m) return { span: `from FL${m[1]} to FL${m[2]}`, wrong: `above FL${m[2]}` };
  m = /\b(\d{3,5})\/(\d{3,5})FT\b/.exec(text);
  if (m) return { span: `from ${levelText(m[1])} to ${levelText(m[2])}`, wrong: `above ${levelText(m[2])}` };
  m = /\b(\d{3,5})FT\/FL(\d{3})\b/.exec(text);
  if (m) return { span: `from ${levelText(m[1])} to FL${m[2]}`, wrong: `above FL${m[2]}` };
  m = new RegExp(String.raw`(?:^|\s)${LEVEL}(?=\s|=|$)`).exec(text);
  if (m) return { span: `at ${levelText(m[1])}`, wrong: `above ${levelText(m[1])}` };
  return null;
}

/** The current SIGMET, decoded the way a pilot has to before accepting a level through it. */
function sigmetCard(snapshot: Snapshot): Card | null {
  if (!snapshot.sigmets?.length) return null;
  const now = Date.parse(snapshot.now);
  const live = snapshot.sigmets.filter((item) => {
    const from = item.from ? Date.parse(item.from) : NaN;
    const to = item.to ? Date.parse(item.to) : NaN;
    return Number.isFinite(from) && Number.isFinite(to) && now >= from && now <= to && HAZARD[item.hazard];
  });
  const pick: SigmetSnapshot | undefined = live.find((item) => sigmetLevel(item.raw));
  if (!pick?.to || !pick.from) return null;
  const level = sigmetLevel(pick.raw);
  if (!level) return null;
  const hazard = HAZARD[pick.hazard];
  const qualifier = QUALIFIER[pick.qualifier] ?? '';
  const wrongQualifier = pick.qualifier === 'SEV' ? 'Moderate' : pick.qualifier === 'HVY' ? 'Moderate' : 'Isolated';
  const until = etaClockUtc(pick.to);
  const since = etaClockUtc(pick.from);
  const { span, wrong: wrongSpan } = level;
  const phrase = (q: string, s: string, t: string) => `${q} ${hazard} ${s}, until ${t}`;
  const correct = phrase(qualifier, span, until);
  const distractors = [
    phrase(qualifier, span, since),
    phrase(qualifier, wrongSpan, until),
    phrase(wrongQualifier, span, until),
  ];
  const fir = FIR[pick.fir] ?? pick.fir;
  const lines = pick.raw.split('\n').map((line) => line.trim()).filter((line) => line && !/^W[A-Z]AU\d\d\b/.test(line));
  const stem = `At ${etaClockUtc(snapshot.now)} you are planning a flight through the ${fir} FIR and a SIGMET is current. `
    + 'Before you accept a level through its area, what does it warn of, over which levels, and until when?';
  const explanation = `The validity group ${pick.from.slice(8, 10)}${since.replace(':', '').replace('Z', '')}/${pick.to.slice(8, 10)}${until.replace(':', '').replace('Z', '')} runs to ${until}, and the level group puts the hazard ${span}: FL is a flight level, FT is feet above mean sea level, and TOP, ABV and BLW qualify the level as written. `
    + 'A SIGMET is issued only for the listed hazards, and for turbulence and icing only when severe; a weather SIGMET is valid for no more than 4 hours, volcanic ash and tropical cyclone SIGMETs for no more than 6. '
    + 'BoM aviation SIGMET guide.';
  const seed = new Date(pick.to).getUTCMinutes() / 7 + 2;
  return card('live.sigmet', ['met.sigmet', 'live.today'], stem, arrange(correct, distractors, seed), explanation,
    bom('SIGMET guide, phenomena and validity'), { title: `${pick.fir} SIGMET`, lines, highlight: [`${pick.qualifier} ${pick.hazard}`.trim()] }, 2);
}

const RUNWAYS: Record<string, string[]> = { YPPH: ['03', '21', '06', '24'], YSSY: ['16', '34', '07', '25'] };
/** Magnetic variation, degrees east positive: ERSA FAC YSSY (VAR 13 DEG E) and FAC YPPH (VAR 2 DEG W), 03 SEP 2026. */
export const VARIATION: Record<string, number> = { YSSY: 13, YPPH: -2 };

/** A true direction as magnetic: subtract east variation, add west. */
export function toMagnetic(trueDeg: number, variationEast: number): number {
  return (((trueDeg - variationEast) % 360) + 360) % 360;
}

function variationText(variationEast: number): string {
  return `${Math.abs(variationEast)}°${variationEast >= 0 ? 'E' : 'W'}`;
}

function metarWind(raw: string): { from: number; kt: number; gust: number | null } | null {
  const match = /\b(\d{3})(\d{2,3})(?:G(\d{2,3}))?KT\b/.exec(raw);
  if (!match) return null;
  return { from: Number(match[1]), kt: Number(match[2]), gust: match[3] ? Number(match[3]) : null };
}

/** Which runway is most into wind on the current METAR. */
function windCard(snapshot: Snapshot): Card | null {
  for (const icao of ['YSSY', 'YPPH']) {
    const item = airport(snapshot, icao);
    const wind = item?.metar ? metarWind(item.metar.raw) : null;
    const ends = RUNWAYS[icao];
    const variation = VARIATION[icao];
    if (!item?.metar || !wind || !ends || variation == null || wind.kt < 8) continue;
    // METAR wind is true; runway designators are magnetic. Compare like with like.
    const magnetic = toMagnetic(wind.from, variation);
    const components = ends.map((end) => {
      const heading = Number(end) * 10;
      const diff = ((magnetic - heading + 540) % 360) - 180;
      const rad = (diff * Math.PI) / 180;
      return { end, head: wind.kt * Math.cos(rad), cross: wind.kt * Math.sin(rad) };
    }).sort((a, b) => b.head - a.head);
    if (components[0].head - components[1].head < 3) continue;
    const best = components[0];
    const side = best.cross > 0 ? 'right' : 'left';
    const pairs = `${ends[0]}/${ends[1]} and ${ends[2]}/${ends[3]}`;
    const windText = `${String(wind.from).padStart(3, '0')}${String(wind.kt).padStart(2, '0')}${wind.gust ? `G${wind.gust}` : ''}KT`;
    const stem = `The ${metarWhen(item)} METAR for ${city(item)} reports wind ${windText}. The runways are ${pairs} and the magnetic variation is ${variationText(variation)}. `
      + 'Taking each runway number as its magnetic heading, which runway gives you the most headwind for landing?';
    const correct = `Runway ${best.end}`;
    const distractors = components.slice(1).map((entry) => `Runway ${entry.end}`);
    const magText = String(Math.round(magnetic)).padStart(3, '0');
    const explanation = `METAR wind is in degrees true and runway numbers are magnetic, so ${String(wind.from).padStart(3, '0')}°T with ${variationText(variation)} variation is ${magText}°M. `
      + `That is ${Math.abs(Math.round(((magnetic - Number(best.end) * 10 + 540) % 360) - 180))}° off runway ${best.end}: about ${Math.round(best.head)} kt of headwind and ${Math.round(Math.abs(best.cross))} kt of crosswind from the ${side}, with runway ${components[1].end} next at ${Math.round(components[1].head)} kt. `
      + `BoM aviation METAR/SPECI guide, wind; AIP ERSA FAC ${icao}, variation.`;
    return card('live.wind', ['met.taf', 'live.today'], stem, arrange(correct, distractors, wind.from / 10), explanation,
      bom('METAR/SPECI guide, wind'), { title: `${icao} METAR`, lines: [item.metar.raw], highlight: [windText] });
  }
  return null;
}

/** The METAR ceiling: the lowest BKN or OVC layer, or none. CAVOK asks what it promises. */
function ceilingCard(snapshot: Snapshot): Card | null {
  for (const icao of ['YSSY', 'YPPH']) {
    const item = airport(snapshot, icao);
    const raw = item?.metar?.raw;
    if (!item?.metar || !raw) continue;
    if (/\bCAVOK\b/.test(raw)) {
      const stem = `The ${metarWhen(item)} METAR for ${city(item)} reports CAVOK. Planning a visual arrival, what does that tell you about the cloud?`;
      const correct = 'No cloud below 5 000 ft or the highest 25 NM minimum sector altitude, whichever is higher, and no CB or TCU';
      const distractors = [
        'No cloud at any level above the aerodrome',
        'No cloud below 1 500 ft, which is all a visual approach needs',
        'No cloud was measured, so the ceiling is unknown',
      ];
      const explanation = 'CAVOK bundles three observations: visibility 10 km or more, no cloud below 5 000 ft or the highest 25 NM MSA (whichever is higher) with no CB or TCU, and no significant weather. It says nothing about cloud above that height. BoM aviation METAR/SPECI guide, CAVOK.';
      return card('live.ceiling', ['met.cavok', 'live.today'], stem, arrange(correct, distractors, 1), explanation,
        bom('METAR/SPECI guide, CAVOK'), { title: `${icao} METAR`, lines: [raw], highlight: ['CAVOK'] });
    }
    const layers = [...raw.matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/g)].map((match) => ({
      amount: match[1], feet: Number(match[2]) * 100, token: match[0],
    }));
    if (!layers.length) continue;
    // A ceiling is the lowest BKN or OVC layer below 20 000 ft; a higher broken layer is not one.
    const broken = layers.filter((layer) => layer.amount === 'BKN' || layer.amount === 'OVC').sort((a, b) => a.feet - b.feet);
    const ceiling = broken.find((layer) => layer.feet < 20000);
    const high = ceiling ? undefined : broken[0];
    const lowest = [...layers].sort((a, b) => a.feet - b.feet)[0];
    const highest = [...layers].sort((a, b) => b.feet - a.feet)[0];
    const ft = (feet: number) => `${feet.toLocaleString('en-AU').replace(',', ' ')} ft`;
    const stem = `The ${metarWhen(item)} METAR for ${city(item)} reports cloud ${layers.map((layer) => layer.token).join(' ')}. For your arrival, what ceiling does this report give?`;
    const correct = ceiling
      ? `${ft(ceiling.feet)}, the lowest layer that is broken or overcast`
      : high
        ? 'No ceiling, because no layer below 20 000 ft covers more than half the sky'
        : 'No ceiling, because no layer covers more than half the sky';
    // Distractors never share the correct height, so a right number for a wrong reason cannot score.
    const distractors = [
      high ? `${ft(high.feet)}, the lowest layer that is broken or overcast` : '',
      lowest.feet !== ceiling?.feet ? `${ft(lowest.feet)}, the lowest layer of any amount` : '',
      highest.feet !== ceiling?.feet && highest.feet !== lowest.feet ? `${ft(highest.feet)}, the highest layer reported` : '',
      ceiling ? 'No ceiling, because only an overcast layer counts as a ceiling' : `${ft(lowest.feet)}, because any cloud below 5 000 ft sets the ceiling`,
      ceiling ? 'No ceiling, because a ceiling comes only from the TAF, not a METAR' : `${ft(highest.feet)}, because the ceiling is the top of the highest layer`,
    ].filter((text) => text && text !== correct);
    const explanation = (ceiling
      ? `${ceiling.token} is the lowest layer covering more than half the sky, so the ceiling is ${ft(ceiling.feet)}; `
      : high
        ? `${high.token} covers more than half the sky but is not below 20 000 ft, and nothing lower is BKN or OVC, so there is no ceiling; `
        : 'FEW is 1–2 oktas and SCT 3–4, so neither covers more than half the sky and there is no ceiling; ')
      + 'the ceiling is the base of the lowest layer below 20 000 ft covering more than half the sky, which in code is BKN or OVC. '
      + 'ICAO Annex 2 definition as adopted by the CASR Dictionary and quoted in Part 121 MOS 2020 s 4.06; BoM aviation METAR/SPECI guide, cloud.';
    return card('live.ceiling', ['met.cavok', 'live.today'], stem, arrange(correct, distractors, lowest.feet / 100), explanation,
      bom('METAR/SPECI guide, cloud'), { title: `${icao} METAR`, lines: [raw], highlight: layers.map((layer) => layer.token) });
  }
  return null;
}

function place(lat: number, lon: number): string {
  const part = (value: number, hemi: string) => {
    const abs = Math.abs(value);
    const tenths = Math.round(abs * 10) / 10;
    const text = Number.isInteger(tenths) ? tenths.toFixed(0) : tenths.toFixed(1);
    return `${text}°${hemi}`;
  };
  return `${part(lat, lat < 0 ? 'S' : 'N')} ${part(lon, lon < 0 ? 'W' : 'E')}`;
}

function chartTitle(snapshot: Snapshot): string {
  const when = snapshot.sampleTime ? ` ${snapshot.sampleTime.slice(8, 10)} ${snapshot.sampleTime.slice(11, 16).replace(':', '')}Z` : '';
  return `MSLP chart${when}`;
}

/** Why the surface wind under the tightest gradient on today's chart is weaker than the geostrophic wind. */
function gradientCard(snapshot: Snapshot): Card | null {
  const gradient = snapshot.gradient;
  if (!gradient || !num(gradient.hpaPer100km) || !num(gradient.geostrophicKt)) return null;
  const where = place(gradient.lat, gradient.lon);
  const kt = Math.round(gradient.geostrophicKt);
  const direction = num(gradient.fromDeg) ? ` from ${String(Math.round(gradient.fromDeg)).padStart(3, '0')}°` : '';
  const surface = num(gradient.windKt) ? Math.round(gradient.windKt) : null;
  const lines = [
    `Tightest gradient ${gradient.hpaPer100km.toFixed(1)} hPa per 100 km at ${where}`,
    `Geostrophic wind ${kt} kt${direction}`,
    ...(surface != null ? [`Model 10 m wind ${surface} kt`] : []),
  ];
  const seed = Math.round(gradient.lon) + 1;
  if (surface != null && surface < kt - 5) {
    const stem = `Today's chart has its tightest isobar spacing near ${where}: ${gradient.hpaPer100km.toFixed(1)} hPa per 100 km, a geostrophic wind of about ${kt} kt${direction}. `
      + `The model 10 m wind at the same point is ${surface} kt. Why is the surface wind so much weaker than the geostrophic wind?`;
    const correct = 'Friction slows the air near the ground, so Coriolis force falls and the wind both weakens and turns towards lower pressure';
    const distractors = [
      'Geostrophic balance only applies above the tropopause, so the surface wind is unrelated to it',
      'Coriolis force reverses direction in the lowest few hundred feet, cancelling most of the wind',
      'The 10 m wind is a ten-minute mean, so the gusts that make up the geostrophic speed are averaged out',
    ];
    const explanation = `The geostrophic wind is the balance of pressure gradient force and Coriolis force along straight isobars above the friction layer. In the lowest few thousand feet friction reduces the speed, Coriolis force (which depends on speed) falls, and the pressure gradient force wins a little, so the wind turns across the isobars towards the low (clockwise, a veer, in the southern hemisphere): ${surface} kt at 10 m under a ${kt} kt gradient. BoM aviation glossary, geostrophic wind; BoM Manual of Aviation Meteorology, wind.`;
    return card('live.gradient', ['met.wind', 'met.gradient'], stem, arrange(correct, distractors, seed), explanation,
      mam('Wind: geostrophic balance and the friction layer'), { title: chartTitle(snapshot), lines, highlight: [where] }, null, {
        mapX: gradient.mapX, mapY: gradient.mapY, place: where, knots: kt,
      });
  }
  const stem = `Today's chart has its tightest isobar spacing near ${where}: ${gradient.hpaPer100km.toFixed(1)} hPa per 100 km, a geostrophic wind of about ${kt} kt${direction}. Why does that spacing imply the strongest wind on the chart?`;
  const correct = 'Closer isobars mean a larger pressure gradient force, which at a given latitude needs a faster wind for Coriolis force to balance it';
  const distractors = [
    'Closer isobars mean the air is denser, and dense air moves faster for the same force',
    'Closer isobars mark the centre of the high, where the air descends fastest',
    'Closer isobars mean a weaker Coriolis force, so nothing holds the wind back',
  ];
  const explanation = `The spacing of isobars is the pressure gradient: ${gradient.hpaPer100km.toFixed(1)} hPa per 100 km here. The geostrophic wind is the speed at which Coriolis force balances that gradient, so at one latitude a tighter spacing is a stronger wind. BoM aviation glossary, geostrophic wind; BoM Manual of Aviation Meteorology, wind.`;
  return card('live.gradient', ['met.wind', 'met.gradient'], stem, arrange(correct, distractors, seed), explanation,
    mam('Wind: pressure gradient and geostrophic balance'), { title: chartTitle(snapshot), lines, highlight: [where] }, null, {
      mapX: gradient.mapX, mapY: gradient.mapY, place: where, knots: kt,
    });
}

/** Why a raw-grid gradient over high terrain is not a wind. */
function artefactCard(snapshot: Snapshot): Card | null {
  const spike = snapshot.artefact;
  if (!spike || !num(spike.geostrophicKt) || !num(spike.hpaPer100km)) return null;
  const where = place(spike.lat, spike.lon);
  const kt = Math.round(spike.geostrophicKt);
  const surface = num(spike.windKt) ? `, yet the model 10 m wind in that cell is ${Math.round(spike.windKt)} kt` : '';
  const stem = `Over the high country near ${where} the raw MSLP grid implies a geostrophic wind of ${kt} kt, a gradient of ${spike.hpaPer100km.toFixed(1)} hPa per 100 km${surface}. Why is this not a real wind?`;
  const correct = 'Station pressure over high terrain is reduced to sea level through a fictitious air column, so neighbouring reduced pressures can disagree sharply without any real gradient';
  const distractors = [
    'The 10 m wind is the error: the pressure field is right and the mountains hide a jet at the surface',
    'Coriolis force changes sign over land, so the balance that gives a geostrophic wind breaks down',
    'A SIGMET for severe turbulence in that area has displaced the isobars on the chart',
  ];
  const lines = [
    `Raw gradient ${spike.hpaPer100km.toFixed(1)} hPa per 100 km at ${where}`,
    `Implied geostrophic wind ${kt} kt`,
    ...(num(spike.windKt) ? [`Model 10 m wind ${Math.round(spike.windKt)} kt`] : []),
  ];
  const explanation = `Mean sea level pressure over terrain is a calculation: the station pressure plus the weight of an imagined column down to sea level, whose temperature has to be assumed. Over ${where} that assumption differs cell to cell, so the reduced field has a steep false gradient while the real wind is light. The chart masks those cells; the screened maximum is elsewhere. BoM aviation Area QNH guide, reduction to mean sea level; BoM Manual of Aviation Meteorology, atmospheric pressure.`;
  return card('live.gradient.artefact', ['met.gradient', 'met.qnh'], stem, arrange(correct, distractors, Math.round(spike.lat) + 2), explanation,
    mam('Atmospheric pressure: reduction to mean sea level'), { title: chartTitle(snapshot), lines, highlight: [where] }, null, {
      mapX: spike.mapX, mapY: spike.mapY, artefact: true, place: where, knots: kt,
    });
}

/** Large CAPE with no thunderstorm in the TAF: which ingredient is missing. */
function capeCard(snapshot: Snapshot): Card | null {
  for (const icao of ['YSSY', 'YPPH']) {
    const item = airport(snapshot, icao);
    const value = item?.sample?.mucapeJkg;
    const taf = item ? tafOf(item) : null;
    if (!item || !num(value) || value < 500 || !taf) continue;
    if (/\b[+-]?(TS|VCTS)[A-Z]*\b|CB\b/.test(taf.raw)) continue;
    const stem = `The model gives MUCAPE of about ${Math.round(value)} J/kg over ${city(item)}, yet the ${icao} TAF has no thunderstorm or CB in any group. Why can a large CAPE sit over an aerodrome with no storm forecast?`;
    const correct = 'CAPE is the energy a parcel would release if lifted; without a trigger such as a front, trough or sea breeze it stays unused';
    const distractors = [
      'CAPE measures wind shear, which prevents storms unless it is very large',
      'A thunderstorm needs CAPE below about 500 J/kg, so this air is too energetic to convect',
      'The forecaster can only use the TAF for cloud and visibility, so storms are never written in a TAF',
    ];
    const explanation = 'CAPE is the energy per kilogram that buoyancy would give a parcel rising from its level of free convection, so it measures instability alone. The thunderstorms guide names three ingredients: instability, low-level moisture and a lifting mechanism; with no front, trough, sea breeze or heating strong enough to lift the parcel, no storm forms and TS stays out of the TAF. BoM aviation thunderstorms guide, ingredients and triggers.';
    const lines = [`${icao} MUCAPE ${Math.round(value)} J/kg (model)`, ...tafLines(item)];
    return card('live.cape', ['met.cb', 'live.today'], stem, arrange(correct, distractors, Math.round(value / 100)), explanation,
      bom('Thunderstorms guide, ingredients and triggers'), { title: `${icao} MUCAPE and TAF`, lines, highlight: [`${Math.round(value)} J/kg`] });
  }
  return null;
}

/** Cards whose inputs are on today's data. A missing input, or nothing worth deciding, drops the card. */
export function liveCards(snapshot: Snapshot | null): Card[] {
  if (!snapshot) return [];
  return [
    groupsCard(snapshot, 'YSSY', 'YPPH', 1),
    sigmetCard(snapshot),
    alternateCard(snapshot, 'YSSY', 'YPPH', 3),
    alternateCard(snapshot, 'YPPH', 'YSSY', null),
    windCard(snapshot),
    ceilingCard(snapshot),
    gradientCard(snapshot),
    artefactCard(snapshot),
    capeCard(snapshot),
  ].filter((item): item is Card => item != null);
}
