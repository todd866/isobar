/** Preserve the website's existing whole-hour >18 h stale threshold. */
export function forecastFreshness(runMs: number, nowMs: number, zone: string): string | null {
  if (!(runMs > 0) || !Number.isFinite(runMs) || !Number.isFinite(nowMs)) return null;
  const age = Math.max(0, Math.floor((nowMs - runMs) / 3_600_000));
  if (age <= 18) return null;
  if (nowMs - runMs <= 36 * 3_600_000) return `Forecast ${age} h old`;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(runMs);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  const minutes = part('minute') === '00' ? '' : `:${part('minute')}`;
  return `Forecast from ${part('weekday')} ${part('hour')}${minutes} ${part('dayPeriod').toLowerCase()}`;
}
