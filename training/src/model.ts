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

export interface Card {
  id: string;
  conceptIds: string[];
  subject: Subject;
  kind: 'mcq' | 'later';
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
  };
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
}
