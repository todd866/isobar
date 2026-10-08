import type { Card, Source } from './model.ts';
import type { Snapshot } from './snapshot.ts';
import { MODES, chipFor, chipOptions, figureKind, modeEnabled, pillLabel, sitting, type Mode, type Page } from './chrome.ts';
import type { Overlay } from './keys.ts';
import { esc } from './html.ts';
import { cardFigure, livePanel } from './sa.ts';

export interface RenderInput {
  page: Page;
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
}

function navIcon(path: string): string {
  return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${path}</svg>`;
}

const railIcon = {
  review: navIcon('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 8h10M7 12h6"/>'),
  live: navIcon('<path d="M4 8c4-2 12-2 16 0M4 12c4-2 12-2 16 0M4 16c4-2 12-2 16 0"/>'),
  plan: navIcon('<circle cx="6" cy="7" r="2"/><circle cx="18" cy="17" r="2"/><path d="M8 8.5 16 15.5"/>'),
  exam: navIcon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M10 2h4M12 2v3"/>'),
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

function choices(card: Card, input: RenderInput): string {
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
  return `<p class="explain">${esc(card.explanation)}</p>`;
}

function citation(card: Card, sources: Source[]): string {
  const source = sources.find((item) => item.id === card.citations[0]?.sourceId);
  if (!source) return '';
  const title = card.citations.map((item) => `${item.sourceId} — ${item.section}`).join('\n');
  return `<p class="cite" title="${esc(title)}">${esc(source.shortName)}</p>`;
}

function reviewCard(input: RenderInput): string {
  const card = input.card;
  if (!card) return '';
  const figure = cardFigure(card, input.snapshot, input.phase);
  const wide = figure.length > 0;
  return `<article class="review-card${wide ? ' has-figure' : ''} sheet ${wide ? 'wide' : 'narrow'}">
    <div class="prompt">
      <h1 class="stem">${stemHtml(card, input.phase === 'revealed')}</h1>
      ${choices(card, input)}
      ${resultPill(card, input)}
      ${explanation(card, input)}
      ${input.phase === 'revealed' ? citation(card, input.sources) : ''}
    </div>
    ${figure}
  </article>`;
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
  if (input.page === 'live' || input.page === 'profile' || input.page === 'plan') {
    return `<span class="chip" aria-label="Subject">${esc(chip.label)}</span>`;
  }
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
  return `<div class="shell" data-screen="${input.page}">
    <nav class="rail" aria-label="Main navigation">
      <button type="button" class="tile" data-page="review" aria-label="Home">ISO</button>
      <div class="rail-list">
        ${railItem('review', 'Review', railIcon.review, input.page)}
        ${railItem('live', 'Live', railIcon.live, input.page)}
        ${railItem('plan', 'Plan', railIcon.plan, input.page)}
        ${railItem('exam', 'Practice Exam', railIcon.exam, input.page)}
      </div>
      ${railItem('profile', 'Profile', railIcon.profile, input.page)}
    </nav>
    <div class="main">
      <header class="toolbar" aria-label="Review toolbar">
        <div class="toolbar-left">${modeSelect(input)}${chipControl(input)}${pill(input)}</div>
        <div class="toolbar-right">${difficulty(input)}${flagButton(input)}${shortcutsButton(input)}</div>
      </header>
      <div class="stage">${stage(input)}</div>
      ${footer(input)}
    </div>
    ${overlays(input)}
  </div>`;
}
