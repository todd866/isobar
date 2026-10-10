import type { Strand } from '../model';

/** A dossier the story can show. Weather and checks stay on the case; scenes never rewrite them. */
export interface StoryCase {
  id: string;
  decreeId: string;
  strand: Strand;
  difficulty: number;
  /** At least one active decree fails. RELEASE is then the wrong stamp. */
  failing: boolean;
  /** A weather decree is among the failures. Set only when failing is set. */
  weatherBad: boolean;
  route: string;
  clock: string;
  fact: string;
}

export type RebelHook = 'border-diversion' | 'manifest-note';
export type RebelChoice = 'help' | 'refuse' | 'report';
export interface RebelRecord { hook: RebelHook; choice: RebelChoice; shift: number }

export type AccidentId = 'authority-gradient' | 'plan-continuation' | 'get-there-itis';
export type ReportKind = 'diversion' | 'hard-landing';

export const WEATHER_DECREES = ['forecast-coverage', 'destination-alternate', 'forecast-groups', 'crosswind', 'icing', 'thunderstorms', 'contaminated-runway'] as const;

export type Beat =
  | { at: number; role: 'captain' | 'first-officer' | 'aftermath' }
  | { at: number; role: 'rebel' | 'callback'; hook: RebelHook };

export interface ShiftScript {
  number: number;
  decreeId: string;
  dossierCount: number;
  quota: number;
  beats: Beat[];
  accidentAfter: AccidentId | null;
  epilogue: boolean;
}

export interface AccidentReport {
  id: AccidentId;
  circular: string;
  lines: readonly string[];
  lesson: string;
  source: string;
}

export type Phase = 'choice' | 'stamp' | 'result' | 'report' | 'summary' | 'accident' | 'advance';

export interface Outcome {
  index: number;
  stamp: 'RELEASE' | 'REFUSE' | 'AMEND';
  correct: boolean;
  onTime: boolean;
  citation: boolean;
  heldBad: boolean;
}

export interface Sitting {
  shift: number;
  index: number;
  phase: Phase;
  seed: number;
  cases: readonly StoryCase[];
  choiceAt: number | null;
  listened: boolean | null;
  noticed: string | null;
  hint: string | null;
  note: string | null;
  rebel: RebelRecord[];
  pendingReport: null | { kind: ReportKind; listened: boolean };
  reportSeen: boolean;
  outcomes: Outcome[];
  strandBefore: Partial<Record<Strand, number>>;
  strandAfter: Partial<Record<Strand, number>>;
}

export interface SceneLine { symbol: string; text: string }
export interface SceneChoice { id: string; label: string }
export interface SceneView {
  phase: Phase;
  role: 'captain' | 'inspector' | 'first-officer' | 'rebel' | 'desk' | 'report' | 'accident' | 'summary';
  symbol: string;
  lines: SceneLine[];
  choices: SceneChoice[];
  dossier: { route: string; clock: string; fact: string; index: number; count: number } | null;
  epilogue: string | null;
}

export interface Meter {
  id: 'dossiers' | 'correct' | 'citations' | 'quota' | 'strands';
  symbol: string;
  value: string;
  datum: string;
  gauge: number;
  tone: 'ok' | 'warn' | 'bad' | 'flat';
  title: string;
}

export const STORY_STORAGE_KEY = 'isobar.od.story.v1';

export interface StoryPayload {
  seed: number;
  shifts: Record<string, StoryCase[]>;
  strands: Record<string, { before?: Partial<Record<Strand, number>>; after?: Partial<Record<Strand, number>> }>;
}
