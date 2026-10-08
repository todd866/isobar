import type { Card } from './model.ts';
import type { AirportSnapshot, Snapshot } from './snapshot.ts';
import { lineMarked } from './taf.ts';
import { convectiveCloud, type ConvectiveCloud } from './metar.ts';
import { figureKind } from './chrome.ts';
import { esc } from './html.ts';

function glyph(paths: string, solid = false): string {
  return `<svg class="glyph${solid ? ' solid' : ''}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}

const icon = {
  book: glyph('<path d="M5 5h6a3 3 0 0 1 3 3v11H8a3 3 0 0 0-3 3z"/><path d="M19 5h-6a3 3 0 0 0-3 3v11h6a3 3 0 0 1 3 3z"/>'),
  cloud: glyph('<path d="M7 17h10a4 4 0 0 0 0-8 5 5 0 0 0-9.5-1A3.5 3.5 0 0 0 7 17z"/>'),
  clear: glyph('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.5 5.5l1.5 1.5M17 17l1.5 1.5M18.5 5.5 17 7M7 17l-1.5 1.5"/>'),
  vis: glyph('<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>'),
  warn: glyph('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 16.5v.5"/>', true),
  grid: glyph('<path d="M4 8c4-2 12-2 16 0M4 12c4-2 12-2 16 0M4 16c4-2 12-2 16 0"/>'),
  bolt: glyph('<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>', true),
  flag: glyph('<path d="M6 4v16M6 5h11l-2 4 2 4H6"/>'),
};

function barb(fromDeg: number, knots: number): string {
  const direction = Number.isFinite(fromDeg) ? fromDeg : 0;
  const speed = Math.max(0, Math.round(knots));
  const marks: string[] = [];
  let left = speed;
  let y = 2;
  while (left >= 50) {
    marks.push(`<polygon points="0,${y} 16,${y + 5} 0,${y + 9}"/>`);
    left -= 50;
    y += 10;
  }
  while (left >= 10) {
    marks.push(`<line x1="0" y1="${y}" x2="14" y2="${y + 7}"/>`);
    left -= 10;
    y += 7;
  }
  if (left >= 5) marks.push(`<line x1="0" y1="${y}" x2="8" y2="${y + 4}"/>`);
  return `<svg class="glyph barb" viewBox="-20 -20 40 40" aria-hidden="true"><g transform="rotate(${direction})"><line x1="0" y1="16" x2="0" y2="-16"/><g transform="translate(0,-16)">${marks.join('')}</g></g></svg>`;
}

function cloudLabel(cloud: string, raw: string): string {
  if (cloud !== 'None') return cloud;
  const token = raw.match(/\b(NCD|NSC|SKC|CLR)\b/);
  return token?.[1] ?? '—';
}

function cloudIcon(label: string): string {
  if (/CAVOK|NSC|SKC|NCD|CLR/.test(label)) return icon.clear;
  return icon.cloud;
}

/** Lightning or a turret, only beside the word it names. Never the R-and-arrow. */
function hazardGlyph(kind: ConvectiveCloud['hazard']): string {
  if (kind === 'TCU') {
    return `<svg class="glyph solid hazard tcu" viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="16" cy="26" rx="13" ry="5"/><ellipse cx="10" cy="20" rx="6" ry="6"/><ellipse cx="22" cy="19" rx="6" ry="6"/><ellipse cx="16" cy="11" rx="7" ry="8"/></svg>`;
  }
  if (kind === 'TS' || kind === 'VCTS' || kind === 'CB') {
    return `<svg class="glyph solid hazard" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3L5 14h6l-1 7 8-11h-6z"/></svg>`;
  }
  return '';
}

function hazardWord(kind: ConvectiveCloud['hazard']): string {
  return kind === 'TS' || kind === 'VCTS' ? kind : '';
}

function windText(wind: string, raw: string): string {
  if (!wind || wind === '—') return '—';
  const gust = raw.match(/\b(?:\d{3}|VRB)\d{2}G(\d{2})KT\b/);
  const shown = gust ? wind.replace(/(\d{2})$/, `$1G${gust[1]}`) : wind;
  return `${shown} kt`;
}

function sampleWind(from: number | null, knots: number | null): string {
  if (from == null || knots == null) return '—';
  return `${String(Math.round(from)).padStart(3, '0')}/${String(Math.round(knots)).padStart(2, '0')}`;
}

function utcStamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${day} ${hour}${minute}Z`;
}

function ended(snapshot: Snapshot | null, airport: AirportSnapshot): boolean {
  if (!snapshot?.now || !airport.taf?.to) return false;
  return Date.parse(snapshot.now) > Date.parse(airport.taf.to);
}

function headerEnd(header: string, isEnded: boolean): string {
  const parts = header.split(' → ');
  if (parts.length < 2) return esc(header);
  const end = esc(parts.slice(1).join(' → '));
  return `${esc(parts[0])} → <span class="${isEnded ? 'ended-time' : ''}"${isEnded ? ' title="Snapshot time is after this TAF"' : ''}>${end}</span>`;
}

function airport(snapshot: Snapshot | null, icao: string): AirportSnapshot | null {
  return snapshot?.airports.find((item) => item.icao === icao) ?? null;
}

function modelRow(snapshot: Snapshot | null, icao: string): string {
  const sample = airport(snapshot, icao)?.sample;
  if (!sample) return '';
  const cape = sample.mucapeJkg == null ? '—' : String(Math.round(sample.mucapeJkg));
  const cloud = sample.cloudCoverPct == null ? '—' : `${Math.round(sample.cloudCoverPct)}%`;
  const temp = sample.t2mC == null ? '—' : `${sample.t2mC.toFixed(0)}°`;
  const mslp = sample.mslpHpa == null ? '—' : sample.mslpHpa.toFixed(1);
  const wind = sampleWind(sample.windFromDeg, sample.windKt);
  return `<div class="row model" title="ECMWF 10 m wind, 2 m temperature, cloud cover, MUCAPE J/kg. ${icao}.">
    ${icon.grid}<span>${icao}</span><span class="v">${mslp}</span><span class="v">${wind === '—' ? wind : `${wind} kt`}</span><span class="v">${temp}</span><span class="v">${cloud}</span><span class="v" title="MUCAPE J/kg">${cape}</span>
  </div>`;
}

function cloudCell(shown: ConvectiveCloud, fallback: string): string {
  if (!shown.lead && !shown.hazard) return `<span>${esc(fallback)}</span>`;
  const tone = shown.hazard === 'TCU' ? ' tcu' : '';
  const word = hazardWord(shown.hazard);
  const lead = shown.lead || shown.hazard;
  const tag = word ? `<span class="tag">${esc(word)}</span>` : '';
  const rest = shown.rest ? `<span class="rest">${esc(shown.rest)}</span>` : '';
  return `<span class="cloud">${tag}<span class="keep${tone}">${esc(lead)}</span>${rest}</span>`;
}

function metarRow(item: AirportSnapshot): string {
  if (!item.metar) return '';
  const metar = item.metar;
  const from = Number(metar.wind.slice(0, 3));
  const knots = Number(metar.wind.slice(4, 6));
  const shown = convectiveCloud(metar.raw, metar.cloud, metar.hazard);
  const label = shown.lead || cloudLabel(metar.cloud, metar.raw);
  const mark = shown.hazard ? hazardGlyph(shown.hazard) : cloudIcon(label);
  const age = `<span class="age${metar.aged ? ' aged' : ''}">${esc(metar.clock)} · ${esc(metar.age)}</span>${metar.aged ? icon.warn : ''}`;
  const tip = metar.hazardTip && !metar.tip.includes(metar.hazardTip) ? `${metar.hazardTip} ${metar.tip}` : metar.tip;
  return `<div class="row metar" title="${esc(tip)}">
    <span></span><span>${item.icao}</span>${mark}${cloudCell(shown, label)}${icon.vis}<span class="v">${esc(metar.vis)}</span>${barb(from, knots)}<span class="v">${esc(windText(metar.wind, metar.raw))}</span><span class="v">${age}</span>
  </div>`;
}

function marked(phase: 'ask' | 'revealed', card: Card | null, icao: string, line: string, index: number): boolean {
  if (!card?.focus || phase !== 'revealed') return false;
  const needles = card.focus.marks?.filter((mark) => mark.icao === icao).map((mark) => mark.needle);
  if (needles?.length) return lineMarked('revealed', needles, line);
  if (card.focus.icao !== icao) return false;
  if (card.focus.needle) return line.includes(card.focus.needle);
  if (card.focus.opening) return index === 0;
  return false;
}

function liveTaf(snapshot: Snapshot | null, item: AirportSnapshot): string {
  if (!item.taf) return '';
  const isEnded = ended(snapshot, item);
  const lines = item.taf.lines.length
    ? item.taf.lines.map((line) => line.active && !isEnded ? `<mark>${esc(line.text)}</mark>` : esc(line.text)).join('\n')
    : esc(item.taf.raw);
  const head = headerEnd(item.taf.header.replace(/^TAF\s*/, ''), isEnded);
  return `<div class="taf-block">
    <div class="row tafhead" title="${esc(item.taf.headerUtc)}">${icon.book}<span>${item.icao}</span><span>TAF ${head}</span></div>
    <pre class="taf-raw${isEnded ? ' ended' : ''}">${lines}</pre>
  </div>`;
}

function answerTaf(snapshot: Snapshot | null, item: AirportSnapshot, card: Card, phase: 'ask' | 'revealed'): string {
  if (!item.taf) return '';
  const isEnded = ended(snapshot, item);
  const lines = item.taf.lines.length
    ? item.taf.lines.map((line, index) => marked(phase, card, item.icao, line.text, index) ? `<mark>${esc(line.text)}</mark>` : esc(line.text)).join('\n')
    : esc(item.taf.raw);
  return `<div class="taf-block">
    <div class="row tafhead" title="${esc(item.taf.headerUtc)}">${icon.book}<span>${item.icao}</span><span>TAF ${headerEnd(item.taf.header.replace(/^TAF\s*/, ''), isEnded)}</span></div>
    <pre class="taf-raw${isEnded ? ' ended' : ''}">${lines}</pre>
  </div>`;
}

function notices(snapshot: Snapshot | null): string {
  const sig = snapshot?.sigmets;
  const notam = snapshot?.notamCount;
  const sigText = sig == null ? '—' : String(sig.length);
  const notamText = notam == null ? '—' : String(notam);
  const hazards = sig?.map((item) => [item.qualifier, item.hazard, item.fir].filter(Boolean).join(' ')).join(' · ') || 'SIGMET feed unavailable';
  const notamTip = notam == null ? 'NOTAM feed unavailable' : 'NOTAM';
  return `<div class="row notice" title="${esc(hazards)}" aria-label="SIGMET">${icon.bolt}<span class="num">${sigText}</span><span class="datum">SIGMET</span></div>
    <div class="row notice" title="${esc(notamTip)}" aria-label="NOTAM">${icon.flag}<span class="num">${notamText}</span><span class="datum">NOTAM</span></div>`;
}

function chartFrame(snapshot: Snapshot | null, pin: string): string {
  const chart = snapshot?.chartPng
    ? `<img alt="MSLP" src="data:image/png;base64,${snapshot.chartPng}">${pin}<span class="credit">ECMWF · CC BY 4.0</span>`
    : '<p class="missing">Chart unavailable</p>';
  return `<div class="frame chart-frame">${chart}</div>`;
}

function stale(snapshot: Snapshot | null): boolean {
  return !!(snapshot?.sampleTime && snapshot.now
    && Math.abs(Date.parse(snapshot.now) - Date.parse(snapshot.sampleTime)) > 3 * 3600 * 1000);
}

export function livePanel(snapshot: Snapshot | null): string {
  const timeTip = snapshot?.runError || (stale(snapshot) ? 'Model time is more than 3 h from this snapshot' : 'Model valid time');
  const time = `<div class="row time" title="${esc(timeTip)}">${stale(snapshot) ? icon.warn : icon.grid}<span>MSLP</span><span class="${stale(snapshot) ? 'aged' : ''}">${utcStamp(snapshot?.sampleTime ?? null)}</span></div>`;
  const blocks = ['YPPH', 'YSSY'].map((icao) => {
    const item = airport(snapshot, icao);
    if (!item) return modelRow(snapshot, icao);
    return `${modelRow(snapshot, icao)}${metarRow(item)}${liveTaf(snapshot, item)}`;
  }).join('');
  return `<div class="live-grid">
    <div class="readout">${time}${blocks}${notices(snapshot)}</div>
    <figure class="figure">${chartFrame(snapshot, '')}<figcaption class="caption">MSLP</figcaption></figure>
  </div>`;
}

function pinHtml(card: Card): string {
  const focus = card.focus;
  if (focus?.mapX == null || focus.mapY == null) return '';
  const tip = focus.artefact
    ? 'Land-mix spike. Mean-sea-level reduction over high terrain.'
    : 'Screened geostrophic maximum';
  const title = focus.place ? `${focus.place}. ${tip}` : tip;
  return `<span class="pin${focus.artefact ? ' artefact' : ''}" style="left:${focus.mapX * 100}%;top:${focus.mapY * 100}%" title="${esc(title)}"></span>`;
}

function causeRow(card: Card): string {
  const cause = card.focus?.cause;
  if (!cause) return '';
  return `<div class="row cause" title="${esc(cause.title)}">${icon.vis}<span>${esc(cause.label)}</span><span class="v">${esc(cause.value)}</span><span class="datum">${esc(cause.datum)}</span></div>`;
}

function placeCaption(card: Card): string {
  const focus = card.focus;
  if (!focus?.place) return '<figcaption class="caption">MSLP</figcaption>';
  const knots = focus.knots == null ? '' : ` · ${focus.knots} kt`;
  return `<figcaption class="caption">${esc(focus.place)}${knots}</figcaption>`;
}

function exhibit(card: Card, phase: 'ask' | 'revealed'): string {
  const figure = card.figure;
  if (!figure?.lines.length) return '';
  const body = figure.lines.map((line) => {
    const metar = /\b(METAR|SPECI)\b/.test(line);
    const shown = metar ? convectiveCloud(line, line) : null;
    const lead = shown?.lead
      ? `<div class="row metar exhibit-metar" title="${esc(line)}">${hazardGlyph(shown.hazard)}${cloudCell(shown, shown.lead)}</div>`
      : '';
    const marked = phase === 'revealed' && figure.highlight.some((needle) => needle.length > 0 && line.includes(needle));
    const text = marked ? `<mark>${esc(line)}</mark>` : esc(line);
    return `${lead}<pre class="taf-raw">${text}</pre>`;
  }).join('');
  return `<figure class="figure"><div class="frame taf-frame"><div class="row tafhead"><span></span><span>${esc(figure.title)}</span></div>${body}</div></figure>`;
}

export function cardFigure(card: Card | null, snapshot: Snapshot | null, phase: 'ask' | 'revealed'): string {
  if (!card) return '';
  if (figureKind(card) === 'none') return exhibit(card, phase);
  if (figureKind(card) === 'chart') {
    const pin = phase === 'revealed' ? pinHtml(card) : '';
    const caption = phase === 'revealed' ? placeCaption(card) : '<figcaption class="caption">MSLP</figcaption>';
    return `<figure class="figure">${chartFrame(snapshot, pin)}${caption}</figure>`;
  }
  const icaos = [...new Set([
    ...(card.focus?.icao ? [card.focus.icao] : []),
    ...(card.focus?.marks?.map((mark) => mark.icao) ?? []),
  ])];
  const plates = icaos.map((icao) => {
    const item = airport(snapshot, icao);
    if (!item?.taf) return `<p class="missing">No TAF for ${esc(icao)}</p>`;
    return answerTaf(snapshot, item, card, phase);
  }).join('');
  const caption = phase === 'revealed' ? causeRow(card) : '';
  return `<figure class="figure"><div class="frame taf-frame">${plates || '<p class="missing">No TAF</p>'}</div>${caption}</figure>`;
}
