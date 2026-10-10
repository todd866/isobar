/** Australian track of docs/training/concepts.json.
 * Concept ids stay so a US track can be added later. ACS references are not served.
 */

export interface AuConcept {
  id: string;
  title: string;
  auRefs: string[];
  prerequisites: string[];
  mode: string;
  layer: string;
}

export interface SyllabusConcept {
  id: string;
  title: string;
  au_refs?: string[];
  us_refs?: string[];
  easa_refs?: string[];
  ca_refs?: string[];
  prerequisites?: string[];
  mode?: string;
  layer?: string;
  /** Levels that see this concept. Met concepts sort first inside a level. */
  levels?: string[];
}

const FAMILY = ['met.', 'drone.', 'nav.', 'fpl.', 'perf.', 'aero.', 'sys.', 'hum.', 'law.', 'def.'];

function familyRank(id: string): number {
  const index = FAMILY.findIndex((prefix) => id.startsWith(prefix));
  return index === -1 ? FAMILY.length : index;
}

/** Concepts present at a level, meteorology first, then the rest in graph order. */
export function conceptsForLevel(concepts: SyllabusConcept[], level: string): SyllabusConcept[] {
  return concepts
    .map((concept, index) => ({ concept, index }))
    .filter(({ concept }) => (concept.levels ?? []).includes(level))
    .sort((a, b) => familyRank(a.concept.id) - familyRank(b.concept.id) || a.index - b.index)
    .map(({ concept }) => concept);
}

export function australianConcepts(concepts: SyllabusConcept[]): AuConcept[] {
  return concepts.map((concept) => ({
    id: concept.id,
    title: concept.title,
    auRefs: concept.au_refs ?? [],
    prerequisites: concept.prerequisites ?? [],
    mode: concept.mode ?? '',
    layer: concept.layer ?? 'none',
  }));
}
