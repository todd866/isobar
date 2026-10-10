/** The interactive flight computer. The instrument is the stage: it fills the
 * space, and everything else is one slim strip of controls, a task card, and
 * coach marks drawn on the instrument itself. One instance keeps its state across
 * the trainer's re-renders; `mount(host)` re-attaches it.
 *
 * Modes: Learn (each skill as Watch → Guided → Solo, with fading), Practice
 * (situations on Australian routes, the Daily E6-B set, chained missions, exam
 * mode) and Free.
 *
 * Input: drag anywhere on the blue disc to turn it (gentle inertia); drag the red
 * hairline or its handle at the rim to move it (it settles on the nearest
 * graduation; hold Option/Alt for free movement); drag the black outer ring to
 * turn it against the disc (disc and hairline stay put on screen); a tap on it
 * brings the hairline there. Wheel or pinch zooms, double-click centres.
 * Keys with the dial focused: arrows turn the disc (Shift ×10), Option+arrows
 * move the hairline, [ / ] turn the view, +/− zoom, 0 upright/centre, Enter next.
 */
import { E6B_PROCEDURES, exercisesFor, problemForProcedure, validateProcedureStep, procedureDiagnosis, type ProcedureExercise } from './procedures.ts';
import { homeHtml, homeLineHtml, nextExercise, problemLine, FIRST_CONTACT, componentTableSvg } from './launch.ts';
import { briefStep, esc, flowHtml, stepLine, type FlowView, type StepView } from './ui.ts';
import { FLOW_ORDER, SET_SIZE, afterProblem, autoStep, crossCheck, estimateAsk, flowProblem, helpLevel, methodLine, moveLine, num, questionLine, readLine, whyLine, type Beat, type HelpLevel } from './flow.ts';
import { manualDemos, windDemos, type Demo, type Highlight, type Step } from './demos.ts';
import { E6B, mark, scale, type Face } from './face.ts';
import { aids, actionFor, autoSteps, goalMet, graduationAngles, nextGraduation, plain, readoutLine, snapCursor, stepGoals, stepMet, tags, type Goal, type Pose } from './coach.ts';
import { checkText, diagnose, estimateText, gradeEstimate } from './feedback.ts';
import { MISSIONS, carry, missionProblem, type Mission } from './missions.ts';
import { SHAPES, SHAPE_NAMES, check, makeProblem, parseAnswer, rng, type Given, type LiveContext, type Problem, type Shape, type Verdict } from './practice.ts';
import { polar, renderFace, renderGhost } from './render.ts';
import { rotatePoint, viewToFace, gestureNumbers } from './view.ts';
import { forInput, gestureApply, pinchFactor, touchPrimary, wheelPixels, wheelSpin, wheelTurn } from './input.ts';
import { dailySet, finishDaily, nextAction, parseRecord, recordAttempt, skillState, type E6BRecord, type Stage } from './skills.ts';
import { angleOf, hmm, norm, turn } from './slide.ts';
import { E6B_CSS, injectE6BStyles } from './styles.ts';
import { coachHtml, howHtml, menuHtml, readoutHtml, readoutPanelHtml, stripHtml, taskHtml, type CoachView, type MenuRow, type Mode, type Side, type TaskView, type Variant } from './ui.ts';
import { PLATE_R, SLIDE, U, HIGH_SPEED_SLIDE, toPlate, toScreen, wrap360, type WindState } from './wind.ts';
import { renderWind } from './windrender.ts';

export type { Variant } from './ui.ts';

const RECORD_KEY = 'isobar.e6b.record';
const HINT_KEY = 'isobar.e6b.hinted';
const LOUPE_KEY = 'isobar.e6b.loupe';
const GHOST_KEY = 'isobar.e6b.ghosted';
/** Loupe magnification at the whole-face view; it eases off as the view zooms in. */
const LOUPE_POWER = 2.4;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Face units across the view: the face (r 1480) plus room for the hairline handle. */
const VIEW = 3160;
const MIN_VIEW = 420;
const MOVE_MS = 900;
const DWELL_MS = 2400;
const AUTO_MS = 1100;

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const clock = (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const today = (): string => new Date().toLocaleDateString('en-CA');

/** Where the learner's problems come from in Practice. */
type Source =
  | { kind: 'daily'; set: Shape[]; index: number; misses: number; results: ('ok' | 'miss')[] }
  | { kind: 'mixed' }
  | { kind: 'skill'; shape: Shape }
  | { kind: 'mission'; mission: Mission; index: number; carried: number[]; own: boolean[]; decided: boolean | null };

/** A guided, watched or replayed run through a demo's steps. */
interface Sequence {
  demo: Demo;
  kind: 'watch' | 'guided' | 'replay';
  round: number;
  index: number;
  auto: boolean[];
  goals: Goal[];
  met: boolean;
  then: () => void;
}

export interface E6BStore { load(): unknown; save(record: E6BRecord): void }

export interface E6BOptions {
  variant?: Variant;
  face?: Face;
  seed?: number;
  /** Where skill memory lives. Defaults to localStorage; the trainer passes its progress file. */
  store?: E6BStore;
  /** Today's data for the situations (winds, temperatures), from the trainer's snapshot. */
  live?: LiveContext;
}

const scaleAt = (scale: string, value: number): Highlight => ({ kind: 'scale', scale, value });

/** The manual's worked example for each skill, as the learner meets it in Watch and the first Guided round. */
const MANUAL_BRIEF: Record<Shape, [string, Given[]]> = {
  tsd: ['Ground speed 150 kt, 245 NM to go. How long?', [{ label: 'GS', value: '150 kt', highlight: scaleAt('outer', 150) }, { label: 'Distance', value: '245 NM', highlight: scaleAt('outer', 245) }]],
  fuel: ['Burning 7.8 gal/h for 3:20. How much fuel?', [{ label: 'Flow', value: '7.8 gal/h', highlight: scaleAt('outer', 78) }, { label: 'Time', value: '3:20', highlight: scaleAt('middle', 200) }]],
  convert: ['90 NM in statute miles, then 160 kg in pounds.', [{ label: 'NM', value: '90', highlight: scaleAt('middle', 90) }, { label: 'kg', value: '160', highlight: scaleAt('middle', 160) }]],
  tas: ['Pressure altitude 15,000 ft, −15 °C, CAS 145 kt. TAS and density altitude?', [{ label: 'PA', value: '15,000 ft', highlight: scaleAt('pa-as', 15000) }, { label: 'OAT', value: '−15 °C', highlight: scaleAt('temp-as', -15) }, { label: 'CAS', value: '145 kt', highlight: scaleAt('middle', 145) }]],
  mach: ['Mach 1.00 at +15 °C. What TAS?', [{ label: 'Mach', value: '1.00', highlight: scaleAt('middle', 10) }, { label: 'OAT', value: '+15 °C', highlight: scaleAt('temp-as', 15) }]],
  offcourse: ['8 NM off course after 125 NM, 235 NM to go. How far do you turn?', [{ label: 'Off', value: '8 NM', highlight: scaleAt('outer', 8) }, { label: 'Flown', value: '125 NM', highlight: scaleAt('middle', 125) }, { label: 'To go', value: '235 NM', highlight: scaleAt('middle', 235) }]],
  truealt: ['Indicated 12,000 ft, pressure altitude 10,000 ft, −19 °C, station 5,000 ft. True altitude?', [{ label: 'PA', value: '10,000 ft', highlight: scaleAt('pa-alt', 10000) }, { label: 'OAT', value: '−19 °C', highlight: scaleAt('temp-alt', -19) }, { label: 'Height', value: '7,000 ft', highlight: scaleAt('middle', 7000) }]],
  windhdg: ['Wind 230°/18 kt, true course 090°, TAS 125 kt. Heading and ground speed?', [{ label: 'Wind', value: '230°/18', highlight: { kind: 'wind', id: 'dot' } }, { label: 'Course', value: '090°', highlight: { kind: 'wind', id: 'index' } }, { label: 'TAS', value: '125 kt', highlight: { kind: 'arc', value: 125 } }]],
  windfind: ['Heading 160°, course 180°, TAS 140 kt, ground speed 120 kt. What wind?', [{ label: 'Heading', value: '160°', highlight: null }, { label: 'Course', value: '180°', highlight: { kind: 'wind', id: 'index' } }, { label: 'TAS', value: '140 kt', highlight: { kind: 'arc', value: 140 } }, { label: 'GS', value: '120 kt', highlight: null }]],
};

let instances = 0;

const localStore: E6BStore = {
  load() { try { return JSON.parse(localStorage.getItem(RECORD_KEY) ?? 'null'); } catch { return null; } },
  save(record) { try { localStorage.setItem(RECORD_KEY, JSON.stringify(record)); } catch { /* private window */ } },
};

export class FlightComputer {
  readonly el: HTMLElement;
  private readonly face: Face;
  private readonly variant: Variant;
  private readonly id: string;
  private readonly store: E6BStore;
  private live?: LiveContext;
  private readonly grads = graduationAngles();
  private record: E6BRecord;

  // DOM
  private svg!: SVGSVGElement;
  private disc!: SVGGElement;
  private cursorG!: SVGGElement;
  private hlBase!: SVGGElement;
  private hlDisc!: SVGGElement;
  private guideG!: SVGGElement;
  private ghostG!: SVGGElement;
  private ghostDisc!: SVGGElement;
  private tagsG!: SVGGElement;
  private stage!: HTMLElement;
  private dial!: HTMLElement;
  private stripEl!: HTMLElement;
  private taskEl!: HTMLElement;
  private coachEl!: HTMLElement;
  private overlayEl!: HTMLElement;
  private loupe!: HTMLElement;
  private loupeSvg!: SVGSVGElement;
  private loupeView!: SVGGElement;
  private loupeDisc!: SVGGElement;
  private loupeCursor!: SVGGElement;
  private rootG!: SVGGElement;
  private windView: Element | null = null;
  /** Where the learner left the loupe, as a fraction of the dial's square; null follows the hairline. */
  private loupeAt: { x: number; y: number } | null = null;
  private loupeDrag: { id: number; dx: number; dy: number } | null = null;
  /** The dial's square in client px, measured once per layout change instead of on every move. */
  private box: { left: number; top: number; size: number } | null = null;
  private loupeSize = 0;
  private paintFrame = 0;
  private wsvg!: SVGSVGElement;
  private slideG!: SVGGElement;
  private plateG!: SVGGElement;
  private dotG!: SVGGElement;
  private hlWind!: SVGGElement;

  // Instrument state
  private side: Side = 'computer';
  private wind: WindState = { plate: 0, gs: 150, dot: null, slide: 'low' };
  private theta = 0;
  private viewAngle = 0;
  private autoTurn = true;
  private viewTween: { from: number; to: number; start: number } | null = null;
  private cursor = 0;
  private view = { x: 0, y: 0, w: VIEW };
  private showLoupe = true;
  private flipping = false;
  private flipTimer = 0;
  private zoomFrame = 0;

  // Teaching state
  private homeOpen = false;
  private activeExercise: ProcedureExercise | null = null;
  private procedureEntries: Record<number, number> = {};
  private procedureFeedback = '';
  private procedureWhy = false;
  private tourIndex = -1;
  private tourTimer = 0;
  private slideEnd: 'low' | 'high' = 'low';
  private slideTimer = 0;
  private mode: Mode = 'free';
  private exam = false;
  private shape: Shape = 'tsd';
  private stageOf: Stage = 'watch';
  private demos: Demo[];
  private seq: Sequence | null = null;
  private playing = false;
  private dwellTimer = 0;
  private problem: Problem | null = null;
  private estimate = '';
  private estimateLocked = false;
  private answer = '';
  private verdict: Verdict | null = null;
  private decision: boolean | null = null;
  private source: Source = { kind: 'mixed' };
  private easier = new Set<Shape>();
  private rand = rng(Date.now() >>> 0);
  private started = 0;
  private elapsed: number | null = null;
  private timer = 0;
  private menuOpen = false;
  private howOpen = false;
  private howProbe: number | null = null;
  private hover: Highlight | null = null;
  private ghost: { theta: number; cursor: number | null; dot: [number, number] | null } | null = null;
  private highlights: Highlight[] = [];
  private paintedCoach: string | null = null;
  private bests: string | null = null;

  // Motion and input
  private tween: { from: number[]; to: number[]; start: number; ms: number; done: () => void } | null = null;
  private spin: { omega: number; last: number } | null = null;
  private frame = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { kind: 'disc' | 'cursor' | 'ring' | 'pan' | 'plate' | 'slide' | 'view'; tap?: 'disc' | 'base' | null; last: number; raw: number; samples: { t: number; a: number }[]; x: number; y: number; moved: boolean; start: { x: number; y: number }; anchor?: { gs: number; y: number; box: { left: number; top: number; size: number }; view: { x: number; y: number; w: number }; angle: number } } | null = null;
  private pinch: { dist: number; w: number; mid: { x: number; y: number }; angle: number; theta: number; view: number; whole: boolean } | null = null;
  /** Set while a second pointer owns the gesture, so a child handler cannot keep dragging the disc or loupe. */
  private twistOwned = false;
  /** The View dial's in-progress drag; cleared when a second pointer takes the gesture. */
  private viewKnob: { last: number; moved: boolean; x: number; y: number } | null = null;
  private resize: ResizeObserver | null = null;
  /** Phone portrait width: the strip becomes a two-row dock and the coach carries the transport. */
  private narrow = false;
  private moreOpen = false;
  /** Phone coach: the full sentence behind the one-line brief. */
  private coachFull = false;

  constructor(options: E6BOptions = {}) {
    this.face = options.face ?? E6B;
    this.variant = options.variant ?? 'lab';
    this.id = `e6b${++instances}`;
    this.store = options.store ?? localStore;
    this.live = options.live;
    if (options.seed != null) this.rand = rng(options.seed);
    this.record = parseRecord(this.store.load());
    if (typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches) this.showLoupe = false;
    this.demos = [...manualDemos(this.face), ...windDemos()];
    this.el = document.createElement('section');
    this.el.className = `e6b ${this.variant}`;
    this.el.setAttribute('aria-label', 'E6-B flight computer');
    this.build();
    this.cursor = angleOf(10);
    if (this.variant === 'lab') {
      const next = nextAction(this.record, new Date().toISOString(), today());
      this.mode = 'learn';
      this.shape = next.kind === 'learn' || next.kind === 'practice' ? next.shape : 'tsd';
      // Owner: land directly in a problem ready to solve; no start screen, no tour.
      this.startFlow(this.record.flowAt ?? 0);
    } else this.renderChrome();
    this.draw();
  }

  /** Attach to a host element (the trainer re-renders its shell; the instrument survives). */
  mount(host: Element): void {
    injectE6BStyles(host.ownerDocument);
    if (this.el.parentElement !== host) host.replaceChildren(this.el);
    this.resize?.disconnect();
    cancelAnimationFrame(this.paintFrame); this.paintFrame = 0;
    window.removeEventListener('scroll', this.onScroll, true); window.removeEventListener('resize', this.onScroll);
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(() => { this.invalidateBox(); this.updateNarrow(); this.layoutShadow(); this.paintLoupe(); this.placeCoach(); });
      this.resize.observe(this.dial);
      this.resize.observe(this.el);
    }
    this.updateNarrow();
    this.invalidateBox();
    window.removeEventListener('scroll', this.onScroll, true); window.removeEventListener('resize', this.onScroll);
    window.addEventListener('scroll', this.onScroll, { capture: true, passive: true }); window.addEventListener('resize', this.onScroll, { passive: true });
    this.layoutShadow();
    this.draw();
  }

  /** New weather is used for the next situation; an active problem stays put. */
  setLive(live: LiveContext | undefined): void { this.live = live; }

  destroy(): void {
    this.stop();
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.viewTween = null; this.spin = null;
    window.clearTimeout(this.movingTimer);
    window.clearTimeout(this.tourTimer); window.clearTimeout(this.slideTimer); window.clearTimeout(this.hintTimer); window.clearTimeout(this.wheelSettle);
    window.clearInterval(this.timer);
    window.clearTimeout(this.hintTimer);
    window.clearTimeout(this.dwellTimer);
    window.clearTimeout(this.wheelSettle);
    this.resize?.disconnect();
    this.el.remove();
  }

  // --- Public hooks (trainer, screenshot harness, tests) ------------------------
  setMode(mode: Mode): void {
    this.finishTour(false); this.homeOpen = false; this.activeExercise = null;
    this.stop();
    this.mode = mode;
    this.menuOpen = false;
    this.seq = null;
    this.ghost = null;
    this.highlights = [];
    if (mode === 'learn') { this.startFlow(this.record.flowAt ?? 0); return; }
    this.flow = null; this.clearFlowMarks();
    if (mode === 'practice') { this.setSource(this.source.kind === 'mixed' ? this.defaultSource() : this.source); return; }
    this.problem = null;
    this.renderChrome();
    this.paint();
  }

  /** Open a skill in Learn at the stage it has reached. */
  openTask(shape: Shape, stage?: Stage): void {
    this.leaveFlow();
    const p = E6B_PROCEDURES.find(p => p.shape === shape)!;
    this.openExercise(p.id, stage);
  }

  openExercise(id: string, stage?: Stage): void {
    this.leaveFlow();
    const p = E6B_PROCEDURES.find(p => p.id === id); if (!p) return;
    this.finishTour(false); this.homeOpen = false; this.activeExercise = p; this.moreOpen = false;
    this.shape = p.shape; this.mode = 'learn'; this.menuOpen = false;
    this.autoTurn = true; this.view={x:0,y:0,w:VIEW};
    if(p.operation==='components')this.viewAngle=0;
    const reached = this.record.curriculum?.[p.operation]?.stage ?? 'watch';
    this.startStage(stage ?? (reached === 'done' ? 'solo' : reached));
  }

  /** The next exercise, at the stage reached but never a demonstration: Watch is in the menu. */
  openNext(): void {
    const n = nextExercise(this.record);
    const p = E6B_PROCEDURES.find(e => e.id === n.id);
    const reached = p ? this.record.curriculum?.[p.operation]?.stage ?? 'watch' : 'watch';
    this.openExercise(n.id, reached === 'watch' ? 'guided' : reached === 'done' ? 'solo' : reached);
  }

  openHome(): void {
    this.leaveFlow();
    this.finishTour(false); this.stop();window.clearInterval(this.timer); this.homeOpen = true; this.moreOpen = false; this.activeExercise = null;
    this.seq = null; this.problem = null; this.ghost = null; this.highlights = [];
    this.mode = 'learn'; this.menuOpen = false; this.renderChrome(); this.paint();
  }

  private startTour(): void {
    this.stop();window.clearInterval(this.timer);this.mode='learn'; this.seq = null; this.homeOpen = false; this.activeExercise = null;
    this.tourIndex = 0; this.tourGo();
  }

  private tourGo(): void {
    window.clearTimeout(this.tourTimer);
    const step = FIRST_CONTACT[this.tourIndex];
    if (!step) { this.finishTour(); return; }
    this.setSide('computer'); this.theta = 0; this.cursor = 0; this.coachFull = false;
    this.highlights = step.highlight; this.setViewRotation(step.angle, true, false);
    this.renderChrome(); this.paint();
    if (this.tourIndex === 1) this.moveTo(35, this.cursor, () => {});
    this.tourTimer = window.setTimeout(() => { this.tourIndex += 1; this.tourGo(); }, 15_000);
  }

  private finishTour(home = true): void {
    if (this.tourIndex < 0) return;
    window.clearTimeout(this.tourTimer); this.tourIndex = -1; this.stop();
    this.record = { ...this.record, firstContact: true }; this.store.save(this.record);
    this.highlights = []; this.setViewRotation(0, false, false);
    if (home) this.openHome();
  }

  /** Jump to a guided step with the learner's part still to do (screenshots, deep links). */
  showGuided(shape: Shape, step: number, round = 1): void {
    this.finishTour(false); this.homeOpen = false; this.activeExercise = null;
    this.mode = 'learn';
    this.shape = shape;
    this.stageOf = 'guided';
    const demo = this.demos[SHAPES.indexOf(shape)];
    this.startSequence(demo, 'guided', round, () => this.startStage('solo'), step, true);
  }

  setRotation(theta: number, cursor?: number): void {
    this.theta = norm(theta);
    if (cursor != null) this.cursor = norm(cursor);
    this.paint();
  }

  /** Rotate the physical computer in the hands; scale settings never change. */
  setViewRotation(angle: number, animated = false, manual = true): void {
    if (manual && this.autoTurn) { this.autoTurn = false; this.renderStrip(); }
    this.viewTween = null;
    if (animated && !reducedMotion()) {
      this.viewTween = { from: this.viewAngle, to: this.viewAngle + turn(angle - this.viewAngle), start: performance.now() };
      this.kick();
    } else { this.viewAngle = norm(angle); this.paint(); }
  }

  /** Instrument and lesson state, for the trainer and the browser tests. */
  snapshot(): { theta: number; cursor: number; viewAngle: number; autoTurn: boolean; viewW: number; side: Side; mode: Mode; stage: Stage; step: number | null; met: boolean | null; goals: string[]; targets: Goal[] } {
    const s = this.seq;
    return { theta: this.theta, cursor: this.cursor, viewAngle: this.viewAngle, autoTurn: this.autoTurn, viewW: this.view.w, side: this.side, mode: this.mode, stage: this.stageOf,
      step: s ? s.index : null, met: s ? s.met : null, goals: s ? s.goals.map((g) => g.kind) : [], targets: s ? s.goals.map((g) => ({ ...g })) : [] };
  }

  setExam(on: boolean): void { this.exam = on; this.renderChrome(); this.paint(); }
  openHow(on = true): void { if (on) { this.stop(); this.renderStrip(); } this.howOpen = on; this.renderOverlay(); }
  openPractice(kind: 'daily' | 'mixed' | 'mission', missionId?: string): void {
    this.leaveFlow();
    this.finishTour(false); this.homeOpen = false; this.activeExercise = null;
    this.mode = 'practice';
    if (kind === 'mission') this.setSource({ kind: 'mission', mission: MISSIONS.find((m) => m.id === missionId) ?? MISSIONS[0], index: 0, carried: [], own: [], decided: null });
    else if (kind === 'daily') this.setSource(this.dailySource());
    else this.setSource({ kind: 'mixed' });
  }

  /** The Guided form uses the same validator as the simulated hand tests. */
  enterProcedureReading(text: string): boolean {
    const p=this.activeExercise,s=this.seq;
    if(!p||!s||s.kind!=='guided')return false;
    const value=parseAnswer(text,false);
    if(value!=null)this.procedureEntries[s.index]=value;
    else delete this.procedureEntries[s.index];
    const met=validateProcedureStep(p,s.index,{...this.pose(),viewAngle:this.viewAngle},value??undefined);
    this.procedureFeedback=met?'✓ Reading checked':p.procedure[s.index].correction;
    this.checkAlignment();this.renderTask();this.renderCoach();return met;
  }

  /** Type into the task card and press its button (screenshot harness). */
  answerWith(estimate: string | null, reading: string): void {
    if (estimate != null) { this.estimate = estimate; this.estimateLocked = true; }
    this.answer = reading;
    this.checkAnswer();
  }

  hoverGiven(index: number | null): void {
    const givens = this.problem?.givens ?? (this.seq?.round === 1 && this.guidedProblem ? this.guidedProblem.givens : MANUAL_BRIEF[this.shape][1]);
    this.hover = index == null ? null : givens[index]?.highlight ?? null;
    this.paintHighlights(true);
  }

  // --- DOM ---------------------------------------------------------------------
  private build(): void {
    const face = renderFace(this.face, this.id);
    const brass = `${this.id}-brass`;
    const lift = `<filter id="${this.id}-lift" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="6" stdDeviation="9" flood-opacity="0.28"/></filter>`;
    // The printed face is static, so it is drawn as two SVG images (base and
    // disc) and only turned. Live SVG text is re-laid out on every transform
    // change anywhere in its <svg>: 200 labels cost a frame's budget per move.
    const baseImage = printedImage(`<defs>${face.defs}${lift}</defs><g class="e6b-art"><g class="e6b-base">${face.base}</g></g>`);
    const discImage = printedImage(`<defs>${face.defs}</defs><g class="e6b-art"><g class="e6b-disc">${face.disc}</g></g>`);
    const hub = `<circle class="hub" r="${this.face.radius.hub}" fill="url(#${brass})"/><circle class="hub-ring" r="45"/><circle class="hub-dot" r="18"/>`;
    this.el.innerHTML = `
      <div class="e6b-stage">
        <div class="e6b-task" aria-live="polite"></div>
        <div class="e6b-dial">
          <div class="e6b-shadow" aria-hidden="true"></div>
          <svg class="e6b-svg" xmlns="${SVG_NS}" viewBox="${-VIEW / 2} ${-VIEW / 2} ${VIEW} ${VIEW}" tabindex="0" role="application"
            aria-label="E6-B computer side. Drag the blue disc to turn it; drag the red hairline or its handle to move it. Arrow keys turn the disc; Option and arrows move the hairline one graduation. Bracket keys turn the whole view.">
            <defs>${face.defs}
              <radialGradient id="${brass}" cx="38%" cy="34%" r="70%"><stop offset="0" stop-color="#ffffff"/><stop offset="0.45" stop-color="#a8b4c0"/><stop offset="1" stop-color="#596773"/></radialGradient>
              ${lift}
            </defs>
            <g id="${this.id}-root" class="e6b-art">
              <g class="e6b-base">${baseImage}</g>
              <g class="e6b-hl" data-layer="base" id="${this.id}-hlb"></g><g class="flow-base"></g>
              <g class="e6b-disc">${discImage}<g class="e6b-knurl">${this.knurl()}</g><g class="e6b-hl" data-layer="disc" id="${this.id}-hld"></g><g class="flow-disc"></g></g>
              <g class="e6b-cursor"><path class="cursor-band" d="M-14 -470H14V-1440H-14Z"/><path class="cursor-line" d="M0 -470V-1440"/>
                <g class="cursor-handle"><rect x="-96" y="-1578" width="192" height="94" rx="47"/><path class="cursor-arrows" d="M-70 -1531L-30 -1558V-1504ZM70 -1531L30 -1558V-1504Z"/></g><g class="flow-cur"></g></g>
              ${hub}
            </g>
            <g class="e6b-art e6b-ghost" style="display:none"><g class="e6b-disc ghost-disc">${renderGhost(this.face)}</g><path class="ghost-line" d="M0 -470V-1440"/></g>
            <g class="e6b-art e6b-guide"></g>
            <g class="e6b-art e6b-tags"></g>
          </svg>
          ${this.windSvgMarkup()}
          <svg class="e6b-component-table e6b-art" viewBox="0 0 760 640" role="img" aria-label="Printed wind component table: four entries for interpolation" style="display:none"></svg>
          <div class="e6b-loupe" aria-hidden="true" title="Loupe"><svg class="e6b-art" viewBox="0 0 100 100"><g class="loupe-view">${baseImage}<use href="#${this.id}-hlb"/><g class="loupe-disc">${discImage}<use href="#${this.id}-hld"/></g><g class="loupe-cursor"><path class="cursor-band" d="M-14 -470H14V-1440H-14Z"/><path class="cursor-line" d="M0 -470V-1440"/></g>${hub}</g></svg></div>
          <button type="button" class="e6b-view-knob" data-e6b="view-knob" aria-label="Turn the whole computer; tap for upright" title="View · tap for upright"><svg viewBox="-20 -20 40 40" aria-hidden="true"><circle class="ring" r="17"/><g class="needle"><path class="up" d="M0 -15L5 -2H-5Z"/><path class="down" d="M0 15L5 2H-5Z"/></g></svg><span>View</span></button>
          <div class="e6b-pencil" role="group" aria-label="Pencil"><button type="button" data-e6b="pencil" aria-pressed="true" aria-label="Pencil: tap the clear plate to mark a dot" title="Pencil: tap the plate to mark a dot">✎</button><button type="button" data-e6b="erase" aria-label="Erase the pencil dot" title="Erase the dot">⌫</button></div>
          <button type="button" class="e6b-centre" data-e6b="centre" aria-label="Centre the computer" title="Centre (double-click)">⊙</button>
        </div>
        <div class="e6b-readpanel" aria-hidden="true" title="Read under the red hairline"></div>
        <div class="e6b-coach" aria-live="polite"></div>
        <div class="e6b-overlay"></div>
        <div class="e6b-hint" hidden></div>
        <svg class="flow-pointer" aria-hidden="true"><defs><marker id="${this.id}-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z"/></marker></defs><path class="fp" marker-end="url(#${this.id}-arrow)"/></svg>
        <div class="flow-hand" aria-hidden="true"></div>
      </div>
      <div class="e6b-strip"></div>`;
    this.svg = this.el.querySelector('.e6b-svg')!;
    this.disc = this.el.querySelector('.e6b-disc')!;
    this.cursorG = this.el.querySelector('.e6b-cursor')!;
    this.hlBase = this.el.querySelector('.e6b-hl[data-layer="base"]')!;
    this.hlDisc = this.el.querySelector('.e6b-hl[data-layer="disc"]')!;
    this.guideG = this.el.querySelector('.e6b-guide')!;
    this.ghostG = this.el.querySelector('.e6b-ghost')!;
    this.ghostDisc = this.el.querySelector('.ghost-disc')!;
    this.tagsG = this.el.querySelector('.e6b-tags')!;
    this.stage = this.el.querySelector('.e6b-stage')!;
    this.dial = this.el.querySelector('.e6b-dial')!;
    this.stripEl = this.el.querySelector('.e6b-strip')!;
    this.taskEl = this.el.querySelector('.e6b-task')!;
    this.coachEl = this.el.querySelector('.e6b-coach')!;
    this.overlayEl = this.el.querySelector('.e6b-overlay')!;
    this.loupe = this.el.querySelector('.e6b-loupe')!;
    this.loupeSvg = this.loupe.querySelector('svg')!;
    this.loupeView = this.loupe.querySelector('.loupe-view')!;
    this.loupeDisc = this.loupe.querySelector('.loupe-disc')!;
    this.loupeCursor = this.loupe.querySelector('.loupe-cursor')!;
    this.rootG = this.svg.querySelector('.e6b-base')!.parentElement as unknown as SVGGElement;
    this.wsvg = this.el.querySelector('.e6b-wind')!;
    this.slideG = this.el.querySelector('.wind-slide')!;
    this.plateG = this.el.querySelector('.wind-plate')!;
    this.dotG = this.el.querySelector('.wind-dot')!;
    this.hlWind = this.el.querySelector('.wind-hl')!;
    this.windView = this.wsvg.querySelector('.wind-view');
    this.bindWindPointer();
    this.bindPointer();
    this.bindLoupe();
    this.bindInstrumentPointers();
    this.bindChrome();
    const knob = this.el.querySelector('.e6b-view-knob') as HTMLButtonElement;
    // The View dial: drag it round the centre to turn the whole computer as one
    // piece (settings unchanged); a tap without a drag sets it upright.
    knob.addEventListener('pointerdown', (e) => {
      if (this.twistOwned) return;
      knob.setPointerCapture(e.pointerId); this.invalidateBox();
      this.viewKnob = { last: this.screenAngle(e.clientX, e.clientY), moved: false, x: e.clientX, y: e.clientY };
      this.stop(); e.stopPropagation();
    });
    knob.addEventListener('pointermove', (e) => {
      const k = this.viewKnob;
      if (!k || this.twistOwned) return;
      if (!k.moved && Math.hypot(e.clientX - k.x, e.clientY - k.y) > 4) k.moved = true;
      const a = this.screenAngle(e.clientX, e.clientY);
      if (k.moved) this.setViewRotation(this.viewAngle + turn(a - k.last));
      k.last = a;
    });
    holdPage(knob);
    knob.addEventListener('pointerup', () => { const k = this.viewKnob; if (k && !k.moved && !this.twistOwned) this.setViewRotation(0, true); this.viewKnob = null; });
    knob.addEventListener('pointercancel', () => { this.viewKnob = null; });
    knob.addEventListener('keydown', (e) => {
      if(['ArrowLeft','ArrowRight','Enter',' '].includes(e.key)){e.preventDefault();this.stop();this.setViewRotation(this.viewAngle+(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?1:15),true);}
      else this.onKey(e);
    });
  }

  /** Knurling on the disc rim, shown while the pointer is over the disc. */
  private knurl(): string {
    let d = '';
    for (let a = 0; a < 360; a += 1.2) {
      const [x1, y1] = polar(a, this.face.radius.disc - 2);
      const [x2, y2] = polar(a + 0.6, this.face.radius.disc - 16);
      d += `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }
    return `<circle class="knurl-ring" r="${this.face.radius.disc - 8}"/><path class="knurl" d="${d}"/>`;
  }

  private windSvgMarkup(): string {
    const wind = renderWind(this.id, this.slideEnd === 'high' ? HIGH_SPEED_SLIDE : SLIDE);
    const grip = (y: number) => `<g class="slide-grip" transform="translate(0 ${y})"><rect x="-120" y="-34" width="240" height="68" rx="34"/><path d="M-50 -10H50M-50 10H50"/></g>`;
    return `<svg class="e6b-svg e6b-wind" xmlns="${SVG_NS}" viewBox="${-VIEW / 2} ${-VIEW / 2} ${VIEW} ${VIEW}" tabindex="0" role="application" style="display:none"
        aria-label="E6-B wind side. Drag the clear plate to turn it; drag the grid above or below it to slide it; tap the plate to mark a pencil dot. Arrow keys turn the plate and move the slide.">
        <defs><radialGradient id="${this.id}-brass-w" cx="38%" cy="34%" r="70%"><stop offset="0" stop-color="#ffffff"/><stop offset="0.45" stop-color="#a8b4c0"/><stop offset="1" stop-color="#596773"/></radialGradient></defs>
        <g class="wind-view"><g class="wind-slide-turn"><g class="wind-slide">${this.slideImage(wind.slide)}</g></g>
        <g class="wind-frame">${printedImage(wind.frame, 'e6b-svg e6b-wind')}</g>
        <g class="wind-plate">${printedImage(wind.plate, 'e6b-svg e6b-wind')}<circle class="plate-grip" r="1086"/><g class="wind-dot"></g><g class="flow-plate"></g></g>
        ${grip(-1440)}${grip(1440)}
        <g class="wind-hl"></g><g class="flow-wind"></g>
        <g class="wind-grommet"><circle class="grommet" r="46" fill="url(#${this.id}-brass-w)"/><circle class="grommet-hole" r="16"/><path class="grommet-cross" d="M-34 0H34M0 -34V34"/></g></g>
      </svg>`;
  }

  /** The printed slide as one image spanning its full travel. */
  private slideImage(markup: string): string {
    const spec = this.slideSpec(), units = this.windUnits();
    const top = -(spec.maxKt * units) - 1350, bottom = -(spec.minKt * units) + 480;
    return printedImage(markup, 'e6b-svg e6b-wind', [-1400, top, 2800, bottom - top]);
  }

  /** Re-render the chrome when the instrument crosses the phone width (700 px, as the CSS). */
  private updateNarrow(): void {
    const width = this.el.clientWidth, height = this.el.clientHeight;
    // Phone portrait, or a phone on its side: the compact dock and one-line coach.
    const narrow = this.variant === 'lab' && width > 0 && (width < 700 || (height > 0 && height < 440 && width < 1000));
    if (narrow === this.narrow) return;
    this.narrow = narrow; this.moreOpen = false;
    // The loupe would sit over the working mark on a phone; it stays in the Menu.
    if (narrow) this.showLoupe = false;
    this.renderStrip(); this.renderTask(); this.paintedCoach = null; this.renderCoach();
  }

  // --- First-run hint --------------------------------------------------------------
  private hintTimer = 0;

  /** Once per browser: how to turn the disc and move the hairline, for the input in hand. */
  private showHint(): void {
    if (this.variant !== 'lab') return;
    try { if (localStorage.getItem(HINT_KEY)) return; } catch { return; }
    const node = this.el.querySelector('.e6b-hint') as HTMLElement;
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    node.textContent = touch ? 'Drag to turn the disc · drag the red handle to move the hairline' : 'Swipe to spin · pinch to zoom · drag a ring to turn it';
    node.hidden = false;
    this.hintTimer = window.setTimeout(() => this.hideHint(), 9000);
  }

  private hideHint(): void {
    const node = this.el.querySelector('.e6b-hint') as HTMLElement | null;
    if (!node || node.hidden) return;
    node.hidden = true;
    window.clearTimeout(this.hintTimer);
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private window */ }
  }

  // --- Chrome: strip, task card, coach bubble, menu, overlay ----------------------
  private pose(): Pose { return { theta: this.theta, cursor: this.cursor, wind: this.wind }; }

  private aids() { return aids(this.mode, this.exam); }

  private renderChrome(): void {
    this.renderStrip();
    this.renderTask();
    this.paintedCoach = null;
    this.renderCoach();
    this.renderOverlay();
    this.el.dataset.view = this.mode;
    this.el.classList.toggle('home', this.homeOpen);
    this.el.classList.toggle('touring', this.tourIndex >= 0);
    this.paintComponents();
    this.el.classList.toggle('exam', this.mode === 'practice' && this.exam);
  }

  private renderStrip(): void {
    this.invalidateBox();
    this.paintedReadout = null;
    const learnSteps = this.seq?.demo.steps.length ?? 0;
    const label = this.sourceLabel();
    this.stripEl.innerHTML = stripHtml({
      variant: this.variant,
      mode: this.mode,
      side: this.side,
      exam: this.exam,
      readout: this.aids().readout ? readoutLine(this.pose(), this.side) : null,
      learn: this.mode === 'learn' ? { title: this.activeExercise?.title ?? SHAPE_NAMES[this.shape], state: skillState(this.record, this.shape), stage: this.stageOf,
        playing: this.playing, step: this.seq ? this.seq.index + 1 : 0, steps: learnSteps } : null,
      practice: this.mode === 'practice' ? { label, timer: this.problem ? clock(this.elapsed ?? (this.started ? performance.now() - this.started : 0)) : null } : null,
      loupe: this.showLoupe, autoTurn: this.autoTurn, slideEnd: this.slideEnd,
      narrow: this.narrow, launch: this.homeOpen || this.tourIndex >= 0, moreOpen: this.moreOpen, flow: !!this.flow,
    }) + (this.menuOpen ? this.menuMarkup() : '');
    this.fitPopups();
  }

  /** Menus rise from the dock but never cover the task line: cap them to the gap. */
  private fitPopups(): void {
    if (!this.narrow) return;
    const top = this.taskEl.hidden ? this.el.getBoundingClientRect().top : this.taskEl.getBoundingClientRect().bottom;
    for (const node of Array.from(this.stripEl.querySelectorAll<HTMLElement>('.more-panel, .menu'))) {
      const room = node.getBoundingClientRect().bottom - top - 8;
      if (room > 0) node.style.maxHeight = `${Math.floor(room)}px`;
    }
  }

  private paintedReadout: string | null = null;
  private updateReadout(): void {
    const on = this.aids().readout;
    const text = on ? readoutLine(this.pose(), this.side) : '';
    if (text === this.paintedReadout) return;
    this.paintedReadout = text;
    const node = this.stripEl.querySelector('.readout');
    if (node) node.innerHTML = on ? readoutHtml(text) : '';
    const panel = this.el.querySelector('.e6b-readpanel') as HTMLElement | null;
    if (panel) { panel.innerHTML = on ? readoutPanelHtml(text) : ''; panel.hidden = !on; }
  }

  private sourceLabel(): string {
    const s = this.source;
    if (s.kind === 'daily') return `Daily set · ${Math.min(s.index + 1, s.set.length)} of ${s.set.length}`;
    if (s.kind === 'mission') return s.mission.title;
    if (s.kind === 'skill') return SHAPE_NAMES[s.shape];
    return 'Mixed';
  }

  private menuMarkup(): string {
    const now = new Date().toISOString();
    if (this.mode === 'learn') {
      return menuHtml('Exercises', [{ title: 'Curriculum', rows: E6B_PROCEDURES.map(p => ({id:`exercise:${p.id}`,label:`${p.title} · ${p.level}`,current:p.id===this.activeExercise?.id})) }]);
    }
    const due = SHAPES.filter((shape) => skillState(this.record, shape) !== 'new').length;
    return menuHtml('Problem set', [
      { title: 'Sets', rows: [
        { id: 'src:daily', label: 'Daily E6-B set', detail: this.record.daily?.day === today() && this.record.daily.done >= this.record.daily.set.length ? 'done today ✓' : `${due ? 'mixed review' : 'mixed'} · 6`, current: this.source.kind === 'daily' },
        { id: 'src:mixed', label: 'Mixed, endless', current: this.source.kind === 'mixed' },
      ] },
      { title: 'Missions: each answer feeds the next', rows: MISSIONS.map((m) => ({ id: `mission:${m.id}`, label: m.title, current: this.source.kind === 'mission' && this.source.mission.id === m.id })) },
      { title: 'One skill', rows: SHAPES.map((shape) => ({ id: `skill:${shape}`, label: SHAPE_NAMES[shape], state: skillState(this.record, shape),
        detail: this.record.bests[shape] ? `best ${clock(this.record.bests[shape]!)}` : '', current: this.source.kind === 'skill' && this.source.shape === shape })) },
    ]);
  }

  private renderTask(): void {
    this.invalidateBox();
    if (this.flow) { this.renderFlow(); return; }
    if (this.homeOpen) { this.taskEl.hidden = false; this.taskEl.innerHTML = this.narrow ? homeLineHtml(this.record) : homeHtml(this.record); return; }
    if (this.tourIndex >= 0) { this.taskEl.hidden = true; return; }
    const view = this.taskView();
    this.taskEl.innerHTML = view ? taskHtml(view) : '';
    this.taskEl.hidden = !view;
    const s = this.seq, p = this.activeExercise;
    if (p && s && s.demo === p.demo && s.kind === 'guided') {
      const step = p.procedure[s.index], a = step.physical;
      const unit = step.result?.unit ?? p.answer.unit;
      if (a.kind === 'estimate' || a.kind === 'read') this.taskEl.innerHTML += `<form class="procedure-entry"><label class="field"><span>${a.kind === 'estimate' ? 'Estimate first' : 'Your reading'} · ${esc(unit)}</span><input data-e6b="procedure-entry" inputmode="decimal" autocomplete="off" aria-label="${a.kind === 'estimate' ? 'Estimate' : 'Reading'}, ${esc(unit)}" placeholder="${a.kind === 'estimate' ? 'Estimate' : 'Reading'}, ${esc(unit)}" value="${this.procedureEntries[s.index] ?? ''}"></label><button class="go" type="submit">Check</button></form>${this.procedureFeedback ? `<p class="procedure-feedback" role="status">${esc(forInput(this.procedureFeedback,touchPrimary()))}</p>` : ''}`;
    }
  }

  private taskView(): TaskView | null {
    if (this.variant === 'card' || this.mode === 'free') return null;
    const exam = this.mode === 'practice' && this.exam;
    if (this.mode === 'learn' && this.stageOf !== 'solo' && this.stageOf !== 'done') {
      const demo = this.seq?.demo ?? this.demos[SHAPES.indexOf(this.shape)];
      if (this.activeExercise) return { kicker: this.narrow ? this.exerciseLabel(this.activeExercise) : `${this.activeExercise.title} · ${this.activeExercise.level} · ${this.stageOf === 'watch' ? 'Watch' : 'Guided'}`, cite:this.activeExercise.source,stem:this.narrow?problemLine(this.activeExercise.scenario):this.activeExercise.scenario,stemFull:this.activeExercise.scenario,givens:[],estimate:null,answer:null,verdict:null,decision:null,replay:false,next:null,step:this.stepView() };
      const own = this.seq?.round === 1 && this.guidedProblem ? this.guidedProblem : null;
      const brief = MANUAL_BRIEF[this.shape];
      const stage = this.stageOf === 'watch' ? 'Watch' : 'Guided';
      return { kicker: `${SHAPE_NAMES[this.shape]} · ${stage}`, cite: own ? undefined : `ASA E6-B manual: ${demo.cite.replace(/^Manual /, '')}`, stem: own ? own.stem : brief[0], givens: own ? own.givens : brief[1], estimate: null, answer: null,
        verdict: null, decision: null, replay: false, next: null, pips: demo.steps.map((_, i) => (this.seq && i < this.seq.index ? 'done' : this.seq && i === this.seq.index ? 'now' : '')) };
    }
    const p = this.problem;
    if (!p) return null;
    const v = this.verdict;
    const estimating = this.wantsEstimate(p);
    const source = this.source;
    let kicker = this.mode === 'learn' ? `${SHAPE_NAMES[this.shape]} · Solo` : this.sourceLabel();
    let pips: string[] | undefined;
    let log: TaskView['log'];
    if (this.mode === 'practice' && source.kind === 'daily') {
      kicker = `Daily E6-B set${this.record.streak.count ? ` · streak ${this.record.streak.count}` : ''}`;
      pips = source.set.map((_, i) => source.results[i] ?? (i === source.index ? 'now' : ''));
    }
    if (this.mode === 'practice' && source.kind === 'mission') {
      kicker = `${source.mission.title} · leg ${Math.min(source.index + 1, source.mission.links.length)} of ${source.mission.links.length}`;
      log = source.mission.links.map((link, i) => ({ label: link.log, value: i < source.carried.length ? this.logValue(link.log, source.carried[i]) : null, own: source.own[i] ?? true }));
    }
    const missionDone = source.kind === 'mission' && this.mode === 'practice' && source.index >= source.mission.links.length;
    const decision = this.decisionView();
    let next: string | null = null;
    if (v && (v.ok || this.replayDone) && (!decision || decision.chosen != null)) {
      if (this.activeExercise) next = v.ok ? 'Next exercise' : 'Easier guided follow-up';
      else if (this.mode === 'learn') next = v.ok ? (SHAPES.indexOf(this.shape) < SHAPES.length - 1 ? `Next: ${SHAPE_NAMES[SHAPES[SHAPES.indexOf(this.shape) + 1]]}` : 'Go to Practice') : 'Try another';
      else if (source.kind === 'daily') next = source.index + 1 >= source.set.length ? 'Finish the set' : 'Next problem';
      else if (source.kind === 'mission') next = missionDone ? (source.decided != null ? 'Fly it again' : null) : source.index + 1 >= source.mission.links.length ? 'To the decision' : 'Next leg';
      else next = v.ok ? 'Next problem' : 'Easier one';
    } else if (v && !v.ok) next = null;
    const pace = v?.ok && this.elapsed != null ? this.paceText() : null;
    return {
      kicker, pips, log, stem: this.narrow ? problemLine(p.stem) : p.stem, stemFull: p.stem, givens: p.givens, plainChips: exam,
      estimate: estimating ? { value: this.estimate, locked: this.estimateLocked } : null,
      answer: { value: this.answer, unit: p.unit, enabled: !estimating || this.estimateLocked, done: !!v && (v.ok || this.replayDone) },
      verdict: v ? {
        ok: v.ok, check: checkText(p, v), diagnosis: v.ok ? null : diagnose(p, v.value)?.text ?? (this.activeExercise ? procedureDiagnosis(this.activeExercise,this.pose()) : null),
        estimate: estimating && this.estimate ? estimateText(p, parseAnswer(this.estimate, p.time) ?? NaN, v.value) : null,
        outcome: v.ok || this.replayDone ? p.outcome ?? null : this.ghost && this.side === 'computer' ? 'Green on the instrument: where the disc and hairline should be.' : null, pace,
      } : null,
      decision, replay: !!v && !v.ok && !this.replayDone, replayLabel:this.activeExercise?'Easier guided follow-up':undefined,next,
    };
  }

  private replayDone = false;

  // --- The teaching flow (docs/design/e6b-teaching-flow.md) -------------------------
  private flow: { index: number; p: ProcedureExercise; level: HelpLevel; entry: string; estimate: number | null; estimated: boolean;
    misses: number; showed: boolean; whyOpen: boolean; bad: string | null; final: number | null; advanceTimer: number; showGlow: boolean; ghostAt: number } | null = null;
  private pencil = true;

  /** Open problem `index` of the flow order at the first beat. */
  private startFlow(index: number): void {
    const p = flowProblem(index);
    this.finishTour(false); this.homeOpen = false; this.menuOpen = false; this.moreOpen = false;
    if (this.flow) window.clearTimeout(this.flow.advanceTimer);
    this.mode = 'learn'; this.activeExercise = p; this.shape = p.shape; this.stageOf = 'guided';
    this.autoTurn = true; this.view = { x: 0, y: 0, w: VIEW }; this.el.classList.remove('zoomed');
    this.verdict = null; this.problem = null; this.ghost = null; this.procedureEntries = {}; this.procedureFeedback = '';
    this.flow = { index, p, level: helpLevel(this.record.help?.[p.shape]), entry: '', estimate: null, estimated: false, misses: 0, showed: false, whyOpen: false, bad: null, final: null, advanceTimer: 0, showGlow: false, ghostAt: -1 };
    this.record = { ...this.record, flowAt: index }; this.store.save(this.record);
    this.paintedFlow = '';
    this.startSequence(p.demo, 'guided', 1, () => {});
    this.renderChrome(); this.paint();
  }

  private flowBeat(): Beat {
    const s = this.seq, f = this.flow!;
    const kind = s ? f.p.procedure[s.index]?.physical.kind : 'read';
    return kind === 'estimate' ? 'estimate' : kind === 'read' ? 'check' : 'instrument';
  }

  private flowView(): FlowView {
    const f = this.flow!, s = this.seq, p = f.p, beat = this.flowBeat();
    const step = s ? p.procedure[s.index] : p.procedure[p.procedure.length - 1];
    const base = { question: questionLine(p), n: (f.index % SET_SIZE) + 1, of: SET_SIZE, beat, done: false, why: null, whyState: null, note: null, bad: f.bad, entry: null, show: false, primary: null, onInstrument: false } as FlowView;
    const unit = (u: string) => u;
    if (beat === 'estimate') {
      if (!f.estimated) return { ...base, line: estimateAsk(p), entry: { unit: p.answer.unit, value: f.entry, ask: `Estimate, ${unit(p.answer.unit)}` } };
      const g = gradeEstimate(Math.abs(f.estimate!), Math.abs(p.estimateValue));
      return { ...base, line: `Your estimate ${num(f.estimate!)} ${p.answer.unit} · ${g === 'close' ? 'close' : g === 'ballpark' ? 'in the ballpark' : 'well off'}`, done: g === 'close', note: methodLine(p), primary: { id: 'flow-next', label: 'Next →' } };
    }
    if (beat === 'instrument') {
      if (s && s.auto[s.index]) {
        const m = /^Turn the whole view until (.+?) is at the top/.exec(step.action);
        return { ...base, line: m ? `Turning ${m[1]} to the top` : step.action.replace(/\.$/, '') };
      }
      const glow = f.level < 2 || f.showGlow;
      return { ...base, line: moveLine(p, step), done: !!s?.met, why: whyLine(p, step, s!.index), whyState: f.level === 0 || f.whyOpen ? 'open' : 'closed', show: true, onInstrument: glow && !s?.met };
    }
    const r = step.result!;
    if (f.final != null) return { ...base, line: `${r.label} ${num(f.final)} ${r.unit}`, done: true, note: crossCheck(p, f.final, f.estimate), bad: null,
      primary: { id: 'flow-problem', label: 'Next problem →' } };
    return { ...base, line: readLine(step), entry: { unit: r.unit, value: f.entry, ask: `Reading, ${r.unit}` }, show: false };
  }

  private renderFlow(): void {
    if (!this.flow) return;
    const view = this.flowView();
    this.taskEl.hidden = false;
    this.taskEl.innerHTML = flowHtml(view);
    this.el.classList.toggle('flowing', true);
    this.flineRect = null;
  }

  private flowSubmit(): void {
    const f = this.flow!, s = this.seq;
    if (!s) return;
    const input = this.taskEl.querySelector('[data-e6b="flow-input"]') as HTMLInputElement | null;
    const text = input?.value ?? f.entry;
    const beat = this.flowBeat();
    if (beat === 'estimate') {
      const v = parseAnswer(text, false);
      if (v == null) { f.bad = 'A number, in your head'; this.renderFlow(); return; }
      f.estimate = v; f.estimated = true; f.bad = null; f.entry = '';
      this.procedureEntries[s.index] = v; s.met = true;
      this.renderFlow();
      return;
    }
    if (beat !== 'check') return;
    const ok = this.enterProcedureReading(text);
    const step = f.p.procedure[s.index];
    if (!ok) { f.misses += 1; f.entry = text; f.bad = step.correction.split(/\.\s/)[0].replace(/\.$/, ''); this.renderFlow(); return; }
    f.bad = null; f.entry = '';
    if (s.index < s.demo.steps.length - 1) { this.coachNext(); return; }
    f.final = parseAnswer(text, false);
    this.renderFlow();
  }

  /** Next → after the estimate: on to the instrument. */
  private flowNext(): void {
    const s = this.seq;
    if (!s) return;
    if (this.flowBeat() === 'estimate' && this.flow?.estimated) { s.met = true; this.coachNext(); }
  }

  private flowNextProblem(): void {
    const f = this.flow;
    if (!f) return;
    const clean = f.misses === 0 && !f.showed;
    this.record = { ...this.record, help: { ...this.record.help, [f.p.shape]: afterProblem(this.record.help?.[f.p.shape], clean) } };
    this.store.save(this.record);
    this.startFlow(f.index + 1);
  }

  /** Show me: the glow, and the move animated on the instrument. */
  private flowShow(): void {
    const f = this.flow, s = this.seq;
    if (!f || !s || this.flowBeat() !== 'instrument') return;
    f.showed = true; f.showGlow = true;
    const step = f.p.procedure[s.index];
    this.moveToStep(step.demoStep, () => { this.checkAlignment(true); this.paint(); });
  }

  /** The step ticks itself when the instrument reaches the setting: no Done to find. */
  private flowMaybeAdvance(): void {
    const f = this.flow, s = this.seq;
    if (!f || !s || s.kind !== 'guided' || s.auto[s.index] || f.advanceTimer) return;
    if (this.flowBeat() !== 'instrument' || !s.met || this.drag || this.pointers.size || this.tween) return;
    const at = s.index;
    f.advanceTimer = window.setTimeout(() => {
      f.advanceTimer = 0;
      if (this.flow !== f || this.seq !== s || s.index !== at || !s.met) return;
      this.coachNext();
    }, reducedMotion() ? 150 : 500);
  }

  /** The legacy lesson API (and the trainer's cards) leave the flow. */
  private leaveFlow(): void {
    if (!this.flow) return;
    window.clearTimeout(this.flow.advanceTimer);
    this.flow = null; this.clearFlowMarks();
  }

  private clearFlowMarks(): void {
    for (const g of Array.from(this.el.querySelectorAll('.flow-base, .flow-disc, .flow-cur, .flow-plate, .flow-wind'))) g.innerHTML = '';
    this.paintedFlow = '';
    this.el.classList.remove('flowing');
    const fp = this.el.querySelector('.flow-pointer') as SVGElement | null;
    if (fp) fp.style.display = 'none';
  }

  private paintedFlow = '';
  /** Bumps each time a ghost hand starts, so a previous hand's finish cannot hide the new one. */
  private ghostStamp = 0;
  private flineRect: DOMRect | null = null;
  /** The one thing to move glows (data-next, with its gesture); where it goes is
   * marked (data-drop); the read point glows on the Check beat. */
  private paintFlow(): void {
    const f = this.flow!, s = this.seq;
    const marks = { base: '', disc: '', cur: '', plate: '', wind: '' };
    const at = (x: number, y: number) => `transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"`;
    const src = (x: number, y: number, gesture: string) => `<g class="flow-src" data-next="true" data-gesture="${gesture}" ${at(x, y)}><circle class="halo" r="96"/><circle class="core" r="60"/></g>`;
    const dst = (x: number, y: number) => `<g class="flow-dst" data-drop="true" ${at(x, y)}><circle r="66"/></g>`;
    const beat = this.flowBeat();
    if (s && !s.auto[s.index] && this.side === (f.p.procedure[s.index].demoStep.wind ? 'wind' : 'computer')) {
      const step = f.p.procedure[s.index], a = step.physical;
      if (beat === 'instrument' && !s.met && (f.level < 2 || f.showGlow)) {
        if (a.kind === 'disc') {
          const spots = step.highlights.map((h) => this.locate(h)).filter((x): x is NonNullable<typeof x> => !!x);
          const d = spots.find((x) => x.layer === 'disc'), b = spots.find((x) => x.layer === 'base');
          const goal = s.goals.find((g) => g.kind === 'disc') as Extract<Goal, { kind: 'disc' }> | undefined;
          if (d) { const [x, y] = polar(d.angle, d.r); marks.disc = src(x, y, 'turn'); }
          if (d && goal) { const [x, y] = polar(d.angle + goal.theta, d.r); marks.base = dst(x, y); }
          else if (b) { const [x, y] = polar(b.angle, b.r); marks.base = dst(x, y); }
        } else if (a.kind === 'cursor') {
          marks.cur = src(0, -1531, 'turn');
          const [x, y] = polar(a.angle, 1531); marks.base = dst(x, y);
        } else if (a.kind === 'plate' || a.kind === 'dot-up') {
          const goal = s.goals.find((g) => g.kind === 'plate') as Extract<Goal, { kind: 'plate' }> | undefined;
          if (a.kind === 'plate') { const [x, y] = polar(a.bearing, 1110); marks.plate = src(x, y, 'turn'); marks.wind = dst(0, -1110); }
          else if (this.wind.dot) {
            const [x, y] = this.wind.dot; marks.plate = src(x, y, 'turn');
            void goal; marks.wind = dst(0, -Math.hypot(x, y));
          }
        } else if (a.kind === 'dot') {
          const goal = s.goals.find((g) => g.kind === 'dot') as Extract<Goal, { kind: 'dot' }> | undefined;
          if (goal) { const [x, y] = toScreen(goal.dot, this.wind.plate); marks.wind = src(x, y, 'tap'); }
        } else if (a.kind === 'fit-tas' || a.kind === 'slide') {
          const goal = s.goals.find((g) => g.kind === 'slide') as Extract<Goal, { kind: 'slide' }> | undefined;
          if (goal) { const dy = (goal.gs - this.wind.gs) * this.windUnits(); marks.wind = src(0, 1440, 'slide') + dst(0, 1440 + dy); }
        }
      }
      if (beat === 'check' && f.final == null && a.kind === 'read' && step.result) {
        const value = num(step.result.read), r = a.reading;
        const put = (x: number, y: number) => `<g class="flow-read" data-read="${value}" ${at(x, y)}><circle r="74"/></g>`;
        if (r.kind === 'scale') { const [x, y] = polar(this.cursor, r.ring === 'inner' ? 1000 : 1205); marks.base = put(x, y); }
        else if (r.kind === 'density') { const [x, y] = polar(this.face.index.density, 818); marks.disc = put(x, y); }
        else if (r.kind === 'wind') {
          if (r.field === 'gs') marks.wind = put(0, 0);
          else if (r.field === 'from') marks.wind = put(0, -1292);
          else if (this.wind.dot) marks.plate = put(this.wind.dot[0], this.wind.dot[1]);
        }
      }
    }
    const key = JSON.stringify(marks);
    if (key !== this.paintedFlow) {
      this.paintedFlow = key;
      const set = (sel: string, html: string) => { const g = this.el.querySelector(sel); if (g) g.innerHTML = html; };
      set('.flow-base', marks.base); set('.flow-disc', marks.disc); set('.flow-cur', marks.cur); set('.flow-plate', marks.plate); set('.flow-wind', marks.wind);
    }
    this.paintPointer();
    this.maybeGhost();
  }

  /** A line from the card's step to the part that moves (first problems only). */
  private paintPointer(): void {
    const fp = this.el.querySelector('.flow-pointer') as SVGSVGElement | null;
    if (!fp) return;
    const f = this.flow!;
    const srcEl = f.level < 2 ? this.el.querySelector('.flow-src') as SVGGElement | null : null;
    const line = this.taskEl.querySelector('.fline') as HTMLElement | null;
    if (!srcEl || !line || this.flowBeat() !== 'instrument') { if (fp.style.display !== 'none') fp.style.display = 'none'; return; }
    const stage = this.stage.getBoundingClientRect();
    const r = this.flineRect ?? (this.flineRect = line.getBoundingClientRect());
    const t = srcEl.getBoundingClientRect();
    const tx = t.left + t.width / 2, ty = t.top + t.height / 2;
    let sx: number, sy: number;
    if (tx > r.right + 8) { sx = r.right + 4; sy = r.top + r.height / 2; }
    else if (ty < r.top) { sx = clamp(tx, r.left + 12, r.right - 12); sy = r.top - 4; }
    else { sx = clamp(tx, r.left + 12, r.right - 12); sy = r.bottom + 4; }
    const len = Math.hypot(tx - sx, ty - sy) || 1, back = Math.min(len - 4, t.width / 2 + 4);
    const ex = tx - (tx - sx) / len * back, ey = ty - (ty - sy) / len * back;
    const d = `M${(sx - stage.left).toFixed(1)} ${(sy - stage.top).toFixed(1)}L${(ex - stage.left).toFixed(1)} ${(ey - stage.top).toFixed(1)}`;
    const path = fp.querySelector('.fp')!;
    attr(path, 'd', d);
    if (fp.style.display !== 'block') fp.style.display = 'block';
  }

  /** A ghost hand shows each kind of gesture once (turn, slide, tap), on the first problems. */
  private maybeGhost(): void {
    const f = this.flow!, s = this.seq;
    if (!s || f.level > 0 || f.ghostAt === s.index || reducedMotion() || this.flowBeat() !== 'instrument') return;
    const srcEl = this.el.querySelector('.flow-src') as SVGGElement | null;
    if (!srcEl) return;
    const gesture = srcEl.dataset.gesture ?? 'turn';
    const kind = gesture === 'turn' ? (f.p.procedure[s.index].physical.kind === 'cursor' ? 'hairline' : 'turn') : gesture;
    let seen: string[] = [];
    try { seen = JSON.parse(localStorage.getItem(GHOST_KEY) ?? '[]'); } catch { /* storage blocked */ }
    f.ghostAt = s.index;
    if (seen.includes(kind)) return;
    try { localStorage.setItem(GHOST_KEY, JSON.stringify([...seen, kind])); } catch { /* storage blocked */ }
    const hand = this.el.querySelector('.flow-hand') as HTMLElement | null;
    const dstEl = this.el.querySelector('.flow-dst') as SVGGElement | null;
    if (!hand) return;
    const stage = this.stage.getBoundingClientRect();
    const a = srcEl.getBoundingClientRect(), b = (dstEl ?? srcEl).getBoundingClientRect();
    const p0 = { x: a.left + a.width / 2 - stage.left, y: a.top + a.height / 2 - stage.top };
    const p1 = { x: b.left + b.width / 2 - stage.left, y: b.top + b.height / 2 - stage.top };
    const frames: Keyframe[] = [];
    if (gesture === 'turn') {
      const box = this.frameBox(), px = box.size / this.view.w;
      const c = { x: box.left - stage.left + (0 - (this.view.x - this.view.w / 2)) * px, y: box.top - stage.top + (0 - (this.view.y - this.view.w / 2)) * px };
      const a0 = Math.atan2(p0.x - c.x, -(p0.y - c.y)), a1 = Math.atan2(p1.x - c.x, -(p1.y - c.y)), R = Math.hypot(p0.x - c.x, p0.y - c.y);
      const da = ((a1 - a0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      for (let i = 0; i <= 16; i++) { const t = a0 + da * i / 16; frames.push({ transform: `translate(${(c.x + R * Math.sin(t)).toFixed(1)}px, ${(c.y - R * Math.cos(t)).toFixed(1)}px)`, opacity: i === 0 ? 0 : 1 }); }
    } else if (gesture === 'slide') {
      for (let i = 0; i <= 8; i++) frames.push({ transform: `translate(${(p0.x + (p1.x - p0.x) * i / 8).toFixed(1)}px, ${(p0.y + (p1.y - p0.y) * i / 8).toFixed(1)}px)`, opacity: i === 0 ? 0 : 1 });
    } else {
      frames.push({ transform: `translate(${p0.x}px, ${p0.y - 30}px)`, opacity: 0 }, { transform: `translate(${p0.x}px, ${p0.y}px) scale(1)`, opacity: 1 }, { transform: `translate(${p0.x}px, ${p0.y}px) scale(0.8)`, opacity: 1 }, { transform: `translate(${p0.x}px, ${p0.y}px) scale(1)`, opacity: 1 });
    }
    frames.push({ ...frames[frames.length - 1], opacity: 0 });
    const stamp = ++this.ghostStamp;
    for (const prev of hand.getAnimations()) prev.cancel();
    hand.style.display = 'block';
    const anim = hand.animate(frames, { duration: 1600, iterations: 2, easing: 'ease-in-out' });
    anim.onfinish = () => { if (stamp === this.ghostStamp) hand.style.display = 'none'; };
  }

  /** The guided procedure step, shown in the task card with the question it
   * belongs to (owner, 8 Oct: the step sat at the bottom, far from Check). */
  private stepView(): StepView | null {
    const p = this.activeExercise, s = this.seq;
    if (!p || !s || s.demo !== p.demo || s.kind !== 'guided') return null;
    const step = p.procedure[s.index];
    if (!step) return null;
    const last = s.index >= p.procedure.length - 1;
    return { n: s.index + 1, of: p.procedure.length, text: forInput(stepLine(p.operation, step.physical.kind, step.action, step.result?.unit ?? p.answer.unit), touchPrimary()),
      ok: s.met, canBack: s.index > 0, canNext: s.met, last };
  }

  private stepBack(): void {
    const s = this.seq;
    if (!s || s.index <= 0) return;
    this.stop(); this.seq = s;
    this.seqGo(s.index - 1);
  }

  /** "Time en route · 2/3": the operation and which of its exercises. */
  private exerciseLabel(p: ProcedureExercise): string {
    const list = exercisesFor(p.operation);
    return `${p.title} · ${list.indexOf(p) + 1}/${list.length}`;
  }

  private logValue(label: string, value: number): string {
    if (label === 'Time') return hmm(value);
    if (label === 'Fuel') return `${Math.round(value).toLocaleString('en-AU')}`;
    return `${Math.round(value)}`;
  }

  private paceText(): string | null {
    if (this.elapsed == null || !this.problem) return null;
    const best = this.record.bests[this.problem.shape];
    return `${clock(this.elapsed)}${best != null ? ` · best ${clock(best)}` : ''}${best != null && this.bests === 'new' ? ' · new best' : ''}`;
  }

  private decisionView(): TaskView['decision'] {
    const v = this.verdict;
    if (!v || !(v.ok || this.replayDone)) return null;
    const s = this.source;
    if (this.mode === 'practice' && s.kind === 'mission') {
      if (s.index < s.mission.links.length) return null;
      const d = s.mission.decision(s.carried);
      return { question: d.question, chosen: s.decided, right: s.decided == null ? null : s.decided === d.answer, why: d.why };
    }
    const d = this.problem?.decision;
    if (!d) return null;
    return { question: d.question, chosen: this.decision, right: this.decision == null ? null : this.decision === d.answer, why: d.why };
  }

  private wantsEstimate(p: Problem): boolean {
    return p.key.unit !== '°T' && p.key.unit !== '°';
  }

  // --- Coach bubble ----------------------------------------------------------------
  private coachView(): CoachView | null {
    if (this.flow) return null;
    if (this.tourIndex >= 0) {
      const t=FIRST_CONTACT[this.tourIndex];
      return {kind:'guided',action:t.title,detail:forInput(t.text,touchPrimary()),ok:false,step:this.tourIndex+1,steps:FIRST_CONTACT.length,next:this.tourIndex===FIRST_CONTACT.length-1?'Start':'Next',skip:true,brief:this.narrow?t.brief:null,full:this.coachFull};
    }
    if (!this.aids().coach && !(this.seq && this.seq.kind !== 'watch' && !this.exam)) return null;
    const s = this.seq;
    if (s) {
      const step = s.demo.steps[s.index];
      const auto = s.kind === 'watch' || s.auto[s.index];
      const last = s.index >= s.demo.steps.length - 1;
      const physical = this.activeExercise && s.demo === this.activeExercise.demo ? this.activeExercise.procedure[s.index] : null;
      // A guided procedure carries its step in the task card, beside Check.
      if (physical && s.kind === 'guided') return null;
      const detail = physical ? physical.action + (s.kind==='watch' && physical.result ? ` → ${physical.result.format(physical.result.read)}.` : '') : plain(step.say);
      if (auto) return { kind: s.kind === 'watch' ? 'watch' : 'auto', action: 'Watch', detail, ok: false, step: s.index + 1, steps: s.demo.steps.length,
        next: s.kind === 'watch' && last && !this.playing ? (this.mode === 'learn' ? 'Your turn' : 'Done') : null,
        transport: this.narrow && s.kind === 'watch' && this.mode === 'learn' ? { playing: this.playing } : null,
        brief: this.narrow ? briefStep(forInput(detail, touchPrimary())) : null, full: this.coachFull };
      return { brief: this.narrow ? briefStep(forInput(detail, touchPrimary())) : null, full: this.coachFull, kind: s.kind, action: physical?.physical.kind === 'estimate' ? 'Estimate first' : physical?.physical.kind === 'read' ? 'Read the instrument' : physical?.physical.kind === 'orient' ? 'Turn the whole view' : actionFor(s.goals), detail, ok: s.met && s.goals.length > 0, step: s.index + 1, steps: s.demo.steps.length,
        next: s.met ? (last ? (s.kind === 'replay' ? 'Got it' : s.round === 0 ? 'Next: all of it' : 'Done: go solo') : 'Next') : null };
    }
    return null;
  }

  private renderCoach(): void {
    const view = this.coachView();
    const html = view ? coachHtml(view) : '';
    if (html === this.paintedCoach) { this.placeCoach(); return; }
    this.paintedCoach = html;
    this.coachEl.innerHTML = html;
    this.coachEl.hidden = !view;
    this.placeCoach();
  }

  /** The face point the bubble hangs from: the fixed target of the step, else the moving mark. */
  private coachAnchor(): { x: number; y: number } | null {
    if (this.ghost && !this.seq) {
      const angle = this.ghost.cursor ?? this.cursor;
      const [x, y] = polar(angle, 1180);
      return { x, y };
    }
    if(this.activeExercise?.operation==='components'){
      const cell=this.el.querySelector('.table-cell-active');
      if(cell){const r=cell.getBoundingClientRect();return this.toView(r.left+r.width/2,r.top+r.height/2);}
    }
    const s = this.seq;
    if (!s) { if (this.tourIndex >= 0) { const [x,y]=polar(-this.viewAngle,1050); return {x,y}; } return null; }
    const step = s.demo.steps[s.index];
    if (this.side === 'wind') {
      const dotGoal = s.goals.find((g) => g.kind === 'dot') as Extract<Goal, { kind: 'dot' }> | undefined;
      if (dotGoal) { const [x, y] = toScreen(dotGoal.dot, this.wind.plate); return { x, y }; }
      const first = step.highlights[0];
      if (first?.kind === 'wind' && first.id === 'dot' && this.wind.dot) { const [x, y] = toScreen(this.wind.dot, this.wind.plate); return { x, y }; }
      if (first?.kind === 'wind' && first.id === 'grommet') return { x: 0, y: 0 };
      return { x: 0, y: -1292 };
    }
    const cursorGoal = s.goals.find((g) => g.kind === 'cursor') as Extract<Goal, { kind: 'cursor' }> | undefined;
    const spots = step.highlights.map((h) => this.locate(h)).filter((spot): spot is NonNullable<typeof spot> => !!spot);
    const fixed = spots.find((spot) => spot.layer === 'base');
    const spot = fixed ?? spots[0];
    if (spot) {
      const angle = spot.layer === 'disc' ? spot.angle + this.theta : spot.angle;
      const [x, y] = polar(angle, spot.r);
      return { x, y };
    }
    const [x, y] = polar(cursorGoal?.angle ?? this.cursor, 1150);
    return { x, y };
  }

  /** Hang the bubble beside its anchor, outward from the centre, inside the stage. */
  private placeCoach(): void {
    const bubble = this.coachEl.firstElementChild as HTMLElement | null;
    if (!bubble || this.coachEl.hidden) return;
    const anchor = this.coachAnchor();
    const stage = this.stage.getBoundingClientRect();
    const box = this.frameBox();
    if (!anchor || !box.size) return;
    const oriented = rotatePoint(anchor, this.viewAngle);
    const px = box.size / this.view.w;
    const sx = box.left - stage.left + (oriented.x - (this.view.x - this.view.w / 2)) * px;
    const sy = box.top - stage.top + (oriented.y - (this.view.y - this.view.w / 2)) * px;
    const cx = box.left - stage.left + (0 - (this.view.x - this.view.w / 2)) * px;
    const cy = box.top - stage.top + (0 - (this.view.y - this.view.w / 2)) * px;
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const dx = sx - cx;
    const dy = sy - cy;
    const len = Math.hypot(dx, dy) || 1;
    const gap = 26;
    let left = dx >= 0 ? sx + (dx / len) * gap : sx + (dx / len) * gap - w;
    let top = sy + (dy / len) * gap - (dy >= 0 ? 0 : h);
    if (Math.abs(dy) < len * 0.5) top = sy - h / 2;
    // Portrait (phones): the free space is above and below the dial, so hang the bubble there.
    const dialTop = box.top - stage.top;
    const dialBottom = dialTop + box.size;
    if (stage.height > stage.width * 1.15) {
      left = sx - w / 2;
      const above = dialTop - h - 6;
      const below = dialBottom + 6;
      const taskBottom = this.taskEl.hidden ? 0 : this.taskEl.getBoundingClientRect().bottom - stage.top;
      top = dy < 0 && above > taskBottom + 4 ? above : below + h < stage.height ? below : dy < 0 ? Math.max(taskBottom + 6, above) : stage.height - h - 8;
    }
    left = Math.max(8, Math.min(stage.width - w - 8, left));
    top = Math.max(8, Math.min(stage.height - h - 8, top));
    // Never cover the task card or the readout: try the other side of the anchor, then above or below.
    const panel = this.el.querySelector('.e6b-readpanel') as HTMLElement | null;
    const avoid = [this.taskEl.hidden ? null : this.taskEl, panel && panel.offsetParent ? panel : null]
      .filter((node): node is HTMLElement => !!node)
      .map((node) => { const t = node.getBoundingClientRect(); return { l: t.left - stage.left, t: t.top - stage.top, r: t.right - stage.left, b: t.bottom - stage.top }; })
      .filter((card) => card.r > card.l);
    // Nor the red "move the hairline" tab at the rim.
    const tab = rotatePoint({ x: Math.sin(this.cursor * Math.PI / 180) * 1531, y: -Math.cos(this.cursor * Math.PI / 180) * 1531 }, this.viewAngle);
    const tx = box.left - stage.left + (tab.x - (this.view.x - this.view.w / 2)) * px;
    const ty = box.top - stage.top + (tab.y - (this.view.y - this.view.w / 2)) * px;
    const tr = 100 * px;
    avoid.push({ l: tx - tr, t: ty - tr, r: tx + tr, b: ty + tr });
    const hits = (x: number, y: number) => avoid.find((card) => x < card.r + 6 && x + w > card.l - 6 && y < card.b + 6 && y + h > card.t - 6);
    const hit = hits(left, top);
    if (hit) {
      const flipped = Math.max(8, Math.min(stage.width - w - 8, dx >= 0 ? sx - gap - w : sx + gap));
      const options = [{ left, top: hit.t - h - 10 }, { left, top: hit.b + 10 }, { left: flipped, top }]
        .filter((o) => o.top >= 8 && o.top + h <= stage.height - 8 && !hits(o.left, o.top));
      if (options.length) ({ left, top } = options[0]);
    }
    bubble.style.transform = `translate(${left.toFixed(0)}px, ${top.toFixed(0)}px)`;
  }

  private renderOverlay(): void {
    this.overlayEl.innerHTML = this.howOpen ? howHtml(this.theta, this.howProbe, touchPrimary()) : '';
    this.overlayEl.hidden = !this.howOpen;
  }

  private bindChrome(): void {
    this.el.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const pick = (target.closest('[data-pick]') as HTMLElement | null)?.dataset.pick;
      if (pick) { this.pick(pick); return; }
      if (this.menuOpen && !target.closest('.menu') && !target.closest('[data-e6b="menu"]')) { this.menuOpen = false; this.renderStrip(); }
      // More folds the phone's secondary controls; any choice in it, or a tap elsewhere, closes it.
      if (target.closest('[data-e6b="more"]')) { this.moreOpen = !this.moreOpen; this.menuOpen = false; this.renderStrip(); return; }
      if (this.moreOpen && !(target.closest('.more-panel') && target.closest('label'))) { this.moreOpen = false; this.renderStrip(); }
      const modeButton = target.closest('button[data-mode]') as HTMLElement | null;
      if (modeButton) { this.setMode(modeButton.dataset.mode as Mode); return; }
      const side = (target.closest('button[data-side]') as HTMLElement | null)?.dataset.side as Side | undefined;
      if (side) { this.stop(); this.flipTo(side); return; }
      const stage = (target.closest('button[data-stage]') as HTMLElement | null)?.dataset.stage as Stage | undefined;
      if (stage) { this.startStage(stage); return; }
      const decide = (target.closest('[data-decide]') as HTMLElement | null)?.dataset.decide;
      if (decide) { this.decide(decide === 'true'); return; }
      const action = (target.closest('[data-e6b]') as HTMLElement | null)?.dataset.e6b;
      if (!action) return;
      if (action === 'home') this.openHome();
      else if (action === 'tour') this.startTour();
      else if (action === 'why') {this.procedureWhy=!this.procedureWhy;this.paintedCoach=null;this.renderCoach();}
      else if (action === 'tour-skip') this.finishTour();
      else if (action === 'slide-end') {this.stop();this.switchSlide(this.slideEnd === 'low' ? 'high' : 'low');}
      else if (action === 'upright') this.setViewRotation(0, true);
      else if (action === 'auto-turn') { this.autoTurn = !this.autoTurn; this.renderStrip(); if (this.autoTurn) this.orientWork(); }
      else if (action === 'centre') this.animateView({ x: 0, y: 0, w: VIEW });
      else if (action === 'menu') { this.menuOpen = !this.menuOpen; this.renderStrip(); }
      else if (action === 'loupe') { this.showLoupe = !this.showLoupe; this.renderStrip(); this.paint(); }
      else if (action === 'how') this.openHow(!this.howOpen);
      else if (action === 'back') this.watchStep(-1);
      else if (action === 'next') this.watchStep(1);
      else if (action === 'play') this.togglePlay();
      else if (action === 'flow-next') this.flowNext();
      else if (action === 'flow-problem') this.flowNextProblem();
      else if (action === 'flow-show') this.flowShow();
      else if (action === 'flow-why') { if (this.flow) { this.flow.whyOpen = !this.flow.whyOpen; this.renderFlow(); } }
      else if (action === 'pencil') { this.pencil = !this.pencil; target.closest('[data-e6b="pencil"]')!.setAttribute('aria-pressed', String(this.pencil)); }
      else if (action === 'erase') { this.wind = { ...this.wind, dot: null }; this.checkAlignment(true); this.paint(); }
      else if (action === 'coach-next' || action === 'step-next') this.coachNext();
      else if (action === 'step-back') this.stepBack();
      else if (action === 'coach-full') { this.coachFull = !this.coachFull; this.paintedCoach = null; this.renderCoach(); }
      else if (action === 'replay') this.replayMiss();
      else if (action === 'advance') this.advance();
    });
    this.el.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      if (target.dataset.e6b === 'exam') this.setExam(target.checked);
    });
    this.el.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      if (target.dataset.e6b === 'estimate') this.estimate = target.value;
      if (target.dataset.e6b === 'reading') this.answer = target.value;
      if (target.dataset.e6b === 'flow-input' && this.flow) {
        this.flow.entry = target.value;
        const check = target.form?.querySelector('button[type="submit"]');
        const typed = target.value.trim() !== '';
        if (typed) { target.removeAttribute('data-next'); check?.setAttribute('data-next', 'true'); }
        else { target.setAttribute('data-next', 'true'); check?.removeAttribute('data-next'); }
      }
    });
    this.el.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.flow) { this.flowSubmit(); return; }
      if (this.activeExercise && this.seq?.kind === 'guided') {
        const input = this.taskEl.querySelector('[data-e6b="procedure-entry"]') as HTMLInputElement | null;
        if (input) {
          const s = this.seq;
          // A checked entry moves straight on; the last one waits on › (Finish).
          if (this.enterProcedureReading(input.value) && s && s.index < s.demo.steps.length - 1) this.coachNext();
          return;
        }
      }
      if (this.problem && this.wantsEstimate(this.problem) && !this.estimateLocked) {
        this.estimateLocked = true;
        this.renderTask();
        (this.taskEl.querySelector('[data-e6b="reading"]') as HTMLInputElement | null)?.focus({ preventScroll: true });
        return;
      }
      this.checkAnswer();
    });
    this.el.addEventListener('pointerover', (event) => {
      const chip = (event.target as HTMLElement).closest('[data-given]') as HTMLElement | null;
      if (chip && !(this.mode === 'practice' && this.exam)) this.hoverGiven(Number(chip.dataset.given));
    });
    this.el.addEventListener('pointerout', (event) => {
      if ((event.target as HTMLElement).closest('[data-given]') && this.hover) this.hoverGiven(null);
    });
    this.el.addEventListener('focusin', (event) => {
      const chip = (event.target as HTMLElement).closest('[data-given]') as HTMLElement | null;
      if (chip && !(this.mode === 'practice' && this.exam)) this.hoverGiven(Number(chip.dataset.given));
    });
    this.el.addEventListener('focusout', (event) => {
      if ((event.target as HTMLElement).closest('[data-given]')) this.hoverGiven(null);
    });
    this.el.addEventListener('keydown', (event) => {
      if(event.key==='Escape'&&this.tourIndex>=0){this.finishTour();event.stopPropagation();return;}
      if (event.key === 'Escape' && (this.menuOpen || this.howOpen)) { this.menuOpen = false; this.howOpen = false; this.renderStrip(); this.renderOverlay(); event.stopPropagation(); }
    });
    // The overlay's probe and drag: across the unrolled scales.
    this.el.addEventListener('pointermove', (event) => {
      const svg = (event.target as Element).closest?.('[data-e6b="how-drag"]') as SVGSVGElement | null;
      if (!svg) return;
      const box = svg.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width) * 1080 - 40;
      if (event.buttons && this.howDrag != null) {
        this.theta = norm(this.howDrag.theta + ((x - this.howDrag.x) / 1000) * 360);
        this.paint();
        return;
      }
      this.howProbe = 10 * 10 ** Math.min(0.999, Math.max(0, x / 1000));
      this.renderOverlay();
    });
    this.el.addEventListener('pointerdown', (event) => {
      const svg = (event.target as Element).closest?.('[data-e6b="how-drag"]') as SVGSVGElement | null;
      if (!svg) return;
      const box = svg.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width) * 1080 - 40;
      const y = ((event.clientY - box.top) / box.height) * 250 - 90;
      this.howDrag = y > 36 ? { x, theta: this.theta } : null;
    });
    this.el.addEventListener('pointerup', () => { this.howDrag = null; });
  }

  private howDrag: { x: number; theta: number } | null = null;

  private pick(id: string): void {
    this.menuOpen = false;
    const [kind, value] = id.split(':');
    if (kind === 'exercise') { this.openExercise(value); return; }
    if (kind === 'task') { this.openTask(value as Shape); return; }
    if (kind === 'next') {
      const next = nextAction(this.record, new Date().toISOString(), today());
      if (next.kind === 'daily') this.openPractice('daily');
      else if (next.kind === 'learn') this.openTask(next.shape);
      else { this.mode = 'practice'; this.setSource({ kind: 'skill', shape: next.shape }); }
      return;
    }
    if (kind === 'src') { this.openPractice(value as 'daily' | 'mixed'); return; }
    if (kind === 'mission') { this.openPractice('mission', value); return; }
    if (kind === 'skill') { this.mode = 'practice'; this.setSource({ kind: 'skill', shape: value as Shape }); }
  }

  // --- Learn: stages and sequences ---------------------------------------------------
  private startStage(stage: Stage): void {
    if (this.activeExercise) { this.startExerciseStage(stage); return; }
    this.stop();
    this.mode = 'learn';
    this.stageOf = stage;
    this.verdict = null;
    this.ghost = null;
    this.problem = null;
    this.replayDone = false;
    const demo = this.demos[SHAPES.indexOf(this.shape)];
    if (stage === 'watch') {
      this.startSequence(demo, 'watch', 0, () => { this.playing = false; this.renderChrome(); }, 0);
      this.playing = !reducedMotion();
      this.renderStrip();
      if (this.playing) this.watchPlay();
      return;
    }
    if (stage === 'guided') {
      this.startSequence(demo, 'guided', 0, () => this.guidedRoundTwo());
      return;
    }
    this.seq = null;
    this.highlights = [];
    this.newProblem(this.shape, false);
  }

  private startExerciseStage(stage: Stage): void {
    const p=this.activeExercise!;
    this.stop();this.mode='learn';this.stageOf=stage;this.verdict=null;this.ghost=null;this.problem=null;this.replayDone=false;
    this.procedureEntries={};this.procedureFeedback='';
    const current=this.record.curriculum?.[p.operation]??{stage:'watch' as Stage,solved:[]};
    this.record={...this.record,curriculum:{...this.record.curriculum,[p.operation]:{...current,stage}}};this.store.save(this.record);
    if(stage==='solo'||stage==='done') {
      this.seq=null;this.highlights=[];
      const problem=problemForProcedure(p);problem.easy=false;
      this.newProblem(p.shape,false,problem);return;
    }
    this.startSequence(p.demo,stage==='watch'?'watch':'guided',1,()=>{
      if(stage==='guided') this.startStage('solo'); else {this.playing=false;this.renderChrome();}
    });
    this.playing=stage==='watch'&&!reducedMotion();this.renderStrip();
    if(this.playing)this.watchPlay();
  }

  private guidedProblem: Problem | null = null;

  private guidedRoundTwo(): void {
    const problem = makeProblem(this.shape, this.rand, true, this.face, this.live);
    this.guidedProblem = problem;
    this.startSequence(problem.demo, 'guided', 1, () => {
      this.setStage('solo');
      this.startStage('solo');
    });
  }

  private setStage(stage: Stage): void {
    const order: Stage[] = ['watch', 'guided', 'solo', 'done'];
    const was = this.record.stages[this.shape] ?? 'watch';
    if (order.indexOf(stage) > order.indexOf(was)) { this.record = { ...this.record, stages: { ...this.record.stages, [this.shape]: stage } }; this.store.save(this.record); }
  }

  /** Begin a run through `demo`. Guided and replay runs start the instrument away
   * from the answer so the learner makes each move; steps before `from` are done. */
  private startSequence(demo: Demo, kind: Sequence['kind'], round: number, then: () => void, from = 0, jump = false): void {
    this.stop();
    this.ghost = null;
    // A replay shows the learner's own numbers being set, from the first step they got wrong.
    const flowing = this.flow && this.activeExercise?.demo === demo;
    const auto = flowing ? this.activeExercise!.procedure.map(autoStep) : kind === 'watch' || kind === 'replay' ? demo.steps.map(() => true) : autoSteps(demo.steps, round);
    this.seq = { demo, kind, round, index: 0, auto, goals: [], met: false, then };
    const first = demo.steps[0];
    const wanted: Side = first.wind ? 'wind' : 'computer';
    if (kind !== 'replay' || from === 0) this.neutralPose(first);
    if (wanted !== this.side) this.setSide(wanted);
    if (jump || kind === 'replay') {
      // Put the instrument where the earlier steps leave it, then start at `from`.
      if (from > 0) this.applyStep(demo.steps[from - 1]);
      this.seqGo(from);
    } else this.seqGo(0);
  }

  /** A start position away from the first step's answer. */
  private neutralPose(first: Step): void {
    if(this.activeExercise){
      this.theta=0;this.cursor=0;this.viewAngle=0;this.setSlide('low');this.wind={plate:0,gs:150,dot:null,slide:'low'};return;
    }
    if (first.wind) {
      this.setSlide(first.wind.slide??'low');this.wind = { plate: wrap360(first.wind.plate + 70), gs: first.wind.gs, dot: null,slide:first.wind.slide };
      return;
    }
    this.theta = Math.abs(turn(first.theta)) < 25 ? 40 : 0;
    this.cursor = angleOf(10);
  }

  private applyStep(step: Step): void {
    if (step.wind) { this.setSlide(step.wind.slide??'low');this.wind = { ...step.wind }; return; }
    this.theta = norm(step.theta);
    if (step.cursor != null) this.cursor = norm(step.cursor);
  }

  private seqGo(index: number): void {
    const s = this.seq;
    if (!s) return;
    window.clearTimeout(this.dwellTimer);
    s.index = index;
    const step = s.demo.steps[index];
    const procedure = this.activeExercise && s.demo === this.activeExercise.demo ? this.activeExercise.procedure[index] : null;
    s.goals = s.auto[index] ? [] : procedure?.goals ?? stepGoals(s.demo.steps, index);
    this.procedureFeedback=''; this.procedureWhy=false; this.coachFull=false;
    s.met = procedure ? validateProcedureStep(this.activeExercise!,index,{...this.pose(),viewAngle:this.viewAngle},this.procedureEntries[index]) : stepMet(s.goals, this.pose());
    this.highlights = step.highlights;
    const wanted: Side = step.wind ? 'wind' : 'computer';
    const go = () => {
      this.orientWork();
      this.renderChrome();
      this.paint();
      if (s.auto[index]) {
        this.moveToStep(step, () => {
          if (this.seq !== s) return;
          this.paint();
          if (s.kind === 'watch' && !this.playing) { this.renderChrome(); return; }
          const last = index >= s.demo.steps.length - 1;
          this.dwellTimer = window.setTimeout(() => {
            if (this.seq !== s) return;
            if (last) { if (s.kind === 'watch') { this.playing = false; this.renderChrome(); } else this.seqFinish(); }
            else this.seqGo(index + 1);
          }, reducedMotion() ? 500 : s.kind === 'watch' ? DWELL_MS : AUTO_MS);
        });
      }
    };
    if (wanted !== this.side) this.flipTo(wanted, go); else go();
  }

  private orientWork(): void {
    if (!this.autoTurn || !this.seq) return;
    const procedure = this.activeExercise && this.seq.demo === this.activeExercise.demo ? this.activeExercise.procedure[this.seq.index] : null;
    if (procedure) {
      if (procedure.physical.kind === 'orient') this.setViewRotation(procedure.physical.angle,true,false);
      return;
    }
    const step = this.seq.demo.steps[this.seq.index];
    if (step.wind) { this.setViewRotation(0, true, false); return; }
    const spots = step.highlights.map((h) => this.locate(h)).filter((p) => p != null);
    const spot = spots.find((p) => p.layer === 'base') ?? spots[0];
    const angle = step.cursor ?? (spot ? spot.angle + (spot.layer === 'disc' ? step.theta : 0) : this.cursor);
    // A reading aid follows the work on alignment steps; guided cursor steps
    // still require the learner to put it on the requested graduation.
    if (step.cursor == null) this.cursor = norm(angle);
    this.setViewRotation(-angle, true, false);
  }

  private moveToStep(step: Step, done: () => void): void {
    const procedure = this.activeExercise?.procedure.find(p=>p.demoStep===step);
    if (procedure?.physical.kind === 'orient') {
      this.setViewRotation(procedure.physical.angle,true,false);
      this.dwellTimer=window.setTimeout(done,reducedMotion()?0:260);return;
    }
    if (procedure?.physical.kind === 'slide-end') { this.switchSlide(procedure.physical.end,done);return; }
    if (step.wind) {
      this.setSlide(step.wind.slide??'low');this.wind = { ...this.wind, slide:step.wind.slide, dot: step.wind.dot };
      this.moveTo(this.theta, this.cursor, done, step.wind.plate, step.wind.gs);
      return;
    }
    this.moveTo(step.theta, step.cursor ?? this.cursor, done);
  }

  private seqFinish(): void {
    const s = this.seq;
    if (!s) return;
    this.seq = null;
    this.highlights = [];
    s.then();
  }

  /** The bubble's button: next step when aligned, or the stage's next move. */
  private coachNext(): void {
    if (this.tourIndex>=0) {this.tourIndex+=1;this.tourGo();return;}
    const s = this.seq;
    if (!s) { if (this.ghost) this.replayMiss(); return; }
    if (s.kind === 'watch') { this.setStage('guided'); this.startStage('guided'); return; }
    if (!s.met && !s.auto[s.index]) return;
    if (s.index >= s.demo.steps.length - 1) this.seqFinish();
    else this.seqGo(s.index + 1);
  }

  /** Re-check alignment after the instrument moved. Snap home when the learner lets go inside the tolerance. */
  private checkAlignment(released = false): void {
    const s = this.seq;
    if (!s || s.auto[s.index] || s.kind === 'watch') return;
    const procedural = this.activeExercise && s.demo === this.activeExercise.demo;
    const met = procedural ? validateProcedureStep(this.activeExercise!,s.index,{...this.pose(),viewAngle:this.viewAngle},this.procedureEntries[s.index]) : stepMet(s.goals, this.pose());
    if (released && met) {
      for (const goal of s.goals) {
        if (goal.kind === 'disc') this.theta = goal.theta;
        if (goal.kind === 'cursor') this.cursor = goal.angle;
        if (goal.kind === 'plate') this.wind = { ...this.wind, plate: goal.plate };
        if (goal.kind === 'slide') this.wind = { ...this.wind, gs: goal.gs };
        if (goal.kind === 'dot') this.wind = { ...this.wind, dot: goal.dot };
      }
    }
    if (met !== s.met) {
      s.met = met;
      this.paintedHighlights = '';
      if (procedural && s.kind === 'guided') this.renderTask();
      this.renderCoach();
      if (met) this.el.classList.add('aligned'); else this.el.classList.remove('aligned');
    }
    this.flowMaybeAdvance();
  }

  // Watch transport
  private togglePlay(): void {
    if (this.playing) { this.stop(); this.renderChrome(); return; }
    const s = this.seq;
    if (!s || s.kind !== 'watch') { this.startStage('watch'); return; }
    this.playing = true;
    if (s.index >= s.demo.steps.length - 1) { this.neutralPose(s.demo.steps[0]); this.seqGo(0); } else this.seqGo(s.index + 1);
    this.renderStrip(); this.renderCoach();
  }

  private watchPlay(): void {
    const s = this.seq;
    if (s) this.seqGo(s.index);
  }

  private watchStep(delta: number): void {
    const s = this.seq;
    if (!s) return;
    this.stop();
    this.seq = s;
    const index = Math.max(0, Math.min(s.demo.steps.length - 1, s.index + delta));
    this.seqGo(index);
    this.renderStrip();
  }

  private stop(): void {
    this.playing = false;
    window.clearTimeout(this.dwellTimer); window.clearTimeout(this.slideTimer); window.clearTimeout(this.flipTimer);
    this.dial?.classList.remove('slide-flip','flip-out','flip-in');this.flipping=false;
    if(this.zoomFrame)cancelAnimationFrame(this.zoomFrame);this.zoomFrame=0;
    this.tween = null;this.viewTween=null;
  }

  // --- Problems: solo, practice, missions ---------------------------------------------
  private defaultSource(): Source {
    const next = nextAction(this.record, new Date().toISOString(), today());
    return next.kind === 'daily' ? this.dailySource() : { kind: 'mixed' };
  }

  private dailySource(): Source {
    const d = this.record.daily;
    if (d && d.day === today() && d.done < d.set.length) return { kind: 'daily', set: d.set, index: d.done, misses: d.misses, results: d.set.map((_, i) => (i < d.done ? 'ok' : '')) as ('ok' | 'miss')[] };
    const set = dailySet(this.record, new Date().toISOString(), this.rand);
    this.record = { ...this.record, daily: { day: today(), set, done: 0, misses: 0 } };
    this.store.save(this.record);
    return { kind: 'daily', set, index: 0, misses: 0, results: [] };
  }

  private setSource(source: Source): void {
    this.stop();
    this.source = source;
    this.seq = null;
    this.highlights = [];
    if (source.kind === 'mission') { this.missionLink(); return; }
    this.newProblem(this.practiceShape(), this.easier.has(this.practiceShape()));
  }

  private practiceShape(): Shape {
    const s = this.source;
    if (s.kind === 'daily') return s.set[Math.min(s.index, s.set.length - 1)];
    if (s.kind === 'skill') return s.shape;
    return SHAPES[Math.floor(this.rand() * SHAPES.length)];
  }

  private newProblem(shape: Shape, easy: boolean, problem?: Problem): void {
    this.problem = problem ?? makeProblem(shape, this.rand, easy, this.face, this.live);
    this.estimate = '';
    this.estimateLocked = false;
    this.answer = '';
    this.verdict = null;
    this.decision = null;
    this.ghost = null;
    this.replayDone = false;
    this.bests = null;
    this.elapsed = null;
    this.started = performance.now();
    this.highlights = [];
    const wanted: Side = this.problem.demo.steps[0].wind ? 'wind' : 'computer';
    if(this.problem.demo.steps[0].wind) this.setSlide(this.problem.demo.steps[0].wind.slide??'low');
    if (wanted !== this.side) this.setSide(wanted);
    if (this.problem.easy && this.mode === 'practice' && !this.exam) this.highlights = this.problem.demo.steps[0].highlights;
    this.startClock();
    this.renderChrome();
    this.paint();
    const field = this.taskEl.querySelector(`[data-e6b="${this.wantsEstimate(this.problem) ? 'estimate' : 'reading'}"]`) as HTMLInputElement | null;
    if (this.variant === 'lab' && matchMedia?.('(pointer: fine)').matches) field?.focus({ preventScroll: true });
  }

  private startClock(): void {
    window.clearInterval(this.timer);
    if (this.mode !== 'practice') return;
    this.timer = window.setInterval(() => {
      if (!this.el.isConnected || this.verdict) { window.clearInterval(this.timer); return; }
      const node = this.stripEl.querySelector('.timer');
      if (node) node.textContent = `⏱ ${clock(performance.now() - this.started)}`;
    }, 1000);
  }

  private missionLink(): void {
    const s = this.source;
    if (s.kind !== 'mission') return;
    const problem = missionProblem(s.mission, s.index, s.carried, this.face, this.live);
    this.newProblem(problem.shape, false, problem);
  }

  private checkAnswer(): void {
    const p = this.problem;
    if (!p || (this.verdict && (this.verdict.ok || this.replayDone))) return;
    const verdict = check(p, this.answer);
    if (verdict.value == null) { this.verdict = verdict; this.renderTask(); return; }
    this.verdict = verdict;
    this.elapsed = performance.now() - this.started;
    window.clearInterval(this.timer);
    const at = new Date().toISOString();
    const before = this.record.bests[p.shape];
    if(this.activeExercise) {
      const e=this.activeExercise, current=this.record.curriculum?.[e.operation]??{stage:'solo' as Stage,solved:[]};
      this.record={...this.record,curriculum:{...this.record.curriculum,[e.operation]:{stage:verdict.ok?'done':'guided',solved:verdict.ok?[...new Set([...current.solved,e.id])]:current.solved.filter(id=>id!==e.id)}}};
    }
    this.record = recordAttempt(this.record, p.shape, { correct: verdict.ok, helped: p.easy, ms: this.elapsed, at });
    this.bests = verdict.ok && !p.easy && before != null && this.record.bests[p.shape] !== before ? 'new' : null;
    const s = this.source;
    if (this.mode === 'learn') {
      if (verdict.ok) this.setStage('done');
    } else if (verdict.ok) this.easier.delete(p.shape);
    else this.easier.add(p.shape);
    if (this.mode === 'practice' && s.kind === 'daily') {
      s.results[s.index] = verdict.ok ? 'ok' : 'miss';
      if (!verdict.ok) s.misses += 1;
    }
    if (this.mode === 'practice' && s.kind === 'mission' && verdict.ok) this.carryMission(verdict);
    this.store.save(this.record);
    if (!verdict.ok) {
      const last = [...p.demo.steps].reverse().find((step) => !step.wind) ?? null;
      const windLast = p.demo.steps[p.demo.steps.length - 1].wind;
      this.ghost = windLast ? { theta: this.theta, cursor: null, dot: windLast.dot } : last ? { theta: last.theta, cursor: [...p.demo.steps].reverse().find((step) => step.cursor != null)?.cursor ?? null, dot: null } : null;
      if (this.exam && this.mode === 'practice') this.ghost = null;
    }
    this.renderChrome();
    this.paint();
    // Bring the verdict into view in a scrolling task sheet (phones).
    const verdictEl = this.taskEl.querySelector('.verdict') as HTMLElement | null;
    if (verdictEl && this.taskEl.scrollHeight > this.taskEl.clientHeight) this.taskEl.scrollTop = Math.max(0, verdictEl.offsetTop - 8);
  }

  private carryMission(verdict: Verdict): void {
    const s = this.source;
    if (s.kind !== 'mission' || !this.problem) return;
    const carried = carry(this.problem, verdict);
    s.carried[s.index] = carried.value;
    s.own[s.index] = carried.own;
  }

  /** On a miss: run the problem's own demo from the first step the learner's setting does not satisfy. */
  private replayMiss(): void {
    if(this.activeExercise) { const p=this.activeExercise,list=exercisesFor(p.operation),i=list.findIndex(e=>e.id===p.id);this.openExercise(list[Math.max(0,i-1)].id,'guided');return; }
    const p = this.problem;
    if (!p) return;
    const steps = p.demo.steps;
    let from = steps.findIndex((_, i) => stepGoals(steps, i).some((goal) => !goalMet(goal, this.pose())));
    if (from < 0) from = steps.length - 1;
    this.ghost = null;
    this.startSequence(p.demo, 'replay', 1, () => {
      this.replayDone = true;
      if (this.mode === 'practice' && this.source.kind === 'mission' && this.verdict) this.carryMission({ ...this.verdict, ok: false });
      this.renderChrome();
      this.paint();
    }, from);
  }

  private decide(answer: boolean): void {
    const s = this.source;
    if (this.mode === 'practice' && s.kind === 'mission') s.decided = answer;
    else this.decision = answer;
    this.renderTask();
  }

  /** The task card's main button. */
  private advance(): void {
    if (this.activeExercise) {
      const p=this.activeExercise, list=exercisesFor(p.operation), i=list.findIndex(e=>e.id===p.id);
      if(this.verdict?.ok) { if(i<list.length-1)this.openExercise(list[i+1].id,'solo');else this.openHome(); }
      else this.openExercise(list[Math.max(0,i-1)].id,'guided');
      return;
    }
    const s = this.source;
    if (this.mode === 'learn') {
      if (this.verdict?.ok) {
        const i = SHAPES.indexOf(this.shape);
        if (i < SHAPES.length - 1) this.openTask(SHAPES[i + 1]); else this.setMode('practice');
      } else this.newProblem(this.shape, true);
      return;
    }
    if (s.kind === 'daily') {
      s.index += 1;
      this.record = { ...this.record, daily: { day: today(), set: s.set, done: s.index, misses: s.misses } };
      if (s.index >= s.set.length) {
        this.record = finishDaily(this.record, today(), s.misses === 0);
        this.store.save(this.record);
        this.source = { kind: 'mixed' };
        this.problem = null;
        this.newProblem(this.practiceShape(), false);
        return;
      }
      this.store.save(this.record);
      this.newProblem(s.set[s.index], this.easier.has(s.set[s.index]));
      return;
    }
    if (s.kind === 'mission') {
      if (s.index >= s.mission.links.length) { this.setSource({ kind: 'mission', mission: s.mission, index: 0, carried: [], own: [], decided: null }); return; }
      s.index += 1;
      if (s.index >= s.mission.links.length) { this.renderChrome(); return; }
      this.missionLink();
      return;
    }
    const shape = this.practiceShape();
    this.newProblem(shape, this.easier.has(shape));
  }

  // --- Motion ----------------------------------------------------------------------
  private moveTo(theta: number, cursor: number, done: () => void, plate = this.wind.plate, gs = this.wind.gs, ms = MOVE_MS): void {
    this.spin = null;
    if (reducedMotion()) {
      this.theta = norm(theta);
      this.cursor = norm(cursor);
      this.wind = { ...this.wind, plate: wrap360(plate), gs };
      done();
      return;
    }
    const from = [this.theta, this.cursor, this.wind.plate, this.wind.gs];
    const to = [this.theta + turn(theta - this.theta), this.cursor + turn(cursor - this.cursor), this.wind.plate + turn(plate - this.wind.plate), gs];
    this.tween = { from, to, start: performance.now(), ms, done };
    this.kick();
  }

  private kick(): void {
    if (!this.frame) this.frame = requestAnimationFrame((now) => this.tick(now));
  }

  private tick(now: number): void {
    this.frame = 0;
    let more = false;
    if (this.viewTween) {
      const t = Math.min(1, (now - this.viewTween.start) / 250);
      this.viewAngle = norm(this.viewTween.from + (this.viewTween.to - this.viewTween.from) * easeInOut(t));
      if (t >= 1) this.viewTween = null; else more = true;
    }
    if (this.tween) {
      const t = Math.min(1, (now - this.tween.start) / this.tween.ms);
      const k = easeInOut(t);
      const at = (i: number) => this.tween!.from[i] + (this.tween!.to[i] - this.tween!.from[i]) * k;
      this.theta = norm(at(0));
      this.cursor = norm(at(1));
      this.wind = { ...this.wind, plate: wrap360(at(2)), gs: at(3) };
      if (t >= 1) {
        const done = this.tween.done;
        this.tween = null;
        done();
      } else more = true;
    }
    if (this.spin) {
      const dt = Math.min(50, now - this.spin.last);
      this.spin.last = now;
      if (this.side === 'wind') this.wind = { ...this.wind, plate: wrap360(this.wind.plate - this.spin.omega * dt) };
      else this.theta = norm(this.theta + this.spin.omega * dt);
      this.spin.omega *= Math.exp(-dt / 320);
      if (Math.abs(this.spin.omega) < 0.002) { this.spin = null; this.checkAlignment(true); }
      else more = true;
    }
    this.draw();
    if (more && this.el.isConnected) this.kick();
  }

  /** Ask for a repaint on the next frame. Pointer, wheel and touch events can
   * arrive several times a frame; they change state, and one frame draws it. */
  private paint(): void {
    if (!this.paintFrame) this.paintFrame = requestAnimationFrame(() => { this.paintFrame = 0; this.draw(); });
  }

  /** Draw now: animation frames, and the first paint after mounting. */
  private draw(): void {
    if (this.paintFrame) { cancelAnimationFrame(this.paintFrame); this.paintFrame = 0; }
    // Only the lens moves while it is dragged; nothing else needs a layer.
    if (!this.loupeDrag) this.markMoving();
    const orientation = `rotate(${this.viewAngle.toFixed(3)})`;
    for (const g of [this.rootG, this.ghostG, this.guideG, this.tagsG, this.windView]) if(g)attr(g, 'transform', orientation);
    this.paintKnob();
    if (this.side === 'wind') { this.paintWind(); show(this.loupe, false); }
    else {
      attr(this.disc, 'transform', `rotate(${this.theta.toFixed(3)})`);
      attr(this.cursorG, 'transform', `rotate(${this.cursor.toFixed(3)})`);
      attr(this.svg, 'viewBox', `${this.view.x - this.view.w / 2} ${this.view.y - this.view.w / 2} ${this.view.w} ${this.view.w}`);
      this.paintHighlights();
      this.paintGuide();
      this.paintGhost();
      this.paintLoupe();
      this.paintTags();
    }
    this.checkAlignment();
    if (this.flow) this.paintFlow();
    this.updateReadout();
    if (this.howOpen) this.renderOverlay();
    if (this.seq || this.ghost || this.tourIndex>=0) this.placeCoach();
  }

  /** A magnifier. It sits where the hairline crosses the two main scales until
   * the learner drags it; then it stays where it was dropped (for the session)
   * and magnifies whatever is under it. It never leaves the dial. */
  private paintLoupe(): void {
    const box = this.frameBox();
    const on = this.side === 'computer' && this.showLoupe && box.size > 0 && this.view.w > 1100 && this.activeExercise?.operation !== 'components';
    show(this.loupe, on);
    if (!on) return;
    const host = this.dialBox;
    const size = this.loupeSize || (this.loupeSize = this.loupe.offsetWidth) || 132;
    const px = box.size / this.view.w;
    const x0 = this.view.x - this.view.w / 2, y0 = this.view.y - this.view.w / 2;
    let sx: number, sy: number;
    if (this.loupeAt) { sx = box.left - host.left + this.loupeAt.x * box.size; sy = box.top - host.top + this.loupeAt.y * box.size; }
    else {
      const [fx, fy] = polar(this.cursor + this.viewAngle, this.face.radius.disc);
      sx = box.left - host.left + (fx - x0) * px; sy = box.top - host.top + (fy - y0) * px;
    }
    // The lens may be parked anywhere over the instrument's area (not just the
    // dial), always whole and on screen.
    const r = size / 2, area = this.areaBox;
    const vw = typeof innerWidth === 'number' ? innerWidth : area.right, vh = typeof innerHeight === 'number' ? innerHeight : area.bottom;
    const left = Math.max(area.left, 0) - host.left, right = Math.min(area.right, vw) - host.left;
    const top = Math.max(area.top, 0) - host.top, bottom = Math.min(area.bottom, vh) - host.top;
    sx = clamp(sx, left + r, Math.max(left + r, right - r)); sy = clamp(sy, top + r, Math.max(top + r, bottom - r));
    this.loupeCentre = { x: sx, y: sy };
    const fx = x0 + (sx - (box.left - host.left)) / px, fy = y0 + (sy - (box.top - host.top)) / px;
    // A fixed magnification on screen, whatever the window size (it was a fixed
    // 300 face units, which on a large window magnified barely 1.1x).
    const span = size / (px * LOUPE_POWER * Math.max(0.55, (this.view.w / VIEW) ** 0.5));
    const move = `translate(${(sx - r).toFixed(1)}px, ${(sy - r).toFixed(1)}px)`;
    if (this.loupe.style.transform !== move) this.loupe.style.transform = move;
    attr(this.loupeSvg, 'viewBox', `${(fx - span / 2).toFixed(1)} ${(fy - span / 2).toFixed(1)} ${span.toFixed(1)} ${span.toFixed(1)}`);
    attr(this.loupeView, 'transform', `rotate(${this.viewAngle.toFixed(3)})`);
    attr(this.loupeDisc, 'transform', `rotate(${this.theta.toFixed(3)})`);
    attr(this.loupeCursor, 'transform', `rotate(${this.cursor.toFixed(3)})`);
  }

  private loupeCentre = { x: 0, y: 0 };

  /** Grab the loupe anywhere and drop it anywhere over the dial. The lens takes
   * the pointer, so a drag that starts on it never turns the disc or ring. */
  private bindLoupe(): void {
    const lens = this.loupe;
    try { const saved = JSON.parse(sessionStorage.getItem(LOUPE_KEY) ?? 'null'); if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) this.loupeAt = saved; } catch { /* storage blocked */ }
    lens.addEventListener('pointerdown', (event) => {
      if (this.twistOwned) return;
      event.preventDefault(); event.stopPropagation();
      try { lens.setPointerCapture(event.pointerId); } catch { /* pointer gone */ }
      this.invalidateBox();
      const host = this.dialBox, box = this.frameBox();
      if (!box.size) return;
      this.loupeDrag = { id: event.pointerId, dx: event.clientX - (host.left + this.loupeCentre.x), dy: event.clientY - (host.top + this.loupeCentre.y) };
      this.el.classList.add('dragging', 'dragging-loupe');
      this.hideHint();
    });
    lens.addEventListener('pointermove', (event) => {
      if (this.twistOwned) return;
      const d = this.loupeDrag;
      if (!d || d.id !== event.pointerId) return;
      const box = this.frameBox();
      this.loupeAt = { x: (event.clientX - d.dx - box.left) / box.size, y: (event.clientY - d.dy - box.top) / box.size };
      this.paint();
    });
    const end = (event: PointerEvent) => {
      const d = this.loupeDrag;
      if (!d || d.id !== event.pointerId) return;
      this.loupeDrag = null;
      this.el.classList.remove('dragging', 'dragging-loupe');
      if (!this.loupeAt) return;
      // Store where it is actually drawn (clamped), so it reopens there.
      this.draw();
      const box = this.frameBox(), host = this.dialBox;
      this.loupeAt = { x: (host.left + this.loupeCentre.x - box.left) / box.size, y: (host.top + this.loupeCentre.y - box.top) / box.size };
      try { sessionStorage.setItem(LOUPE_KEY, JSON.stringify(this.loupeAt)); } catch { /* storage blocked */ }
    };
    lens.addEventListener('pointerup', end);
    lens.addEventListener('pointercancel', end);
    lens.addEventListener('dblclick', (event) => {
      event.preventDefault(); event.stopPropagation();
      this.loupeAt = null;
      try { sessionStorage.removeItem(LOUPE_KEY); } catch { /* storage blocked */ }
      this.paint();
    });
    holdPage(lens);
  }

  private movingTimer = 0;
  /** While anything moves, the turning groups get their own compositor layers
   * (CSS `.moving`), so a turn is a transform of an already-drawn layer, not a
   * repaint of the printed face. At rest they drop back to the SVG, so a zoom
   * settles crisp instead of scaling a cached bitmap. */
  private markMoving(): void {
    if (!this.el.classList.contains('moving')) this.el.classList.add('moving');
    window.clearTimeout(this.movingTimer);
    this.movingTimer = window.setTimeout(() => {
      if (this.drag || this.pointers.size || this.frame) this.markMoving();
      else this.el.classList.remove('moving');
    }, 400);
  }

  private paintedKnob = '';
  /** The View dial's needle points to the computer's top, like a compass. */
  private paintKnob(): void {
    const a = this.viewAngle.toFixed(1);
    if (a === this.paintedKnob) return;
    this.paintedKnob = a;
    const knob = this.el.querySelector('.e6b-view-knob') as HTMLElement | null;
    const needle = knob?.querySelector('.needle') as SVGGElement | null;
    if (needle) attr(needle, 'transform', `rotate(${a})`);
    knob?.classList.toggle('turned', Math.abs(turn(this.viewAngle)) > 0.5);
  }

  /** The soft shadow under the face: a static element, so turning the disc never repaints it. */
  private layoutShadow(): void {
    const box = this.frameBox();
    const host = this.dial.getBoundingClientRect();
    const shadow = this.el.querySelector('.e6b-shadow') as HTMLElement | null;
    if (!shadow || !box.size) return;
    const d = (box.size * (2 * this.face.radius.base)) / VIEW;
    shadow.style.width = shadow.style.height = `${d.toFixed(0)}px`;
    shadow.style.left = `${(box.left - host.left + box.size / 2 - d / 2).toFixed(0)}px`;
    shadow.style.top = `${(box.top - host.top + box.size / 2 - d / 2).toFixed(0)}px`;
  }

  private paintedTags = '';
  /** Values under the hairline, on the scale beside it, upright. Rebuilt only when
   * the text changes; otherwise the two tags are just moved. */
  private paintTags(): void {
    const on = (this.aids().tags && this.variant === 'lab') || this.variant === 'card';
    if (!on) { if (this.paintedTags) { this.tagsG.innerHTML = ''; this.paintedTags = ''; } return; }
    const t = tags(this.pose());
    // Keep the tags clear of the loupe, which sits on the crossing.
    const box = this.frameBox();
    const loupeR = !this.loupeAt && this.loupe.style.display !== 'none' && box.size ? ((this.loupeSize || 132) / 2) * (this.view.w / box.size) : 0;
    const rOut = loupeR ? Math.min(1390, Math.max(1290, this.face.radius.disc + loupeR + 50)) : 1290; // below the rim tab
    const rIn = loupeR ? Math.min(905, this.face.radius.disc - loupeR - 50) : 905;
    const key = `${t.outer}|${t.inner}`;
    if (key !== this.paintedTags) {
      this.paintedTags = key;
      const tag = (text: string, cls: string) => {
        const w = text.length * 30 + 40;
        return `<g class="tag ${cls}"><rect x="${(-w / 2).toFixed(0)}" y="-36" width="${w.toFixed(0)}" height="72" rx="36"/><text>${text}</text></g>`;
      };
      this.tagsG.innerHTML = tag(t.outer, 'outer') + tag(t.inner, 'inner');
    }
    const g1 = this.tagsG.children[0];
    const g2 = this.tagsG.children[1];
    const [x1, y1] = polar(this.cursor, rOut);
    const [x2, y2] = polar(this.cursor, rIn);
    if(g1)attr(g1, 'transform', `translate(${x1.toFixed(1)} ${y1.toFixed(1)}) rotate(${-this.viewAngle})`);
    if(g2)attr(g2, 'transform', `translate(${x2.toFixed(1)} ${y2.toFixed(1)}) rotate(${-this.viewAngle})`);
  }

  private paintedGhost = '';
  private paintGhost(): void {
    const g = this.ghost;
    const key = g && this.side === 'computer' ? `${g.theta}|${g.cursor}` : '';
    if (key === this.paintedGhost) return;
    this.paintedGhost = key;
    this.ghostG.style.display = key ? '' : 'none';
    if (!g || !key) return;
    attr(this.ghostDisc, 'transform', `rotate(${g.theta.toFixed(3)})`);
    const line = this.ghostG.querySelector('.ghost-line') as SVGPathElement;
    line.style.display = g.cursor == null ? 'none' : '';
    attr(line, 'transform', `rotate(${(g.cursor ?? 0).toFixed(3)})`);
  }

  /** Direction cues for the current goal: an arc from where the mark is to where it goes, a dashed target hairline. */
  private paintedGuide = '';
  private paintGuide(): void {
    const s = this.seq;
    let html = '';
    if (s && !s.auto[s.index] && s.kind !== 'watch' && this.side === 'computer') {
      for (const goal of s.goals) {
        if (goal.kind === 'cursor' && !goalMet(goal, this.pose())) {
          html += `<path class="target-line" transform="rotate(${goal.angle.toFixed(3)})" d="M0 -470V-1440"/>`;
        }
        if (goal.kind === 'disc' && !goalMet(goal, this.pose())) {
          const ref = s.demo.steps[s.index].highlights.map((h) => this.locate(h)).find((spot) => spot?.layer === 'disc');
          const base = ref?.angle ?? 0;
          const a0 = base + this.theta;
          const a1 = base + goal.theta;
          const sweep = turn(a1 - a0);
          if (Math.abs(sweep) > 1.5) {
            const r = 1060;
            const [x0, y0] = polar(a0, r);
            const [x1, y1] = polar(a0 + sweep, r);
            const [hx, hy] = polar(a0 + sweep - Math.sign(sweep) * 2.2, r + 26);
            const [kx, ky] = polar(a0 + sweep - Math.sign(sweep) * 2.2, r - 26);
            html += `<path class="turn-arc" d="M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 ${Math.abs(sweep) > 180 ? 1 : 0} ${sweep > 0 ? 1 : 0} ${x1.toFixed(1)} ${y1.toFixed(1)}"/><path class="turn-head" d="M${x1.toFixed(1)} ${y1.toFixed(1)}L${hx.toFixed(1)} ${hy.toFixed(1)}L${kx.toFixed(1)} ${ky.toFixed(1)}Z"/>`;
          }
        }
      }
      if (s.met && s.goals.length) {
        const anchor = this.coachAnchor();
        if (anchor) html += `<g class="aligned-tick" transform="translate(${anchor.x.toFixed(1)} ${anchor.y.toFixed(1)})"><circle r="44"/><path d="M-20 2L-6 16L22 -14"/></g>`;
      }
    }
    if (html === this.paintedGuide) return;
    this.paintedGuide = html;
    this.guideG.innerHTML = html;
  }

  private paintedDot = '';
  private paintWind(): void {
    attr(this.slideG, 'transform', `translate(0 ${(this.wind.gs * this.windUnits()).toFixed(1)})`);
    attr(this.plateG, 'transform', `rotate(${(-this.wind.plate).toFixed(3)})`);
    attr(this.wsvg, 'viewBox', `${this.view.x - this.view.w / 2} ${this.view.y - this.view.w / 2} ${this.view.w} ${this.view.w}`);
    const dot = this.wind.dot;
    const key = dot ? dot.map((v) => v.toFixed(1)).join(',') : '';
    if (key !== this.paintedDot) {
      this.paintedDot = key;
      this.dotG.innerHTML = dot
        ? `<path class="pencil-line" d="M0 0L${dot[0].toFixed(1)} ${dot[1].toFixed(1)}"/><circle class="pencil-dot" cx="${dot[0].toFixed(1)}" cy="${dot[1].toFixed(1)}" r="15"/>`
        : '';
    }
    const coach = this.aids().coach || (this.seq && !this.exam) || (this.hover && !this.exam);
    let hl = '';
    const s = this.seq;
    const met = s?.met && s.goals.length ? ' ok' : '';
    const items = [...(coach ? this.highlights : []), ...(this.hover && !this.exam ? [this.hover] : [])];
    for (const item of items) {
      if (item.kind === 'wind') {
        let x = 0;
        let y = 0;
        if (item.id === 'index') y = -1292;
        else if (item.id === 'dot') { if (!dot) continue; [x, y] = toScreen(dot, this.wind.plate); }
        hl += `<circle class="hl-ring${met}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${item.id === 'index' ? 70 : 52}"/>`;
      } else if (item.kind === 'arc') {
        const r = item.value * this.windUnits();
        const cy = this.wind.gs * this.windUnits();
        const half = Math.min(60, (Math.asin(Math.min(1, SLIDE.halfWidth / r)) * 180) / Math.PI);
        const [ax, ay] = polar(-half, r);
        const [bx, by] = polar(half, r);
        hl += `<path class="hl-arc" d="M${ax.toFixed(1)} ${(ay + cy).toFixed(1)}A${r} ${r} 0 0 1 ${bx.toFixed(1)} ${(by + cy).toFixed(1)}"/>`;
      }
    }
    // Pencil-dot target and plate/slide cues for the learner's goal.
    if (s && !s.auto[s.index] && s.kind !== 'watch') {
      for (const goal of s.goals) {
        if (goal.kind === 'dot' && !goalMet(goal, this.pose())) {
          const [x, y] = toScreen(goal.dot, this.wind.plate);
          hl += `<circle class="dot-target" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.max(64, goal.tol).toFixed(0)}"/><circle class="dot-target-core" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10"/>`;
        }
        if (goal.kind === 'plate' && !goalMet(goal, this.pose())) {
          const sweep = -turn(goal.plate - this.wind.plate);
          const r = 1110;
          const [x1, y1] = polar(sweep, r);
          const [hx, hy] = polar(sweep - Math.sign(sweep) * 2.4, r + 30);
          const [kx, ky] = polar(sweep - Math.sign(sweep) * 2.4, r - 30);
          if (Math.abs(sweep) > 1.5) hl += `<path class="turn-arc" d="M0 ${-r}A${r} ${r} 0 ${Math.abs(sweep) > 180 ? 1 : 0} ${sweep > 0 ? 1 : 0} ${x1.toFixed(1)} ${y1.toFixed(1)}"/><path class="turn-head" d="M${x1.toFixed(1)} ${y1.toFixed(1)}L${hx.toFixed(1)} ${hy.toFixed(1)}L${kx.toFixed(1)} ${ky.toFixed(1)}Z"/>`;
        }
        if (goal.kind === 'slide' && !goalMet(goal, this.pose())) {
          const up = goal.gs < this.wind.gs;
          hl += `<g class="slide-cue" transform="translate(0 ${up ? -1440 : 1440})"><path d="M0 ${up ? -120 : 120}l-40 ${up ? 50 : -50}h80Z"/></g>`;
        }
      }
      if (s.met && s.goals.length) {
        const anchor = this.coachAnchor();
        if (anchor) hl += `<g class="aligned-tick" transform="translate(${anchor.x.toFixed(1)} ${anchor.y.toFixed(1)})"><circle r="44"/><path d="M-20 2L-6 16L22 -14"/></g>`;
      }
    }
    this.hlWind.innerHTML = hl;
  }

  private paintedHighlights = '';
  private paintHighlights(force = false): void {
    const s = this.seq;
    const coach = this.aids().coach || (!!s && !this.exam) || (this.mode === 'practice' && !this.exam);
    const items = [...(coach ? this.highlights : []), ...(this.hover && !(this.mode === 'practice' && this.exam) ? [this.hover] : [])];
    const ok = !!s && s.met && s.goals.length > 0;
    const key = JSON.stringify(items) + ok;
    if (!force && key === this.paintedHighlights) return;
    this.paintedHighlights = key;
    if (this.side === 'wind') { this.paintWind(); return; }
    let base = '';
    let disc = '';
    for (const item of items) {
      const spot = this.locate(item);
      if (!spot) continue;
      const [x, y] = polar(spot.angle, spot.r);
      const svg = `<g class="hl${ok ? ' ok' : ''}${item === this.hover ? ' hover' : ''}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${spot.angle.toFixed(2)})"><rect x="-38" y="-50" width="76" height="100" rx="18"/></g>`;
      if (spot.layer === 'base') base += svg; else disc += svg;
    }
    this.hlBase.innerHTML = base;
    this.hlDisc.innerHTML = disc;
  }

  private locate(item: Highlight): { layer: 'base' | 'disc'; angle: number; r: number } | null {
    if (item.kind === 'wind' || item.kind === 'arc') return null;
    if (item.kind === 'scale') {
      const found = scale(this.face, item.scale);
      return { layer: found.layer, angle: found.at(item.value), r: found.r + found.dir * 40 };
    }
    if (item.kind === 'mark') {
      const found = mark(this.face, item.id);
      return { layer: found.layer, angle: angleOf(found.value), r: found.layer === 'base' ? 1186 : 1030 };
    }
    if (item.id === 'rate') return { layer: 'disc', angle: angleOf(60), r: 1010 };
    if (item.id === 'unit') return { layer: 'disc', angle: 0, r: 1010 };
    if (item.id === 'seconds') return { layer: 'disc', angle: angleOf(36), r: 1030 };
    if (item.id === 'density') return { layer: 'disc', angle: this.face.index.density, r: 818 };
    return { layer: 'base', angle: this.face.index.mach, r: 612 };
  }

  private paintComponents(): void {
    const table=this.el.querySelector('.e6b-component-table') as SVGSVGElement;
    const p=this.activeExercise, on=p?.operation==='components';
    table.style.display=on?'':'none';
    this.invalidateBox();
    this.el.classList.toggle('components',!!on);
    if(!on) { this.svg.style.display=this.side==='computer'?'':'none'; this.wsvg.style.display=this.side==='wind'?'':'none'; return; }
    this.svg.style.display='none';this.wsvg.style.display='none';this.loupe.style.display='none';
    const a=p!.procedure.find(s=>s.physical.kind==='read')!.physical;
    if(a.kind==='read'&&a.reading.kind==='component') {
      const active=this.seq?p!.procedure[this.seq.index].physical:null;
      table.innerHTML=componentTableSvg(a.reading.speed,a.reading.angle,active?.kind==='read'&&active.reading.kind==='component'?active.reading.field:null);
    }
  }

  private windUnits(): number { return this.slideEnd === 'high' ? HIGH_SPEED_SLIDE.unitsPerKt : U; }
  private slideSpec() { return this.slideEnd === 'high' ? HIGH_SPEED_SLIDE : SLIDE; }
  private setSlide(end:'low'|'high'):void {
    if(end===this.slideEnd)return;
    this.slideEnd=end;
    this.wind={...this.wind,slide:end,gs:end==='high'?500:150};
    this.slideG.innerHTML=this.slideImage(renderWind(`${this.id}-${end}`,this.slideSpec()).slide);
    this.paintedDot='';this.renderStrip();this.paint();
  }
  switchSlide(end:'low'|'high',done:()=>void=()=>{}):void {
    if(end===this.slideEnd){done();return;}
    if(reducedMotion()){this.setSlide(end);done();return;}
    this.dial.classList.add('slide-flip');
    window.clearTimeout(this.slideTimer);
    this.slideTimer=window.setTimeout(()=>{
      this.setSlide(end);this.dial.classList.remove('slide-flip');done();
    },250);
  }

  // --- Sides -------------------------------------------------------------------------
  private setSide(side: Side): void {
    this.side = side;
    this.invalidateBox();
    this.svg.style.display = side === 'computer' && this.activeExercise?.operation!=='components' ? '' : 'none';
    this.wsvg.style.display = side === 'wind' ? '' : 'none';
    this.el.dataset.showing = side;
    this.paintedHighlights = '';
    this.paintedGuide = '';
    this.renderStrip();
    this.paint();
  }

  /** Turn the computer over with a short flip; `then` runs once the new side faces up. */
  flipTo(side: Side, then?: () => void): void {
    if (side === this.side) { then?.(); return; }
    if (reducedMotion() || this.flipping) { this.setSide(side); then?.(); return; }
    this.flipping = true;
    this.dial.classList.add('flip-out');
    this.flipTimer=window.setTimeout(() => {
      this.setSide(side);
      this.dial.classList.remove('flip-out');
      this.dial.classList.add('flip-in');
      this.flipTimer=window.setTimeout(() => {
        this.dial.classList.remove('flip-in');
        this.flipping = false;
        then?.();
      }, 230);
    }, 230);
  }

  // --- Pointer, wheel and keys ----------------------------------------------------
  /** The square the viewBox is drawn into (the element may be letterboxed). */
  /** Measured once, then reused until the layout can have changed (resize,
   * scroll, chrome re-render, side flip) or a quarter second has passed.
   * Measuring after every write forced a synchronous layout per pointer move. */
  private frameBox(): { left: number; top: number; size: number } {
    const now = performance.now();
    if (this.box && now - this.boxAt < 250) return this.box;
    const surface=this.activeExercise?.operation==='components'?this.el.querySelector('.e6b-component-table')!:this.side==='wind'?this.wsvg:this.svg;
    const box = surface.getBoundingClientRect();
    const size = Math.min(box.width, box.height);
    this.dialBox = this.dial.getBoundingClientRect();
    this.areaBox = this.el.getBoundingClientRect();
    this.boxAt = now;
    this.box = { left: box.left + (box.width - size) / 2, top: box.top + (box.height - size) / 2, size };
    return this.box;
  }

  private boxAt = 0;
  private dialBox: DOMRect = { left: 0, top: 0, width: 0, height: 0 } as DOMRect;
  private areaBox: DOMRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
  private invalidateBox(): void { this.box = null; this.loupeSize = 0; }
  private readonly onScroll = () => { this.box = null; };

  private toFace(clientX: number, clientY: number): { x: number; y: number } {
    return viewToFace(this.toView(clientX, clientY), this.viewAngle);
  }

  private toView(clientX: number, clientY: number): { x: number; y: number } {
    const box = this.frameBox();
    const s = this.view.w / box.size;
    return { x: this.view.x - this.view.w / 2 + (clientX - box.left) * s, y: this.view.y - this.view.w / 2 + (clientY - box.top) * s };
  }

  private angleAt(p: { x: number; y: number }): number {
    return norm((Math.atan2(p.x, -p.y) * 180) / Math.PI);
  }

  /** What a press at face point `p` grabs: the hairline (line or handle), the disc, or the fixed ring.
   * A mouse grabs the hairline within 16 px anywhere along it. A finger grabs it
   * within 24 px (a 48 px target) on the fixed ring and the handle only, so a
   * finger on the disc always turns the disc. */
  private hitComputer(p: { x: number; y: number }, touch = false): 'cursor' | 'disc' | 'base' | null {
    const r = Math.hypot(p.x, p.y);
    const a = this.angleAt(p);
    const pxPerUnit = this.frameBox().size / this.view.w;
    const offCursor = Math.abs(turn(a - this.cursor)) * Math.PI / 180 * r * pxPerUnit;
    // The red tab at the rim is the explicit "move the red line" control: grab it generously.
    const offCursorUnits = Math.abs(turn(a - this.cursor)) * Math.PI / 180 * r;
    if (r > 1470 && r < 1640 && offCursorUnits < (touch ? 130 : 100)) return 'cursor';
    if (touch ? r > this.face.radius.disc && r < 1600 && offCursor < 24 : r > 460 && r < 1580 && offCursor < 16) return 'cursor';
    if (r <= this.face.radius.disc && r > this.face.radius.hub) return 'disc';
    if (r > this.face.radius.disc && r < this.face.radius.base + 40) return 'base';
    return null;
  }

  /** Clockwise screen angle of a pointer about the instrument centre, in degrees. */
  private screenAngle(clientX: number, clientY: number): number {
    const o = this.offset(clientX, clientY);
    return norm((Math.atan2(o.x, -o.y) * 180) / Math.PI);
  }

  /** Turn the black ring by `deg` on screen. Only the ring moves: the view turns and the
   * disc and hairline counter-turn by the same amount, so both stay put on screen. */
  private turnRing(deg: number): void {
    this.theta = norm(this.theta - deg);
    this.cursor = norm(this.cursor - deg);
    this.setViewRotation(this.viewAngle + deg, false, false);
    this.paint();
  }

  /** Pointer offset from the instrument centre, in screen px. */
  private offset(clientX: number, clientY: number): { x: number; y: number } {
    const box = this.frameBox();
    const k = box.size / this.view.w;
    return { x: clientX - (box.left + (0 - (this.view.x - this.view.w / 2)) * k), y: clientY - (box.top + (0 - (this.view.y - this.view.w / 2)) * k) };
  }

  private wheelCursor: { raw: number; at: number } | null = null;
  private gesture: { theta: number; w: number; plate: number; view: number; whole: boolean; mid: { x: number; y: number } } | null = null;

  /** Scroll wheel and trackpad over the dial: a plain scroll or two-finger swipe
   * turns the whole computer (wheelSpin; both axes, down/right clockwise);
   * pinch (ctrl+wheel) zooms; Option turns the disc (or the wind plate) under
   * the fingers; Shift, or the pointer on the handle, moves the hairline.
   * The listener is on the dial's SVG, whose hit area is the round face, so a
   * scroll anywhere else still scrolls the page. Drawing is one per frame. */
  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.hideHint();
    this.stop();
    this.spin = null;
    const [dx, dy] = wheelPixels(event.deltaX, event.deltaY, event.deltaMode);
    if (event.ctrlKey) {
      this.zoomAbout(this.toView(event.clientX, event.clientY), clamp(this.view.w * pinchFactor(dy), MIN_VIEW, VIEW));
      return;
    }
    const o = this.offset(event.clientX, event.clientY);
    const deg = wheelTurn(dx, dy, o.x, o.y);
    const spin = wheelSpin(dx, dy);
    if (this.side === 'wind') {
      if (event.shiftKey) {
        const unitsPerPx = this.view.w / (this.frameBox().size || 1);
        this.wind = { ...this.wind, gs: clamp(this.wind.gs - (dy * unitsPerPx) / this.windUnits(), this.slideSpec().minKt, this.slideSpec().maxKt) };
      } else if (event.altKey) this.wind = { ...this.wind, plate: wrap360(this.wind.plate - deg) };
      else this.setViewRotation(this.viewAngle + spin);
    } else {
      const p = this.toFace(event.clientX, event.clientY);
      const onHandle = this.hitComputer(p) === 'cursor' && Math.hypot(p.x, p.y) > 1380;
      if (!event.shiftKey && !onHandle && !event.altKey) this.setViewRotation(this.viewAngle + spin);
      else if (event.shiftKey || onHandle) {
        const now = performance.now();
        if (!this.wheelCursor || now - this.wheelCursor.at > 250) this.wheelCursor = { raw: this.cursor, at: now };
        this.wheelCursor.raw = norm(this.wheelCursor.raw + deg);
        this.wheelCursor.at = now;
        this.cursor = snapCursor(this.wheelCursor.raw, this.theta, this.grads);
      } else this.theta = norm(this.theta + deg);
    }
    this.paint();
    window.clearTimeout(this.wheelSettle);
    // Settle once the scroll (and macOS's own momentum) has stopped.
    this.wheelSettle = window.setTimeout(() => { this.checkAlignment(true); this.paint(); }, 160);
  }

  private wheelSettle = 0;

  /** Safari's trackpad gestures: rotation turns the disc (or plate) one to one, scale zooms. */
  private bindGestures(svg: SVGSVGElement): void {
    svg.addEventListener('gesturestart', (event) => {
      event.preventDefault();
      // iOS also reports a two-finger touch as gesture events; the pointer handler owns touch.
      if ((this.pointers?.size ?? 0) >= 2) { this.gesture = null; return; }
      const e = gestureNumbers(event), box = this.frameBox();
      const x = e.x ?? box.left + box.size / 2, y = e.y ?? box.top + box.size / 2;
      this.stop(); this.spin = null;
      const p = this.toFace(x, y);
      const whole = e.alt || Math.hypot(p.x, p.y) > (this.side === 'wind' ? 1180 : this.face.radius.disc);
      this.gesture = { theta: this.theta, w: this.view.w, plate: this.wind.plate, view: this.viewAngle, whole, mid: this.toView(x, y) };
    }, { passive: false });
    svg.addEventListener('gesturechange', (event) => {
      event.preventDefault();
      const e = gestureNumbers(event), g = this.gesture;
      if (!g) return;
      const next = gestureApply({ theta: g.whole ? g.view : this.side === 'wind' ? -g.plate : g.theta, w: g.w }, e.scale, e.rotation, MIN_VIEW, VIEW);
      if (g.whole) this.setViewRotation(next.theta);
      else if (this.side === 'wind') this.wind = { ...this.wind, plate: wrap360(-next.theta) };
      else this.theta = next.theta;
      this.zoomAbout(g.mid, next.w);
    }, { passive: false });
    svg.addEventListener('gestureend', (event) => { event.preventDefault(); this.gesture = null; this.checkAlignment(true); this.paint(); }, { passive: false });
  }

  /** Keys with the instrument focused: arrows turn the disc (Shift coarse); Alt+arrows move the hairline a graduation. */
  private onKey(event: KeyboardEvent): void {
    const big = event.shiftKey;
    const dir = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    let handled = true;
    if(dir||['[',']','Backspace','+','=','-','0'].includes(event.key))this.stop();
    if (event.key === '[' || event.key === ']') this.setViewRotation(this.viewAngle + (event.key === '[' ? -1 : 1)*(event.shiftKey?1:15), true);
    else if(dir && this.side==='wind' && event.ctrlKey) {
      const [x,y]=toScreen(this.wind.dot??[0,0],this.wind.plate), step=(big?10:1)*this.windUnits();
      const dx=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0;
      const dy=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;
      if(Math.hypot(x+dx,y+dy)<PLATE_R)this.wind={...this.wind,dot:toPlate(x+dx,y+dy,this.wind.plate)};
    } else if(event.key==='Backspace'&&this.side==='wind')this.wind={...this.wind,dot:null};
    else if (dir && this.side === 'wind') {
      if (event.altKey) this.wind = { ...this.wind, gs: clamp(this.wind.gs - dir * (big ? 10 : 1), this.slideSpec().minKt, this.slideSpec().maxKt) };
      else this.wind = { ...this.wind, plate: wrap360(this.wind.plate - dir * (big ? 10 : 1)) };
    } else if (dir && event.altKey) {
      for (let i = 0; i < (big ? 10 : 1); i++) this.cursor = nextGraduation(this.cursor, dir as 1 | -1, this.grads);
    } else if (dir) this.theta = norm(this.theta + dir * (big ? 2 : 0.2));
    else if (event.key === '+' || event.key === '=') this.zoomAbout({ x: this.view.x, y: this.view.y }, clamp(this.view.w / 1.25, MIN_VIEW, VIEW));
    else if (event.key === '-') this.zoomAbout({ x: this.view.x, y: this.view.y }, clamp(this.view.w * 1.25, MIN_VIEW, VIEW));
    else if (event.key === '0') { this.setViewRotation(0, true); this.animateView({ x: 0, y: 0, w: VIEW }); }
    else if (event.key === 'Enter') this.coachNext();
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); this.hideHint(); this.paint(); }
  }

  /** A second pointer anywhere on the instrument — the loupe, the View dial, the
   * task card — turns the whole computer. Capture runs before a child can
   * stopPropagation, and cancels a disc or loupe drag already under way. */
  private bindInstrumentPointers(): void {
    const root = this.el;
    root.addEventListener('pointerdown', (event) => {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size < 2) return;
      this.beginWholeTwist();
      try { root.setPointerCapture(event.pointerId); } catch { /* a pointer the browser no longer tracks */ }
      event.stopPropagation();
    }, true);
    root.addEventListener('pointermove', (event) => {
      if (!this.pointers.has(event.pointerId)) return;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!this.twistOwned || this.pointers.size < 2) return;
      this.applyTwist();
      event.stopPropagation();
    }, true);
    const end = (event: PointerEvent) => {
      if (!this.pointers.has(event.pointerId)) return;
      const twisting = this.twistOwned;
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) {
        this.pinch = null;
        this.twistOwned = false;
      }
      if (twisting) event.stopPropagation();
    };
    root.addEventListener('pointerup', end, true);
    root.addEventListener('pointercancel', end, true);
  }

  /** Promote the current pointers to a whole-unit twist. Settings stay put. */
  private beginWholeTwist(): void {
    this.drag = null;
    this.loupeDrag = null;
    this.viewKnob = null;
    this.spin = null;
    this.stop();
    this.hideHint();
    this.el.classList.remove('dragging', 'dragging-disc', 'dragging-cursor', 'dragging-ring', 'dragging-pan', 'dragging-view', 'dragging-loupe', 'dragging-plate', 'dragging-slide');
    const pts = [...this.pointers.values()];
    const a = pts[0], b = pts[1];
    if (!a || !b) return;
    this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), w: this.view.w, mid: this.toView((a.x + b.x) / 2, (a.y + b.y) / 2),
      angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI, theta: this.side === 'wind' ? this.wind.plate : this.theta, view: this.viewAngle, whole: true };
    this.twistOwned = true;
  }

  /** Two pointers: the angle between them turns the whole computer; the spread zooms. */
  private applyTwist(): void {
    const pinch = this.pinch;
    if (!pinch || this.pointers.size < 2) return;
    const pts = [...this.pointers.values()];
    const a = pts[0], b = pts[1];
    if (!a || !b) return;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const w = clamp(pinch.w * (pinch.dist / Math.max(dist, 1)), MIN_VIEW, VIEW);
    const twist = turn(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI - pinch.angle);
    if (pinch.whole) this.setViewRotation(pinch.view + twist);
    else if (this.side === 'wind') this.wind = { ...this.wind, plate: wrap360(pinch.theta - twist) };
    else this.theta = norm(pinch.theta + twist);
    this.zoomAbout(pinch.mid, w);
  }

  /** Slide gs from the pointerdown grab, so the release position is the position. */
  private applySlide(clientX: number, clientY: number): void {
    const a = this.drag?.anchor;
    if (!a) return;
    const s = a.view.w / (a.box.size || 1);
    const p = viewToFace({ x: a.view.x - a.view.w / 2 + (clientX - a.box.left) * s, y: a.view.y - a.view.w / 2 + (clientY - a.box.top) * s }, a.angle);
    this.wind = { ...this.wind, gs: clamp(a.gs + (p.y - a.y) / this.windUnits(), this.slideSpec().minKt, this.slideSpec().maxKt) };
  }

  private bindPointer(): void {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (event) => {
      if (this.twistOwned) return;
      this.invalidateBox();
      try { svg.setPointerCapture(event.pointerId); } catch { /* a pointer the browser no longer tracks */ }
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.stop();
      this.spin = null;
      this.hideHint();
      if (this.pointers.size === 2) {
        this.beginWholeTwist();
        return;
      }
      const p = this.toFace(event.clientX, event.clientY);
      const a = this.angleAt(p);
      const hit = this.hitComputer(p, event.pointerType === 'touch');
      const zoomed = this.view.w < VIEW - 1;
      if (!hit && !zoomed) {
        // Off the printed face (the margin round it): turn the whole computer as one piece.
        this.drag = { kind: 'view', tap: null, last: this.screenAngle(event.clientX, event.clientY), raw: this.cursor, samples: [], x: p.x, y: p.y, moved: false, start: { x: event.clientX, y: event.clientY } };
        this.el.classList.add('dragging', 'dragging-view');
        return;
      }
      // Whatever is under the pointer moves: the disc, the hairline, or the black ring.
      // Zoomed in, a drag moves the camera instead; only the red line keeps its own drag.
      const kind = hit === 'cursor' ? 'cursor' : zoomed ? 'pan' : hit === 'disc' ? 'disc' : 'ring';
      this.drag = { kind, tap: hit === 'disc' || hit === 'base' ? hit : null, last: kind === 'ring' ? this.screenAngle(event.clientX, event.clientY) : a, raw: this.cursor, samples: [{ t: event.timeStamp, a: this.theta }], x: p.x, y: p.y, moved: false, start: { x: event.clientX, y: event.clientY } };
      if (kind === 'pan') { this.drag.x = event.clientX; this.drag.y = event.clientY; this.drag.last = a; }
      this.el.classList.add('dragging', `dragging-${kind}`);
      this.paint();
    });
    svg.addEventListener('pointermove', (event) => {
      if (this.twistOwned) return;
      if (!this.pointers.has(event.pointerId)) {
        if (event.pointerType === 'mouse') {
          const hit = this.hitComputer(this.toFace(event.clientX, event.clientY)) ?? (this.view.w < VIEW - 1 ? '' : 'view');
          if (this.el.dataset.hover !== hit) this.el.dataset.hover = hit;
        }
        return;
      }
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pinch && this.pointers.size === 2) {
        this.applyTwist();
        return;
      }
      const drag = this.drag;
      if (!drag) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) > 4) drag.moved = true;
      if (drag.kind === 'pan') {
        if (!drag.moved) return;
        const box = this.frameBox();
        const k = this.view.w / (box.size || 1);
        const limit = (VIEW - this.view.w) / 2;
        this.view = { ...this.view, x: clamp(this.view.x - (event.clientX - drag.x) * k, -limit, limit), y: clamp(this.view.y - (event.clientY - drag.y) * k, -limit, limit) };
        drag.x = event.clientX; drag.y = event.clientY;
        this.paint();
        return;
      }
      if (drag.kind === 'ring' || drag.kind === 'view') {
        const s = this.screenAngle(event.clientX, event.clientY);
        const d = turn(s - drag.last);
        drag.last = s;
        if (drag.moved && drag.kind === 'view') this.setViewRotation(this.viewAngle + d);
        else if (drag.moved) this.turnRing(d);
        return;
      }
      const a = this.angleAt(this.toFace(event.clientX, event.clientY));
      const d = turn(a - drag.last);
      drag.last = a;
      if (drag.kind === 'disc') {
        if (!drag.moved) return;
        this.theta = norm(this.theta + d);
        drag.samples.push({ t: event.timeStamp, a: this.theta });
        if (drag.samples.length > 6) drag.samples.shift();
      } else {
        drag.raw = norm(drag.raw + d);
        this.cursor = event.altKey ? drag.raw : snapCursor(drag.raw, this.theta, this.grads);
      }
      this.paint();
    });
    svg.addEventListener('pointerleave', () => { if (!this.drag) this.el.dataset.hover = ''; });
    const end = (event: PointerEvent) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      const drag = this.drag;
      if (!drag) return;
      this.drag = null;
      this.el.classList.remove('dragging', 'dragging-disc', 'dragging-cursor', 'dragging-ring', 'dragging-pan', 'dragging-view');
      let spun = false;
      if (drag.kind === 'pan' && !drag.moved && event.type === 'pointerup' && drag.tap) {
        // Zoomed in, a tap still brings the hairline to the graduation under it.
        const a = drag.last;
        this.cursor = event.altKey ? a : snapCursor(a, this.theta, this.grads);
      } else if (drag.kind === 'ring' && !drag.moved && event.type === 'pointerup') {
        // A tap on the black ring brings the hairline to the graduation under it.
        const a = this.angleAt({ x: drag.x, y: drag.y });
        this.cursor = event.altKey ? a : snapCursor(a, this.theta, this.grads);
      } else if (drag.kind === 'disc' && !drag.moved && event.type === 'pointerup') {
        // A click on the disc brings the hairline to the graduation under it.
        const a = this.angleAt({ x: drag.x, y: drag.y });
        this.cursor = event.altKey ? a : snapCursor(a, this.theta, this.grads);
      } else if (drag.kind === 'disc') {
        const s = drag.samples;
        const first = s[0];
        const last = s[s.length - 1];
        const dt = last.t - first.t;
        const recent = event.timeStamp - last.t < 60;
        const omega = dt > 0 && recent ? turn(last.a - first.a) / dt : 0;
        if (Math.abs(omega) > 0.03 && !reducedMotion()) {
          this.spin = { omega: clamp(omega, -0.8, 0.8), last: performance.now() };
          spun = true;
          this.kick();
        }
      }
      if (!spun) { this.checkAlignment(true); this.paint(); }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    holdPage(svg);
    this.bindGestures(svg);
    svg.addEventListener('dblclick', (event) => {
      event.preventDefault();
      if (!this.hitComputer(this.toFace(event.clientX, event.clientY))) this.setViewRotation(0, true);
      this.animateView({ x: 0, y: 0, w: VIEW });
    });
    svg.addEventListener('keydown', (event) => this.onKey(event));
    svg.addEventListener('keyup', (event) => { if (event.key.startsWith('Arrow')) this.checkAlignment(true); });
  }

  private bindWindPointer(): void {
    const svg = this.wsvg;
    const facePoint = (event: PointerEvent | WheelEvent) => this.toFace(event.clientX, event.clientY);
    const hitWind = (p: { x: number; y: number }): 'plate' | 'slide' | null => {
      const r = Math.hypot(p.x, p.y);
      return r <= 1180 ? 'plate' : Math.abs(p.x) <= SLIDE.halfWidth ? 'slide' : null;
    };
    svg.addEventListener('pointerdown', (event) => {
      if (this.twistOwned) return;
      this.invalidateBox();
      try { svg.setPointerCapture(event.pointerId); } catch { /* a pointer the browser no longer tracks */ }
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.stop();
      this.spin = null;
      this.hideHint();
      if (this.pointers.size === 2) {
        this.beginWholeTwist();
        return;
      }
      const p = facePoint(event);
      const kind = hitWind(p);
      if (!kind) return;
      const a = this.angleAt(p);
      const box = this.frameBox();
      const drag: NonNullable<FlightComputer['drag']> = { kind, last: a, raw: 0, samples: [{ t: event.timeStamp, a: this.wind.plate }], x: p.x, y: p.y, moved: false, start: { x: event.clientX, y: event.clientY } };
      if (kind === 'slide') drag.anchor = { gs: this.wind.gs, y: p.y, box: { left: box.left, top: box.top, size: box.size }, view: { ...this.view }, angle: this.viewAngle };
      this.drag = drag;
      this.el.classList.add('dragging', `dragging-${kind}`);
    });
    svg.addEventListener('pointermove', (event) => {
      if (this.twistOwned) return;
      if (!this.pointers.has(event.pointerId)) {
        if (event.pointerType === 'mouse') {
          const hit = hitWind(facePoint(event));
          if (this.el.dataset.hover !== (hit ?? '')) this.el.dataset.hover = hit ?? '';
        }
        return;
      }
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pinch && this.pointers.size === 2) {
        this.applyTwist();
        return;
      }
      const drag = this.drag;
      if (!drag) return;
      if (Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) > 4) drag.moved = true;
      if (drag.kind === 'slide') this.applySlide(event.clientX, event.clientY);
      else if (drag.kind === 'plate') {
        const p = facePoint(event);
        const a = this.angleAt(p);
        const d = turn(a - drag.last);
        drag.last = a;
        if (drag.moved) {
          this.wind = { ...this.wind, plate: wrap360(this.wind.plate - d) };
          drag.samples.push({ t: event.timeStamp, a: -this.wind.plate });
          if (drag.samples.length > 6) drag.samples.shift();
        }
      }
      this.paint();
    });
    svg.addEventListener('pointerleave', () => { if (!this.drag) this.el.dataset.hover = ''; });
    const end = (event: PointerEvent) => {
      if (this.twistOwned) return;
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      const drag = this.drag;
      // The release coordinates are the drag. A move that stopped short of the
      // finger must not leave the slide a few knots back, or the step never ticks.
      if (drag?.kind === 'slide') this.applySlide(event.clientX, event.clientY);
      this.drag = null;
      this.el.classList.remove('dragging', 'dragging-plate', 'dragging-slide');
      if (!drag) return;
      if (drag.kind === 'plate' && !drag.moved) {
        // A tap on the plate is the pencil: mark a dot there.
        const r = Math.hypot(drag.x, drag.y);
        if (r < PLATE_R && this.pencil) {
          this.wind = { ...this.wind, dot: toPlate(drag.x, drag.y, this.wind.plate) };
          this.checkAlignment(true);
          this.paint();
        }
        return;
      }
      if (drag.kind === 'plate') {
        const s = drag.samples;
        const dt = s[s.length - 1].t - s[0].t;
        const recent = event.timeStamp - s[s.length - 1].t < 60;
        const omega = dt > 0 && recent ? turn(s[s.length - 1].a - s[0].a) / dt : 0;
        if (Math.abs(omega) > 0.03 && !reducedMotion()) {
          this.spin = { omega: clamp(omega, -0.8, 0.8), last: performance.now() };
          this.kick();
          return;
        }
      }
      this.checkAlignment(true);
      this.paint();
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    holdPage(svg);
    this.bindGestures(svg);
    svg.addEventListener('dblclick', (event) => { event.preventDefault(); this.setViewRotation(0, true); this.animateView({ x: 0, y: 0, w: VIEW }); });
    svg.addEventListener('keydown', (event) => this.onKey(event));
    svg.addEventListener('keyup', (event) => { if (event.key.startsWith('Arrow')) this.checkAlignment(true); });
  }

  /** Zoom keeping the view-space point `p` under the same screen position. */
  private zoomAbout(p: { x: number; y: number }, w: number): void {
    const k = w / this.view.w;
    let x = p.x + (this.view.x - p.x) * k;
    let y = p.y + (this.view.y - p.y) * k;
    const limit = (VIEW - w) / 2;
    x = clamp(x, -limit, limit);
    y = clamp(y, -limit, limit);
    this.view = { x, y, w };
    this.el.classList.toggle('zoomed', w < VIEW - 1);
    this.paint();
  }

  private animateView(to: { x: number; y: number; w: number }): void {
    if(this.zoomFrame)cancelAnimationFrame(this.zoomFrame);
    const from = { ...this.view };
    const start = performance.now();
    const step = (now: number) => {
      this.zoomFrame=0;
      const t = reducedMotion() ? 1 : Math.min(1, (now - start) / 420);
      const k = easeInOut(t);
      this.view = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, w: from.w + (to.w - from.w) * k };
      this.el.classList.toggle('zoomed', this.view.w < VIEW - 1);
      this.draw();
      if (t < 1) this.zoomFrame=requestAnimationFrame(step);
    };
    this.zoomFrame=requestAnimationFrame(step);
  }
}

/** Printed artwork (the face, the disc, the wind plate, frame and slide) as an
 * SVG image: drawn once, then only turned or slid. Live SVG text is re-laid
 * out on every transform change anywhere in its <svg>, and the face has 200
 * labels: a frame's budget per pointer move. The image embeds the instrument
 * sheet, whose face rules are scoped to `.e6b-art` and `.e6b-wind`. */
function printedImage(inner: string, rootClass = '', box: [number, number, number, number] = [-VIEW / 2, -VIEW / 2, VIEW, VIEW]): string {
  const [x, y, w, h] = box;
  const doc = `<svg xmlns="${SVG_NS}"${rootClass ? ` class="${rootClass}"` : ''} viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}"><style><![CDATA[${E6B_CSS}]]></style>${inner}</svg>`;
  return `<image href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc)}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
}

/** Set an attribute only when it changes. An SVG viewBox or transform write
 * invalidates layout even when the value is the same, and SVG text layout is
 * the most expensive thing on the page. */
function attr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function show(el: HTMLElement | SVGElement, on: boolean): void {
  const value = on ? '' : 'none';
  if (el.style.display !== value) el.style.display = value;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Older iOS Safari can still pan or zoom the page under `touch-action: none`;
 * a non-passive touchmove on the working surface holds the page still. Taps and
 * pointer events are unaffected, and the rest of the page scrolls normally. */
function holdPage(node: Element): void {
  node.addEventListener('touchmove', (event) => { if (event.cancelable) event.preventDefault(); }, { passive: false });
}
