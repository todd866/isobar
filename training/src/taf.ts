/** TAF groups used for the alternate decision.
 * Times are UTC. A group that cannot be bounded is a failed parse, not a guess.
 */

export interface Minima {
  ceilingFt: number;
  visM: number;
}

export interface TafProduct {
  raw: string;
  issue?: string | null;
  from?: string | null;
  to?: string | null;
}

interface Cond {
  visM: number | null;
  visAtLeast: boolean;
  ceilingFt: number | null;
  /** A thunderstorm at the aerodrome (TS, TSRA, +TSGR…). VCTS is not. */
  ts: boolean;
  known: boolean;
}

export interface Group {
  kind: 'base' | 'FM' | 'BECMG' | 'TEMPO' | 'INTER' | 'PROB30' | 'PROB40';
  prob: 30 | 40 | null;
  change: 'TEMPO' | 'INTER' | null;
  start: number;
  end: number;
  cond: Cond;
  /** Change indicator, empty on the base group. */
  marker: string;
  /** Conditions after the change indicator. */
  body: string;
}

/** Why the decision came out as it did. Part 91 MOS 2020 s 8.02 (relevant
 * weather conditions), 8.04 (destination alternate: ETA ±30 min, holding in
 * lieu: 30 min INTER, 60 min TEMPO, otherwise until the conditions end) and
 * 7.02 (6) (the forecast must be valid from 30 min before to 60 min after ETA). */
export type AlternateReason =
  | 'clear'
  | 'prevailing'
  | 'tempo'
  | 'inter'
  | 'prob'
  | 'uncovered'
  | 'unparsed';

export interface AlternateResult {
  required: boolean;
  reason: AlternateReason;
  eta: string;
  /** Holding fuel, in minutes, that removes the requirement: 30 for INTER, 60
   * for TEMPO, the time from ETA to 30 min after the conditions end otherwise.
   * Zero when nothing is required. Null when only an alternate satisfies the
   * rule (no forecast coverage, or conditions that last to the end of the TAF). */
  holdMinutes: number | null;
  /** Change indicator that drove the decision, e.g. "INTER 0720/0800". Empty for the prevailing group. */
  group: string;
  /** The driving conditions are relevant only because of a thunderstorm; cloud and visibility are at or above the minima. */
  thunderstorm: boolean;
  /** Planned on a TAF3 with the ETA in its first 3 hours and inside any service end (s 8.02 (2), 8.04 (2)):
   * PROBs are disregarded and the window is the ETA itself, not ETA ±30 min. */
  taf3: boolean;
}

const MARKER = /\b(FM\d{6}|(?:PROB(?:30|40)(?:\s+(?:TEMPO|INTER))?|BECMG|TEMPO|INTER)\s+\d{4}\/\d{4})\b/g;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function monthAnchor(ms: number, day: number, hour: number, minute: number): number | null {
  if (day < 1 || day > 31 || hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) return null;
  const anchor = new Date(ms);
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  let best: number | null = null;
  let bestDist = Infinity;
  for (let offset = -1; offset <= 1; offset += 1) {
    const month = new Date(Date.UTC(y, m + offset, 1));
    const days = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    if (day > days) continue;
    const stamp = Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day, hour === 24 ? 0 : hour, minute);
    const adjusted = hour === 24 ? stamp + 24 * 3600 * 1000 : stamp;
    const dist = Math.abs(adjusted - ms);
    if (dist < bestDist) {
      best = adjusted;
      bestDist = dist;
    }
  }
  return best;
}

function parseStamp(stamp: string, anchorMs: number): number | null {
  if (!/^\d{4}(\d{2})?$/.test(stamp)) return null;
  const day = Number(stamp.slice(0, 2));
  const hour = Number(stamp.slice(2, 4));
  const minute = stamp.length === 6 ? Number(stamp.slice(4, 6)) : 0;
  return monthAnchor(anchorMs, day, hour, minute);
}

function parseCond(text: string): Cond | null {
  const tokens = text.split(/\s+/).filter(Boolean);
  let visM: number | null = null;
  let visAtLeast = false;
  let ceilingFt: number | null = null;
  let cavok = false;
  let cloud = false;
  let ts = false;
  for (const token of tokens) {
    if (token === 'CAVOK') {
      cavok = true;
      cloud = true;
      visM = 9999;
      visAtLeast = true;
      ceilingFt = null;
      continue;
    }
    if (token === 'NSC' || token === 'NCD' || token === 'SKC' || token === 'CLR') {
      cloud = true;
      continue;
    }
    if (visM == null && /^\d{4}$/.test(token)) {
      visM = Number(token);
      visAtLeast = visM >= 9999;
      continue;
    }
    if (/^[+-]?TS[A-Z]*$/.test(token)) {
      ts = true;
      continue;
    }
    const cloudMatch = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU)?$/.exec(token);
    if (cloudMatch) {
      cloud = true;
      if (cavok) continue;
      const amount = cloudMatch[1];
      const base = cloudMatch[2];
      if (amount === 'BKN' || amount === 'OVC' || amount === 'VV') {
        if (base === '///') return null;
        const feet = Number(base) * 100;
        ceilingFt = ceilingFt == null ? feet : Math.min(ceilingFt, feet);
      }
    }
  }
  // Cloud is omitted when fog is forecast (BoM TAF guide, change groups).
  const fog = tokens.some((token) => /^[+-]?(FZ|MI|BC|PR)?FG$/.test(token));
  if (visM == null || (!cloud && !fog)) return null;
  return { visM, visAtLeast, ceilingFt: cavok ? null : ceilingFt, ts, known: true };
}

/** Relevant weather conditions, Part 91 MOS s 8.02 (1): more than SCT below the
 * alternate minimum, visibility below it, or a thunderstorm at the aerodrome. */
function below(cond: Cond, minima: Minima): boolean {
  if (cond.ts) return true;
  return belowMinima(cond, minima);
}

/** Cloud or visibility below the alternate minima, ignoring thunderstorms. */
function belowMinima(cond: Cond, minima: Minima): boolean {
  const visOk = visValue(cond) >= minima.visM;
  const ceilOk = cond.ceilingFt == null || cond.ceilingFt >= minima.ceilingFt;
  return !(visOk && ceilOk);
}

function carry(prev: Cond, next: Cond): Cond {
  return {
    visM: next.visM ?? prev.visM,
    visAtLeast: next.visM == null ? prev.visAtLeast : next.visAtLeast,
    ceilingFt: next.ceilingFt,
    ts: next.ts,
    known: true,
  };
}

/** The last bulletin wins. An AMD or a later TAF replaces everything before it. */
function latestBulletin(raw: string): string {
  const text = raw.replace(/=/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = text.split(/ (?=TAF\b)/).filter(Boolean);
  return parts[parts.length - 1] ?? text;
}

/** The remarks of the latest bulletin start at RMK; they are not forecast groups. */
function splitRemarks(raw: string): { forecast: string; remarks: string } {
  const at = /\bRMK\b/.exec(raw);
  return at ? { forecast: raw.slice(0, at.index).trim(), remarks: raw.slice(at.index) } : { forecast: raw, remarks: '' };
}

/** TAF3 service from the remarks: present, and its end (VALID TL ddhhmm) if limited. Null when not a TAF3. */
function taf3Service(taf: TafProduct): { end: number | null } | null {
  if (!taf.raw) return null;
  const { remarks } = splitRemarks(latestBulletin(taf.raw));
  if (!/\bTAF3\b/.test(remarks)) return null;
  const till = /\bTAF3\s+VALID\s+TL\s+(\d{6})\b/.exec(remarks);
  if (!till) return { end: null };
  const anchor = Date.parse(taf.issue ?? taf.from ?? '');
  if (!Number.isFinite(anchor)) return null;
  const end = parseStamp(till[1], anchor);
  return end == null ? null : { end };
}

function parseGroups(taf: TafProduct): Group[] | null {
  if (!taf.raw || !taf.from || !taf.to) return null;
  const from = Date.parse(taf.from);
  const to = Date.parse(taf.to);
  const anchor = taf.issue ? Date.parse(taf.issue) : from;
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(anchor) || to <= from) return null;
  const raw = splitRemarks(latestBulletin(taf.raw)).forecast;
  if (/\b(CNL|NIL)\b/.test(raw)) return null;
  const valid = /\b\d{4}\/\d{4}\b/.exec(raw);
  if (!valid) return null;
  const body = raw.slice(valid.index + valid[0].length);
  const markers = [...body.matchAll(MARKER)];
  const groups: Group[] = [];
  for (let i = 0; i <= markers.length; i += 1) {
    const begin = i === 0 ? 0 : markers[i - 1].index + markers[i - 1][0].length;
    const end = i < markers.length ? markers[i].index : body.length;
    const text = body.slice(begin, end).trim();
    if (/\b(FM\w*|BECMG|TEMPO|INTER|PROB\w*|NOSIG|BECOME)\b/.test(text)) return null;
    const cond = parseCond(text);
    if (!cond && i === 0) return null;
    let kind: Group['kind'] = 'base';
    let prob: 30 | 40 | null = null;
    let change: 'TEMPO' | 'INTER' | null = null;
    let start = from;
    let finish = to;
    let marker = '';
    if (i > 0) {
      marker = markers[i - 1][0];
      if (marker.startsWith('FM')) {
        kind = 'FM';
        const stamp = marker.slice(2);
        const parsed = parseStamp(stamp, anchor);
        if (parsed == null) return null;
        start = parsed;
        finish = to;
      } else {
        const bits = marker.split(/\s+/);
        const span = bits[bits.length - 1].split('/');
        const head = bits.slice(0, -1).join(' ');
        if (head.startsWith('PROB30')) prob = 30;
        else if (head.startsWith('PROB40')) prob = 40;
        if (head.includes('TEMPO') || head === 'TEMPO') change = 'TEMPO';
        if (head.includes('INTER') || head === 'INTER') change = 'INTER';
        if (head === 'BECMG') kind = 'BECMG';
        else if (prob === 30) kind = 'PROB30';
        else if (prob === 40) kind = 'PROB40';
        else if (change === 'TEMPO') kind = 'TEMPO';
        else if (change === 'INTER') kind = 'INTER';
        else return null;
        const a = parseStamp(span[0], anchor);
        const b = parseStamp(span[1], anchor);
        if (a == null || b == null || b <= a) return null;
        start = a;
        finish = b;
      }
    }
    if (start < from || start >= to || finish > to || finish <= start) return null;
    if (!cond) return null;
    groups.push({ kind, prob, change, start, end: finish, cond, marker, body: text });
  }
  return groups;
}

function prevailingAt(groups: Group[], t: number): Cond | null {
  let current: Cond | null = null;
  let becmg: Group | null = null;
  const prevailing = groups
    .filter((g) => g.kind === 'base' || g.kind === 'FM' || g.kind === 'BECMG')
    .sort((a, b) => a.start - b.start);
  for (const group of prevailing) {
    if (group.kind === 'base' || group.kind === 'FM') {
      if (t >= group.start) {
        current = group.kind === 'base' ? group.cond : carry(current ?? group.cond, group.cond);
        becmg = null;
      }
    } else if (t >= group.end) {
      current = carry(current ?? group.cond, group.cond);
      becmg = null;
    } else if (t >= group.start && t < group.end) {
      becmg = group;
    }
  }
  if (!current?.known || current.visM == null) return null;
  if (becmg) {
    // Part 91 MOS s 8.04 (8): a deterioration in any element applies the whole BECMG
    // group from the start of its period; otherwise it applies from the end.
    const next = carry(current, becmg.cond.known ? becmg.cond : current);
    if (next.visM == null) return null;
    return deteriorates(current, next) ? next : current;
  }
  return current;
}

function visValue(cond: Cond): number {
  return cond.visAtLeast ? Math.max(cond.visM ?? 0, 10000) : (cond.visM ?? 0);
}

/** True when any element of next is worse than prev: lower visibility, a lower ceiling, or a new thunderstorm. */
function deteriorates(prev: Cond, next: Cond): boolean {
  if (visValue(next) < visValue(prev)) return true;
  if (next.ceilingFt != null && (prev.ceilingFt == null || next.ceilingFt < prev.ceilingFt)) return true;
  return next.ts && !prev.ts;
}

function overlays(groups: Group[], t: number): Group[] {
  return groups.filter((g) => g.kind !== 'base' && g.kind !== 'FM' && g.kind !== 'BECMG' && t >= g.start && t < g.end);
}

const MINUTE = 60 * 1000;

/** The destination alternate decision for one ETA.
 * Part 91 MOS 2020: the TAF must be valid from 30 min before to 60 min after
 * ETA (s 7.02 (6)); otherwise an alternate is required (s 8.04 (3)). Relevant
 * weather conditions (s 8.02) in the ETA ±30 min window require an alternate
 * (s 8.04 (1)) unless fuel is carried to hold until 30 min after they end
 * (s 8.04 (5)), or 30 min for INTER / 60 min for TEMPO (s 8.04 (6)), the most
 * limiting indicator winning (s 8.04 (7)). A PROB30 or PROB40 counts
 * (s 8.02 (1) (b) (ii) and (d)); a PROB without INTER or TEMPO is not an
 * INTER or TEMPO holding case, so it is held to its end. On a TAF3 with the ETA
 * in its first 3 hours and inside any service end, probabilities are
 * disregarded (s 8.02 (2)) and the window is the ETA itself (s 8.04 (2)).
 * Every relevant case is combined: the holding fuel that removes the
 * requirement is the largest any case needs, and a case that only an
 * alternate satisfies makes the alternate mandatory.
 * holdingMinutes is the holding fuel already on the plan. Null if the TAF cannot be read. */
export function alternateDecision(
  taf: TafProduct,
  etaIso: string,
  minima: Minima,
  holdingMinutes: number,
): AlternateResult | null {
  const groups = parseGroups(taf);
  if (!groups || !taf.from || !taf.to) return null;
  const eta = Date.parse(etaIso);
  const from = Date.parse(taf.from);
  const to = Date.parse(taf.to);
  if (!Number.isFinite(eta)) return null;
  for (let t = eta - 30 * MINUTE; t <= eta + 60 * MINUTE; t += 5 * MINUTE) {
    if (t < from || t > to) {
      return { required: true, reason: 'uncovered', eta: etaIso, holdMinutes: null, group: '', thunderstorm: false, taf3: false };
    }
  }
  const service = taf3Service(taf);
  const taf3 = service != null && eta - from <= 180 * MINUTE && (service.end == null || eta <= service.end);
  const buffer = taf3 ? 0 : 30 * MINUTE;
  let prevailingBad = false;
  let prevailingTs = true;
  let tempo: { group: Group; ts: boolean } | null = null;
  let inter: { group: Group; ts: boolean } | null = null;
  let prob: { group: Group; ts: boolean } | null = null;
  for (let t = eta - buffer; t <= eta + buffer; t += 5 * MINUTE) {
    const base = prevailingAt(groups, t);
    if (!base) return null;
    if (below(base, minima)) {
      prevailingBad = true;
      if (belowMinima(base, minima)) prevailingTs = false;
    }
    for (const extra of overlays(groups, t)) {
      if (taf3 && extra.prob != null) continue;
      const cond = extra.cond.known && extra.cond.visM != null ? carry(base, extra.cond) : null;
      if (!cond || !below(cond, minima)) continue;
      const hit = { group: extra, ts: !belowMinima(cond, minima) };
      if (extra.change === 'TEMPO') tempo = tempo ?? hit;
      else if (extra.change === 'INTER') inter = inter ?? hit;
      else prob = prob ?? hit;
    }
  }
  const cases: { reason: AlternateReason; hold: number | null; group: string; ts: boolean }[] = [];
  if (prevailingBad) {
    // The end of the last relevant spell that touches the window, followed past
    // the window while it continues. Reaching the end of the TAF means the
    // conditions are not forecast to end.
    let end = eta - buffer;
    for (let t = eta - buffer; t < to; t += 5 * MINUTE) {
      const cond = prevailingAt(groups, t);
      if (cond && below(cond, minima)) end = t + 5 * MINUTE;
      else if (t > eta + buffer) break;
    }
    const hold = end >= to ? null : Math.round((end + buffer - eta) / MINUTE);
    cases.push({ reason: 'prevailing', hold, group: '', ts: prevailingTs });
  }
  if (prob) {
    const hold = Math.max(0, Math.round((prob.group.end + buffer - eta) / MINUTE));
    cases.push({ reason: 'prob', hold, group: prob.group.marker, ts: prob.ts });
  }
  if (tempo) cases.push({ reason: 'tempo', hold: 60, group: tempo.group.marker, ts: tempo.ts });
  if (inter) cases.push({ reason: 'inter', hold: 30, group: inter.group.marker, ts: inter.ts });
  if (!cases.length) {
    return { required: false, reason: 'clear', eta: etaIso, holdMinutes: 0, group: '', thunderstorm: false, taf3 };
  }
  // The most limiting case: one that holding cannot cover, else the longest hold. Ties keep the order above.
  let worst = cases[0];
  for (const item of cases.slice(1)) {
    if (worst.hold == null) break;
    if (item.hold == null || item.hold > worst.hold) worst = item;
  }
  const required = worst.hold == null || holdingMinutes < worst.hold;
  return { required, reason: worst.reason, eta: etaIso, holdMinutes: worst.hold, group: worst.group, thunderstorm: worst.ts, taf3 };
}

/** All groups of the latest bulletin, in document order. Null when the TAF cannot be read. */
export function tafGroups(taf: TafProduct): Group[] | null {
  return parseGroups(taf);
}

/** An ETA worth asking about: the middle of the first TEMPO, INTER or PROB
 * period still ahead that takes the aerodrome below the minima (when given),
 * else the first such period, else now when the TAF covers it. Null otherwise. */
export function chooseEta(taf: TafProduct, nowIso: string, minima?: Minima): string | null {
  const groups = parseGroups(taf);
  if (!groups || !taf.from || !taf.to) return null;
  const from = Date.parse(taf.from);
  const to = Date.parse(taf.to);
  const now = Date.parse(nowIso);
  const floor = Number.isFinite(now) ? now : from;
  const ahead = groups
    .filter((g) => g.kind !== 'base' && g.kind !== 'FM' && g.kind !== 'BECMG' && g.end > floor)
    .sort((a, b) => a.start - b.start);
  const relevant = minima ? ahead.find((g) => {
    const base = prevailingAt(groups, Math.max(g.start, floor));
    return base && g.cond.known && g.cond.visM != null && below(carry(base, g.cond), minima);
  }) : null;
  const window = relevant ?? ahead[0] ?? null;
  if (window) {
    const start = Math.max(window.start, from, floor);
    const end = Math.min(window.end, to);
    if (end > start) return new Date(start + (end - start) / 2).toISOString();
  }
  if (Number.isFinite(now) && now >= from && now <= to) return new Date(now).toISOString();
  return null;
}

/** "02:30 Perth time" style local clock for a UTC instant. */
export function localClock(iso: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('hour')}:${pick('minute')}`;
}

export function etaClockUtc(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`;
}

export interface TafForce {
  kind: Group['kind'];
  role: 'prevailing' | 'transition' | 'additional';
  needle: string;
  visM: number | null;
  visAtLeast: boolean;
  start: number;
  end: number;
  body: string;
  change: 'TEMPO' | 'INTER' | null;
}

export interface TafCause {
  label: string;
  value: string;
  datum: string;
  title: string;
}

export interface VisibilityAt {
  /** ICAO with the lower in-force visibility, or `equal`. */
  winner: string;
  cause: TafCause;
  marks: { icao: string; needle: string }[];
}

function publish(group: Group, role: TafForce['role']): TafForce {
  return {
    kind: group.kind,
    role,
    needle: group.marker || group.body,
    visM: group.cond.visM,
    visAtLeast: group.cond.visAtLeast,
    start: group.start,
    end: group.end,
    body: group.body,
    change: group.change,
  };
}

/** Groups in force at one instant. Null when the TAF cannot be read. */
export function groupsInForce(taf: TafProduct, atIso: string): TafForce[] | null {
  const groups = parseGroups(taf);
  if (!groups || !taf.from || !taf.to) return null;
  const t = Date.parse(atIso);
  const from = Date.parse(taf.from);
  const to = Date.parse(taf.to);
  if (!Number.isFinite(t) || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (t < from || t >= to) return [];
  let prevailing: Group | null = null;
  let taken = -Infinity;
  for (const group of groups) {
    if (group.kind !== 'base' && group.kind !== 'FM' && group.kind !== 'BECMG') continue;
    const effect = group.kind === 'BECMG' ? group.end : group.start;
    if (t >= effect && effect >= taken) {
      prevailing = group;
      taken = effect;
    }
  }
  const found: TafForce[] = [];
  if (prevailing) found.push(publish(prevailing, 'prevailing'));
  for (const group of groups) {
    if (group.kind !== 'BECMG' || t < group.start || t >= group.end) continue;
    if (taken <= group.start) found.push(publish(group, 'transition'));
  }
  for (const group of groups) {
    if (group.kind !== 'TEMPO' && group.kind !== 'INTER' && group.kind !== 'PROB30' && group.kind !== 'PROB40') continue;
    if (t >= group.start && t < group.end) found.push(publish(group, 'additional'));
  }
  return found;
}

function visRank(group: TafForce): number | null {
  if (group.visM == null) return null;
  return group.visAtLeast ? Math.max(group.visM, 10000) : group.visM;
}

function roleOrder(role: TafForce['role']): number {
  if (role === 'additional') return 0;
  if (role === 'transition') return 1;
  return 2;
}

function limiting(groups: TafForce[]): { group: TafForce; rank: number } | null {
  let best: { group: TafForce; rank: number } | null = null;
  for (const group of groups) {
    const rank = visRank(group);
    if (rank == null) continue;
    if (!best || rank < best.rank || (rank === best.rank && roleOrder(group.role) < roleOrder(best.group.role))) {
      best = { group, rank };
    }
  }
  return best;
}

const WIND = /^(?:VRB|\d{3})\d{2}(?:G\d{2})?KT$/;

function conditionParts(body: string): { value: string; rest: string } {
  const tokens = body.split(/\s+/).filter((token) => token && !WIND.test(token));
  const value = tokens.includes('CAVOK') ? 'CAVOK' : (tokens.find((token) => /^\d{4}$/.test(token)) ?? '');
  const rest = tokens.filter((token) => token !== value && token !== 'CAVOK' && !/^\d{4}$/.test(token)).join(' ');
  return { value, rest };
}

function hourLabel(ms: number): string {
  const date = new Date(ms);
  const minute = date.getUTCMinutes();
  if (minute === 0) return String(date.getUTCHours());
  return `${pad(date.getUTCHours())}:${pad(minute)}`;
}

function spanLabel(group: TafForce): string {
  const start = new Date(group.start);
  const end = new Date(group.end);
  const onHour = start.getUTCMinutes() === 0 && end.getUTCMinutes() === 0;
  const sameDay = start.getUTCDate() === end.getUTCDate() && start.getUTCMonth() === end.getUTCMonth();
  if (onHour && sameDay) return `${start.getUTCHours()}–${end.getUTCHours()}Z`;
  if (onHour) return `${start.getUTCHours()}Z–${end.getUTCHours()}Z`;
  return `${hourLabel(group.start)}–${hourLabel(group.end)}Z`;
}

function kindLabel(group: TafForce): string {
  if ((group.kind === 'PROB30' || group.kind === 'PROB40') && group.change) return `${group.kind} ${group.change}`;
  return group.kind;
}

function groupLabel(group: TafForce): string {
  if (group.kind === 'FM') return `FM ${hourLabel(group.start)}Z`;
  if (group.kind === 'base') return `${hourLabel(group.start)}Z`;
  return `${kindLabel(group)} ${spanLabel(group)}`;
}

function causeFrom(group: TafForce, icao: string): TafCause {
  const { value, rest } = conditionParts(group.body);
  const label = group.kind === 'base' ? (value || groupLabel(group)) : groupLabel(group);
  const shown = group.kind === 'base' ? '' : value;
  const datum = `${rest ? `${rest} ` : ''}→ ${icao}`;
  const title = group.needle === group.body ? group.body : `${group.needle} ${group.body}`.trim();
  return { label, value: shown, datum, title };
}

function equalCause(left: TafForce, right: TafForce): TafCause {
  const a = conditionParts(left.body).value;
  const b = conditionParts(right.body).value;
  const sameCeiling = (visRank(left) ?? 0) >= 10000 && (visRank(right) ?? 0) >= 10000;
  const label = a === b ? a : (sameCeiling ? '≥10 km' : a);
  return { label: label || '—', value: '', datum: '→ equal', title: 'In-force visibility is the same' };
}

/** Lower visibility among groups in force, including TEMPO, INTER, PROB and a BECMG in transition. */
export function lowerVisibility(
  left: { icao: string; taf: TafProduct },
  right: { icao: string; taf: TafProduct },
  atIso: string,
): VisibilityAt | null {
  const a = groupsInForce(left.taf, atIso);
  const b = groupsInForce(right.taf, atIso);
  if (!a || !b) return null;
  const lowLeft = limiting(a);
  const lowRight = limiting(b);
  if (!lowLeft || !lowRight) return null;
  const marks = [
    ...a.map((group) => ({ icao: left.icao, needle: group.needle })),
    ...b.map((group) => ({ icao: right.icao, needle: group.needle })),
  ];
  if (lowLeft.rank === lowRight.rank) {
    return { winner: 'equal', cause: equalCause(lowLeft.group, lowRight.group), marks };
  }
  const side = lowLeft.rank < lowRight.rank ? left : right;
  const group = lowLeft.rank < lowRight.rank ? lowLeft.group : lowRight.group;
  return { winner: side.icao, cause: causeFrom(group, side.icao), marks };
}

/** A TAF line is marked only after the answer, and only when it is one of the in-force groups. */
export function lineMarked(phase: 'ask' | 'revealed', needles: readonly string[] | undefined, line: string): boolean {
  if (phase !== 'revealed' || !needles?.length) return false;
  return needles.some((needle) => needle.length > 0 && line.includes(needle));
}
