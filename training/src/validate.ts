import type { Card, Concept, Source } from './model.ts';

/** Words that talk about the data feed instead of the weather. */
const BANNED = /\b(snapshot|run|product|bucket)\b/i;
/** The Australian sources a rule-bearing explanation must name. */
const RULE_SOURCES = ['Part 91 MOS', 'Part 121 MOS', 'Part 101 MOS', 'BoM', 'AIP', 'CASA'];
const US_SOURCES = ['14 CFR', 'FAA', 'AIM', 'ACS', 'PHAK'];
const DEFENCE_SOURCES = ['JP 3-59', 'ATP 2-01.3', 'AFH', 'AFMAN'];
/** Concepts whose cards state a rule rather than a mechanism. */
const RULE_CONCEPTS = /^(fp\.|met\.taf|met\.cavok|met\.sigmet)/;

export function isRuleCard(card: Card): boolean {
  if (card.claim === 'rule') return true;
  if (card.claim === 'mechanism') return false;
  return card.subject === 'plan' || card.subject === 'live' || card.conceptIds.some((id) => RULE_CONCEPTS.test(id));
}

function namesSource(card: Card): boolean {
  const text = card.explanation;
  if (card.level === 'defence') return DEFENCE_SOURCES.some((name) => text.includes(name));
  if (card.rules === 'us') return US_SOURCES.some((name) => text.includes(name));
  if (card.rules === 'both') return US_SOURCES.some((name) => text.includes(name)) || RULE_SOURCES.some((name) => text.includes(name));
  return RULE_SOURCES.some((name) => text.includes(name));
}

/** The question standard: a complete stem, parallel options, a sourced explanation, no feed talk. */
function lintStem(card: Card, errors: string[]): void {
  const stem = card.stem.trim();
  if (!stem.endsWith('?')) errors.push(`${card.id} stem does not end in a question mark`);
  if (stem.split(/\s+/).length < 8) errors.push(`${card.id} stem is shorter than 8 words`);
  if (stem.includes('…')) errors.push(`${card.id} uses an ellipsis`);
  const hit = BANNED.exec(stem);
  if (hit) errors.push(`${card.id} uses the banned word “${hit[1]}”`);
}

export function lintCard(card: Card): string[] {
  if (card.kind === 'numeric') {
    const errors: string[] = [];
    lintStem(card, errors);
    const spec = card.numeric;
    if (!spec) errors.push(`${card.id} numeric card has no answer`);
    else if (!spec.method.trim() || !spec.thumb.trim() || !spec.unit.trim()) errors.push(`${card.id} numeric card is missing the method, cross-check or unit`);
    if (card.figure) {
      const body = card.figure.lines.join('\n');
      for (const needle of card.figure.highlight) {
        if (!body.includes(needle)) errors.push(`${card.id} figure does not contain “${needle}”`);
      }
    }
    return errors;
  }
  if (card.kind !== 'mcq') return [];
  const errors: string[] = [];
  const stem = card.stem.trim();
  if (!stem.endsWith('?')) errors.push(`${card.id} stem does not end in a question mark`);
  if ([stem, ...card.options.map((option) => option.text), card.explanation].some((text) => text.includes('…')))
    errors.push(`${card.id} uses an ellipsis`);
  if (stem.split(/\s+/).length < 8) errors.push(`${card.id} stem is shorter than 8 words`);
  if (card.options.length < 3 || card.options.length > 4) errors.push(`${card.id} needs 3–4 options`);
  const texts = card.options.map((option) => option.text.trim());
  if (texts.some((text) => /\b(all|none) of the above\b/i.test(text))) errors.push(`${card.id} uses all/none of the above`);
  if (texts.some((text) => /[.?]$/.test(text))) errors.push(`${card.id} option ends in punctuation`);
  if (texts.some((text) => !/^[A-Z0-9“‘]/.test(text))) errors.push(`${card.id} option does not start with a capital or number`);
  const lengths = texts.map((text) => text.length);
  if (Math.max(...lengths) > 3 * Math.min(...lengths) + 24) errors.push(`${card.id} option lengths are not parallel`);
  if (new Set(texts.map((text) => text.toLowerCase())).size !== texts.length) errors.push(`${card.id} options repeat`);
  if (!card.explanation.trim()) errors.push(`${card.id} has no explanation`);
  if (isRuleCard(card) && !namesSource(card)) {
    const where = card.rules === 'us' || card.level === 'defence' ? 'source' : 'Australian source';
    errors.push(`${card.id} rule explanation names no ${where}`);
  }
  if ((card.level === 'curious' || card.level === 'drone' || card.level === 'defence') && !card.picture) {
    errors.push(`${card.id} has no picture`);
  }
  for (const text of [stem, ...texts, card.explanation]) {
    const hit = BANNED.exec(text);
    if (hit) errors.push(`${card.id} uses the banned word “${hit[1]}”`);
  }
  if (card.subject === 'live') {
    if (!card.figure) errors.push(`${card.id} live card has no figure`);
    else {
      const body = card.figure.lines.join('\n');
      if (!card.figure.lines.length || !body.trim()) errors.push(`${card.id} figure is empty`);
      if (!card.figure.highlight.length) errors.push(`${card.id} figure highlights nothing`);
      for (const needle of card.figure.highlight) {
        if (!body.includes(needle)) errors.push(`${card.id} figure does not contain “${needle}”`);
      }
    }
  }
  return errors;
}

export function validateCard(card: Card, concepts: Concept[], sources: Source[]): string[] {
  const errors: string[] = [];
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  const sourceIds = new Set(sources.map((source) => source.id));
  if (!card.id) errors.push('missing id');
  if (!card.stem.trim()) errors.push(`${card.id} missing stem`);
  if (!card.explanation.trim()) errors.push(`${card.id} missing explanation`);
  if (!card.conceptIds.length) errors.push(`${card.id} has no concept`);
  for (const id of card.conceptIds) if (!conceptIds.has(id)) errors.push(`${card.id} unknown concept ${id}`);
  if (!card.citations.length) errors.push(`${card.id} has no citation`);
  for (const citation of card.citations) {
    if (!sourceIds.has(citation.sourceId)) errors.push(`${card.id} unknown source ${citation.sourceId}`);
    if (!citation.section.trim()) errors.push(`${card.id} citation has no section`);
  }
  if (card.complexity < 1 || card.complexity > 3) errors.push(`${card.id} bad complexity`);
  if (card.kind === 'later') {
    if (card.options.length || card.correctId) errors.push(`${card.id} later card has an answer`);
    if (card.planStep == null) errors.push(`${card.id} later card is not a plan step`);
    if (!/later/i.test(card.explanation)) errors.push(`${card.id} later card is not labelled later`);
    return errors;
  }
  if (card.kind === 'numeric') {
    if (card.options.length || card.correctId) errors.push(`${card.id} numeric card has choices`);
    const spec = card.numeric;
    if (!spec) errors.push(`${card.id} numeric card has no answer`);
    else {
      if (!Number.isFinite(spec.value)) errors.push(`${card.id} numeric answer is not finite`);
      if (!(spec.tolerance >= 0)) errors.push(`${card.id} numeric tolerance is negative`);
      if (!spec.diagnoses.length) errors.push(`${card.id} numeric card has no diagnosis`);
    }
    return errors;
  }
  if (card.options.length < 2 || card.options.length > 4) errors.push(`${card.id} needs 2–4 options`);
  const ids = new Set(card.options.map((option) => option.id));
  if (ids.size !== card.options.length) errors.push(`${card.id} duplicate option ids`);
  if (!ids.has(card.correctId)) errors.push(`${card.id} correct option is missing`);
  const texts = card.options.map((option) => option.text.trim());
  if (texts.some((text) => !text)) errors.push(`${card.id} blank option`);
  if (new Set(texts).size !== texts.length) errors.push(`${card.id} duplicate options`);
  return errors;
}

export function validateLibrary(cards: Card[], concepts: Concept[], sources: Source[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.id)) errors.push(`duplicate card ${card.id}`);
    seen.add(card.id);
    errors.push(...validateCard(card, concepts, sources), ...lintCard(card));
  }
  const ids = new Set(concepts.map((concept) => concept.id));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function walk(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`cycle at ${id}`);
      return;
    }
    visiting.add(id);
    const concept = concepts.find((item) => item.id === id);
    if (!concept) {
      errors.push(`missing concept ${id}`);
      visiting.delete(id);
      return;
    }
    for (const pid of concept.prerequisiteIds) {
      if (!ids.has(pid)) errors.push(`${id} prerequisite ${pid} is missing`);
      else walk(pid);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const concept of concepts) walk(concept.id);
  for (const concept of concepts) {
    if (!concept.prerequisiteIds.length) continue;
    for (const pid of concept.prerequisiteIds) {
      const taught = cards.some((card) => card.kind === 'mcq' && card.conceptIds.includes(pid));
      if (!taught) errors.push(`prerequisite ${pid} has no card`);
    }
  }
  const steps = cards.filter((card) => card.planStep != null).map((card) => card.planStep);
  if (new Set(steps).size !== steps.length) errors.push('duplicate plan steps');
  const met = cards.filter((card) => card.subject === 'met' && card.kind === 'mcq').length;
  const plan = cards.filter((card) => card.subject === 'plan' && card.kind === 'mcq').length;
  if (met < 40) errors.push(`meteorology deck has ${met} cards`);
  if (plan < 25) errors.push(`flight-planning deck has ${plan} cards`);
  return errors;
}
