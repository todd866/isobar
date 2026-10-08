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
  prerequisites?: string[];
  mode?: string;
  layer?: string;
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
