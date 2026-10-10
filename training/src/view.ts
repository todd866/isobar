import type { Card, Source } from './model.ts';
import type { Snapshot } from './snapshot.ts';
import { MODES, chipFor, chipOptions, figureKind, modeEnabled, pillLabel, sitting, type Mode, type Page } from './chrome.ts';
import type { Overlay } from './keys.ts';
import { esc } from './html.ts';
import { cardFigure, livePanel } from './sa.ts';
import { fmt, formatTolerance, parseEntry } from './skills/format.ts';
import { worksheet } from './adaptive.ts';
import { handbookFigure } from './table.ts';
import { marks as stepMarks, type StepMark } from './worksheet.ts';
import { supportDiagram } from './diagrams.ts';
import type { InstrumentId } from './instruments/types.ts';
import { pictureFor } from './learn-cards.ts';

export interface RenderInput {
  page: Page;
  navigation?: 'rail' | 'tabs';
  mode: Mode;
  card: Card | null;
  phase: 'ask' | 'revealed';
  selected: string | null;
  done: number;
  due: number;
  profileDue: number;
  retentionPct: number;
  streak: number;
  snapshot: Snapshot | null;
  sources: Source[];
  cards: Card[];
  overlay: Overlay;
  flagDraft: string;
  flagged: boolean;
  shortcuts: { keys: string; label: string }[];
  /** The card's support instrument is open beside the question. */
  toolOpen?: boolean;
  /** Worksheet drafts by step id, on a retest. */
  work?: Record<string, string>;
  /** Steps the learner pressed Enter on. */
  committed?: string[];
  supportInstrument?: InstrumentId | null;
  supportOpen?: boolean;
  /** Level chip. Absent on the ATPL bank. */
  learn?: { value: string; options: { value: string; label: string }[] } | null;
}

function navIcon(path: string): string {
  return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${path}</svg>`;
}

const railIcon = {
  review: navIcon('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 8h10M7 12h6"/>'),
  live: navIcon('<path d="M4 8c4-2 12-2 16 0M4 12c4-2 12-2 16 0M4 16c4-2 12-2 16 0"/>'),
  plan: navIcon('<circle cx="6" cy="7" r="2"/><circle cx="18" cy="17" r="2"/><path d="M8 8.5 16 15.5"/>'),
  exam: navIcon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M10 2h4M12 2v3"/>'),
  lab: navIcon('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 3v4M12 12l3.5-3.5"/>'),
  profile: navIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
};

function railItem(id: Page, label: string, icon: string, current: Page): string {
  const on = id === current;
  return `<button type="button" class="rail-item" data-page="${id}" aria-current="${on ? 'page' : 'false'}">${icon}<span>${label}</span></button>`;
}

function stemHtml(card: Card, revealed: boolean): string {
  const parts = card.stem.split('____');
  if (parts.length === 1) return esc(card.stem);
  const answer = card.options.find((option) => option.id === card.correctId)?.text ?? '';
  const blank = revealed
    ? `<span class="cloze">${esc(answer)}</span>`
    : '<span class="blank" aria-label="blank"></span>';
  return parts.map((part) => esc(part)).join(blank);
}

function fieldWidth(value: number, decimals: number): number {
  return Math.max(4, fmt(value, decimals).length + 1);
}

function answerField(attrs: string, value: string, width: number, unit: string, label: string): string {
  return `<span class="field"><input ${attrs} class="entry" style="--w:${width}ch" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="${esc(label)}" value="${esc(value)}"><span class="unit">${esc(unit)}</span></span>`;
}

type RowMark = StepMark | 'shown';

const MARK: Record<RowMark, string> = { empty: '', pending: '', ok: '✓', bad: '✗', shown: '' };

function worksheetHtml(card: Card, input: RenderInput): string {
  const steps = worksheet(card);
  const revealed = input.phase === 'revealed';
  const marks = stepMarks(steps, input.work ?? {}, new Set(input.committed ?? []));
  // One field width down the sheet so the entries line up as a column.
  const width = Math.max(...steps.map((step) => fieldWidth(step.value, step.decimals)));
  const rows = steps.map((step, i) => {
    const mark: RowMark = revealed ? (marks[i] === 'ok' ? 'ok' : 'shown') : marks[i]!;
    const field = revealed
      ? `<span class="field shown"><span class="entry-value">${fmt(step.value, step.decimals)}</span><span class="unit">${esc(step.unit)}</span></span>`
      : answerField(`data-step="${esc(step.id)}"`, input.work?.[step.id] ?? '', width, step.unit, `${step.label}${step.unit ? ` in ${step.unit}` : ''}`);
    return `<li class="ws-step ${mark}">
      <span class="ws-n" aria-hidden="true">${i + 1}</span>
      <span class="ws-text"><span class="ws-label">${esc(step.label)}</span><span class="ws-detail">${esc(step.detail)}</span></span>
      ${field}
      <span class="ws-mark" aria-hidden="true">${MARK[mark]}</span>
    </li>`;
  }).join('');
  return `<ol class="worksheet" aria-label="Worksheet">${rows}</ol>`;
}

function numericEntry(card: Card, input: RenderInput): string {
  const spec = card.numeric;
  if (card.kind !== 'numeric' || !spec) return '';
  if (card.drill?.stage === 'retest' && input.phase !== 'revealed') return worksheetHtml(card, input);
  const sheet = card.drill?.stage === 'retest' ? worksheetHtml(card, input) : '';
  if (input.phase !== 'revealed') {
    return `<div class="answer">${answerField('data-numeric', input.selected ?? '', fieldWidth(spec.value, spec.decimals), spec.unit, `Answer in ${spec.unit}`)}</div>`;
  }
  const entered = input.selected == null ? null : parseEntry(input.selected);
  const ok = entered != null && Math.abs(entered - spec.value) <= spec.tolerance;
  const tone = entered == null ? ' shown' : ok ? ' good' : ' bad';
  const symbol = entered == null ? '' : ok ? '✓' : '✗';
  const yours = entered != null && !ok ? `<p class="yours">You entered ${fmt(entered, spec.decimals)} ${esc(spec.unit)}.</p>` : '';
  return `${sheet}<div class="verdict${tone}" role="status">
      <span class="tick" aria-hidden="true">${symbol}</span>
      <span class="num">${fmt(spec.value, spec.decimals)}</span>
      <span class="unit">${esc(spec.unit)}</span>
      <span class="tol" title="Tolerance">${esc(formatTolerance(spec.tolerance))}</span>
    </div>${yours}`;
}

/** One line above the stem: why this card is here. */
function followUpHead(card: Card, input: RenderInput): string {
  const ref = card.drill;
  if (!ref?.stage) return '';
  if (ref.stage === 'retest') {
    const slip = ref.slip && input.phase === 'ask' ? `<p class="slip" role="status"><span aria-hidden="true">✗</span> ${esc(ref.slip)}</p>` : '';
    return `<p class="eyebrow">Same problem, in steps</p>${slip}`;
  }
  return `<p class="eyebrow">New numbers${ref.support > 0 ? ' · guided' : ''}</p>`;
}

function choices(card: Card, input: RenderInput): string {
  if (card.kind === 'numeric') return numericEntry(card, input);
  if (card.kind !== 'mcq') return '';
  const revealed = input.phase === 'revealed';
  return `<div class="choices">${card.options.map((option) => {
    const pressed = input.selected === option.id;
    const correct = revealed && option.id === card.correctId;
    const wrong = revealed && pressed && option.id !== card.correctId;
    const mark = correct ? ' correct' : wrong ? ' wrong' : '';
    const symbol = correct ? '✓' : wrong ? '✗' : '';
    return `<button type="button" class="choice${mark}" data-option="${option.id}" aria-pressed="${pressed}">
      <span class="keycap">${option.id}</span>
      <span class="choice-text">${esc(option.text)}</span>
      ${symbol ? `<span class="tick" aria-hidden="true">${symbol}</span>` : ''}
    </button>`;
  }).join('')}</div>`;
}

function resultPill(card: Card, input: RenderInput): string {
  if (input.phase !== 'revealed' || card.kind !== 'mcq' || !input.selected) return '';
  const correct = input.selected === card.correctId;
  return `<p class="result ${correct ? 'good' : 'bad'}" role="status">${correct ? '✓ Correct' : '✗ Incorrect'}</p>`;
}

function explanation(card: Card, input: RenderInput): string {
  if (input.phase !== 'revealed') return '';
  if (card.kind === 'numeric' && card.numeric) {
    return `<p class="explain">${esc(card.numeric.method)}</p><p class="thumb"><span>Rule of thumb</span> ${esc(card.numeric.thumb)}</p>`;
  }
  return `<p class="explain">${esc(card.explanation)}</p>`;
}

function citation(card: Card, sources: Source[]): string {
  const source = sources.find((item) => item.id === card.citations[0]?.sourceId);
  if (!source) return '';
  const title = card.citations.map((item) => `${item.sourceId} — ${item.section}`).join('\n');
  return `<p class="cite" title="${esc(title)}">${esc(source.shortName)}</p>`;
}

function spanSolved(card: Card, input: RenderInput): (index: number) => boolean {
  if (input.phase === 'revealed') return () => true;
  const spans = card.figure?.table?.spans ?? [];
  if (card.drill?.stage !== 'retest') return () => false;
  const steps = worksheet(card);
  const marks = stepMarks(steps, input.work ?? {});
  return (index) => {
    const span = spans[index];
    return !!span && steps.some((step, i) => marks[i] === 'ok' && Math.abs(step.value - span.result) <= Math.max(step.tolerance, 0.5));
  };
}

function figureFor(card: Card, input: RenderInput): string {
  const table = card.figure?.table;
  const steps = worksheet(card);
  const marks = stepMarks(steps, input.work ?? {});
  const stepSolved = (id: string) => steps.some((step, i) => step.id === id && marks[i] === 'ok');
  const diagram = card.figure?.diagram;
  if (diagram && ((card.drill?.support ?? 0) > 0 || input.phase === 'revealed')) {
    return supportDiagram(diagram, { revealed: input.phase === 'revealed', solved: stepSolved, answerSolved: marks.at(-1) === 'ok' });
  }
  if (!table) return cardFigure(card, input.snapshot, input.phase);
  return handbookFigure(table, {
    support: card.drill?.support ?? 0,
    revealed: input.phase === 'revealed',
    solved: spanSolved(card, input),
    stepSolved,
  });
}

function reviewCard(input: RenderInput): string {
  const card = input.card;
  if (!card) return '';
  const tool = card.tool === 'e6b' && input.toolOpen ? '<div class="figure tool-host" data-e6b-host="card"></div>' : '';
  const figure = tool || figureFor(card, input);
  const wide = figure.length > 0;
  const toolButton = card.tool === 'e6b'
    ? `<button type="button" class="textbtn tool-toggle" data-tool aria-pressed="${!!input.toolOpen}">${railIcon.lab}<span>E6-B computer</span></button>`
    : '';
  const lead = card.picture ? pictureFor(card) : '';
  const fit = !tool && card.figure?.table ? ' fit' : '';
  const support = input.supportInstrument ? `<div class="instrument-support${input.supportOpen ? ' is-open' : ''}" data-support-panel>
    <button type="button" class="instrument-open" data-instrument-open aria-expanded="${input.supportOpen ? 'true' : 'false'}">${input.supportOpen ? 'Instrument open' : 'Open instrument'}</button>
    ${input.supportOpen ? '<button type="button" class="instrument-return" data-support-return>Return to drill</button><div data-instrument-support></div>' : ''}
  </div>` : '';
  return `<div class="review-with-support${input.supportOpen ? ' support-open' : ''}"><article class="review-card${wide ? ' has-figure' : ''}${fit}${card.drill?.stage === 'retest' ? ' working' : ''} sheet ${wide ? 'wide' : 'narrow'}">
    ${lead}
    <div class="prompt-head">
      ${followUpHead(card, input)}
      <h1 class="stem">${stemHtml(card, input.phase === 'revealed')}</h1>
    </div>
    ${figure}
    <div class="prompt-body">
      ${choices(card, input)}
      ${resultPill(card, input)}
      ${explanation(card, input)}
      ${input.phase === 'revealed' ? citation(card, input.sources) : ''}
      ${toolButton}
    </div>
  </article>${support}</div>`;
}

function profileGlyph(path: string, solid = false): string {
  return `<svg class="glyph${solid ? ' solid' : ''}" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
}

function profileCard(input: RenderInput): string {
  return `<article class="review-card profile-card sheet narrow">
    <div class="inst" title="Cards due" aria-label="Cards due">${profileGlyph('<path d="M6 5h12v14H6z"/><path d="M9 5V3h6v2M8 10h8M8 14h5"/>')}<span class="num">${input.profileDue}</span><span class="datum">due</span></div>
    <div class="inst retention" title="Retention, mean probability of recall" aria-label="Retention"><div class="track"><div class="fill" style="width:${input.retentionPct}%"></div></div><span class="num">${input.retentionPct}%</span><span class="datum">retention</span></div>
    <div class="inst" title="Study streak, consecutive days" aria-label="Study streak">${profileGlyph('<path d="M12 3l2 6h6l-5 4 2 7-5-4-5 4 2-7-5-4h6z"/>')}<span class="num">${input.streak}</span><span class="datum">streak</span></div>
  </article>`;
}

function stage(input: RenderInput): string {
  if (input.page === 'lab') return '<div class="lab-host" data-lab-host></div>';
  if (input.page === 'live') {
    return `<div class="sheet wide"><article class="review-card live-card">${livePanel(input.snapshot)}</article></div>`;
  }
  if (input.page === 'profile') return profileCard(input);
  return reviewCard(input);
}

function modeSelect(input: RenderInput): string {
  if (!sitting(input.page) || input.page === 'plan') return '';
  const options = MODES.map((mode) => {
    const enabled = modeEnabled(mode.id, input.cards);
    return `<option value="${mode.id}"${enabled ? '' : ' disabled'}${mode.id === input.mode ? ' selected' : ''}>${esc(mode.label)}</option>`;
  }).join('');
  return `<label class="mode"><select data-mode aria-label="Review mode">${options}</select></label>`;
}

function chipControl(input: RenderInput): string {
  const chip = chipFor(input.card, input.page, input.mode);
  if (input.page === 'live' || input.page === 'profile' || input.page === 'plan' || input.page === 'lab') {
    return `<span class="chip" aria-label="Subject">${esc(chip.label)}</span>`;
  }
  // A subject mode already names the subject; a second identical pill is noise.
  if (input.mode !== 'mixed' && chip.id === input.mode) return '';
  const options = chipOptions(input.cards).map((option) => (
    `<option value="${option.id}"${option.enabled ? '' : ' disabled'}${option.id === chip.id ? ' selected' : ''}>${esc(option.label)}</option>`
  )).join('');
  return `<label class="mode"><select data-chip aria-label="Subject">${options}</select></label>`;
}

function pill(input: RenderInput): string {
  if (!sitting(input.page)) return '';
  const fill = input.due > 0 ? Math.min(100, Math.round((input.done / input.due) * 100)) : 0;
  return `<button type="button" class="pill" data-page="profile" aria-label="Progress: ${input.done} of ${input.due}"><span class="pill-fill" style="width:${fill}%"></span><span class="pill-text">${pillLabel(input.done, input.due)}</span></button>`;
}

function difficulty(input: RenderInput): string {
  if (!sitting(input.page)) return '';
  const open = input.overlay === 'difficulty';
  return `<div class="diff">
    <button type="button" class="diff-btn" data-difficulty aria-expanded="${open}" aria-label="Review difficulty: Auto" title="Review difficulty">
      <span aria-hidden="true">◒</span><span>Difficulty: Auto</span>
    </button>
    ${open ? `<div class="diff-panel" role="dialog" aria-label="Review difficulty"><button type="button" class="diff-auto" data-dismiss aria-pressed="true">Auto</button></div>` : ''}
  </div>`;
}

function learnControl(input: RenderInput): string {
  if (!input.learn || !sitting(input.page)) return '';
  const options = input.learn.options.map((option) => (
    `<option value="${esc(option.value)}"${option.value === input.learn?.value ? ' selected' : ''}>${esc(option.label)}</option>`
  )).join('');
  return `<label class="mode level-chip"><select data-level data-level-chip aria-label="Level">${options}</select></label>`;
}

function explainButton(input: RenderInput): string {
  if (!input.learn || !sitting(input.page) || !input.card) return '';
  return `<button type="button" class="textbtn" data-explain aria-label="Explain this"><svg class="flag-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M5 6.5h14v9H8.5L5 18.5z"/></svg><span>Explain this</span></button>`;
}

function flagButton(input: RenderInput): string {
  if (!sitting(input.page) || !input.card) return '';
  const label = input.flagged ? 'Flagged' : 'Flag';
  const icon = input.flagged
    ? '<svg class="flag-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4h9l-1.5 4L14 12H5"/></svg>'
    : '<svg class="flag-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4M5 4h9l-1.5 4L14 12H5"/></svg>';
  return `<button type="button" class="textbtn${input.flagged ? ' flagged' : ''}" data-flag aria-label="${input.flagged ? 'Flagged' : 'Flag this item (F)'}">${icon}<span>${label}</span></button>`;
}

function shortcutsButton(input: RenderInput): string {
  if (!sitting(input.page)) return '';
  return '<button type="button" class="linkish" data-shortcuts>Shortcuts (?)</button>';
}

function footer(input: RenderInput): string {
  if (!sitting(input.page) || !input.card) return '';
  const wide = figureKind(input.card) !== 'none' || (input.card.figure?.lines.length ?? 0) > 0;
  const sheet = `sheet ${wide ? 'wide' : 'narrow'}`;
  if (input.phase === 'ask' && input.card.kind === 'numeric') {
    return `<footer class="action"><div class="${sheet}"><button type="button" class="show" data-numeric-submit>Check<span class="hint"> · Enter</span></button></div></footer>`;
  }
  if (input.phase === 'ask') {
    return `<footer class="action"><div class="${sheet}"><button type="button" class="show" data-reveal>Show answer<span class="hint"> · Space</span></button></div></footer>`;
  }
  const grades = [
    ['1', 'Again', 'again'],
    ['2', 'Hard', 'hard'],
    ['3', 'Good', 'good'],
    ['4', 'Easy', 'easy'],
  ].map(([quality, label, tone]) => (
    `<button type="button" class="grade ${tone}" data-grade="${quality}" aria-label="${label} (${quality})"><span>${label}</span><small>${quality}</small></button>`
  )).join('');
  return `<footer class="action"><div class="${sheet}"><div class="grades" role="group" aria-label="When do you want to see this again?">${grades}</div></div></footer>`;
}

function overlays(input: RenderInput): string {
  if (input.overlay === 'flag') {
    return `<div class="overlay" data-dismiss>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Flag content">
        <textarea id="flag-note" aria-label="What’s wrong?" placeholder="What's wrong? (optional)" rows="2">${esc(input.flagDraft)}</textarea>
        <div class="dialog-actions">
          <button type="button" data-dismiss>Cancel</button>
          <button type="button" class="filled" data-submit-flag>Flag</button>
        </div>
        <p class="hintline">Enter to submit · Esc to cancel</p>
      </div>
    </div>`;
  }
  if (input.overlay === 'shortcuts') {
    const rows = input.shortcuts.map((row) => (
      `<div class="shortcut"><span>${esc(row.label)}</span><kbd>${esc(row.keys)}</kbd></div>`
    )).join('');
    return `<div class="overlay" data-dismiss>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Shortcuts">
        <div class="dialog-head"><h2>Shortcuts</h2><button type="button" data-dismiss>Close</button></div>
        <div class="shortcut-list">${rows}</div>
      </div>
    </div>`;
  }
  return '';
}

export function renderShell(input: RenderInput): string {
  const tabs = input.navigation === 'tabs';
  const sections: [Page, string][] = [['review', 'Review'], ['live', 'Live'], ['plan', 'Plan'], ['exam', 'Practice Exam'], ['lab', 'Lab'], ['profile', 'Profile']];
  return `<div class="shell${tabs ? ' tabs' : ''}" data-screen="${input.page}">
    ${tabs ? `<nav class="sections" aria-label="Training sections">${sections.map(([id, label]) =>
      `<button type="button" class="section-item" data-page="${id}" aria-current="${id === input.page ? 'page' : 'false'}">${label}</button>`).join('')}</nav>` : `<nav class="rail" aria-label="Main navigation">
      <button type="button" class="tile" data-page="review" aria-label="Home">ISO</button>
      <div class="rail-list">
        ${railItem('review', 'Review', railIcon.review, input.page)}
        ${railItem('live', 'Live', railIcon.live, input.page)}
        ${railItem('plan', 'Plan', railIcon.plan, input.page)}
        ${railItem('exam', 'Practice Exam', railIcon.exam, input.page)}
        ${railItem('lab', 'Lab', railIcon.lab, input.page)}
      </div>
      ${railItem('profile', 'Profile', railIcon.profile, input.page)}
    </nav>`}
    <div class="main">
      <header class="toolbar" aria-label="Review toolbar">
        <div class="toolbar-left">${modeSelect(input)}${chipControl(input)}${learnControl(input)}${sitting(input.page) && input.card?.scenario === 'example' ? '<span class="chip" data-example-chip>Example</span>' : ''}${pill(input)}</div>
        <div class="toolbar-right">${difficulty(input)}${explainButton(input)}${flagButton(input)}${shortcutsButton(input)}</div>
      </header>
      <div class="stage">${stage(input)}</div>
      ${footer(input)}
    </div>
    ${overlays(input)}
  </div>`;
}
