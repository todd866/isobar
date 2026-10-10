/** Builds the level bank and the first card, which is anchored to the map. */

import { dispatchSeeds } from './dispatch-cards.ts';
import { curiousSeeds, defenceSeeds, droneSeeds, pilotSeeds, type Seed } from './learn-bank.ts';
import { pictureHtml } from './learn-picture.ts';
import { levelLogit, type LearnGoal, type LearnLevel, type LearnRules } from './levels.ts';
import type { Card, Citation } from './model.ts';
import type { Snapshot } from './snapshot.ts';

export const SEEDS: Seed[] = [...curiousSeeds, ...droneSeeds, ...pilotSeeds, ...defenceSeeds, ...dispatchSeeds];

function placeOptions(id: string, options: string[], correct: number): { options: Card['options']; correctId: string } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const order = options.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i -= 1) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return {
    options: order.map((source, slot) => ({ id: String(slot + 1), text: options[source]! })),
    correctId: String(order.indexOf(correct) + 1),
  };
}

function subjectOf(concept: string): Card['subject'] {
  if (concept.startsWith('fpl.') || concept.startsWith('law.') || concept.startsWith('perf.')) return 'plan';
  return 'met';
}

function complexityOf(level: LearnLevel): Card['complexity'] {
  if (level === 'airline') return 3;
  if (level === 'commercial' || level === 'student') return 2;
  return 1;
}

let serial = 0;

export function cardFromSeed(seed: Seed, index = serial++): Card {
  const rules = seed.rules === 'both' ? 'both' : seed.rules ?? 'x';
  const id = `${seed.level}.${rules}.${seed.concept}.${index}`;
  const difficulty = levelLogit(seed.level) + ((index % 5) - 2) * 0.04;
  return {
    id,
    conceptIds: [seed.concept],
    subject: subjectOf(seed.concept),
    kind: 'mcq',
    planStep: null,
    stem: seed.stem,
    ...placeOptions(id, [...seed.options], 0),
    explanation: seed.explanation,
    citations: [{ sourceId: seed.sourceId, section: seed.section }],
    complexity: complexityOf(seed.level),
    topics: seed.strands,
    level: seed.level,
    rules: seed.rules,
    claim: seed.claim,
    strands: seed.strands,
    difficulty,
    picture: { kind: seed.picture, caption: seed.caption },
  };
}

export const learnCards: Card[] = SEEDS.map((seed, index) => cardFromSeed(seed, index));

export function cardsForLevel(level: LearnLevel, rules: LearnRules | null): Card[] {
  return learnCards.filter((card) => {
    if (card.level !== level) return false;
    if (level === 'curious' || level === 'defence') return true;
    if (!rules || card.rules == null || card.rules === 'both') return true;
    return card.rules === rules;
  });
}

/** Evidence stays attached to its own place and valid time, never the UI clock. */
export interface MapCue {
  place: string;
  timeLocal: string;
  report: { text: string; timeLocal: string } | null;
  wind: { kt: number; timeLocal: string } | null;
}

function localTime(time: string | null | undefined, zone: string): string | null {
  if (!time || !Number.isFinite(Date.parse(time))) return null;
  try {
    return new Intl.DateTimeFormat('en-AU', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: zone, hour12: true,
    }).format(new Date(time));
  } catch { return null; }
}

export function cueFromSnapshot(snapshot: Snapshot | null, placeHint?: string | null): MapCue {
  const hint = placeHint?.trim().toLowerCase();
  // An unmatched selected place must not quietly borrow another airport's weather.
  const airport = hint ? snapshot?.airports.find((item) =>
    item.name.toLowerCase() === hint || item.icao.toLowerCase() === hint) : snapshot?.airports[0];
  const zone = airport?.zone || 'UTC';
  const timeLocal = localTime(snapshot?.now, zone) ?? '';
  const reportTime = localTime(airport?.metar?.time, zone);
  // Only the observation: a TREND or remark must not become current cloud/wind.
  const text = airport?.metar?.raw.split(/\b(?:RMK|TEMPO|BECMG|INTER|NOSIG|FM\d{4,6})\b/)[0]?.trim() ?? '';
  const station = /^(?:(?:METAR|SPECI)\s+)?(?:(?:COR|AUTO)\s+)*([A-Z]{4})\s+/.exec(text)?.[1];
  const sampleTime = localTime(snapshot?.sampleTime, zone);
  const kt = airport?.sample?.windKt;
  return {
    place: airport?.name || placeHint || '', timeLocal,
    report: reportTime && station === airport?.icao && !/\bNIL\b/.test(text) ? { text, timeLocal: reportTime } : null,
    wind: sampleTime && typeof kt === 'number' && Number.isFinite(kt) && kt >= 0
      ? { kt, timeLocal: sampleTime } : null,
  };
}

type AnchorSeed = Seed & { scenario: 'live' | 'example' };
const EXAMPLE_PLACE = 'Example Field (a fictional aerodrome)';
const feet = (n: number) => n.toLocaleString('en-AU');

function ceilingSeed(level: LearnLevel, rules: LearnRules | null, text: string, where: string, scenario: AnchorSeed['scenario']): AnchorSeed | null {
  const tokens = text.replace(/=$/, '').split(/\s+/);
  const groups = tokens.filter((token) => /^(?:FEW|SCT|BKN|OVC|VV)/.test(token));
  const layers = groups.map((token) => /^(FEW|SCT|BKN|OVC)(\d{3})(?:CB|TCU)?$/.exec(token));
  // Obscuration, missing heights and partial groups do not prove a numeric ceiling.
  if (layers.some((layer) => !layer)) return null;
  const clear = tokens.find((token) => /^(?:CAVOK|NSC|NCD|SKC|CLR)$/.test(token));
  if (!groups.length && !clear || groups.length && clear) return null;
  const cloud = groups.join(' ') || clear!;
  const bases = layers.map((layer) => Number(layer![2]) * 100);
  const ceilings = layers.filter((layer) => layer![1] === 'BKN' || layer![1] === 'OVC').map((layer) => Number(layer![2]) * 100);
  const ceiling = ceilings.length ? Math.min(...ceilings) : null;
  if (ceiling === 0) return null; // 000 is below the reporting increment, not an exact zero-foot base.
  const noCeiling = 'No ceiling reported';
  const answer = ceiling == null ? noCeiling : `${feet(ceiling)} ft AGL`;
  // Distractors come from this report's other bases or scaling errors, never a fixed layer.
  const alternatives = [...new Set([
    ...bases.filter((base) => base > 0).map((base) => `${feet(base)} ft AGL`),
    ...(ceiling == null ? [] : [ceiling / 10, ceiling * 10].map((base) => `${feet(base)} ft AGL`)),
    noCeiling, 'Cloud amount is the ceiling height', 'Cloud base is measured above sea level',
    'Every cloud layer defines a ceiling',
  ])].filter((option) => option !== answer);
  const defence = level === 'defence';
  const us = rules === 'us';
  const shared = rules === 'easa' || rules === 'ca';
  const source = defence ? 'JP 3-59, ceiling and visibility; BoM METAR guide, cloud.'
    : shared ? 'METAR sky condition: broken or overcast is the ceiling.'
    : us ? 'FAA-H-8083-28, METAR sky condition.' : 'BoM METAR guide, cloud.';
  return {
    concept: defence ? 'def.ceiling-vis' : 'met.ceiling', level, rules: defence ? null : rules ?? 'aus',
    claim: shared ? 'mechanism' : 'rule', strands: defence ? ['operations', 'charts'] : ['charts'], scenario,
    stem: `The METAR for ${where} reports ${cloud}. What ceiling does it report?`,
    options: [answer, alternatives[0]!, alternatives[1]!, alternatives[2]!],
    explanation: `${ceiling == null ? `${cloud} reports no ceiling; it does not establish that the whole sky is cloud-free.` : `${feet(ceiling)} ft AGL is the lowest reported broken or overcast base.`} FEW and SCT do not define a ceiling. ${source}`,
    sourceId: defence ? 'jp-3-59' : us ? 'faa-wx' : 'bom-aviation', section: 'Cloud and ceiling',
    picture: 'cloud', caption: cloud,
  };
}

function windSeed(level: LearnLevel, rules: LearnRules | null, cue: MapCue): AnchorSeed | null {
  const group = /(?:^|\s)((?:\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT)(?=\s|$|=)/.exec(cue.report?.text ?? '');
  const observed = group && cue.report;
  if (!observed && !cue.wind) return null;
  const mean = group ? Number(group[2]) : Math.round(cue.wind!.kt);
  const gust = group?.[3] ? Number(group[3]) : null;
  if (gust != null && gust <= mean) return null;
  const where = `${cue.place} at ${observed ? cue.report!.timeLocal : cue.wind!.timeLocal}`;
  const datum = observed ? `The METAR for ${where} reports ${group![1]}` : `The model point at ${where} shows ${mean} kt wind`;
  const us = rules === 'us';
  const shared = rules === 'easa' || rules === 'ca';
  const guide = shared ? 'METAR wind group.' : us ? 'FAA-H-8083-28, wind.' : 'BoM METAR guide, wind.';
  const faster = gust != null;
  return {
    concept: 'drone.low-level-wind', level, rules: level === 'curious' ? null : rules ?? 'aus',
    claim: 'mechanism', strands: ['physics', 'charts'], scenario: 'live',
    stem: `${datum}. ${faster ? `What does the ${gust} kt gust mean?` : 'What does that wind-speed reading measure?'}`,
    options: faster ? [
      `A brief increase from ${mean} kt to ${gust} kt`,
      `A steady wind of ${gust} kt throughout`,
      `A cloud base of ${feet(gust! * 100)} ft`,
      `A wind direction of ${gust} degrees`,
    ] : [
      'How fast the air moves over the ground', 'How high the lowest cloud sits',
      'How far you can see through the air', 'How fast the pressure is changing',
    ],
    explanation: faster
      ? `The mean wind is ${mean} kt; G${gust} reports gusts reaching ${gust} kt. ${guide}`
      : `Knots measure wind speed. This reading alone does not say whether gusts or rain will follow. ${shared ? 'METAR wind group.' : us ? 'FAA-H-8083-28, wind.' : 'BoM aviation guide, wind.'}`,
    sourceId: us ? 'faa-wx' : 'bom-aviation', section: 'Wind', picture: 'wind',
    caption: observed ? group![1] : `${mean} kt · model wind`,
  };
}

function defenceWind(cue: MapCue): AnchorSeed | null {
  const wind = /(?:^|\s)(\d{3})(\d{2,3})(?:G\d{2,3})?KT(?=\s|$|=)/.exec(cue.report?.text ?? '');
  if (!wind || Number(wind[2]) === 0 || Number(wind[1]) < 1 || Number(wind[1]) > 360) return null;
  const from = Number(wind[1]);
  const to = (from + 180) % 360;
  return {
    concept: 'def.downwind-hazard', level: 'defence', rules: null, claim: 'rule', strands: ['operations', 'physics'], scenario: 'live',
    stem: `The METAR for ${cue.place} at ${cue.report!.timeLocal} reports ${wind[0].trim()}. Which way would this wind carry smoke?`,
    options: [`Toward ${to}° true, downwind`, `Toward ${from}° true, upwind`, 'Straight up with no horizontal drift', 'In every direction equally'],
    explanation: `Wind direction names where air comes from: ${from}° true. Downwind is the opposite direction, ${to}° true. JP 3-59, downwind hazard areas.`,
    sourceId: 'jp-3-59', section: 'Downwind hazard areas', picture: 'wind', caption: wind[0].trim(),
  };
}

function anchorSeed(level: LearnLevel, rules: LearnRules | null, _goal: LearnGoal, cue: MapCue): AnchorSeed {
  if (level === 'curious' || level === 'drone') {
    const wind = windSeed(level, rules, cue);
    if (wind) return wind;
    return {
      concept: 'met.pressure-gradient', level, rules: level === 'curious' ? null : rules ?? 'aus',
      claim: 'mechanism', strands: ['physics'], scenario: 'example',
      stem: `Near ${EXAMPLE_PLACE}, isobars are closer together than in the surrounding area. What does that spacing indicate?`,
      options: ['A stronger pressure gradient', 'A weaker pressure gradient', 'A cloud base close to the ground', 'A higher temperature at the ground'],
      explanation: 'Closer isobars mean a larger pressure change over the same distance. That produces a stronger pressure-gradient force.',
      sourceId: 'bom-mam', section: 'Pressure gradient', picture: 'isobars', caption: 'Closely spaced isobars',
    };
  }
  if (level === 'defence') {
    // No precipitation window is supplied by Snapshot. A rain band cannot be inferred.
    const wind = defenceWind(cue);
    if (wind) return wind;
  }
  const cloud = cue.report && ceilingSeed(level, rules, cue.report.text, `${cue.place} at ${cue.report.timeLocal}`, 'live');
  if (cloud) return cloud;
  if (level === 'defence') return {
    concept: 'def.trafficability', level, rules: null, claim: 'rule', strands: ['operations', 'physics'], scenario: 'example',
    stem: `At ${EXAMPLE_PLACE}, prolonged rain has saturated an unsealed track. What can that do to wheeled movement?`,
    options: ['Soften the soil so wheels sink further', 'Harden the soil as soon as rain ends', 'Change only the wind above the track', 'Affect sealed roads but not the soil'],
    explanation: 'Saturation can reduce soil strength; drainage and soil type affect recovery. ATP 2-01.3, trafficability.',
    sourceId: 'atp-2-01-3', section: 'Trafficability', picture: 'soil', caption: 'Saturated ground',
  };
  return ceilingSeed(level, rules, 'FEW010 BKN030', EXAMPLE_PLACE, 'example')!;
}

export function anchorCard(input: {
  level: LearnLevel;
  rules: LearnRules | null;
  goal: LearnGoal;
  cue: MapCue;
}): Card {
  const seed = anchorSeed(input.level, input.rules, input.goal, input.cue);
  const card = cardFromSeed(seed, 9000);
  return { ...card, id: 'learn.anchor', scenario: seed.scenario };
}

export function pictureFor(card: Card): string {
  if (!card.picture) return '';
  return pictureHtml(card.picture.kind, card.picture.caption);
}

export type { Citation };
