import { decree } from '../decrees';
import { evaluateDossier } from '../judge';
import type { Dossier } from '../model';
import { accident, captainLine, epilogueLine, FO_OPEN, foHint, rebelCallback, rebelOutcome, rebelPrompt, reportLines } from './lines';
import { inspectorSlots } from './schedule';
import { beatAt, storyShift } from './shifts';
import { WEATHER_DECREES, type Outcome, type Phase, type RebelChoice, type RebelRecord, type ReportKind, type SceneLine, type SceneView, type Sitting, type StoryCase } from './types';

const WEATHER = new Set<string>(WEATHER_DECREES);
const HARD_LANDING = new Set(['crosswind', 'contaminated-runway', 'landing-distance']);

export function reportKind(decreeId: string): ReportKind {
  return HARD_LANDING.has(decreeId) ? 'hard-landing' : 'diversion';
}

export function caseFromDossier(d: Dossier): StoryCase {
  const failed = evaluateDossier(d, d.edition).filter(a => a.result.status === 'fail').map(a => a.decreeId);
  const weather = failed.filter(id => WEATHER.has(id));
  const raw = d.destinationWeather.taf?.raw ?? '';
  return {
    id: d.id,
    decreeId: weather[0] ?? failed[0] ?? d.target.decreeIds[0] ?? '',
    strand: d.target.strand,
    difficulty: d.target.difficulty,
    failing: failed.length > 0,
    weatherBad: weather.length > 0,
    route: `${d.departure.id}–${d.destination.id}`,
    clock: `${d.plan.arrivalUtc.slice(11, 16)}Z`,
    fact: raw ? raw.slice(0, 96) : 'TAF missing',
  };
}

function phaseFor(s: Sitting): Phase {
  const beat = beatAt(s.shift, s.index);
  if (beat?.role === 'aftermath' && s.pendingReport && !s.reportSeen) return 'report';
  if ((beat?.role === 'first-officer' || beat?.role === 'rebel') && s.choiceAt !== s.index) return 'choice';
  return 'stamp';
}

export function openShift(input: {
  shift: number;
  cases: readonly StoryCase[];
  seed: number;
  rebel?: readonly RebelRecord[];
  strandBefore?: Sitting['strandBefore'];
  strandAfter?: Sitting['strandAfter'];
}): Sitting {
  const script = storyShift(input.shift);
  if (!Number.isInteger(input.seed)) throw new RangeError('Invalid seed');
  if (input.cases.length !== script.dossierCount) throw new RangeError('Dossier count does not match the shift');
  for (const item of input.cases) {
    if (item.weatherBad && !item.failing) throw new RangeError('Weather cannot be bad on a passing dossier');
    const rule = decree(item.decreeId);
    if (rule.shiftIntroduced > input.shift) throw new RangeError('Decree is not in force');
  }
  const sitting: Sitting = {
    shift: input.shift,
    index: 0,
    phase: 'stamp',
    seed: input.seed,
    cases: input.cases,
    choiceAt: null,
    listened: null,
    noticed: null,
    hint: null,
    note: null,
    rebel: [...(input.rebel ?? [])],
    pendingReport: null,
    reportSeen: false,
    outcomes: [],
    strandBefore: { ...input.strandBefore },
    strandAfter: { ...input.strandAfter },
  };
  return { ...sitting, phase: phaseFor(sitting) };
}

export type StoryAction =
  | { type: 'listen' }
  | { type: 'dismiss' }
  | { type: 'rebel'; choice: RebelChoice }
  | { type: 'stamp'; stamp: Outcome['stamp'] }
  | { type: 'continue' };

export function act(s: Sitting, action: StoryAction): Sitting {
  const beat = beatAt(s.shift, s.index);
  const current = s.cases[s.index];
  if (!current && s.phase !== 'summary' && s.phase !== 'accident' && s.phase !== 'advance') throw new RangeError('No dossier');
  if (action.type === 'listen' || action.type === 'dismiss') {
    if (s.phase !== 'choice' || beat?.role !== 'first-officer' || !current) throw new RangeError('The first officer is not waiting');
    const noticed = action.type === 'listen' && current.failing;
    return {
      ...s,
      phase: 'stamp',
      choiceAt: s.index,
      hint: action.type === 'listen' ? foHint(current.decreeId, current.failing) : null,
      listened: noticed ? true : action.type === 'dismiss' ? false : s.listened,
      noticed: noticed ? current.decreeId : s.noticed,
    };
  }
  if (action.type === 'rebel') {
    if (s.phase !== 'choice' || beat?.role !== 'rebel' || !current) throw new RangeError('There is no note');
    return {
      ...s,
      phase: 'stamp',
      choiceAt: s.index,
      note: rebelOutcome(beat.hook, action.choice),
      rebel: [...s.rebel, { hook: beat.hook, choice: action.choice, shift: s.shift }],
    };
  }
  if (action.type === 'stamp') {
    if (s.phase !== 'stamp' || !current) throw new RangeError('No stamp is waiting');
    const released = action.stamp === 'RELEASE';
    const correct = action.stamp === 'AMEND' ? current.failing : released ? !current.failing : current.failing;
    const bad = current.failing && current.weatherBad;
    const heldBad = beat?.role === 'captain' && !released && bad;
    const outcome: Outcome = {
      index: s.index, stamp: action.stamp, correct, onTime: correct && released, citation: !correct, heldBad,
    };
    const pending = beat?.role === 'captain' && released && bad
      ? { kind: reportKind(current.decreeId), listened: s.listened === true }
      : s.pendingReport;
    return { ...s, phase: 'result', outcomes: [...s.outcomes, outcome], pendingReport: pending };
  }
  if (s.phase === 'report') return { ...s, reportSeen: true, phase: phaseFor({ ...s, reportSeen: true }) };
  if (s.phase === 'result') return advance(s);
  if (s.phase === 'summary') {
    return storyShift(s.shift).accidentAfter ? { ...s, phase: 'accident' } : { ...s, phase: 'advance' };
  }
  if (s.phase === 'accident') return { ...s, phase: 'advance' };
  throw new RangeError('Nothing to continue');
}

function advance(s: Sitting): Sitting {
  if (s.index + 1 < s.cases.length) {
    const next: Sitting = { ...s, index: s.index + 1, hint: null, note: null };
    return { ...next, phase: phaseFor(next) };
  }
  return { ...s, phase: 'summary', hint: null, note: null };
}

const STAMPS: SceneView['choices'] = [
  { id: 'RELEASE', label: 'RELEASE' },
  { id: 'REFUSE', label: 'REFUSE' },
  { id: 'AMEND', label: 'AMEND' },
];

const say = (symbol: string, text: string): SceneLine => ({ symbol, text });

export function sceneView(s: Sitting): SceneView {
  const script = storyShift(s.shift);
  const beat = beatAt(s.shift, s.index);
  const current = s.cases[s.index];
  const dossier = current && s.phase !== 'summary' && s.phase !== 'accident' && s.phase !== 'report'
    ? { route: current.route, clock: current.clock, fact: current.fact, index: s.index, count: s.cases.length }
    : null;
  const epilogue = s.phase === 'summary' && script.epilogue ? epilogueLine(s.rebel) : null;
  const base = { phase: s.phase, dossier, epilogue };

  if (s.phase === 'choice' && beat?.role === 'first-officer') {
    return { ...base, role: 'first-officer', symbol: 'O', lines: [say('O', FO_OPEN)], choices: [{ id: 'listen', label: 'Listen' }, { id: 'dismiss', label: 'Leave it' }] };
  }
  if (s.phase === 'choice' && beat?.role === 'rebel') {
    return { ...base, role: 'rebel', symbol: 'N', lines: [say('N', rebelPrompt(beat.hook))], choices: [{ id: 'help', label: 'Help' }, { id: 'refuse', label: 'Refuse' }, { id: 'report', label: 'Report' }] };
  }
  if (s.phase === 'stamp' || s.phase === 'choice') {
    const lines: SceneLine[] = [];
    let role: SceneView['role'] = 'desk';
    let symbol = '·';
    if (beat?.role === 'captain') {
      role = 'captain'; symbol = 'C';
      lines.push(say('C', captainLine(s.shift)));
      if (s.listened && s.noticed) lines.push(say('O', foHint(s.noticed, true)));
    } else if (beat?.role === 'first-officer') {
      role = 'first-officer'; symbol = 'O';
      if (s.hint) lines.push(say('O', s.hint));
    } else if (beat?.role === 'rebel') {
      role = 'rebel'; symbol = 'N';
      if (s.note) lines.push(say('N', s.note));
    } else if (beat?.role === 'callback') {
      const prior = [...s.rebel].reverse().find(r => r.hook === beat.hook);
      const line = prior ? rebelCallback(beat.hook, prior.choice) : null;
      if (line) lines.push(say('·', line));
    }
    return { ...base, role, symbol, lines, choices: STAMPS };
  }
  if (s.phase === 'result') {
    const last = s.outcomes[s.outcomes.length - 1];
    const audited = inspectorSlots(s.shift, s.cases.length, s.seed).includes(s.index);
    const symbol = audited ? 'I' : '·';
    const lines = [say(symbol, audited ? inspectorCite(current?.decreeId ?? '', last?.citation === true) : last?.correct ? 'Filed.' : 'Citation.')];
    const lastDossier = s.index + 1 === s.cases.length;
    return { ...base, role: audited ? 'inspector' : 'desk', symbol, lines, choices: [{ id: 'continue', label: lastDossier ? 'Close shift' : 'Next dossier' }] };
  }
  if (s.phase === 'report' && s.pendingReport) {
    const [head, foot] = reportLines(s.pendingReport.kind, s.pendingReport.listened);
    return { ...base, role: 'report', symbol: '§', lines: [say('§', head!), say(s.pendingReport.listened ? 'O' : '§', foot!)], choices: [{ id: 'continue', label: 'File' }] };
  }
  if (s.phase === 'accident' && script.accidentAfter) {
    const paper = accident(script.accidentAfter);
    const lines = [...paper.lines, paper.lesson, paper.source].map(text => say('§', text));
    return { ...base, role: 'accident', symbol: '§', lines, choices: [{ id: 'continue', label: 'Next shift' }], epilogue: null };
  }
  const summaryLabel = script.accidentAfter ? 'Continue' : s.shift >= 12 ? 'Close shift' : 'Next shift';
  return { ...base, role: 'summary', symbol: '·', lines: [], choices: [{ id: 'continue', label: summaryLabel }] };
}

function inspectorCite(decreeId: string, cited: boolean): string {
  if (!cited) return 'Stamp in order.';
  const rule = decree(decreeId);
  return `Citation. §${rule.shiftIntroduced} ${rule.title}.`;
}
