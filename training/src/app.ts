import { concepts, sources } from './catalog.ts';
import { library, staticCards, laterCard } from './deck.ts';
import { applyGrade, emptyProgress, localDay, meanRetrieval, type ProgressFile, type ProgressFlag } from './progress.ts';
import { selectQueue } from './queue.ts';
import { openSession, reduce, type Session } from './session.ts';
import type { Snapshot } from './snapshot.ts';
import type { Card } from './model.ts';
import { modePool, planQueue, sitting, type Mode, type Page } from './chrome.ts';
import { keyIntent, shortcutRows, type Overlay } from './keys.ts';
import { renderShell } from './view.ts';

interface Bridge {
  snapshot?: Snapshot;
  progress?: ProgressFile & { shot?: unknown };
  save?: (progress: ProgressFile) => void;
  close?: () => void;
}

declare global {
  interface Window {
    isobar?: Bridge;
    __THEME?: 'light' | 'dark';
    __TRAINING_READY?: boolean;
  }
}

const app = document.querySelector('#app');
if (!app) throw new Error('missing app root');

const theme = window.__THEME ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = theme;

const loaded = loadProgress(window.isobar?.progress);
let snapshot: Snapshot | null = window.isobar?.snapshot ?? null;
let progress: ProgressFile = loaded.progress;
let page: Page = loaded.shot === 'live' ? 'live' : loaded.shot === 'plan' ? 'plan' : 'review';
let mode: Mode = 'mixed';
let overlay: Overlay = 'none';
let flagDraft = '';
let done = 0;
let due = 0;
let session: Session = openSession([], 'all', Date.now());

start();
if (loaded.shot === 'revealed') {
  const card = currentCard();
  if (card && card.options.some((option) => option.id === card.correctId)) {
    session = reduce(session, { type: 'choose', optionId: card.correctId }, card).session;
  }
  if (card) session = reduce(session, { type: 'reveal', now: Date.now() }, card).session;
}

function isFlag(value: unknown): value is ProgressFlag {
  if (!value || typeof value !== 'object') return false;
  const flag = value as ProgressFlag;
  return typeof flag.cardId === 'string' && typeof flag.note === 'string' && typeof flag.at === 'string';
}

function loadProgress(value: (ProgressFile & { shot?: unknown }) | undefined): { progress: ProgressFile; shot: string | null } {
  const shot = value && typeof value.shot === 'string' ? value.shot : null;
  if (!value || value.version !== 1 || !value.cards || !value.streak) return { progress: emptyProgress(), shot };
  const next: ProgressFile = { version: 1, cards: value.cards, streak: value.streak };
  if (Array.isArray(value.flags)) next.flags = value.flags.filter(isFlag);
  return { progress: next, shot };
}

function cardsNow(): Card[] {
  return library(snapshot);
}

function queueFor(nextPage: Page, nextMode: Mode): string[] {
  const cards = cardsNow();
  const now = snapshot?.now ?? new Date().toISOString();
  if (nextPage === 'plan') return planQueue(cards);
  const pool = modePool(cards, nextMode);
  if (nextPage === 'exam') {
    const questions = pool.filter((card) => card.kind === 'mcq');
    return selectQueue({
      cards: questions.length ? questions : pool,
      concepts,
      memories: progress.cards,
      now,
      filter: 'all',
      dueOnly: questions.length ? false : undefined,
    });
  }
  return selectQueue({
    cards: pool,
    concepts,
    memories: progress.cards,
    now,
    filter: 'all',
  });
}

function start(): void {
  const queue = sitting(page) ? queueFor(page, mode) : [];
  session = openSession(queue, 'all', Date.now());
  done = 0;
  due = queue.length;
}

function currentCard(): Card | null {
  const id = session.queue[session.index];
  return cardsNow().find((card) => card.id === id) ?? null;
}

function render(): void {
  const card = currentCard();
  const ids = staticCards.map((item) => item.id).concat(laterCard.id);
  app!.innerHTML = renderShell({
    page,
    mode,
    card,
    phase: session.phase,
    selected: session.selected,
    done,
    due,
    profileDue: queueFor('review', 'mixed').length,
    retentionPct: Math.round(meanRetrieval(progress, ids) * 100),
    streak: progress.streak.count,
    snapshot,
    sources,
    cards: cardsNow(),
    overlay,
    flagDraft,
    flagged: (progress.flags ?? []).some((flag) => flag.cardId === card?.id),
    shortcuts: shortcutRows(session.phase),
  });
  const dialog = app!.querySelector('[role="dialog"]');
  if (dialog && !dialog.contains(document.activeElement)) {
    (dialog.querySelector('textarea, button') as HTMLElement | null)?.focus();
  }
  window.__TRAINING_READY = true;
}

function persist(): void {
  window.isobar?.save?.(progress);
}

function record(card: Card, quality: number, responseTimeMs: number): void {
  const day = localDay(new Date(snapshot?.now ?? Date.now()), 'Australia/Sydney');
  progress = applyGrade(progress, card.id, {
    quality,
    at: snapshot?.now ?? new Date().toISOString(),
    responseTimeMs,
    complexity: card.complexity,
    day,
  });
  persist();
}

function reveal(): void {
  const card = currentCard();
  session = reduce(session, { type: 'reveal', now: Date.now() }, card).session;
  render();
}

function choose(optionId: string): void {
  session = reduce(session, { type: 'choose', optionId }, currentCard()).session;
  render();
}

function commitGrade(quality: number): void {
  const card = currentCard();
  const next = reduce(session, { type: 'grade', quality, now: Date.now() }, card);
  if (!next.grade || !card) return;
  session = next.session;
  done += 1;
  record(card, next.grade.quality, next.grade.responseTimeMs);
  render();
}

function go(next: Page): void {
  overlay = 'none';
  page = next;
  if (sitting(next)) start();
  render();
}

function submitFlag(): void {
  const card = currentCard();
  overlay = 'none';
  if (card) {
    progress = {
      ...progress,
      flags: [...(progress.flags ?? []), {
        cardId: card.id,
        note: flagDraft.trim(),
        at: snapshot?.now ?? new Date().toISOString(),
      }],
    };
    persist();
  }
  flagDraft = '';
  render();
}

function onKey(event: KeyboardEvent): void {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
  const card = currentCard();
  const intent = keyIntent({
    key: event.key,
    code: event.code,
    phase: session.phase,
    overlay,
    typing,
    shift: event.shiftKey,
    optionIds: card?.options.map((option) => option.id) ?? [],
  });
  if (intent.type === 'ignore') return;
  if (intent.type !== 'choose') event.preventDefault();
  if (intent.type === 'choose') choose(intent.optionId);
  else if (intent.type === 'reveal') reveal();
  else if (intent.type === 'grade') commitGrade(intent.quality);
  else if (intent.type === 'flag') { overlay = 'flag'; flagDraft = ''; render(); }
  else if (intent.type === 'shortcuts') { overlay = 'shortcuts'; render(); }
  else if (intent.type === 'submit-flag') submitFlag();
  else if (intent.type === 'dismiss') { overlay = 'none'; render(); }
  else if (intent.type === 'close') window.isobar?.close?.();
}

app.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const closedDifficulty = overlay === 'difficulty' && !target.closest('.diff');
  if (closedDifficulty) overlay = 'none';
  if (target.closest('[data-submit-flag]')) { submitFlag(); return; }
  if (target.closest('[data-reveal]')) { reveal(); return; }
  const gradeButton = target.closest('[data-grade]') as HTMLElement | null;
  if (gradeButton?.dataset.grade) { commitGrade(Number(gradeButton.dataset.grade)); return; }
  const option = target.closest('[data-option]') as HTMLElement | null;
  if (option?.dataset.option) { choose(option.dataset.option); return; }
  if (target.closest('[data-flag]')) { overlay = 'flag'; flagDraft = ''; render(); return; }
  if (target.closest('[data-shortcuts]')) { overlay = 'shortcuts'; render(); return; }
  if (target.closest('[data-difficulty]')) {
    overlay = overlay === 'difficulty' ? 'none' : 'difficulty';
    render();
    return;
  }
  const dismiss = target.closest('[data-dismiss]') as HTMLElement | null;
  if (dismiss && !(dismiss.classList.contains('overlay') && target !== dismiss)) {
    overlay = 'none';
    render();
    return;
  }
  const pageButton = target.closest('[data-page]') as HTMLElement | null;
  if (pageButton?.dataset.page) { go(pageButton.dataset.page as Page); return; }
  if (closedDifficulty) render();
});

app.addEventListener('change', (event) => {
  const select = event.target as HTMLSelectElement;
  if (!(select instanceof HTMLSelectElement)) return;
  if (select.dataset.mode != null) {
    mode = select.value as Mode;
    if (page !== 'exam') page = 'review';
    overlay = 'none';
    start();
    render();
    return;
  }
  if (select.dataset.chip != null) {
    if (select.value === 'live') { go('live'); return; }
    mode = select.value as Mode;
    page = 'review';
    overlay = 'none';
    start();
    render();
  }
});

app.addEventListener('input', (event) => {
  const area = event.target;
  if (area instanceof HTMLTextAreaElement) flagDraft = area.value;
});

document.addEventListener('keydown', onKey);
render();
