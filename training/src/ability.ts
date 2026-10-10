/** Per-strand ability. Levels are bands. Difficulty and ability are a 1PL (Rasch)
 * pair: authored difficulty is the prior, and it does not move until answers
 * come from a spread of learners. The picker is a wide prior, not a label. */

import { classifyTeachingState, type TeachingState } from './scheduler.ts';
export { teachingServe, scaffoldStep, type TeachingServe } from './scheduler.ts';
import {
  bandOf, levelLogit, STRANDS, type LearnGoal, type LearnLevel, type LearnRules, type Strand,
} from './levels.ts';

export interface StrandState {
  theta: number;
  /** Standard deviation. Wide after the picker, after a long gap, or a surprise. */
  sigma: number;
  updatedAt: number;
  answers: number;
}

export interface ConceptStat {
  exposure: number;
  correct: number;
}

export interface AbilityHistory {
  at: number;
  strand: Strand;
  difficulty: number;
  correct: boolean;
}

export interface Person {
  strands: Record<Strand, StrandState>;
  goal: LearnGoal;
  rules: LearnRules | null;
  /** Picker level. An override replaces this prior and widens uncertainty. */
  levelPrior: LearnLevel;
  history: AbilityHistory[];
  concepts: Record<string, ConceptStat>;
  /** Completed session lengths, so a three-card habit stays a three-card habit. */
  sessionLengths: number[];
  consecutiveFailures: number;
  /** Summary logit when this sitting opened, for the trend arrow. */
  chipAt: number;
  updatedAt: number;
}

export interface ServeCard {
  id: string;
  strands: Strand[];
  difficulty: number;
  conceptId: string;
}

export interface ServePace {
  position: number;
  consecutiveFailures: number;
  lowCommitment: boolean;
}

const SIGMA_PRIOR = 1.35;
const SIGMA_FLOOR = 0.28;
const SIGMA_CAP = 2.4;

function sigmoid(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

function emptyStrand(theta: number, now: number, answers = 0, sigma = SIGMA_PRIOR): StrandState {
  return { theta, sigma, updatedAt: now, answers };
}

export function summaryTheta(person: Person): number {
  const answered = STRANDS.filter((strand) => person.strands[strand].answers > 0);
  const pool = answered.length ? answered : [...STRANDS];
  const values = pool.map((strand) => person.strands[strand].theta).sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}

export function priorPerson(input: {
  level: LearnLevel;
  goal: LearnGoal;
  rules: LearnRules | null;
  now: number;
  emphasis?: Partial<Record<Strand, 'low' | 'typical' | 'high'>>;
}): Person {
  const theta = levelLogit(input.level);
  const strands = {} as Record<Strand, StrandState>;
  for (const strand of STRANDS) {
    const emphasis = input.emphasis?.[strand] ?? 'typical';
    const shift = emphasis === 'high' ? 0.35 : emphasis === 'low' ? -0.35 : 0;
    strands[strand] = emptyStrand(Math.max(-3.5, Math.min(3.5, theta + shift)), input.now);
  }
  return {
    strands,
    goal: input.goal,
    rules: input.rules,
    levelPrior: input.level,
    history: [],
    concepts: {},
    sessionLengths: [],
    consecutiveFailures: 0,
    chipAt: theta,
    updatedAt: input.now,
  };
}

/** A new prior. History and per-concept exposure stay. */
export function overridePrior(person: Person, level: LearnLevel, rules: LearnRules | null, now: number): Person {
  const theta = levelLogit(level);
  const strands = {} as Record<Strand, StrandState>;
  for (const strand of STRANDS) {
    strands[strand] = emptyStrand(theta, now, person.strands[strand].answers);
  }
  return {
    ...person,
    strands,
    rules: level === 'curious' || level === 'defence' ? null : rules,
    levelPrior: level,
    chipAt: theta,
    updatedAt: now,
    consecutiveFailures: 0,
  };
}

export function lowCommitment(person: Person): boolean {
  if (!person.sessionLengths.length) return person.goal === 'weather';
  const mean = person.sessionLengths.reduce((sum, n) => sum + n, 0) / person.sessionLengths.length;
  return mean <= 3.5;
}

export function difficultyTarget(person: Person, strand: Strand, rng: () => number, pace: ServePace): number {
  const state = person.strands[strand];
  const theta = state.theta;
  // A low-commitment learner never sees two failures in a row.
  if (pace.lowCommitment && pace.consecutiveFailures >= 1) return theta - 1.2;
  // Anyone else is pulled down before a fourth miss, and usually before a third.
  if (pace.consecutiveFailures >= 2) return -2.8;
  if (pace.position === 0) return theta - (pace.lowCommitment ? 0.85 : 0.45);
  const share = state.sigma > 0.85 ? 0.32 : 0.15;
  const roll = rng();
  if (roll < share) return theta + 1;
  if (roll < share * 2) return theta - 1;
  return theta;
}

function strandWeight(person: Person, strand: Strand): number {
  const sigma = person.strands[strand].sigma;
  let weight = 1 + sigma;
  const goal = person.goal;
  if (goal === 'weather' && (strand === 'physics' || strand === 'charts')) weight += 0.8;
  if (goal === 'drones' && (strand === 'operations' || strand === 'charts')) weight += 0.8;
  if (goal === 'flying' && (strand === 'charts' || strand === 'numbers' || strand.startsWith('rules'))) weight += 0.5;
  if (goal === 'defence' && strand === 'operations') weight += 1;
  if (goal !== 'flying' && strand.startsWith('rules')) weight *= 0.35;
  if (person.rules && strand.startsWith('rules-') && strand !== `rules-${person.rules}`) weight *= 0.2;
  if (!person.rules && strand.startsWith('rules')) weight *= 0.15;
  return weight;
}

export function chooseStrand(person: Person, cards: readonly ServeCard[], rng: () => number): Strand {
  const present = new Set<Strand>();
  for (const card of cards) for (const strand of card.strands) present.add(strand);
  const pool = STRANDS.filter((strand) => present.has(strand));
  const usable = pool.length ? pool : [...STRANDS];
  let total = 0;
  const weights = usable.map((strand) => {
    const weight = strandWeight(person, strand);
    total += weight;
    return weight;
  });
  let roll = rng() * total;
  for (let i = 0; i < usable.length; i += 1) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return usable[i]!;
  }
  return usable[usable.length - 1]!;
}

export function chooseCard<T extends ServeCard>(person: Person, cards: readonly T[], rng: () => number, pace: ServePace): T | null {
  if (!cards.length) return null;
  const strand = chooseStrand(person, cards, rng);
  const target = difficultyTarget(person, strand, rng, pace);
  const onStrand = cards.filter((card) => card.strands.includes(strand));
  const pool = onStrand.length ? onStrand : cards;
  let best = pool[0]!;
  let bestDist = Math.abs(best.difficulty - target);
  for (const card of pool) {
    const dist = Math.abs(card.difficulty - target);
    if (dist < bestDist) { best = card; bestDist = dist; }
  }
  return best;
}

export function updateStrand(state: StrandState, difficulty: number, correct: boolean, responseMs: number, now: number, scale = 1): StrandState {
  let sigma = state.sigma;
  if (state.updatedAt > 0) {
    const gapDays = (now - state.updatedAt) / 86_400_000;
    if (gapDays > 14) sigma = Math.min(SIGMA_CAP, sigma * (1 + (gapDays - 14) / 21));
  }
  const p = sigmoid(state.theta - difficulty);
  const y = correct ? 1 : 0;
  let weight = 1;
  if (correct && responseMs > 0 && responseMs < 8_000) weight = 1.12;
  else if (correct && responseMs > 45_000) weight = 0.75;
  // Rasch residual, scaled by uncertainty so a mis-set prior moves in a short sitting.
  const surprise = y - p;
  const gain = Math.min(1.55, Math.max(0.15, sigma * 1.2));
  const theta = Math.max(-4, Math.min(4, state.theta + gain * weight * scale * surprise));
  let nextSigma = Math.max(SIGMA_FLOOR, sigma * (1 - 0.1 * weight * scale));
  if (Math.abs(surprise) > 0.62) nextSigma = Math.min(1.55, nextSigma * 1.08);
  return { theta, sigma: nextSigma, updatedAt: now, answers: state.answers + 1 };
}

export function answerCard(person: Person, card: ServeCard, correct: boolean, responseMs: number, now: number): Person {
  const strands = { ...person.strands };
  for (const strand of STRANDS) {
    const direct = card.strands.includes(strand);
    const state = person.strands[strand];
    const uncertain = state.sigma > 0.7 || state.answers < 8;
    // A mis-set prior is shared, so an uncertain strand moves with every answer.
    // A confident strand barely notices a card from another strand.
    const scale = direct ? 1 : uncertain ? 0.8 : 0.08;
    strands[strand] = updateStrand(state, card.difficulty, correct, responseMs, now, scale);
  }
  const concepts = { ...person.concepts };
  const stat = concepts[card.conceptId] ?? { exposure: 0, correct: 0 };
  concepts[card.conceptId] = { exposure: stat.exposure + 1, correct: stat.correct + (correct ? 1 : 0) };
  return {
    ...person,
    strands,
    concepts,
    history: [...person.history, ...card.strands.map((strand) => ({ at: now, strand, difficulty: card.difficulty, correct }))],
    consecutiveFailures: correct ? 0 : person.consecutiveFailures + 1,
    updatedAt: now,
  };
}

export function conceptState(person: Person, conceptId: string): TeachingState {
  const stat = person.concepts[conceptId] ?? { exposure: 0, correct: 0 };
  const recall = stat.exposure ? stat.correct / stat.exposure : 0;
  const confidence = stat.exposure >= 4 ? 0.8 : stat.exposure === 0 ? 0 : 0.45;
  return classifyTeachingState({ exposureCount: stat.exposure, recallOnExamDay: recall, confidence });
}

export interface DiffObservation {
  theta: number;
  correct: boolean;
}

/** Authored difficulty holds until the answers span a real range of ability. */
export function calibratedDifficulty(authored: number, observations: readonly DiffObservation[]): number {
  if (observations.length < 12) return authored;
  const thetas = observations.map((row) => row.theta);
  const spread = Math.max(...thetas) - Math.min(...thetas);
  if (spread < 1.5) return authored;
  let d = authored;
  const tau2 = 0.45 * 0.45;
  for (let step = 0; step < 8; step += 1) {
    let grad = (authored - d) / tau2;
    let hess = -1 / tau2;
    for (const row of observations) {
      const p = sigmoid(row.theta - d);
      const y = row.correct ? 1 : 0;
      grad += p - y;
      hess += -p * (1 - p);
    }
    if (Math.abs(hess) < 1e-6) break;
    d -= grad / hess;
  }
  return Math.max(-4, Math.min(4, d));
}

/** Goal moves with behaviour. Ability does not. */
export function applyBehaviour(person: Person, hint: string): Person {
  const text = hint.toLowerCase();
  let goal = person.goal;
  if (/\b(part\s*107|drone|dji|repl)\b/.test(text)) goal = 'drones';
  else if (/\b(army|navy|defence|defense|grunt)\b/.test(text)) goal = 'defence';
  else if (/\b(atpl|cpl|ppl|private pilot|instrument rating)\b/.test(text)) goal = 'flying';
  return { ...person, goal };
}

export function shownLevel(person: Person): { level: Exclude<LearnLevel, 'defence'> | LearnLevel; labelTheta: number; trend: 'up' | 'down' | 'flat' } {
  const labelTheta = summaryTheta(person);
  const level = person.goal === 'defence' && Math.abs(labelTheta - levelLogit('defence')) < 0.8 && person.levelPrior === 'defence'
    ? 'defence' as const
    : bandOf(labelTheta);
  const delta = labelTheta - person.chipAt;
  const trend = delta > 0.35 ? 'up' as const : delta < -0.35 ? 'down' as const : 'flat' as const;
  return { level, labelTheta, trend };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function responds(trueTheta: number, difficulty: number, rng: () => number): boolean {
  return rng() < sigmoid(trueTheta - difficulty);
}
