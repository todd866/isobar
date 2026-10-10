/** HTML for the chrome around the instrument: the slim control strip, the task
 * card, the coach bubble, the task menu and the "How it works" overlay. Pure
 * strings from plain data, so the tests can check what each mode shows. */
import type { Given } from './practice.ts';
import type { SkillState, Stage } from './skills.ts';
import { INPUT_MAP, TOUCH_INPUT_MAP } from './input.ts';
import { norm } from './slide.ts';

export type Mode = 'learn' | 'practice' | 'free';
export type Side = 'computer' | 'wind';
export type Variant = 'lab' | 'card';

export const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));

/** The plain-language readout, each value tinted like the scale it comes from. */
export function readoutHtml(text: string): string {
  return text.split(' · ').map((part) => {
    const cls = part.startsWith('Outer') ? 'ink' : part.startsWith('Inner') || part.startsWith('Time') ? 'blue' : '';
    // "Dot: TAS 150 kt, 3.2° right" reads as label "Dot" and its value.
    const m = /^(Dot:)\s(.+)$/.exec(part) ?? /^(.*?)(-?[\d.,:]+[^\s]*(?:\s(?:kt|ft))?)$/.exec(part);
    return m ? `<span class="ro ${cls}"><span class="k">${keyHtml(m[1].trim())}</span> <b>${esc(m[2])}</b></span>` : `<span class="ro ${cls}">${esc(part)}</span>`;
  }).join('');
}

/** "Outer (black)": the colour word is redundant where the value is tinted, so a phone hides it. */
const keyHtml = (key: string): string => key === 'Ground speed'
  ? '<span class="long">Ground speed</span><span class="short">GS</span>'
  : esc(key.replace(/:$/, '')).replace(/ (\([a-z]+\))$/, ' <span class="paren">$1</span>');

/** The same readout as an instrument block: one row per value, values right-aligned. */
export function readoutPanelHtml(text: string): string {
  return text.split(' · ').map((part) => {
    const cls = part.startsWith('Outer') ? 'ink' : part.startsWith('Inner') || part.startsWith('Time') ? 'blue' : '';
    const m = /^(.*?)(-?[\d.,:]+[^\s]*(?:\s(?:kt|ft))?)$/.exec(part);
    return m ? `<div class="rp-row ${cls}"><span class="k">${esc(m[1].trim())}</span><b>${esc(m[2])}</b></div>` : `<div class="rp-row ${cls}"><span class="k">${esc(part)}</span></div>`;
  }).join('');
}

export interface StripView {
  variant: Variant;
  mode: Mode;
  side: Side;
  exam: boolean;
  /** Null when the readout is hidden (exam mode). */
  readout: string | null;
  learn: { title: string; state: SkillState; stage: Stage; playing: boolean; step: number; steps: number } | null;
  practice: { label: string; timer: string | null } | null;
  loupe: boolean;
  autoTurn?: boolean;
  slideEnd?: 'low'|'high';
  /** Phone portrait: readings row plus one dock row; the rest folds into More. */
  narrow?: boolean;
  /** Home and the first-contact tour show the modes in the dock instead of the lesson stages. */
  launch?: boolean;
  /** The teaching flow owns the problem: no stages, no exercise picker. */
  flow?: boolean;
  moreOpen?: boolean;
}

const STATE_GLYPH: Record<SkillState, string> = { new: '○', learning: '◐', fluent: '●' };
const STATE_WORD: Record<SkillState, string> = { new: 'New', learning: 'Learning', fluent: 'Fluent' };

export function stateGlyph(state: SkillState): string {
  return `<span class="sk ${state}" title="${STATE_WORD[state]}" aria-label="${STATE_WORD[state]}">${STATE_GLYPH[state]}</span>`;
}

function segmented(name: string, items: [string, string][], current: string, attr: string): string {
  return `<div class="seg" role="radiogroup" aria-label="${esc(name)}">${items.map(([id, label]) =>
    `<button type="button" role="radio" ${attr}="${id}" aria-checked="${id === current}">${esc(label)}</button>`).join('')}</div>`;
}

export function stripHtml(v: StripView): string {
  const sides = segmented('Side of the computer', [['computer', 'Computer'], ['wind', 'Wind']], v.side, 'data-side');
  const readout = v.readout != null ? `<div class="readout" aria-live="off" title="Read under the red hairline">${readoutHtml(v.readout)}</div>` : '<div class="readout"></div>';
  if (v.variant === 'card') return `<div class="strip card">${readout}${sides}</div>`;
  if (v.narrow) return dockHtml(v, readout, sides);
  const modes = segmented('Mode', [['learn', 'Problems'], ['free', 'Free']], v.mode === 'practice' ? 'learn' : v.mode, 'data-mode');
  let context = '';
  if (v.mode === 'learn' && v.learn && !v.flow) {
    const l = v.learn;
    const order: Stage[] = ['watch', 'guided', 'solo'];
    const at = l.stage === 'done' ? 3 : order.indexOf(l.stage);
    const pips = order.map((stage, i) =>
      `<button type="button" class="pip${i < at ? ' done' : i === at ? ' now' : ''}" data-stage="${stage}" aria-current="${i === at}">${stage === 'watch' ? 'Watch' : stage === 'guided' ? 'Guided' : 'Solo'}</button>`).join('<span class="chev" aria-hidden="true">›</span>');
    const transport = l.stage === 'watch'
      ? `<div class="transport" role="group" aria-label="Demonstration"><button type="button" data-e6b="back" aria-label="Previous step">⏮</button><button type="button" class="play" data-e6b="play" aria-label="${l.playing ? 'Pause' : 'Play'}">${l.playing ? '⏸' : '▶'}</button><button type="button" data-e6b="next" aria-label="Next step">⏭</button><span class="count">${l.step}/${l.steps}</span></div>`
      : '';
    context = `<div class="stages" role="group" aria-label="Stage">${pips}</div>${transport}`;
  } else if (v.mode === 'practice' && v.practice) {
    context = `<button type="button" class="picker" data-e6b="menu" aria-haspopup="menu"><span>${esc(v.practice.label)}</span><span class="caret" aria-hidden="true">▾</span></button>
      ${v.practice.timer != null ? `<span class="timer${v.exam ? ' exam' : ''}" aria-label="Time on this problem">⏱ ${esc(v.practice.timer)}</span>` : ''}`;
  }
  return `<div class="strip">
    <div class="grp modes">${modes}</div>
    ${context ? `<div class="grp ctx">${context}</div>` : ''}
    ${readout}
    <div class="grp end">${sides}
      <button type="button" class="tbtn menu-button" data-e6b="more" aria-haspopup="true" aria-expanded="${!!v.moreOpen}">Menu<span class="caret" aria-hidden="true">${v.moreOpen ? '▾' : '▴'}</span></button>
    </div>${v.moreOpen ? moreHtml(v, sides, false) : ''}
  </div>`;
}

function stagesHtml(stage: Stage): string {
  const order: Stage[] = ['watch', 'guided', 'solo'];
  const at = stage === 'done' ? 3 : order.indexOf(stage);
  return `<div class="seg stage-seg" role="group" aria-label="Stage">${order.map((s, i) =>
    `<button type="button" data-stage="${s}" aria-current="${i === at}" class="${i < at ? 'done' : ''}">${i < at ? '<span class="tick" aria-hidden="true">✓</span>' : ''}${s === 'watch' ? 'Watch' : s === 'guided' ? 'Guided' : 'Solo'}</button>`).join('')}</div>`;
}

/** Phone dock, one row: the readings, then Menu. Mode, stage, side and the
 * view controls live in the menu. */
function dockHtml(v: StripView, readout: string, sides: string): string {
  const timer = v.practice?.timer != null && !v.launch
    ? `<span class="ro timer${v.exam ? ' exam' : ''}" aria-label="Time on this problem"><span class="k" aria-hidden="true">⏱</span> <b>${esc(v.practice.timer)}</b></span>` : '';
  const cells = readout.replace(/<\/div>$/, `${timer}</div>`);
  const more = v.moreOpen ? moreHtml(v, sides) : '';
  return `<div class="strip dock">${cells}<button type="button" class="dbtn more" data-e6b="more" aria-haspopup="true" aria-expanded="${!!v.moreOpen}">Menu<span class="caret" aria-hidden="true">${v.moreOpen ? '▾' : '▴'}</span></button>${more}
  </div>`;
}

/** Everything the dock folds away: one labelled 44 pt row each, labels of two words or fewer. */
function moreHtml(v: StripView, sides: string, phone = true): string {
  const lesson = !v.launch && v.mode === 'learn' && v.learn;
  const row = (attrs: string, glyph: string, label: string, state = '') =>
    `<button type="button" class="mrow" ${attrs}><span class="g" aria-hidden="true">${glyph}</span><span class="l">${esc(label)}</span>${state}</button>`;
  const onOff = (on: boolean) => `<span class="state${on ? ' on' : ''}">${on ? 'On' : 'Off'}</span>`;
  const rows = [
    phone ? `<div class="mseg">${segmented('Mode', [['learn', 'Problems'], ['free', 'Free']], v.mode === 'practice' ? 'learn' : v.mode, 'data-mode')}</div>` : '',
    phone && lesson && !v.flow ? `<div class="mseg">${stagesHtml(v.learn!.stage)}</div>` : '',
    phone ? `<div class="mseg">${sides}</div>` : '',
    v.side === 'wind' ? row('data-e6b="slide-end"', '⇅', 'Slide end', `<span class="state">${v.slideEnd === 'high' ? 'High · 10 kt' : 'Low · 2 kt'}</span>`) : '',
    v.mode === 'learn' && !v.flow ? row('data-e6b="menu" aria-haspopup="menu"', '≡', 'Exercises', lesson ? `<span class="state">${esc(v.learn!.title)}</span>` : '') : '',
    v.mode === 'practice' && v.practice ? row('data-e6b="menu" aria-haspopup="menu"', '≡', 'Problem set', `<span class="state">${esc(v.practice.label)}</span>`) : '',
    v.mode === 'practice' ? `<label class="mrow switch"><span class="g" aria-hidden="true">⏱</span><span class="l">Exam</span><input type="checkbox" data-e6b="exam"${v.exam ? ' checked' : ''}></label>` : '',
    row('data-e6b="upright"', '↟', 'Upright'),
    v.mode === 'learn' ? row(`data-e6b="auto-turn" aria-pressed="${!!v.autoTurn}"`, '↻', 'Auto-turn', onOff(!!v.autoTurn)) : '',
    row(`data-e6b="loupe" aria-pressed="${v.loupe}"`, '⌕', 'Loupe', onOff(v.loupe)),
    v.flow ? '' : row('data-e6b="tour"', 'ⓘ', 'Tour'),
    row('data-e6b="how"', '∿', 'Theory'),
  ];
  return `<div class="more-panel" role="group" aria-label="More controls">${rows.join('')}</div>`;
}

export interface TaskView {
  kicker: string;
  /** Source of a worked example, as a tooltip on the kicker. */
  cite?: string;
  pips?: string[];
  log?: { label: string; value: string | null; own: boolean }[];
  stem: string;
  /** The full scenario when `stem` is the phone's one line. */
  stemFull?: string;
  givens: Given[];
  /** Hide the chips' hover glow (exam). */
  plainChips?: boolean;
  estimate: { value: string; locked: boolean } | null;
  answer: { value: string; unit: string; enabled: boolean; done: boolean } | null;
  verdict: { ok: boolean; check: string; diagnosis: string | null; estimate: string | null; outcome: string | null; pace: string | null } | null;
  decision: { question: string; chosen: boolean | null; right: boolean | null; why: string } | null;
  replay: boolean;
  replayLabel?:string;
  next: string | null;
  /** A guided procedure: the step in hand, with ‹ › beside the question. */
  step?: StepView | null;
}

export interface StepView { n: number; of: number; text: string; ok: boolean; canBack: boolean; canNext: boolean; last: boolean }

const UNIT_WORDS: Record<string, string> = { min: 'minutes', kt: 'knots', NM: 'NM', kg: 'kg', ft: 'feet', 'ft/min': 'ft/min', '°': 'degrees', '°T': 'degrees true' };
const QUANTITY: Record<string, string> = {
  time: 'time', speed: 'ground speed', distance: 'distance', fuel: 'fuel burn', endurance: 'endurance', climb: 'rate', convert: 'answer', sg: 'mass',
  tas: 'TAS', truealt: 'true altitude', density: 'density altitude', mach: 'TAS', offcourse: 'turn', windhdg: 'ground speed', jet: 'ground speed', windfind: 'wind speed', components: 'headwind',
};

/** One line for a procedure step: the action, with the words that say what the
 * number is ("Estimate the time in minutes, then Check"). Typed steps end in
 * "then Check" because the Check button is the next thing to press. */
export function stepLine(operation: string, kind: string, action: string, unit: string): string {
  const u = UNIT_WORDS[unit] ?? unit;
  if (kind === 'estimate') return `Estimate the ${QUANTITY[operation] ?? 'answer'} in ${u}, then Check`;
  let t = action.trim().split(/;\s|\.\s/)[0].replace(/\.$/, '');
  const rules: [RegExp, string][] = [
    [/^Turn the blue disc until (.+?) on inner blue sits under (.+?) on outer black$/, 'Turn the disc: inner blue $1 under outer black $2'],
    [/^Turn the whole view until (.+?) is at the top, upright$/, 'Turn $1 to the top'],
    [/^Read (min|kt|NM) on (inner blue|outer black) under the hairline$/, `Read ${u} on $2`],
  ];
  for (const [re, to] of rules) t = t.replace(re, to);
  return kind === 'read' ? `${t}, then Check` : t;
}

function stepperHtml(v: StepView): string {
  return `<div class="stepper" role="group" aria-label="Step ${v.n} of ${v.of}"><button type="button" class="sbtn" data-e6b="step-back" aria-label="Previous step"${v.canBack ? '' : ' disabled'}>‹</button><span class="sn">${v.n}/${v.of}</span><button type="button" class="sbtn${v.canNext ? ' go' : ''}" data-e6b="step-next" aria-label="${v.last ? 'Finish' : 'Next step'}"${v.canNext ? '' : ' disabled'}>›</button></div>`;
}

/** Keep a number with its unit. */
export const nbsp = (text: string): string =>
  text.replace(/(\d) (°C|kt|NM|ft|kg\/h|kg|L\/h|L|min|lb|SM|km|m|US gal|imp gal)(?![\w])/g, '$1\u00a0$2');

export function taskHtml(v: TaskView): string {
  const pips = v.pips?.length ? `<span class="dots" aria-hidden="true">${v.pips.map((p) => `<i class="${p}"></i>`).join('')}</span>` : '';
  const log = v.log?.length ? `<div class="navlog" role="table" aria-label="Nav log">${v.log.map((cell) =>
    `<div class="cell${cell.value == null ? ' empty' : ''}${cell.value != null && !cell.own ? ' given' : ''}" role="cell" title="${cell.value != null && !cell.own ? 'Exact value carried forward' : ''}"><span class="k">${esc(cell.label)}</span><b>${esc(cell.value ?? '—')}</b></div>`).join('')}</div>` : '';
  const chips = v.givens.length ? `<div class="chips">${v.givens.map((g, i) =>
    `<span class="chip${v.plainChips || !g.highlight ? ' plain' : ''}" data-given="${i}" tabindex="${v.plainChips || !g.highlight ? -1 : 0}"><span class="k">${esc(g.label)}</span> ${esc(g.value)}</span>`).join('')}</div>` : '';
  let entry = '';
  if (v.answer) {
    const estimating = !!v.estimate && !v.estimate.locked;
    const enabled = v.answer.enabled && !v.answer.done;
    const est = v.estimate
      ? `<div class="erow"><label class="field est${v.estimate.locked ? ' locked' : ''}"><span>Estimate first, in your head</span><input type="text" inputmode="decimal" autocomplete="off" data-e6b="estimate" value="${esc(v.estimate.value)}" placeholder="Estimate, ${esc(v.answer.unit)}"${v.estimate.locked ? ' readonly' : ''}><span class="unit">${esc(v.answer.unit)}</span></label>${estimating ? '<button type="submit" class="go">Set</button>' : ''}</div>`
      : '';
    entry = `<form class="entry" data-e6b="answer">${est}
      <div class="erow"><label class="field"><span>Reading off the scale</span><input type="text" inputmode="decimal" autocomplete="off" data-e6b="reading" value="${esc(v.answer.value)}" placeholder="${enabled && !estimating ? `Reading, ${esc(v.answer.unit)}` : ''}"${enabled && !estimating ? '' : ' disabled'}><span class="unit">${esc(v.answer.unit)}</span></label>${v.answer.done || estimating ? '' : '<button type="submit" class="go">Check</button>'}</div>
    </form>`;
  }
  let verdict = '';
  if (v.verdict) {
    const d = v.verdict;
    verdict = `<div class="verdict ${d.ok ? 'good' : 'bad'}" role="status"><span class="mark" aria-hidden="true">${d.ok ? '✓' : '✗'}</span><div>
      <p class="check">${esc(d.check)}</p>
      ${d.diagnosis ? `<p class="diag">${esc(d.diagnosis)}</p>` : ''}
      ${d.estimate ? `<p class="sub">${esc(d.estimate)}</p>` : ''}
      ${d.outcome ? `<p class="sub">${esc(d.outcome)}</p>` : ''}
      ${d.pace ? `<p class="sub">${esc(d.pace)}</p>` : ''}
    </div></div>`;
  }
  let decision = '';
  if (v.decision) {
    const d = v.decision;
    const button = (value: boolean) => `<button type="button" data-decide="${value}" aria-pressed="${d.chosen === value}"${d.chosen != null ? ' disabled' : ''}>${value ? 'Yes' : 'No'}</button>`;
    decision = `<div class="decision"><p>${esc(d.question)}</p><div class="yn">${button(true)}${button(false)}</div>
      ${d.right != null ? `<p class="sub ${d.right ? 'good' : 'bad'}">${d.right ? '✓' : '✗'} ${esc(d.why)}</p>` : ''}</div>`;
  }
  const actions = v.replay || v.next
    ? `<div class="actions">${v.replay ? `<button type="button" class="ghostbtn" data-e6b="replay">${esc(v.replayLabel??'Show me with these numbers')}</button>` : ''}${v.next ? `<button type="button" class="go" data-e6b="advance">${esc(v.next)}</button>` : ''}</div>`
    : '';
  return `<div class="kicker"${v.cite ? ` title="${esc(v.cite)}"` : ''}><span>${esc(v.kicker)}${v.cite ? ' <span class="src">ⓘ</span>' : ''}</span>${pips}</div>${log}${v.step ? '<div class="qrow">' : ''}<p class="stem"${v.stemFull && v.stemFull !== v.stem ? ` title="${esc(v.stemFull)}" aria-label="${esc(v.stemFull)}"` : ''}>${esc(nbsp(v.stem))}</p>${v.step ? `${stepperHtml(v.step)}</div><p class="step${v.step.ok ? ' ok' : ''}" aria-live="polite">${v.step.ok ? '<span class="tick" aria-hidden="true">✓</span>' : ''}${esc(nbsp(v.step.text))}</p>` : ''}${chips}${entry}${verdict}${decision}${actions}`;
}

export interface CoachView {
  kind: 'watch' | 'guided' | 'replay' | 'auto' | 'ghost';
  action: string;
  detail: string;
  ok: boolean;
  step: number;
  steps: number;
  next: string | null;
  /** Watch transport, carried by the coach on a phone (the dock has no room). */
  transport?: { playing: boolean } | null;
  /** First-contact tour: Skip sits beside Next. */
  skip?: boolean;
  /** Phone: one short line instead of head + sentence; the sentence opens on tap. */
  brief?: string | null;
  full?: boolean;
}

export function coachHtml(v: CoachView): string {
  const head = v.kind === 'watch' || v.kind === 'auto' ? 'Watch' : v.ok ? 'Aligned' : v.action;
  const tick = v.ok && v.kind !== 'watch' && v.kind !== 'auto' ? '<span class="tick" aria-hidden="true">✓</span>' : '';
  const transport = v.transport
    ? `<div class="transport" role="group" aria-label="Demonstration"><button type="button" data-e6b="back" aria-label="Previous step">⏮</button><button type="button" class="play" data-e6b="play" aria-label="${v.transport.playing ? 'Pause' : 'Play'}">${v.transport.playing ? '⏸' : '▶'}</button><button type="button" data-e6b="next" aria-label="Next step">⏭</button></div>`
    : '';
  const buttons = v.next || v.skip || transport
    ? `<div class="btns">${transport}${v.skip ? '<button type="button" class="tour-skip" data-e6b="tour-skip">Skip tour</button>' : ''}${v.next ? `<button type="button" class="go" data-e6b="coach-next">${esc(v.next)}</button>` : ''}</div>`
    : '';
  // "Estimate first" / "Estimate first: 70 min…": say the action once.
  const detail = v.detail.startsWith(`${head}: `) ? v.detail.slice(head.length + 2).replace(/^./, (c) => c.toUpperCase()) : v.detail;
  if (v.brief != null) {
    const more = v.brief !== detail;
    const line = v.full && more ? detail : v.brief;
    return `<div class="bubble compact ${v.kind}${v.ok ? ' ok' : ''}">
    <div class="txt"><p class="say">${v.steps > 1 ? `<span class="n">${v.step}/${v.steps}</span> ` : ''}${tick}${more ? `<button type="button" class="line" data-e6b="coach-full" aria-expanded="${!!v.full}">${esc(line)}</button>` : esc(line)}</p></div>
    ${buttons}
  </div>`;
  }
  return `<div class="bubble ${v.kind}${v.ok ? ' ok' : ''}">
    <div class="txt"><p class="act">${tick}<span class="h">${esc(head)}</span>${v.steps > 1 ? `<span class="n">${v.step}/${v.steps}</span>` : ''}</p>
    <p class="say">${esc(detail)}</p></div>
    ${buttons}
  </div>`;
}

export interface MenuRow { id: string; label: string; detail?: string; state?: SkillState; current?: boolean }

export function menuHtml(title: string, sections: { title: string; rows: MenuRow[] }[]): string {
  return `<div class="menu" role="menu" aria-label="${esc(title)}">${sections.map((section) =>
    `<p class="mh">${esc(section.title)}</p>${section.rows.map((row) =>
      `<button type="button" role="menuitem" data-pick="${esc(row.id)}"${row.current ? ' aria-current="true"' : ''}>${row.state ? stateGlyph(row.state) : '<span class="sk"></span>'}<span class="l">${esc(row.label)}</span>${row.detail ? `<span class="d">${esc(row.detail)}</span>` : ''}</button>`).join('')}`).join('')}</div>`;
}

/** The slide rule unrolled: two log scales, the blue one shifted by the disc
 * angle, so that sliding is adding lengths and adding lengths is multiplying. */
export function howHtml(theta: number, probe: number | null, touch = false): string {
  const W = 1000;
  const x = (v: number) => (Math.log10(v / 10)) * W;
  const shift = (norm(theta) / 360) * W;
  // The two scales face each other across a gap, as on the instrument: black
  // ticks hang down from y 0 with labels above; blue ticks rise from y 70 with labels below.
  const ticks = (cls: string, y: number, dir: 1 | -1, offset: number) => {
    let d = '';
    let text = '';
    for (let v = 10; v < 100; v += v < 20 ? 1 : v < 50 ? 2 : 5) {
      for (const k of [0, 1]) {
        const px = x(v) + offset - k * W;
        if (px < -1 || px > W + 1) continue;
        const major = v % 10 === 0 || v === 15 || v === 25;
        d += `M${px.toFixed(1)} ${y}v${dir * (major ? 24 : 13)}`;
        if (v % 10 === 0 || v === 15) text += `<text x="${px.toFixed(1)}" y="${y - dir * 18}" class="${cls}">${v / 10}</text>`;
      }
    }
    return `<path class="${cls}" d="${d}"/>${text}`;
  };
  const a = probe ?? 30;
  const b = 10 * 10 ** (((x(a) - shift) % W + W) % W / W);
  // Past the end of the black scale the product wraps into the next decade: ×10.
  const top = x(a) < shift ? a : a / 10;
  const bracket = (from: number, to: number, y: number, cls: string, label: string) =>
    `<path class="br ${cls}" d="M${from.toFixed(1)} ${y}v-8H${to.toFixed(1)}v8"/><text class="brl ${cls}" x="${((from + to) / 2).toFixed(1)}" y="${y - 16}">${label}</text>`;
  const shiftLabel = (10 ** (shift / W)).toFixed(2);
  return `<div class="how" role="dialog" aria-label="How it works">
    <button type="button" class="close" data-e6b="how" aria-label="Close">✕</button>
    <h2>Sliding is adding; adding logs is multiplying</h2>
    <p>Each scale is spaced by logarithm: the distance from 1 to <i>n</i> is log <i>n</i>. Slide the blue scale along by log ${shiftLabel} and every blue number sits under ${shiftLabel} times itself, because log a + log b = log (a × b).</p>
    <div class="scroller"><svg viewBox="-40 -90 1080 250" class="unrolled" data-e6b="how-drag" role="img" aria-label="The two scales unrolled">
      ${bracket(0, shift, 146, 'blue', `log ${shiftLabel}`)}
      <path class="rail" d="M0 0H${W}"/>${ticks('ink', 0, 1, 0)}
      <path class="rail blue" d="M0 70H${W}"/>${ticks('blue', 70, -1, shift)}
      <path class="probe" d="M${x(a).toFixed(1)} -40V100"/>
      <text class="pr" x="${x(a).toFixed(1)}" y="-56">${(b / 10).toFixed(2)} × ${shiftLabel} = ${top.toFixed(top >= 10 ? 1 : 2)}</text>
    </svg></div>
    <p>Bend one decade round a circle, 1 to 10 in 360°, and you have the E6-B: the black outer scale and the blue inner scale turn against each other, and the decade repeats every turn, which is why you place the decimal point yourself. ${touch ? 'Touch' : 'Point at'} the scales to move the probe; drag the blue scale, or turn the disc, to slide it.</p>
    <h3>Using it</h3>
    <dl class="inputs">${(touch ? TOUCH_INPUT_MAP : INPUT_MAP).map(([input, effect]) => `<dt>${esc(input)}</dt><dd>${esc(effect)}</dd>`).join('')}</dl>
  </div>`;
}

/** One short line for a coach step on a phone: the first clause, with the
 * recurring long phrasings cut to their working words. The full sentence stays
 * one tap away. */
export function briefStep(text: string): string {
  let t = text.trim().split(/;\s|\.\s/)[0].replace(/\.$/, '');
  const rules: [RegExp, string][] = [
    [/^Turn the whole view until (.+?) is at the top, upright$/, 'Turn $1 to the top'],
    [/^Move the red hairline (over|to) /, 'Hairline $1 '],
    [/^Turn the blue disc until (.+?) on inner blue sits under (.+?) on outer black$/, 'Blue $1 under black $2'],
    [/^Turn the clear plate until /, 'Turn plate: '],
    [/^Turn the plate until /, 'Turn plate: '],
    [/ under TRUE INDEX$/, ' at TRUE INDEX'],
    [/^(Estimate first: [^:]+):.*$/, '$1'],
    [/^Turn blue until (.+?) on black pressure altitude meets (.+?) on blue temperature in AIRSPEED CORRECTION$/, 'PA $1 against $2 (airspeed window)'],
    [/^Turn blue PA (.+?) to meet black (.+?) in ALTITUDE CORRECTION$/, 'PA $1 against $2 (altitude window)'],
    [/^Turn the disc until blue (.+?) is opposite black (.+)$/, 'Blue $1 against black $2'],
    [/^Read true height on black, then add station elevation (.+?) to obtain AMSL$/, 'Read true height; add $1'],
    [/^Read the black density-altitude graduation under the blue ▲$/, 'Read density altitude at ▲'],
    [/^On the printed component table, use (.+?) column and bracket (.+?) between the ten-knot rows$/, 'Table: $1 column, bracket $2'],
    [/^Mark the (.+?) TAS arc at (.+?) drift \(heading minus course\)$/, 'Mark $1 arc at $2 drift'],
    [/^Turn plate: the dot is on the centre line above the grommet$/, 'Turn plate: dot above grommet'],
    [/^Slide the grid until the dot lies on the (.+?) arc$/, 'Slide dot onto $1 arc'],
    [/, not the wind dot$/, ''],
    [/^With the grommet at (.+?), mark (.+?) up the centre line.*$/, 'Mark $2 up from $1'],
  ];
  for (const [re, to] of rules) t = t.replace(re, to);
  return t;
}

/** The problem card of the teaching flow: the question, the beat in hand as one
 * line, its why (or method), and at most one primary button. `next` marks the
 * one affordance to act on (data-next), unless it is on the instrument. */
export interface FlowView {
  question: string;
  n: number; of: number;
  beat: 'estimate' | 'instrument' | 'check';
  /** The line for this beat: the ask, the move, or the reading. */
  line: string;
  done: boolean;
  why: string | null;
  /** 'open' shows it; 'closed' offers a small "why"; null hides it. */
  whyState: 'open' | 'closed' | null;
  /** After an estimate or a final reading: the method and the cross-check. */
  note: string | null;
  bad: string | null;
  entry: { unit: string; value: string; ask: string } | null;
  show: boolean;
  primary: { id: string; label: string } | null;
  /** True when the one thing to do is on the instrument (data-next sits there). */
  onInstrument: boolean;
}

export function flowHtml(v: FlowView): string {
  const beats = (['estimate', 'instrument', 'check'] as const).map((b, i) =>
    `<i class="${b === v.beat ? 'on' : (['estimate', 'instrument', 'check'].indexOf(v.beat) > i ? 'past' : '')}" title="${['Estimate', 'On the E6-B', 'Check'][i]}">${'①②③'[i]}</i>`).join('');
  const nextAttr = (on: boolean) => (on ? ' data-next="true"' : '');
  const entryEmpty = !!v.entry && !v.entry.value;
  const form = v.entry
    ? `<form class="fentry" data-e6b="flow-entry"><input data-e6b="flow-input" inputmode="decimal" autocomplete="off" aria-label="${esc(v.entry.ask)}" placeholder="${esc(v.entry.ask)}" value="${esc(v.entry.value)}"${nextAttr(!v.onInstrument && entryEmpty)}><button type="submit" class="go"${nextAttr(!v.onInstrument && !entryEmpty)}>Check</button></form>`
    : '';
  const why = v.why && v.whyState === 'open' ? `<p class="fwhy">${esc(v.why)}</p>` : '';
  const whyBtn = v.why && v.whyState === 'closed' ? '<button type="button" class="fbtn ghostbtn" data-e6b="flow-why">why</button>' : '';
  const acts = v.show || v.primary || whyBtn
    ? `<div class="facts">${whyBtn}${v.show ? '<button type="button" class="fbtn ghostbtn" data-e6b="flow-show">Show me</button>' : ''}${v.primary ? `<button type="button" class="fbtn go" data-e6b="${esc(v.primary.id)}"${nextAttr(true)}>${esc(v.primary.label)}</button>` : ''}</div>`
    : '';
  return `<div class="flow" data-beat="${v.beat}">
    <div class="fhead"><span class="fbeats" aria-label="Beat ${['estimate', 'instrument', 'check'].indexOf(v.beat) + 1} of 3">${beats}</span><span class="fq">${esc(nbsp(v.question))}</span><span class="fn">${v.n}/${v.of}</span></div>
    <p class="fline${v.done ? ' ok' : ''}">${v.done ? '<span class="tick" aria-hidden="true">✓</span>' : ''}${esc(nbsp(v.line))}</p>
    ${why}${v.note ? `<p class="fnote">${esc(v.note)}</p>` : ''}${v.bad ? `<p class="fbad" role="status">${esc(v.bad)}</p>` : ''}
    ${form}${acts}
  </div>`;
}
