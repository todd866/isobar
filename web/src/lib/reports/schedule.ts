/** A bounded cron dialect: one local time, daily or selected weekdays (0=Sun).
 * DST: first occurrence on a repeated clock; skip nonexistent wall times. */
export function parseSchedule(schedule: string) {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:,[0-6])*)$/.exec(schedule);
  if (!m || +m[1] > 59 || +m[2] > 23) throw new Error('Use a daily or weekly local time');
  return { minute: +m[1], hour: +m[2], days: m[3] === '*' ? null : [...new Set(m[3].split(',').map(Number))] };
}
export function validTimezone(zone: string): boolean {
  if (zone.length > 80 || (!zone.includes('/') && zone !== 'UTC')) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return true; } catch { return false; }
}
function parts(format: Intl.DateTimeFormat, date: Date) {
  return Object.fromEntries(format.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
export function nextOccurrence(schedule: string, timezone: string, after: Date): Date {
  const rule = parseSchedule(schedule);
  if (!validTimezone(timezone) || !Number.isFinite(+after)) throw new Error('Invalid timezone or time');
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const local = parts(format, after), first = Date.UTC(local.year, local.month - 1, local.day);
  for (let day = 0; day < 9; day++) {
    const calendar = new Date(first + day * 86_400_000);
    if (rule.days && !rule.days.includes(calendar.getUTCDay())) continue;
    const wall = +calendar + rule.hour * 3_600_000 + rule.minute * 60_000;
    const candidates = new Set<number>();
    // Inspect offsets on both sides of a transition, including half-hour DST.
    for (let h = -36; h <= 36; h += 6) {
      const sample = new Date(wall + h * 3_600_000), p = parts(format, sample);
      const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - +sample;
      const candidate = wall - offset, q = parts(format, new Date(candidate));
      if (q.year === calendar.getUTCFullYear() && q.month === calendar.getUTCMonth() + 1 && q.day === calendar.getUTCDate() && q.hour === rule.hour && q.minute === rule.minute) candidates.add(candidate);
    }
    const earliest = Math.min(...candidates);
    if (Number.isFinite(earliest) && earliest > +after) return new Date(earliest);
  }
  throw new Error('Schedule has no next occurrence');
}
