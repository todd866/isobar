import type { FigureDiagram, FigureTable, WorkStep } from './figure.ts';
import type { LearnLevel, LearnRules, Strand } from './levels.ts';

/** Concept, question and source records.
 * Shape ported from Cohort prisma/schema/{concepts,content,citations}.prisma.
 * Fields this deck does not use (embeddings, exam vectors, Anki custody) are omitted.
 */

export interface Source {
  id: string;
  slug: string;
  name: string;
  shortName: string;
  sourceType: 'textbook' | 'guidelines';
  reliability: number;
  jurisdiction: 'au' | 'international';
  publisher: string;
}

export interface Citation {
  sourceId: string;
  section: string;
}

export interface Concept {
  id: string;
  name: string;
  description: string;
  subject: 'met' | 'plan';
  topics: string[];
  prerequisiteIds: string[];
  examWeight: number;
}

export type Subject = 'met' | 'plan' | 'live';

export interface NumericDiagnosis {
  id: string;
  /** Sub-skill the miss implies. */
  skill: string;
  /** Short label on the card. */
  note: string;
  /** Sentence for the tooltip. */
  detail: string;
  value: number;
}

export interface NumericAnswer {
  value: number;
  tolerance: number;
  unit: string;
  decimals: number;
  method: string;
  thumb: string;
  diagnoses: NumericDiagnosis[];
  /** Generated inputs retained so a support instrument can mirror this card. */
  given?: Record<string, number>;
  /** Worksheet for the supported follow-up; the last step is the answer. */
  steps?: WorkStep[];
}

/** Where a generated drill card came from, so a follow-up can be rebuilt. */
export interface DrillRef {
  skill: string;
  rung: 1 | 2 | 3 | 4;
  seed: number;
  /** 0 none; 1 the used cells marked; 2 marked cells, number line and the worksheet. */
  support: 0 | 1 | 2;
  /** Set on adaptive follow-ups: the card whose miss started the loop. */
  origin?: string;
  stage?: 'retest' | 'transfer';
  /** The named slip, shown in one line on a retest. */
  slip?: string;
}

export interface Card {
  id: string;
  conceptIds: string[];
  subject: Subject;
  kind: 'mcq' | 'later' | 'numeric';
  /** Worked-plan order. Null for ordinary review cards. */
  planStep: number | null;
  stem: string;
  options: { id: string; text: string }[];
  correctId: string;
  explanation: string;
  citations: Citation[];
  complexity: 1 | 2 | 3;
  topics: string[];
  /** The exhibit the question is about, rendered beside the stem so the card is
   * answerable without scrolling. `lines` carry the raw product text (TAF
   * groups, a METAR, a SIGMET, chart readings); `highlight` names the
   * substrings the answer depends on. Every live card has one. */
  figure?: {
    title: string;
    lines: string[];
    highlight: string[];
    /** A handbook table; drawn instead of `lines` when present. */
    table?: FigureTable;
    diagram?: FigureDiagram;
  };
  /** A support instrument the card can open beside the question. */
  tool?: 'e6b';
  /** Typed answer. Present when `kind` is `numeric`. */
  numeric?: NumericAnswer;
  /** Present on generated part-task drills. */
  drill?: DrillRef;
  /** Live-data feature this card is about. TAF marks and the cause row are shown after the answer. */
  focus?: {
    icao?: string;
    /** Mark the first TAF line. */
    opening?: boolean;
    /** Mark the TAF line that contains this text. */
    needle?: string;
    /** In-force TAF lines to mark after the answer is revealed. */
    marks?: { icao: string; needle: string }[];
    /** One instrument row for the revealed cause. */
    cause?: { label: string; value: string; datum: string; title: string };
    mapX?: number;
    mapY?: number;
    artefact?: boolean;
    place?: string;
    knots?: number;
  };
  /** Learn level this wording was written for. Absent on the ATPL bank. */
  level?: LearnLevel;
  /** Rule set. Null when the card has no national rules. */
  rules?: LearnRules | 'both' | null;
  /** A rule claim must name its source. A mechanism card must not pretend to. */
  claim?: 'rule' | 'mechanism';
  strands?: Strand[];
  /** Rasch difficulty. Authored from the level band. */
  difficulty?: number;
  /** Example scenarios never inherit live place/time or weather context. */
  scenario?: 'live' | 'example';
  /** Picture or short animation shown before the question. */
  picture?: { kind: string; caption: string };
}
