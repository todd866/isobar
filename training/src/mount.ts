import { concepts, learnSources, sources } from './catalog.ts';
import { library, staticCards, laterCard } from './deck.ts';
import { answerCard, chooseCard, conceptState, lowCommitment, overridePrior, shownLevel, teachingServe, scaffoldStep, mulberry32, type Person } from './ability.ts';
import { anchorCard, cueFromSnapshot, learnCards } from './learn-cards.ts';
import type { LearnRecord } from './learn-profile.ts';
import { chipLabel, isLearnLevel, isLearnRules, levelChoices, showsRules, type LearnLevel, type LearnRules } from './levels.ts';
import { applyGrade, emptyProgress, localDay, meanRetrieval, type ProgressFile, type ProgressFlag } from './progress.ts';
import { selectQueue } from './queue.ts';
import { insertNext, openSession, reduce, type Session } from './session.ts';
import { judge, nextSupport, noteGrade, noteMiss, originOf, retestCard, transferCard, worksheet } from './adaptive.ts';
import { activeStep, markStep, solved as worksheetSolved } from './worksheet.ts';
import { parseEntry } from './skills/format.ts';
import type { Snapshot } from './snapshot.ts';
import type { Card } from './model.ts';
import { modePool, planQueue, sitting, type Mode, type Page } from './chrome.ts';
import { keyIntent, shortcutRows, type Overlay } from './keys.ts';
import { renderShell } from './view.ts';
import { FlightComputer } from './instruments/e6b/index.ts';
import { mountLab, type LabInstrumentId } from './instruments/lab.ts';
import { mount as mountInstrument } from './instruments/index.ts';
import { instrumentForCard } from './instruments/support.ts';
import type { InstrumentMode } from './instruments/types.ts';
import { PREVIEW_DRILLS } from './skills/index.ts';

/** The native bridge and browser storage are adapters around the same trainer. */
export interface TrainerStorage {
  load(): ProgressFile | null | undefined;
  save(progress: ProgressFile): void;
}

export interface TrainerOptions {
  snapshot?: Snapshot | null;
  storage?: TrainerStorage;
  navigation?: 'rail' | 'tabs';
  theme?: 'light' | 'dark';
  close?: () => void;
  /** Deterministic local previews, also used by the native screenshot tools. */
  preview?: { card?: string; drills?: boolean; page?: Page; revealed?: boolean; labInstrument?: LabInstrumentId; labMode?: InstrumentMode };
  /** A graded answer. The site logs it; the native app leaves it unset. */
  onAnswer?: (answer: { id: string; quality: number }) => void;
  /** Level queue. Absent for the ATPL bank. */
  learn?: {
    record: LearnRecord;
    place?: string | null;
    onChange?: (record: LearnRecord) => void;
    onExplain?: (detail: { cardId: string; level: string; rules: string | null; stem: string }) => void;
  };
}

export interface Trainer {
  setSnapshot(snapshot: Snapshot): void;
  setTheme(theme: 'light' | 'dark'): void;
  worksheetSteps(): { id: string; text: string }[];
  dispose(): void;
}

/** Renders a local card synchronously; live data may be supplied later. */
export function mountTrainer(app: HTMLElement, options: TrainerOptions = {}): Trainer {
  app.classList.add('trainer');
  if (!app.hasAttribute('tabindex')) app.tabIndex = -1;
  app.dataset.theme = options.theme ?? 'light';
  const drillPreview = options.preview?.drills ?? false;
  const onlyCard = options.preview?.card;

  const loaded = loadProgress(options.storage?.load());
  let snapshot: Snapshot | null = options.snapshot ?? null;
  let progress: ProgressFile = loaded;
  let cards = library(snapshot);
  let page: Page = options.preview?.page ?? 'review';
  let toolOpen = false;
  let labInstrument: LabInstrumentId = options.preview?.labInstrument ?? 'e6b';
  let labMode: InstrumentMode = options.preview?.labMode ?? 'learn';
  let labMount: ReturnType<typeof mountLab> | null = null;
  let supportOpen = false;
  let supportMount: ReturnType<typeof mountInstrument> | null = null;
  let supportCardId: string | null = null;
  let cardComputerId: string | null = null;
  let cardComputer: FlightComputer | null = null;
  let mode: Mode = 'mixed';
  let overlay: Overlay = 'none';
  let flagDraft = '';
  let numericDraft = '';
  let done = 0;
  let due = 0;
  let session: Session = openSession([], 'all', Date.now());
  /** Follow-up cards made during this sitting, by id. */
  const extra = new Map<string, Card>();
  let work: Record<string, string> = {};
  let committed = new Set<string>();
  let learnRecord: LearnRecord | null = options.learn?.record.person ? options.learn.record : null;
  let person: Person | null = learnRecord?.person ?? null;
  const learnRng = mulberry32(((learnRecord?.updatedAt.length ?? 1) * 997) >>> 0);

  function learnPool(): Card[] {
    const learner = person;
    if (!learner) return [];
    return learnCards.filter((card) => {
      if (!card.strands?.length || typeof card.difficulty !== 'number') return false;
      if (card.rules && card.rules !== 'both' && learner.rules && card.rules !== learner.rules) return false;
      if (!learner.rules && card.rules && card.rules !== 'both') return false;
      return true;
    });
  }

  function pickLearn(position: number): Card | null {
    if (!person) return null;
    const used = new Set(session.queue);
    const pool = learnPool().filter((card) => !used.has(card.id)).map((card) => ({
      ...card,
      strands: card.strands ?? [],
      difficulty: card.difficulty ?? 0,
      conceptId: card.conceptIds[0] ?? card.id,
    }));
    return chooseCard(person, pool, learnRng, {
      position,
      consecutiveFailures: person.consecutiveFailures,
      lowCommitment: lowCommitment(person),
    });
  }

  function currentAnchor(): Card | null {
    if (!person || !learnRecord) return null;
    return anchorCard({
      level: learnRecord.level,
      rules: person.rules,
      goal: person.goal,
      cue: cueFromSnapshot(snapshot, options.learn?.place),
    });
  }

  function openLearn(): void {
    const anchor = currentAnchor();
    if (!anchor) return;
    extra.set(anchor.id, anchor);
    const queue = [anchor.id];
    session = openSession(queue, 'all', Date.now());
    for (let i = 0; i < 8; i += 1) {
      const next = pickLearn(i + 1);
      if (!next) break;
      extra.set(next.id, next);
      queue.push(next.id);
    }
    session = { ...session, queue };
    done = 0;
    due = queue.length;
  }

  function replaceAnchor(): void {
    if (session.index !== 0 || session.phase !== 'ask' || session.selected) return;
    const anchor = currentAnchor();
    if (anchor) extra.set(anchor.id, anchor);
  }

  function learnView(): { value: string; options: { value: string; label: string }[] } | null {
    if (!person) return null;
    const shown = shownLevel(person);
    const rules = showsRules(shown.level) ? person.rules : null;
    const chip = chipLabel(shown.level, rules, shown.trend);
    const value = `${shown.level}|${showsRules(shown.level) ? (person.rules ?? 'aus') : 'x'}`;
    return { value, options: levelChoices().map((option) => ({ value: option.value, label: option.value === value ? chip : option.label })) };
  }

  function remember(next: Person): void {
    person = next;
    if (!learnRecord) return;
    const shown = shownLevel(next);
    learnRecord = {
      ...learnRecord,
      person: next,
      level: shown.level,
      rules: showsRules(shown.level) ? next.rules : null,
      goal: next.goal,
      updatedAt: new Date().toISOString(),
    };
    progress = { ...progress, learn: learnRecord };
    persist();
    options.learn?.onChange?.(learnRecord);
  }

  start();
  if (options.preview?.revealed) {
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

  function loadProgress(value: ProgressFile | null | undefined): ProgressFile {
    if (!value || value.version !== 1 || !value.cards || !value.streak) return emptyProgress();
    const next: ProgressFile = { version: 1, cards: value.cards, streak: value.streak };
    if (Array.isArray(value.flags)) next.flags = value.flags.filter(isFlag);
    if (value.e6b && typeof value.e6b === 'object') next.e6b = value.e6b;
    if (value.skills && typeof value.skills === 'object') next.skills = value.skills;
    if (value.learn && typeof value.learn === 'object') next.learn = value.learn;
    return next;
  }

  function cardsNow(): Card[] {
    // A Ministry citation can request one generated Learn card explicitly.
    // Keep the ordinary ATPL library and adaptive queue unchanged.
    const linked = onlyCard && options.learn ? learnPool().find(card => card.id === onlyCard) : null;
    return linked ? [...cards, linked] : cards;
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
    work = {};
    committed = new Set();
    numericDraft = '';
    supportOpen = false;
    toolOpen = false;
    if (onlyCard) {
      if (page !== 'lab') page = 'review';
      mode = cardsNow().find((card) => card.id === onlyCard)?.kind === 'numeric' ? 'performance' : 'mixed';
      session = openSession([onlyCard], 'all', Date.now());
      done = 0;
      due = 1;
      return;
    }
    if (drillPreview) {
      if (page !== 'lab') page = 'review';
      mode = 'performance';
      session = openSession(PREVIEW_DRILLS, 'all', Date.now());
      done = 0;
      due = PREVIEW_DRILLS.length;
      return;
    }
    if (options.learn && page === 'review') {
      openLearn();
      return;
    }
    const queue = sitting(page) ? queueFor(page, mode) : [];
    session = openSession(queue, 'all', Date.now());
    done = 0;
    due = queue.length;
  }

  function currentCard(): Card | null {
    const id = session.queue[session.index];
    if (id && extra.has(id)) return extra.get(id)!;
    return cardsNow().find((card) => card.id === id) ?? null;
  }

  let renderedCard: string | null = null;

  function render(): void {
    const card = currentCard();
    const focused = document.activeElement instanceof HTMLElement && app.contains(document.activeElement) ? document.activeElement : null;
    const focusAttribute = focused ? ['data-page', 'data-mode', 'data-chip', 'data-option', 'data-grade', 'data-reveal', 'data-numeric-submit', 'data-flag', 'data-shortcuts', 'data-difficulty'].find((name) => focused.hasAttribute(name)) : undefined;
    const focusSelector = focusAttribute ? `[${focusAttribute}="${CSS.escape(focused!.getAttribute(focusAttribute)!)}"]` : null;
    const navScroll = app.querySelector('.sections')?.scrollLeft ?? 0;
    // Re-rendering the same card (a worksheet keystroke) must not jump the scroll.
    const keep = card?.id === renderedCard ? app!.querySelector('.stage')?.scrollTop ?? 0 : 0;
    const ids = staticCards.map((item) => item.id).concat(laterCard.id);
    const labHost = page === 'lab' ? app.querySelector<HTMLElement>('[data-lab-host]') : null;
    const supportHost = sitting(page) && supportOpen && supportCardId === card?.id
      ? app.querySelector<HTMLElement>('[data-instrument-support]') : null;
    if (!labHost) { labMount?.destroy(); labMount = null; }
    if (!supportHost) { supportMount?.destroy(); supportMount = null; supportCardId = null; }
    // Hidden flight computers must not retain timers or document listeners.
    if (!sitting(page) || !toolOpen || card?.tool !== 'e6b' || cardComputerId !== card.id) {
      cardComputer?.destroy(); cardComputer = null; cardComputerId = null;
    }
    app!.innerHTML = renderShell({
      page,
      navigation: options.navigation,
      mode,
      card,
      phase: session.phase,
      selected: session.phase === 'ask' && card?.kind === 'numeric' ? numericDraft : session.selected,
      done,
      due,
      profileDue: queueFor('review', 'mixed').length,
      retentionPct: Math.round(meanRetrieval(progress, ids) * 100),
      streak: progress.streak.count,
      snapshot,
      sources: options.learn ? learnSources : sources,
      cards: cardsNow(),
      learn: learnView(),
      overlay,
      flagDraft,
      flagged: (progress.flags ?? []).some((flag) => flag.cardId === card?.id),
      toolOpen,
      shortcuts: shortcutRows(session.phase, card?.kind === 'numeric' ? 'numeric' : 'mcq'),
      work,
      committed: [...committed],
      supportInstrument: instrumentForCard(card),
      supportOpen,
    });
    const nextLab = app.querySelector<HTMLElement>('[data-lab-host]');
    if (nextLab) {
      if (labHost) nextLab.replaceWith(labHost);
      else labMount = mountLab(nextLab, {
        instrument: labInstrument, mode: labMode, store: e6bStore, live: liveContext(),
        theme: app.dataset.theme as 'light' | 'dark',
        onChange: (instrument, mode) => { labInstrument = instrument; labMode = mode; },
      });
    }
    const nextSupport = app.querySelector<HTMLElement>('[data-instrument-support]');
    if (nextSupport) {
      if (supportHost) nextSupport.replaceWith(supportHost);
      else {
        const instrument = instrumentForCard(card);
        if (instrument && card) {
          supportMount = mountInstrument(nextSupport, { instrument, mode: 'learn', card });
          supportCardId = card.id;
        }
      }
    }
    const side = app.querySelector('[data-e6b-host="card"]');
    if (side) {
      (cardComputer ??= new FlightComputer({ variant: 'card' })).mount(side);
      cardComputerId = card?.id ?? null;
    }
    app.querySelectorAll<HTMLElement>('.e6b').forEach((instrument) => { instrument.dataset.theme = app.dataset.theme; });
    renderedCard = card?.id ?? null;
    const stage = app!.querySelector('.stage');
    if (stage && keep) stage.scrollTop = keep;
    const dialog = app!.querySelector('[role="dialog"]');
    if (dialog && !dialog.contains(document.activeElement)) {
      (dialog.querySelector('textarea, button') as HTMLElement | null)?.focus();
    }
    const sections = app.querySelector('.sections');
    if (sections) sections.scrollLeft = navScroll;
    if (focused && overlay === 'none' && !app.contains(document.activeElement)) {
      (focusSelector ? app.querySelector<HTMLElement>(focusSelector) ?? app : app).focus({ preventScroll: true });
    }
    if (sitting(page) && !(supportOpen && matchMedia('(max-width: 1000px)').matches) && overlay === 'none' && card?.kind === 'numeric' && session.phase === 'ask') focusEntry(card);
    app.dataset.trainingReady = 'true';
  }

  /** E6-B skill memory lives in the progress file beside the cards, reviewed by the same scheduler. */
  const e6bStore = {
    load: () => progress.e6b ?? null,
    save: (record: NonNullable<ProgressFile['e6b']>) => { progress = { ...progress, e6b: record }; persist(); },
  };

  /** Today's winds and temperatures for the E6-B's situations, where the snapshot has them. */
  function liveContext() {
    if (!snapshot) return undefined;
    return { airports: snapshot.airports.map((a) => ({ icao: a.icao, windFrom: a.sample?.windFromDeg ?? null, windKt: a.sample?.windKt ?? null, tempC: a.sample?.t2mC ?? null })) };
  }

  /** Focus the answer field, or on a retest the step `stepId` (default: the first not yet right). */
  function focusEntry(card: Card, stepId?: string): void {
    if (card.drill?.stage !== 'retest') {
      const field = app!.querySelector('[data-numeric]');
      if (field instanceof HTMLInputElement) field.focus({ preventScroll: true });
      return;
    }
    const steps = worksheet(card);
    const id = stepId ?? steps[Math.max(0, activeStep(steps, work))]?.id;
    const field = id ? app!.querySelector(`[data-step="${CSS.escape(id)}"]`) : null;
    if (field instanceof HTMLInputElement) {
      // On arrival keep the slip and the stem in view; while working, follow the step.
      field.focus({ preventScroll: !stepId });
      if (stepId) field.scrollIntoView({ block: 'nearest' });
      const end = field.value.length;
      field.setSelectionRange(end, end);
    }
  }

  function persist(): void {
    options.storage?.save(progress);
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
    options.onAnswer?.({ id: card.id, quality });
  }

  function submitNumeric(text: string): void {
    const card = currentCard();
    if (!card || card.kind !== 'numeric' || session.phase !== 'ask') return;
    if (card.drill?.stage === 'retest') { checkWorksheet(); return; }
    if (parseEntry(text) == null) return;
    const now = Date.now();
    const verdict = judge(card, text, now - session.shownAt);
    const follow = verdict.outcome === 'correct' ? null : retestCard(card, verdict);
    if (!follow) {
      session = reduce(session, { type: 'answer', text }, card).session;
      numericDraft = '';
      render();
      return;
    }
    // The miss is objective evidence: Again when wrong, Hard when right but slow.
    record({ ...card, id: originOf(card) }, verdict.outcome === 'wrong' ? 1 : 2, now - session.shownAt);
    progress = { ...progress, skills: noteMiss(progress.skills ?? {}, card, verdict, snapshot?.now ?? new Date(now).toISOString()) };
    persist();
    extra.set(follow.id, follow);
    session = reduce(session, { type: 'follow', id: follow.id, now }, card).session;
    done += 1;
    due += 1;
    numericDraft = '';
    work = {};
    committed = new Set();
    supportOpen = instrumentForCard(follow) != null;
    render();
  }

  /** Enter on a worksheet: mark the steps typed so far; reveal once every step is right. */
  function checkWorksheet(focusId?: string): void {
    const card = currentCard();
    if (!card || card.drill?.stage !== 'retest' || session.phase !== 'ask') return;
    const steps = worksheet(card);
    for (const step of steps) if ((work[step.id] ?? '').trim()) committed.add(step.id);
    if (worksheetSolved(steps, work)) {
      session = reduce(session, { type: 'answer', text: work[steps.at(-1)!.id] ?? '' }, card).session;
      render();
      return;
    }
    render();
    focusEntry(card, focusId);
  }

  function onStepInput(field: HTMLInputElement): void {
    const card = currentCard();
    const id = field.dataset.step;
    if (!card || !id || session.phase !== 'ask') return;
    work = { ...work, [id]: field.value };
    committed.delete(id);
    const steps = worksheet(card);
    const step = steps.find((item) => item.id === id);
    if (!step) return;
    if (worksheetSolved(steps, work)) { checkWorksheet(); return; }
    const ok = markStep(step, field.value) === 'ok';
    const next = ok ? steps[steps.indexOf(step) + 1] : undefined;
    render();
    focusEntry(card, next && markStep(next, work[next.id] ?? '') !== 'ok' ? next.id : id);
  }

  function reveal(): void {
    const card = currentCard();
    session = reduce(session, { type: 'reveal', now: Date.now() }, card).session;
    // A wrong answer on a calculation card opens the computer beside it.
    if (card?.tool && session.selected && session.selected !== card.correctId) toolOpen = true;
    render();
  }

  function choose(optionId: string): void {
    session = reduce(session, { type: 'choose', optionId }, currentCard()).session;
    render();
  }

  function numericSolved(card: Card): boolean {
    const spec = card.numeric;
    const entered = session.selected == null ? null : parseEntry(session.selected);
    return !!spec && entered != null && Math.abs(entered - spec.value) <= spec.tolerance;
  }

  function commitGrade(quality: number): void {
    const card = currentCard();
    if (!card || session.phase !== 'revealed') return;
    if (person && card.strands?.length && typeof card.difficulty === 'number') {
      const correct = card.kind === 'mcq' ? session.selected === card.correctId : quality >= 3;
      const responseMs = Math.max(0, Date.now() - session.shownAt);
      const conceptId = card.conceptIds[0] ?? card.id;
      const nextPerson = answerCard(person, {
        id: card.id, strands: card.strands, difficulty: card.difficulty, conceptId,
      }, correct, responseMs, Date.now());
      remember(nextPerson);
      if (!correct && teachingServe(conceptState(nextPerson, conceptId)) === 'scaffold' && scaffoldStep(nextPerson.consecutiveFailures) === 'retest') {
        session = insertNext(session, card.id);
        due += 1;
      }
      if (session.index + 1 >= session.queue.length) {
        const upcoming = pickLearn(session.index + 1);
        if (upcoming) {
          extra.set(upcoming.id, upcoming);
          session = { ...session, queue: [...session.queue, upcoming.id] };
          due += 1;
        }
      }
    }
    const solvedIt = card.kind === 'numeric' && numericSolved(card);
    // A follow-up is queued before the grade moves the session on, so it comes next.
    const support = card.drill ? nextSupport(card, solvedIt) : null;
    if (card.drill && support != null) {
      const follow = transferCard(card, support);
      if (follow) {
        extra.set(follow.id, follow);
        session = insertNext(session, follow.id);
        due += 1;
      }
    }
    const next = reduce(session, { type: 'grade', quality, now: Date.now() }, card);
    if (!next.grade) return;
    session = next.session;
    toolOpen = false;
    supportOpen = false;
    done += 1;
    work = {};
    committed = new Set();
    const stage = card.drill?.stage;
    if (card.drill) progress = { ...progress, skills: noteGrade(progress.skills ?? {}, card, solvedIt, snapshot?.now ?? new Date().toISOString()) };
    // A supported retest is not independent evidence; a transfer counts for the card that started the loop.
    if (stage === 'retest') persist();
    else record(stage === 'transfer' ? { ...card, id: originOf(card) } : card, next.grade.quality, next.grade.responseTimeMs);
    render();
  }

  function go(next: Page): void {
    overlay = 'none';
    toolOpen = false;
    supportOpen = false;
    const wasLab = page === 'lab';
    page = next;
    // Lab is a companion: keep a sitting and its drafts when returning to review.
    if (sitting(next) && !(wasLab && next === 'review' && session.queue.length)) start();
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
    if (target && target !== document.body && !app.contains(target)) return;
    // The instrument owns its keys; on the Lab page only Escape and ? reach the trainer.
    if (target?.closest('.e6b, [data-instrument-support], [data-lab-host]')) return;
    if (page === 'lab' && event.key !== 'Escape' && event.key !== '?') return;
    const stepField = target instanceof HTMLInputElement && target.dataset.step != null ? target : null;
    if (stepField && event.key === 'Enter') {
      event.preventDefault();
      checkWorksheet(stepField.dataset.step);
      return;
    }
    const field = target instanceof HTMLInputElement && target.dataset.numeric != null ? target : null;
    if (field && event.key === 'Enter') {
      event.preventDefault();
      submitNumeric(field.value);
      return;
    }
    if ((field || stepField) && event.key === ' ') {
      event.preventDefault();
      reveal();
      return;
    }
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
    else if (intent.type === 'close') options.close?.();
  }

  function onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('.e6b, [data-instrument-support], [data-lab-host]')) return;
    if (target.closest('[data-instrument-open]')) { supportOpen = true; render(); return; }
    if (target.closest('[data-support-return]')) { supportOpen = false; render(); return; }
    if (target.closest('[data-tool]')) { toolOpen = !toolOpen; render(); return; }
    const closedDifficulty = overlay === 'difficulty' && !target.closest('.diff');
    if (closedDifficulty) overlay = 'none';
    if (target.closest('[data-submit-flag]')) { submitFlag(); return; }
    if (target.closest('[data-numeric-submit]')) {
      if (currentCard()?.drill?.stage === 'retest') { checkWorksheet(); return; }
      const field = app!.querySelector('[data-numeric]');
      submitNumeric(field instanceof HTMLInputElement ? field.value : numericDraft);
      return;
    }
    if (target.closest('[data-reveal]')) { reveal(); return; }
    const gradeButton = target.closest('[data-grade]') as HTMLElement | null;
    if (gradeButton?.dataset.grade) { commitGrade(Number(gradeButton.dataset.grade)); return; }
    const option = target.closest('[data-option]') as HTMLElement | null;
    if (option?.dataset.option) { choose(option.dataset.option); return; }
    if (target.closest('[data-explain]')) {
      const card = currentCard();
      if (card && person) {
        const shown = shownLevel(person);
        options.learn?.onExplain?.({
          cardId: card.id,
          level: shown.level,
          rules: showsRules(shown.level) ? person.rules : null,
          stem: card.stem,
        });
      }
      return;
    }
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
  }

  function onChange(event: Event): void {
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
    if (select.dataset.level != null && person) {
      const [level, rules] = select.value.split('|');
      if (!isLearnLevel(level)) return;
      const nextRules: LearnRules | null = isLearnRules(rules) ? rules : person.rules;
      remember(overridePrior(person, level as LearnLevel, nextRules, Date.now()));
      replaceAnchor();
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
  }

  function onInput(event: Event): void {
    const area = event.target;
    if (area instanceof HTMLTextAreaElement) flagDraft = area.value;
    if (area instanceof HTMLInputElement && area.dataset.numeric != null) numericDraft = area.value;
    if (area instanceof HTMLInputElement && area.dataset.step != null) onStepInput(area);
  }

  function worksheetSteps() {
    const card = currentCard();
    return card ? worksheet(card).map((step) => ({ id: step.id, text: String(Math.round(step.value * 10 ** step.decimals) / 10 ** step.decimals) })) : [];
  };

  app.addEventListener('click', onClick);
  app.addEventListener('change', onChange);
  app.addEventListener('input', onInput);
  const keyboardTarget = options.navigation === 'tabs' ? app : document;
  keyboardTarget.addEventListener('keydown', onKey as EventListener);
  render();
  if (document.activeElement === document.body) app.focus({ preventScroll: true });
  let disposed = false;
  return {
    setSnapshot(next: Snapshot): void {
      if (disposed) return;
      // A late snapshot must not replace the question or discard an answer draft.
      const current = currentCard();
      if (current) extra.set(current.id, current);
      snapshot = next;
      cards = library(snapshot);
      if (options.learn) {
        replaceAnchor();
        labMount?.setLive(liveContext());
        render();
        return;
      }
      labMount?.setLive(liveContext());
      if (sitting(page) && !onlyCard && !drillPreview) {
        const added = queueFor(page, mode).filter((id) => !session.queue.includes(id));
        session = { ...session, queue: [...session.queue, ...added] };
        due += added.length;
      }
      // Active review remains untouched until the next interaction. Live/empty
      // views can fill immediately without stealing keyboard focus from the site.
      if (!sitting(page) || !current) render();
    },
    setTheme(theme: 'light' | 'dark'): void {
      if (disposed) return;
      app.dataset.theme = theme;
      labMount?.setTheme(theme);
      app.querySelectorAll<HTMLElement>('.e6b').forEach((instrument) => { instrument.dataset.theme = theme; });
    },
    worksheetSteps,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      keyboardTarget.removeEventListener('keydown', onKey as EventListener);
      app.removeEventListener('click', onClick);
      app.removeEventListener('change', onChange);
      app.removeEventListener('input', onInput);
      labMount?.destroy();
      supportMount?.destroy();
      cardComputer?.destroy();
      app.replaceChildren();
      delete app.dataset.trainingReady;
    },
  };
}
