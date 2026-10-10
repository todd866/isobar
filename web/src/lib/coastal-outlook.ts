import { bestWindow, kiteBandState, shownKnots, shoreDirection, type KiteBand } from './coastal';
import type { CoastalForecast, CoastalHour } from './coastal-forecast';
import { zonedStamp } from './time-label';

export const HOUR = 3_600_000;
export function coastalRows(wind: CoastalForecast | null, marine: CoastalForecast | null, nowMs: number): CoastalHour[] {
  const winds = new Map(wind?.hours.map((row) => [row.time, row]));
  const waves = new Map(marine?.hours.map((row) => [row.time, row]));
  const times = [...new Set([...winds.keys(), ...waves.keys()])].sort((a, b) => a - b);
  return times.filter((time) => time >= nowMs && time < nowMs + 72 * HOUR).map((time) => {
    const w = winds.get(time), m = waves.get(time);
    return { ...(m ?? w!), windKt: w?.windKt ?? null, gustKt: w?.gustKt ?? null, windFrom: w?.windFrom ?? null, daylight: w?.daylight ?? null };
  });
}
export function coastalClock(time: number, zone: string): { day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(time);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: get('weekday'), hour: get('hour'), minute: get('minute') };
}

/** Local column, in the map's 12-hour style. On-the-hour samples drop :00 ("Fri 3 pm"). */
export function coastalWhen(time: number, zone: string): string {
  const stamp = zonedStamp(time, zone);
  const clock = stamp.minute === '00' ? `${stamp.hour} ${stamp.dayPeriod}` : `${stamp.hour}:${stamp.minute} ${stamp.dayPeriod}`;
  return `${stamp.weekday} ${clock}`;
}

export function kiteGood(row: CoastalHour, band: KiteBand, normal: number | null): boolean {
  const shore = shoreDirection(row.windFrom, normal);
  return row.daylight === true && kiteBandState(row.windKt, band) === 'inside'
    && row.gustKt != null && shownKnots(row.gustKt) <= band.max
    && shore != null && shore !== 'offshore' && shore !== 'cross-off';
}
export function surfGood(row: CoastalHour, normal: number | null): boolean {
  const shore = shoreDirection(row.windFrom, normal);
  return row.daylight === true && row.swellHeightM != null && row.swellHeightM > 0
    && row.swellPeriodS != null && row.swellPeriodS >= 10 && row.windKt != null
    && (row.windKt <= 8 || shore === 'offshore' || shore === 'cross-off');
}
export function bestCoastalWindow(rows: CoastalHour[], lens: 'kite' | 'surf', band: KiteBand, normal: number | null) {
  // Evaluate every hourly sample, not just the three-hour Surf display; missing
  // intermediate swell/wind or night breaks the window instead of being bridged.
  return bestWindow(rows.map((row) => ({ time: row.time, good: lens === 'kite' ? kiteGood(row, band, normal) : surfGood(row, normal) })), HOUR);
}
/** Phone sheet keeps at least this fraction of the viewport as map at peek. */
export const COASTAL_MAP_SHARE = 0.35;
export const COASTAL_PEEK_ROWS = 3;

/**
 * Phone coastal sheet height. Peek is the measured header, best line and three
 * rows, and never eats the map below {@link COASTAL_MAP_SHARE}. Full stops
 * under the time slider.
 */
export function coastalSheetHeight(
  detent: 'peek' | 'full',
  panelTop: number,
  panelBottom: number,
  ceiling: number,
  viewportHeight: number,
  peekPx: number,
): number {
  const span = panelBottom - panelTop;
  if (![span, viewportHeight, peekPx, ceiling].every((value) => Number.isFinite(value)) || span <= 0 || viewportHeight <= 0) return 0;
  const belowSlider = Math.max(0, panelBottom - Math.max(panelTop, ceiling));
  if (detent === 'full') return Math.floor(belowSlider);
  const maxPeek = Math.floor(span - viewportHeight * COASTAL_MAP_SHARE);
  return Math.max(0, Math.min(Math.floor(Math.max(0, peekPx)), maxPeek, Math.floor(belowSlider)));
}

export function bestLabel(window: ReturnType<typeof bestWindow>, zone: string, lens: 'kite' | 'surf', band: KiteBand): string {
  if (!window) return lens === 'kite' ? `none in ${band.min}–${band.max} kt` : 'none';
  const start = coastalClock(window.start, zone), end = coastalClock(window.end, zone);
  const endDay = end.day === start.day ? '' : `${end.day} `;
  return `best ${start.day} ${start.hour}–${endDay}${end.hour}`;
}
