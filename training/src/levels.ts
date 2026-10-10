/** Learn levels, strands and the chip. The picker is a prior; bands sit on one scale. */

export const LEARN_LEVELS = ['curious', 'drone', 'student', 'commercial', 'airline', 'defence'] as const;
export type LearnLevel = (typeof LEARN_LEVELS)[number];

export const LEARN_GOALS = ['weather', 'drones', 'flying', 'defence'] as const;
export type LearnGoal = (typeof LEARN_GOALS)[number];

export const STRANDS = ['physics', 'charts', 'rules-aus', 'rules-us', 'rules-easa', 'rules-ca', 'operations', 'numbers'] as const;
export type Strand = (typeof STRANDS)[number];

export const LEARN_RULES = ['aus', 'us', 'easa', 'ca'] as const;
export type LearnRules = (typeof LEARN_RULES)[number];

const RULE_CHIP: Record<LearnRules, string> = { aus: 'AUS', us: 'US', easa: 'EASA', ca: 'CAN' };

/** Logit of the band centre. Defence is not a band; its cards carry their own difficulty. */
export const BAND_LOGIT: Record<Exclude<LearnLevel, 'defence'>, number> = {
  curious: -2,
  drone: -1,
  student: 0,
  commercial: 1,
  airline: 2,
};

export const LEVEL_LABEL: Record<LearnLevel, string> = {
  curious: 'Curious',
  drone: 'Drone',
  student: 'Student pilot',
  commercial: 'Commercial',
  airline: 'Airline',
  defence: 'Defence',
};

export function isLearnLevel(value: string): value is LearnLevel {
  return (LEARN_LEVELS as readonly string[]).includes(value);
}

export function isLearnGoal(value: string): value is LearnGoal {
  return (LEARN_GOALS as readonly string[]).includes(value);
}

export function isStrand(value: string): value is Strand {
  return (STRANDS as readonly string[]).includes(value);
}

export function isLearnRules(value: string): value is LearnRules {
  return (LEARN_RULES as readonly string[]).includes(value);
}

export function rulesStrand(rules: LearnRules): Strand {
  if (rules === 'aus') return 'rules-aus';
  if (rules === 'us') return 'rules-us';
  if (rules === 'easa') return 'rules-easa';
  return 'rules-ca';
}

export function levelLogit(level: LearnLevel): number {
  if (level === 'defence') return -0.5;
  return BAND_LOGIT[level];
}

/** Curious never shows a rules control. Defence hides it unless a card cites a national rule. */
export function showsRules(level: LearnLevel, cardCitesNationalRules = false): boolean {
  if (level === 'curious') return false;
  if (level === 'defence') return cardCitesNationalRules;
  return true;
}

export function chipLabel(level: LearnLevel, rules: LearnRules | null, trend: 'up' | 'down' | 'flat' = 'flat'): string {
  const rulesBit = showsRules(level) && rules ? ` · ${RULE_CHIP[rules]}` : '';
  const arrow = trend === 'up' ? ' ↑' : trend === 'down' ? ' ↓' : '';
  return `${LEVEL_LABEL[level]}${rulesBit}${arrow}`;
}

export function bandOf(theta: number): Exclude<LearnLevel, 'defence'> {
  if (theta < -1.5) return 'curious';
  if (theta < -0.5) return 'drone';
  if (theta < 0.5) return 'student';
  if (theta < 1.5) return 'commercial';
  return 'airline';
}

export function levelChoices(): { value: string; label: string }[] {
  const rows: [string, string][] = [['curious|x', 'Curious']];
  for (const level of ['drone', 'student', 'commercial', 'airline'] as const) {
    for (const rules of LEARN_RULES) rows.push([`${level}|${rules}`, `${LEVEL_LABEL[level]} · ${RULE_CHIP[rules]}`]);
  }
  rows.push(['defence|x', 'Defence']);
  return rows.map(([value, label]) => ({ value, label }));
}

export function trendOf(from: number, to: number): 'up' | 'down' | 'flat' {
  if (to - from > 0.35) return 'up';
  if (from - to > 0.35) return 'down';
  return 'flat';
}
