import { describe, it, expect } from 'vitest';
import { bestCoastalWindow, bestLabel, coastalRows, coastalSheetHeight, coastalWhen, HOUR, kiteGood, surfGood } from '../../src/lib/coastal-outlook';
import { DEFAULT_KITE_BAND } from '../../src/lib/coastal';
import { parseCoastalForecast, type CoastalHour } from '../../src/lib/coastal-forecast';
import { fieldColor } from '../../src/lib/field-color';
import { mergeSettings } from '../../src/lib/account/merge';
import { checkDoc } from '../../src/lib/account/validate';
import { readSetting, setPref, readLocal, writeLocal } from '../../src/lib/account/local';

const start = Date.parse('2026-10-10T05:00Z'); // Sat 13h Perth
const row = (time = start): CoastalHour => ({ time, windKt: 20, gustKt: 24, windFrom: 270, daylight: true, waveHeightM: 2, swellHeightM: 1.5, swellPeriodS: 12, swellFrom: 220, secondaryHeightM: null, secondaryPeriodS: null, secondaryFrom: null, seaTempC: 19 });
describe('coastal outlook', () => {
  it('does not offer offshore, gusty, missing or night hours for Kite', () => {
    expect(kiteGood(row(), DEFAULT_KITE_BAND, 270)).toBe(true);
    expect(kiteGood({ ...row(), gustKt: 25 }, DEFAULT_KITE_BAND, 270)).toBe(true);
    expect(kiteGood({ ...row(), gustKt: 25.4 }, DEFAULT_KITE_BAND, 270)).toBe(true);
    expect(kiteGood({ ...row(), gustKt: 25.5 }, DEFAULT_KITE_BAND, 270)).toBe(false);
    for (const change of [{ windFrom: 90 }, { windFrom: 135 }, { windFrom: null }, { gustKt: 30 }, { gustKt: null }, { windKt: null }, { daylight: false }, { daylight: null }]) expect(kiteGood({ ...row(), ...change }, DEFAULT_KITE_BAND, 270)).toBe(false);
    expect(kiteGood(row(), DEFAULT_KITE_BAND, null)).toBe(false);
    const rows = Array.from({ length: 5 }, (_, i) => row(start + i * HOUR));
    expect(bestLabel(bestCoastalWindow(rows, 'kite', DEFAULT_KITE_BAND, 270), 'Australia/Perth', 'kite', DEFAULT_KITE_BAND)).toBe('best Sat 13–17');
    expect(bestLabel(null, 'Australia/Perth', 'kite', DEFAULT_KITE_BAND)).toBe('none in 15–25 kt');
    expect(bestLabel(null, 'Australia/Perth', 'kite', { min: 18, max: 30 })).toBe('none in 18–30 kt');
    expect(bestLabel(null, 'Australia/Perth', 'surf', DEFAULT_KITE_BAND)).toBe('none');
    expect(coastalWhen(Date.parse('2026-10-09T07:00:00Z'), 'Australia/Perth')).toBe('Fri 3 pm');
    rows[2].daylight = false;
    expect(bestCoastalWindow(rows, 'kite', DEFAULT_KITE_BAND, 270)).toEqual({ start, end: start + HOUR });
  });
  it('Surf needs daylight, real swell and offshore or light wind; gaps break windows', () => {
    expect(surfGood(row(), 270)).toBe(false);
    expect(surfGood({ ...row(), windFrom: 90 }, 270)).toBe(true);
    expect(surfGood({ ...row(), windKt: 8 }, 270)).toBe(true);
    for (const change of [{ swellPeriodS: null }, { swellHeightM: 0 }, { windKt: null }, { daylight: null }, { daylight: false }]) expect(surfGood({ ...row(), windKt: 4, ...change }, 270)).toBe(false);
    const rows = [row(), row(start + HOUR), row(start + 3 * HOUR), row(start + 4 * HOUR)].map((r) => ({ ...r, windKt: 5 }));
    expect(bestCoastalWindow(rows, 'surf', DEFAULT_KITE_BAND, 270)).toEqual({ start, end: start + HOUR });
  });
  it('joins exact timestamps, retains swell when wind fails, and limits to the next 72h', () => {
    const wind = parseCoastalForecast({ hourly: { time: [start / 1000], wind_speed_10m: [15], is_day: [1] } }, 'wind');
    const marine = parseCoastalForecast({ hourly: { time: [start / 1000, (start + HOUR) / 1000, (start + 72 * HOUR) / 1000], swell_wave_height: [1, 2, 3] } }, 'marine');
    const rows = coastalRows(wind, marine, start);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ windKt: 15, swellHeightM: 1, daylight: true });
    expect(rows[1]).toMatchObject({ windKt: null, swellHeightM: 2, daylight: null });
    expect(coastalRows(null, marine, start)[0].swellHeightM).toBe(1);
  });
  it('opens the phone sheet at a peek that keeps 35% of the viewport for the map', () => {
    const peek = coastalSheetHeight('peek', 200, 619, 206, 667, 174);
    expect(peek).toBe(174);
    expect((619 - peek - 200) / 667).toBeGreaterThanOrEqual(0.35);
    const capped = coastalSheetHeight('peek', 200, 619, 206, 667, 400);
    expect((619 - capped - 200) / 667).toBeGreaterThanOrEqual(0.35);
    expect(capped).toBeLessThan(400);
    expect(coastalSheetHeight('full', 208, 800, 214, 844, 174)).toBe(800 - 214);
    expect(coastalSheetHeight('peek', 10, 10, 0, 844, 174)).toBe(0);
  });
  it('tints the field with the editable band, leaving the standard wind palette alone', () => {
    expect(fieldColor('wind', 20, DEFAULT_KITE_BAND)).toMatchObject({ r: 34 / 255, g: 197 / 255, b: 94 / 255 });
    expect(fieldColor('wind', 25.4, DEFAULT_KITE_BAND)).toMatchObject({ r: 34 / 255, g: 197 / 255, b: 94 / 255 });
    expect(fieldColor('wind', 25.5, DEFAULT_KITE_BAND).r).toBe(239 / 255);
    expect(fieldColor('wind', 20, { min: 21, max: 30 })).toMatchObject({ r: 245 / 255, g: 158 / 255 });
    expect(fieldColor('wind', 30, DEFAULT_KITE_BAND).r).toBe(239 / 255);
    expect(fieldColor('wind', NaN, DEFAULT_KITE_BAND).a).toBe(0);
    expect(fieldColor('wind', 20)).not.toEqual(fieldColor('wind', 20, DEFAULT_KITE_BAND));
  });
  it('validates and syncs a kite band as one timestamped account setting', () => {
    const a = { values: { kiteBand: { min: 15, max: 25 } }, at: { kiteBand: '2026-10-08T00:00Z' } };
    const b = { values: { kiteBand: { min: 18, max: 27 } }, at: { kiteBand: '2026-10-09T00:00Z' } };
    expect(mergeSettings(a, b)).toEqual(b);
    expect(checkDoc('settings', b).ok).toBe(true);
    for (const band of [{ min: 30, max: 15 }, { min: -1, max: 25 }, { min: 15, max: 101 }]) expect(checkDoc('settings', { values: { kiteBand: band }, at: {} }).ok).toBe(false);
    const saved = new Map<string, string>();
    const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k) } });
    try {
      setPref('kiteBand', a.values.kiteBand);
      expect(readSetting('kiteBand')).toEqual(a.values.kiteBand);
      expect(readLocal('settings')).toMatchObject({ values: a.values });
      writeLocal('settings', b);
      expect(readSetting('kiteBand')).toEqual(b.values.kiteBand);
    } finally { if (prior) Object.defineProperty(globalThis, 'localStorage', prior); else Reflect.deleteProperty(globalThis, 'localStorage'); }
  });
});
