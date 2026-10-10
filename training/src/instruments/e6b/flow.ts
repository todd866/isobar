/** The E6-B teaching flow (docs/design/e6b-teaching-flow.md): one problem card,
 * three beats (estimate in your head, do it on the E6-B, check one against the
 * other), one obvious next action, help that fades per skill.
 *
 * Pure: the words, the order and the fading rules, from the problem's own
 * numbers, so the tests can read every line. */
import { E6B_PROCEDURES, type ProcedureExercise, type ProcedureStep } from './procedures.ts';
import { gradeEstimate } from './feedback.ts';

export type Beat = 'estimate' | 'instrument' | 'check';

/** Numbers as a pilot says them: whole where whole, one or two decimals otherwise. */
export const num = (v: number): string => {
  const a = Math.abs(v);
  const r = a >= 100 ? Math.round(v) : a >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
  return r.toLocaleString('en-AU');
};

/** The ten problems of a first session: one of each skill, the easiest first. */
export const FLOW_ORDER = ['time-1', 'fuel-1', 'windhdg-1', 'speed-1', 'distance-1', 'tas-1', 'convert-1', 'climb-1', 'offcourse-1', 'windfind-1',
  'time-2', 'fuel-2', 'windhdg-2', 'speed-2', 'distance-2', 'tas-2', 'convert-2', 'climb-2', 'offcourse-2', 'windfind-2', 'endurance-1', 'density-1', 'truealt-1', 'mach-1', 'sg-1',
  'time-3', 'fuel-3', 'windhdg-3', 'speed-3', 'distance-3', 'tas-3', 'convert-3', 'climb-3', 'offcourse-3', 'windfind-3', 'endurance-2', 'density-2', 'truealt-2', 'mach-2', 'sg-2', 'jet-1'];
export const SET_SIZE = 10;

export function flowProblem(index: number): ProcedureExercise {
  const id = FLOW_ORDER[((index % FLOW_ORDER.length) + FLOW_ORDER.length) % FLOW_ORDER.length];
  return E6B_PROCEDURES.find((p) => p.id === id)!;
}

/** The question in pilot terms, one line: "120 kt · 60 NM → time". */
export function questionLine(p: ProcedureExercise): string {
  const v = p.vals;
  switch (p.operation) {
    case 'time': return `${v.gs} kt · ${v.dist} NM → time`;
    case 'speed': return `${v.dist} NM in ${v.min} min → ground speed`;
    case 'distance': return `${v.gs} kt for ${v.min} min → distance`;
    case 'fuel': return `${num(v.rate)} kg/h for ${v.min} min → fuel`;
    case 'endurance': return `${num(v.fuel)} kg at ${num(v.rate)} kg/h → endurance`;
    case 'climb': return `${num(v.height)} ft in ${v.min} min → ft/min`;
    case 'convert': return `${num(v.value)} ${p.units!.from} → ${p.units!.to}`;
    case 'sg': return `${num(v.litres)} L at ${v.sg} kg/L → kg`;
    case 'tas': return `CAS ${v.cas} kt · PA ${num(v.pa)} ft · ${v.oat} °C → TAS`;
    case 'density': return `PA ${num(v.pa)} ft · ${v.oat} °C → density altitude`;
    case 'truealt': return `${num(v.indicated)} ft indicated · ${v.oat} °C → true altitude`;
    case 'mach': return `Mach ${v.mach} at ${v.oat} °C → TAS`;
    case 'offcourse': return `${v.off} NM off after ${v.flown} NM, ${v.remaining} to go → turn`;
    case 'windhdg': case 'jet': return `TC ${v.tc}° · TAS ${v.tas} kt · wind ${v.from}°/${v.speed} → GS`;
    case 'windfind': return `TH ${v.th}° · TC ${v.tc}° · TAS ${v.tas} · GS ${v.gs} → wind`;
    default: return p.scenario;
  }
}

/** What the estimate asks for, with its unit. */
export function estimateAsk(p: ProcedureExercise): string {
  const unit = UNIT_WORD[p.answer.unit] ?? p.answer.unit;
  const what: Record<string, string> = { time: 'time', speed: 'ground speed', distance: 'distance', fuel: 'fuel', endurance: 'endurance', climb: 'rate', convert: 'answer', sg: 'mass',
    tas: 'TAS', density: 'density altitude', truealt: 'true altitude', mach: 'TAS', offcourse: 'turn', windhdg: 'ground speed', jet: 'ground speed', windfind: 'wind speed' };
  return `Estimate the ${what[p.operation] ?? 'answer'} in your head, in ${unit}`;
}

const UNIT_WORD: Record<string, string> = { min: 'minutes', kt: 'knots', NM: 'NM', kg: 'kg', ft: 'feet', 'ft/min': 'ft/min', '°': 'degrees', '°T': 'degrees', L: 'litres', lb: 'lb', SM: 'statute miles', 'US gal': 'US gal' };

const rad = (d: number) => d * Math.PI / 180;
const angleOff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/** The rule of thumb that gets the answer in your head, from the problem's own
 * numbers, one line: "120 kt = 2 NM/min → 60 ÷ 2 = 30 min". */
export function methodLine(p: ProcedureExercise): string {
  const v = p.vals;
  switch (p.operation) {
    case 'time': { const m = v.gs / 60; return `${v.gs} kt = ${num(m)} NM/min → ${v.dist} ÷ ${num(m)} = ${num(v.dist / m)} min`; }
    case 'speed': { const m = v.dist / v.min; return `${v.dist} ÷ ${v.min} = ${num(m)} NM/min × 60 = ${num(m * 60)} kt`; }
    case 'distance': { const m = v.gs / 60; return `${v.gs} kt = ${num(m)} NM/min × ${v.min} = ${num(m * v.min)} NM`; }
    case 'fuel': { const m = v.rate / 60; return `${num(v.rate)} kg/h = ${num(m)} kg/min × ${v.min} = ${num(m * v.min)} kg`; }
    case 'endurance': { const h = v.fuel / v.rate; return `${num(v.fuel)} ÷ ${num(v.rate)} = ${num(h)} h × 60 = ${num(h * 60)} min`; }
    case 'climb': return `${num(v.height)} ft ÷ ${v.min} min = ${num(v.height / v.min)} ft/min`;
    case 'convert': return `1 ${p.units!.from} ≈ ${num(v.factor)} ${p.units!.to} → ${num(v.value)} × ${num(v.factor)} ≈ ${num(v.value * v.factor)} ${p.units!.to}`;
    case 'sg': return `${num(v.litres)} L × ${v.sg} kg/L = ${num(v.litres * v.sg)} kg`;
    case 'tas': { const pc = 2 * v.pa / 1000; return `TAS ≈ CAS + 2% per 1000 ft: ${v.cas} + ${num(pc)}% ≈ ${num(v.cas * (1 + pc / 100))} kt`; }
    case 'density': { const isa = 15 - 2 * v.pa / 1000, dev = v.oat - isa; return `ISA at ${num(v.pa)} ft is ${num(isa)} °C; ${dev >= 0 ? '+' : '−'}${num(Math.abs(dev))} °C × 120 ft → DA ≈ ${num(v.pa + 120 * dev)} ft`; }
    case 'truealt': { const isa = 15 - 2 * v.pa / 1000, dev = v.oat - isa, c = v.height * 0.004 * dev; return `${num(v.height)} ft above the station, ${num(dev)} °C off ISA × 4%/10 °C → ${c >= 0 ? '+' : '−'}${num(Math.abs(c))} ≈ ${num(v.indicated + c)} ft`; }
    case 'mach': { const a = 39 * Math.sqrt(v.oat + 273); return `Sound ≈ 39√(${v.oat}+273) ≈ ${num(a)} kt × M${v.mach} ≈ ${num(a * v.mach)} kt`; }
    case 'offcourse': { const a = 60 * v.off / v.flown, b = 60 * v.off / v.remaining; return `1 in 60: 60×${v.off}÷${v.flown} = ${num(a)}° + 60×${v.off}÷${v.remaining} = ${num(b)}° → ${num(a + b)}°`; }
    case 'windhdg': case 'jet': {
      const off = angleOff(v.from, v.tc);
      if (off <= 90) { const h = v.speed * Math.cos(rad(off)); return `Wind ${num(off)}° off the nose: headwind ≈ ${v.speed} × cos ${num(off)}° ≈ ${num(h)} → GS ≈ ${num(v.tas - h)} kt`; }
      const t = v.speed * Math.cos(rad(180 - off)); return `Wind ${num(180 - off)}° off the tail: tailwind ≈ ${v.speed} × cos ${num(180 - off)}° ≈ ${num(t)} → GS ≈ ${num(v.tas + t)} kt`;
    }
    case 'windfind': { const wca = Math.abs(v.th - v.tc), x = v.tas * wca / 60, h = v.tas - v.gs; return `${h >= 0 ? `Headwind ${num(h)}` : `Tailwind ${num(-h)}`} (TAS − GS), crosswind ≈ ${v.tas}×${wca}÷60 = ${num(x)} → wind ≈ ${num(Math.hypot(h, x))} kt`; }
    default: return '';
  }
}

/** One line per move on the instrument: what moves, and to where. */
export function moveLine(p: ProcedureExercise, step: ProcedureStep): string {
  const a = step.physical;
  const t = step.action.trim().split(/;\s|\.\s/)[0].replace(/\.$/, '');
  if (a.kind === 'disc') {
    const m = /^Turn the blue disc until (.+?) on inner blue sits under (.+?) on outer black$/.exec(t);
    if (m) return m[1] === '60' ? `Turn the disc: ▲ (60) under ${m[2]} on the outer scale` : `Turn the disc: blue ${m[1]} under black ${m[2]}`;
    const rules: [RegExp, string][] = [
      [/^Turn blue until (.+?) on black pressure altitude meets (.+?) on blue temperature in AIRSPEED CORRECTION$/, 'Turn the disc: PA $1 against $2 in the airspeed window'],
      [/^Turn blue PA (.+?) to meet black (.+?) in ALTITUDE CORRECTION$/, 'Turn the disc: blue PA $1 against $2 in the altitude window'],
      [/^Turn the disc until blue (.+?) is opposite black MACH NO\. INDEX.*$/, 'Turn the disc: blue $1 opposite the MACH index'],
    ];
    for (const [re, to] of rules) if (re.test(t)) return t.replace(re, to);
    return t;
  }
  if (a.kind === 'cursor') return t.replace(/\s+/g, ' ').replace(/^Move the red hairline (over|to) /, 'Hairline to ').replace(/ on (outer )?black$/, ' on the outer scale').replace(/ on (inner )?blue$/, ' on the blue disc');
  if (a.kind === 'plate') return `Turn the rose: ${a.bearing}° under TRUE INDEX`;
  if (a.kind === 'dot') return p.operation === 'windfind' ? t.replace(/^Mark/, 'Pencil a dot on').replace(/ \(heading minus course\)$/, '') : `Pencil a dot ${p.vals.speed} kt straight up from the grommet`;
  if (a.kind === 'fit-tas') return `Slide the grid until the dot sits on the ${a.tas} kt arc`;
  if (a.kind === 'slide') return `Slide the grid: the ${a.gs} kt arc under the grommet`;
  if (a.kind === 'dot-up') return 'Turn the rose until the dot is straight above the grommet';
  return t;
}

/** Why the hand does it, one line, with the problem's numbers. */
export function whyLine(p: ProcedureExercise, step: ProcedureStep, index: number): string {
  const a = step.physical, v = p.vals;
  const first = p.procedure.findIndex((s) => s.physical.kind === 'cursor') === index;
  if (a.kind === 'cursor') {
    if (first) return 'The hairline marks the number you start from; the app turns it to the top';
    const m = /(\d[\d,.]*)\s*(?:[A-Za-z° ]*)?\s*on (inner blue|outer black|blue|black)/.exec(step.action);
    return `The answer sits opposite ${m ? m[1] : 'this number'} on the other scale: same ratio all round`;
  }
  if (a.kind === 'disc') {
    switch (p.operation) {
      case 'time': case 'distance': return `▲ is 60 min: ${v.gs} over 60 sets ${v.gs} NM per hour on every pair`;
      case 'fuel': case 'endurance': return `▲ is 60 min: ${num(v.rate)} over 60 sets ${num(v.rate)} kg per hour on every pair`;
      case 'speed': return `${v.dist} NM over ${v.min} min: black over blue is the ratio, the same all round`;
      case 'climb': return `${num(v.height)} ft over ${v.min} min: black over blue is feet per minute all round`;
      case 'convert': case 'sg': return 'The arrows are the unit ratio: aligning them converts every pair';
      case 'tas': return 'The window sets air density from pressure altitude and temperature';
      case 'truealt': return 'Cold air squeezes the layers: the window applies it to your height';
      case 'mach': return 'Sound speed depends only on temperature: the index sets it';
      case 'offcourse': return `${v.off} NM over the distance flown is the error; 60 turns it into degrees`;
      default: return 'Black over blue is a ratio, the same all the way round';
    }
  }
  if (a.kind === 'plate') {
    const firstPlate = p.procedure.findIndex((s) => s.physical.kind === 'plate') === index;
    if (p.operation === 'windfind') return 'Course at TRUE INDEX: the grid then shows ground track straight up';
    return firstPlate ? 'Set the wind direction under TRUE INDEX: the dot you mark is where the wind comes from'
      : `Now the course under TRUE INDEX: the dot keeps the wind's push relative to ${v.tc}°`;
  }
  if (a.kind === 'dot') return p.operation === 'windfind' ? 'The dot is the air vector: TAS along the heading you flew'
    : `The dot is the wind's push: direction from TRUE INDEX, length ${v.speed} kt`;
  if (a.kind === 'fit-tas') return `The dot sits at ${v.tas} kt: the air vector's length is TAS; the grommet now reads GS`;
  if (a.kind === 'slide') return 'The grommet is the ground vector: its arc is ground speed';
  if (a.kind === 'dot-up') return 'Dot above the grommet: the wind blows from the direction now at TRUE INDEX';
  return '';
}

/** What to read for a reading step, one line. */
export function readLine(step: ProcedureStep): string {
  const t = step.action.trim().split(/;\s|\.\s/)[0].replace(/\.$/, '');
  return t.replace(/^Read (min|kt|NM) on/, (_, u) => `Read ${UNIT_WORD[u] ?? u} on`);
}

/** "E6-B 30:00 · your estimate 30 ✓": the instrument against the head. */
export function crossCheck(p: ProcedureExercise, reading: number, estimate: number | null): string {
  const e6b = `${num(reading)}${p.answer.unit === '°' || p.answer.unit === '°T' ? '' : ' '}${p.answer.unit}`;
  if (estimate == null || !Number.isFinite(estimate)) return `E6-B ${e6b}`;
  const g = gradeEstimate(Math.abs(estimate), Math.abs(reading));
  return `E6-B ${e6b} · your estimate ${num(estimate)} ${g === 'close' ? '✓' : g === 'ballpark' ? '≈' : '✗ check the decimal'}`;
}

/** Steps the app performs itself (turning the work to the top, picking the
 * slide end): they are bookkeeping, not lessons. */
export function autoStep(step: ProcedureStep): boolean {
  return step.physical.kind === 'orient' || step.physical.kind === 'slide-end';
}

// --- Help that fades ------------------------------------------------------------
export interface SkillHelp { clean: number; missed: boolean }
/** 0: glow, pointer, ghost hand and why lines. 1: why lines behind "why".
 * 2: no glow until Show me. A miss brings full help back. */
export type HelpLevel = 0 | 1 | 2;

export function helpLevel(h: SkillHelp | undefined): HelpLevel {
  if (!h || h.missed) return 0;
  return h.clean >= 4 ? 2 : h.clean >= 2 ? 1 : 0;
}

export function afterProblem(h: SkillHelp | undefined, clean: boolean): SkillHelp {
  return clean ? { clean: (h?.clean ?? 0) + 1, missed: false } : { clean: 0, missed: true };
}
