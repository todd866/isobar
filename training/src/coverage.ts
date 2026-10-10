/** Syllabus lists mapped onto docs/training/concepts.json. */

import { readFileSync } from 'node:fs';
import { curiousSeeds, defenceSeeds, droneSeeds, pilotSeeds, type Seed } from './learn-bank.ts';
import { dispatchSeeds } from './dispatch-cards.ts';

const LISTS = [
  { file: 'casa-atpl.json', id: 'casa-atpl', field: 'au_refs', prefix: 'casa:' },
  { file: 'faa-atp.json', id: 'faa-atp', field: 'us_refs', prefix: 'faa:' },
  { file: 'easa-atpl.json', id: 'easa-atpl', field: 'easa_refs', prefix: 'easa:' },
  { file: 'tc-atpl.json', id: 'tc-atpl', field: 'ca_refs', prefix: 'ca:' },
] as const;

const LEVELS = ['curious', 'drone', 'student', 'commercial', 'airline', 'defence'] as const;
const KINDS = new Set(['objective', 'reserved', 'competency']);

interface Objective {
  id: string;
  text: string;
  kind: string;
  concept_ids: string[];
  gap?: boolean;
}

interface Subject {
  code: string;
  title: string;
  source_url?: string;
  objectives: Objective[];
}

interface Syllabus {
  schema?: string;
  id?: string;
  authority?: string;
  title?: string;
  version?: string;
  version_date?: string;
  retrieved?: string;
  licence?: string;
  licence_note?: string;
  source_url?: string;
  subjects?: Subject[];
}

interface Concept {
  id: string;
  title?: string;
  au_refs?: string[];
  us_refs?: string[];
  easa_refs?: string[];
  ca_refs?: string[];
  prerequisites?: string[];
  au_us?: string;
  easa_note?: string;
  ca_note?: string;
}

export interface CoverageFile {
  schema: 'isobar.training.coverage/v1';
  written: '2026-10-09';
  syllabi: {
    id: string;
    subjects: {
      code: string;
      title: string;
      objectives: number;
      mapped: number;
      concepts: number;
      withCards: number;
      curious: number;
      drone: number;
      student: number;
      commercial: number;
      airline: number;
      defence: number;
      gap: number;
    }[];
  }[];
  rules: { concept: string; au_us: string; easa: string; ca: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function load(root: URL, name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, root), 'utf8')) as unknown;
}

function cardsByConcept(): Map<string, Set<string>> {
  const seeds: Seed[] = [...curiousSeeds, ...droneSeeds, ...pilotSeeds, ...defenceSeeds, ...dispatchSeeds];
  const out = new Map<string, Set<string>>();
  for (const seed of seeds) {
    const levels = out.get(seed.concept) ?? new Set<string>();
    levels.add(seed.level);
    out.set(seed.concept, levels);
  }
  return out;
}

function cell(value: string): string {
  return value.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

function refsOf(concept: Concept, field: (typeof LISTS)[number]['field']): string[] {
  const value = concept[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function validateSyllabi(root: URL): string[] {
  const errors: string[] = [];
  const graph = load(root, 'concepts.json');
  if (!isRecord(graph) || !Array.isArray(graph.concepts)) return ['concepts.json has no concepts'];
  const concepts = new Map<string, Concept>();
  for (const item of graph.concepts) {
    if (!isRecord(item) || typeof item.id !== 'string') {
      errors.push('concept is missing an id');
      continue;
    }
    if (concepts.has(item.id)) errors.push(`duplicate concept ${item.id}`);
    concepts.set(item.id, item as unknown as Concept);
  }
  for (const concept of concepts.values()) {
    for (const field of ['au_refs', 'us_refs', 'easa_refs', 'ca_refs'] as const) {
      if (!Array.isArray(concept[field])) errors.push(`${concept.id} ${field} is not a list`);
    }
    for (const prereq of concept.prerequisites ?? []) {
      if (!concepts.has(prereq)) errors.push(`${concept.id} prerequisite ${prereq} is missing`);
    }
  }

  const objectives = new Map<string, { list: string; concepts: string[] }>();
  for (const list of LISTS) {
    let syllabus: Syllabus;
    try { syllabus = load(root, `syllabi/${list.file}`) as Syllabus; }
    catch { errors.push(`missing syllabi/${list.file}`); continue; }
    if (syllabus.schema !== 'isobar.training.syllabus/v1') errors.push(`${list.id} schema`);
    if (syllabus.id !== list.id) errors.push(`${list.id} id`);
    for (const key of ['authority', 'title', 'version', 'version_date', 'retrieved', 'licence', 'licence_note', 'source_url'] as const) {
      if (typeof syllabus[key] !== 'string' || !syllabus[key]) errors.push(`${list.id} ${key}`);
    }
    if (!Array.isArray(syllabus.subjects) || !syllabus.subjects.length) errors.push(`${list.id} subjects`);
    for (const subject of syllabus.subjects ?? []) {
      if (!subject || typeof subject.code !== 'string' || typeof subject.title !== 'string' || !Array.isArray(subject.objectives)) {
        errors.push(`${list.id} subject`);
        continue;
      }
      for (const row of subject.objectives) {
        if (!row || typeof row.id !== 'string' || typeof row.text !== 'string' || !row.text.trim()) {
          errors.push(`${list.id} empty objective`);
          continue;
        }
        if (!KINDS.has(row.kind)) errors.push(`${row.id} kind`);
        if (!Array.isArray(row.concept_ids) || row.concept_ids.some((id) => typeof id !== 'string')) {
          errors.push(`${row.id} concept_ids`);
          continue;
        }
        const gapped = row.concept_ids.length === 0;
        if (gapped !== (row.gap === true)) errors.push(`${row.id} gap`);
        if (objectives.has(row.id)) errors.push(`duplicate objective ${row.id}`);
        objectives.set(row.id, { list: list.id, concepts: row.concept_ids });
        for (const conceptId of row.concept_ids) {
          const concept = concepts.get(conceptId);
          if (!concept) {
            errors.push(`${row.id} missing concept ${conceptId}`);
            continue;
          }
          if (!refsOf(concept, list.field).includes(row.id)) errors.push(`${row.id} missing from ${conceptId} ${list.field}`);
        }
      }
    }
  }

  for (const concept of concepts.values()) {
    for (const list of LISTS) {
      for (const ref of refsOf(concept, list.field)) {
        if (!ref.startsWith(list.prefix)) continue;
        const hit = objectives.get(ref);
        if (!hit || hit.list !== list.id) errors.push(`${concept.id} ${list.field} ${ref} is not an objective`);
      }
    }
  }
  return errors;
}

export function coverageDocuments(root: URL): { markdown: string; json: CoverageFile } {
  const graph = load(root, 'concepts.json') as { concepts: Concept[] };
  const byId = new Map(graph.concepts.map((concept) => [concept.id, concept]));
  const cards = cardsByConcept();
  const syllabi: CoverageFile['syllabi'] = [];
  const lines: string[] = ['Coverage below counts curator-assigned objective links; it does not establish teaching completeness or national regulatory validation.', ''];
  for (const list of LISTS) {
    const syllabus = load(root, `syllabi/${list.file}`) as Syllabus;
    const subjects = [];
    lines.push(`**${list.id}**`, '', '| Subject | Objectives | Mapped | Concepts | With cards | Curious | Drone | Student | Commercial | Airline | Defence | Gap |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const subject of syllabus.subjects ?? []) {
      const ids = new Set<string>();
      let mapped = 0;
      let gap = 0;
      for (const row of subject.objectives) {
        if (row.concept_ids.length) mapped += 1;
        else gap += 1;
        for (const id of row.concept_ids) ids.add(id);
      }
      const levels = Object.fromEntries(LEVELS.map((level) => [level, 0])) as Record<(typeof LEVELS)[number], number>;
      let withCards = 0;
      for (const id of ids) {
        const held = cards.get(id);
        if (!held?.size) continue;
        withCards += 1;
        for (const level of LEVELS) if (held.has(level)) levels[level] += 1;
      }
      const row = {
        code: subject.code,
        title: subject.title,
        objectives: subject.objectives.length,
        mapped,
        concepts: ids.size,
        withCards,
        ...levels,
        gap,
      };
      subjects.push(row);
      const subjectLabel = row.code === row.title ? row.title : `${row.code} ${row.title}`;
      lines.push(`| ${cell(subjectLabel)} | ${row.objectives} | ${row.mapped} | ${row.concepts} | ${row.withCards} | ${row.curious} | ${row.drone} | ${row.student} | ${row.commercial} | ${row.airline} | ${row.defence} | ${row.gap} |`);
    }
    syllabi.push({ id: list.id, subjects });
    lines.push('');
  }

  const rules = graph.concepts
    .filter((concept) => concept.easa_note || concept.ca_note)
    .map((concept) => ({
      concept: concept.id,
      au_us: concept.au_us ?? '',
      easa: concept.easa_note ?? '',
      ca: concept.ca_note ?? '',
    }))
    .sort((a, b) => a.concept.localeCompare(b.concept));
  lines.push('**rules**', '', '| Concept | AU/US | EASA | CAN |', '| --- | --- | --- | --- |');
  for (const rule of rules) {
    const concept = byId.get(rule.concept);
    lines.push(`| ${cell(concept?.title ? `${rule.concept} ${concept.title}` : rule.concept)} | ${cell(rule.au_us)} | ${cell(rule.easa)} | ${cell(rule.ca)} |`);
  }
  lines.push('');
  return {
    markdown: lines.join('\n'),
    json: { schema: 'isobar.training.coverage/v1', written: '2026-10-09', syllabi, rules },
  };
}
