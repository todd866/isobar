import type { AccidentId, AccidentReport, RebelChoice, RebelHook } from './types';

/** Captain pressure, one line a shift. The stamp is the answer. */
export const CAPTAIN_LINES = [
  'Sign it before the minute turns.',
  'The alternate is a habit. Sign.',
  'We will be airborne before the TEMPO matters. Sign.',
  'I have landed in more wind than this. Sign.',
  'The ice is a forecast. Sign.',
  'We will be through it before it matters. Sign.',
  'The fuel is enough. I have done the sum. Sign.',
  'The roster is a clerk’s problem. Sign.',
  'The runway is long enough. Sign.',
  'We will be light when it matters. Sign.',
  'The snow is within limits. Sign.',
  'The density number is a desk invention. Sign.',
] as const;

export const FO_OPEN = 'Something on this sheet is wrong. I think.';
export const FO_CLEAR = 'Nothing on the sheet. I was wrong.';

export const FO_HINT: Record<string, string> = {
  'forecast-coverage': 'The TAF ends before the ETA.',
  'destination-alternate': 'No alternate is named. The ceiling is low.',
  'forecast-groups': 'A TEMPO covers the arrival.',
  crosswind: 'The gust is past the sheet.',
  icing: 'Anti-ice is deferred. The cruise is cold.',
  thunderstorms: 'Thunderstorms sit on the ETA.',
  fuel: 'The fuel line stops short of the reserve.',
  duty: 'The duty exceeds the roster.',
  'takeoff-distance': 'The take-off roll is longer than the runway.',
  'landing-distance': 'The landing mass does not fit.',
  'contaminated-runway': 'The runway report is uninspected.',
  'density-altitude': 'The worksheet does not match the QNH.',
};

const PROMPT: Record<RebelHook, string> = {
  'manifest-note': 'One name is in another hand. The count is one short.',
  'border-diversion': 'If the weather takes us to Orel, someone is at the north fence.',
};

const OUTCOME: Record<RebelHook, Record<RebelChoice, string>> = {
  'manifest-note': {
    help: 'You leave the count as written.',
    refuse: 'You send the list back.',
    report: 'The list goes in the Ministry tray.',
  },
  'border-diversion': {
    help: 'You write Orel in the remarks.',
    refuse: 'You hand the note back.',
    report: 'The inspector takes the note.',
  },
};

const CALLBACK: Record<RebelHook, Record<RebelChoice, string>> = {
  'manifest-note': {
    help: 'The corridor is empty. A seat stays warm.',
    refuse: 'The manifest is rewritten. The count matches.',
    report: 'A clerk asks whether the handwriting was yours.',
  },
  'border-diversion': {
    help: 'Orel is in the margin. You did not put it there.',
    refuse: 'No one says Orel.',
    report: 'Tuesday’s captain is off the roster.',
  },
};

const BOTH: Record<string, string> = {
  'help/help': 'Two names are missing on the arrival list. The tally balances.',
  'help/refuse': 'One note came back. One did not.',
  'help/report': 'One note is in the Ministry tray. One name is still aboard.',
  'refuse/help': 'One note came back. One did not.',
  'refuse/refuse': 'Both notes are back in their pockets. The queue is flights.',
  'refuse/report': 'The Ministry has one note. The other was handed back.',
  'report/help': 'One note is in the Ministry tray. One name is still aboard.',
  'report/refuse': 'The Ministry has one note. The other was handed back.',
  'report/report': 'Both notes are filed under your stamp.',
};

const ONLY: Record<RebelHook, Record<RebelChoice, string>> = {
  'manifest-note': {
    help: 'The extra name does not appear again.',
    refuse: 'The list matches. No one mentions the hand.',
    report: 'The manifest is in the Ministry file.',
  },
  'border-diversion': {
    help: 'Orel stays in the margin of a later plan.',
    refuse: 'The note is gone. The queue is flights.',
    report: 'The border note is in the Ministry file.',
  },
};

export function captainLine(shift: number): string {
  const line = CAPTAIN_LINES[shift - 1];
  if (!line) throw new RangeError('Unknown shift');
  return line;
}

export function foHint(decreeId: string, failing: boolean): string {
  if (!failing) return FO_CLEAR;
  return FO_HINT[decreeId] ?? 'The bulletin and the plan disagree.';
}

export function rebelPrompt(hook: RebelHook): string { return PROMPT[hook]; }
export function rebelOutcome(hook: RebelHook, choice: RebelChoice): string { return OUTCOME[hook][choice]; }
export function rebelCallback(hook: RebelHook, choice: RebelChoice): string { return CALLBACK[hook][choice]; }

export function epilogueLine(records: readonly { hook: RebelHook; choice: RebelChoice }[]): string | null {
  const manifest = records.find(r => r.hook === 'manifest-note');
  const border = records.find(r => r.hook === 'border-diversion');
  if (manifest && border) return BOTH[`${manifest.choice}/${border.choice}`] ?? null;
  if (manifest) return ONLY['manifest-note'][manifest.choice];
  if (border) return ONLY['border-diversion'][border.choice];
  return null;
}

export function reportLines(kind: 'diversion' | 'hard-landing', listened: boolean): string[] {
  const head = kind === 'diversion'
    ? 'Diversion report. The flight left the arrival. The captain had the release.'
    : 'Hard-landing report. The aircraft met the runway it was given. The captain had the release.';
  const foot = listened ? 'The first officer had the TAF open.' : 'No other signature on the release.';
  return [head, foot];
}

export const ACCIDENTS: readonly AccidentReport[] = [
  {
    id: 'authority-gradient',
    circular: '14-7',
    lines: [
      'Night. A 727 on a coastal approach.',
      'The first officer saw the lights in the wrong place.',
      'He mentioned the lights. The captain continued.',
      'The aircraft struck short of the runway.',
    ],
    lesson: 'Crew members have to be able to challenge a captain who continues.',
    source: 'NTSB AAR-00/01 · Korean Air flight 801 · 1997',
  },
  {
    id: 'plan-continuation',
    circular: '19-2',
    lines: [
      'Thunderstorms on the arrival TAF.',
      'The divert field was briefed.',
      'The crew continued. The aircraft left the runway.',
    ],
    lesson: 'Discontinue the approach when severe storms are on the field.',
    source: 'NTSB AAR-01/02 · American Airlines flight 1420 · 1999',
  },
  {
    id: 'get-there-itis',
    circular: '08-3',
    lines: [
      'Snow on the wings at the hold.',
      'The captain said the snow would come off on the roll.',
      'The aircraft did not climb.',
    ],
    lesson: 'Do not take off with snow or ice on the airframe.',
    source: 'NTSB AAR-82-08 · Air Florida flight 90 · 1982',
  },
];

export function accident(id: AccidentId): AccidentReport {
  const found = ACCIDENTS.find(a => a.id === id);
  if (!found) throw new RangeError('Unknown accident report');
  return found;
}
