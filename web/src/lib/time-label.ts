export interface ZonedStamp {
  weekday: string;
  day: string;
  month: string;
  hour: string;
  minute: string;
  dayPeriod: string;
  zone: string;
  year: string;
  monthNumber: string;
}

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  const existing = cache.get(zone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat('en-AU', {
    timeZone: zone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
    timeZoneName: 'short',
  });
  cache.set(zone, created);
  return created;
}

export function zonedStamp(ms: number, zone: string): ZonedStamp {
  const parts = formatter(zone).formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    weekday: pick('weekday'),
    day: pick('day'),
    month: pick('month'),
    hour: pick('hour'),
    minute: pick('minute'),
    dayPeriod: pick('dayPeriod').toLowerCase(),
    zone: pick('timeZoneName'),
    year: pick('year'),
    monthNumber: pick('month'),
  };
}

/** How a clock is shown. Place local is the default; the choice is per browser. */
export type ClockMode = 'place' | 'utc' | 'device';

const LETTERS = /^[A-Z]{2,5}$/;
/** Civil Australian names when ICU only offers "GMT+8". Offset is minutes east of UTC. */
const AU_OFFSET: Record<number, string> = {
  480: 'AWST', 525: 'ACWST', 570: 'ACST', 600: 'AEST', 630: 'ACDT', 660: 'AEDT',
};

/**
 * Alphabetic zone name for this instant: AWST, AEDT, PDT, BST.
 * ICU's short name depends on the locale (en-AU says AWST, en-US says PDT),
 * so the first letter-name across those locales wins. "GMT+8" is not a name.
 */
export function zoneAbbreviation(ms: number, zone: string): string {
  const names = ['en-AU', 'en-GB', 'en-US'].map((locale) => {
    try {
      const parts = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ms));
      return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    } catch {
      return '';
    }
  });
  const letters = names.find((name) => LETTERS.test(name));
  if (letters) return letters;
  if (zone === 'UTC' || zone === 'Etc/UTC' || zone === 'Etc/GMT') return 'UTC';
  if (zone.startsWith('Australia/') || zone.startsWith('Antarctica/')) {
    const known = AU_OFFSET[Math.round(zonedOffset(ms, zone) / 60000)];
    if (known) return known;
  }
  return names.find(Boolean) || 'UTC';
}

export function clockZone(mode: ClockMode, placeZone: string): string {
  if (mode === 'utc') return 'UTC';
  if (mode === 'device') {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch { return 'UTC'; }
  }
  return placeZone || 'UTC';
}

export function clockParts(ms: number, zone: string): { weekday: string; time: string; abbrev: string } {
  const stamp = zonedStamp(ms, zone);
  return {
    weekday: stamp.weekday,
    time: `${stamp.hour}:${stamp.minute} ${stamp.dayPeriod}`,
    abbrev: zoneAbbreviation(ms, zone),
  };
}

/** "Fri 2:04 pm AWST". Without the weekday: "2:04 pm AWST". */
export function formatClock(ms: number, zone: string, weekday = true): string {
  const parts = clockParts(ms, zone);
  return weekday ? `${parts.weekday} ${parts.time} ${parts.abbrev}` : `${parts.time} ${parts.abbrev}`;
}

/** "0604Z" — UTC hours and minutes, no colon. */
export function zuluLabel(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const digit = (type: string) => (parts.find((part) => part.type === type)?.value ?? '00').replace(/\D/g, '').padStart(2, '0').slice(-2);
  return `${digit('hour')}${digit('minute')}Z`;
}

/** "10am AEDT Wed 7 Oct" — the chart title. Minutes appear only when they are not :00. */
export function chartTitle(ms: number, zone: string, now: boolean): string {
  const stamp = zonedStamp(ms, zone);
  const clock = stamp.minute === '00' ? `${stamp.hour}${stamp.dayPeriod}` : `${stamp.hour}:${stamp.minute}${stamp.dayPeriod}`;
  const title = `${clock} ${zoneAbbreviation(ms, zone)} ${stamp.weekday} ${stamp.day} ${stamp.month}`;
  return now ? `Now · ${title}` : title;
}

export function clockLabel(ms: number, zone: string): string {
  return formatClock(ms, zone, false);
}

/** Local calendar day key yyyy-mm-dd in `zone`. */
export function localDayKey(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
  return parts;
}

/** UTC milliseconds of the local midnight that starts the calendar day containing `ms`. */
export function localMidnight(ms: number, zone: string): number {
  const key = localDayKey(ms, zone);
  const [year, month, day] = key.split('-').map(Number);
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = zonedOffset(guess, zone);
  return guess - offset;
}

function zonedOffset(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
  return asUtc - ms;
}

export function addLocalDays(midnightMs: number, days: number, zone: string): number {
  return localMidnight(midnightMs + days * 86_400_000 + 12 * 3_600_000, zone);
}

export function weekdayShort(ms: number, zone: string): string {
  return zonedStamp(ms, zone).weekday;
}
