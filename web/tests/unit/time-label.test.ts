import { describe, expect, it } from 'vitest';
import { nowMinuteOf, type ChartManifest } from '../../src/lib/chart-store';
import { clockZone, formatClock, zoneAbbreviation, zuluLabel } from '../../src/lib/time-label';

const NOW = Date.parse('2026-10-09T06:04:00Z');

describe('place clocks', () => {
  it('writes Perth local time with AWST and Zulu beside it', () => {
    expect(formatClock(NOW, 'Australia/Perth')).toBe('Fri 2:04 pm AWST');
    expect(zuluLabel(NOW)).toBe('0604Z');
    expect(zoneAbbreviation(NOW, 'Australia/Sydney')).toBe('AEDT');
  });

  it('uses the selected place, so Vancouver is PDT on Vancouver’s day', () => {
    expect(formatClock(NOW, 'America/Vancouver')).toBe('Thu 11:04 pm PDT');
    expect(formatClock(NOW, 'UTC', false)).toBe('6:04 am UTC');
  });

  it('keeps a GMT offset only when the zone has no letter name', () => {
    expect(zoneAbbreviation(NOW, 'Asia/Kolkata')).toBe('GMT+5:30');
  });

  it('reuses zone rules across a daylight-saving change without caching the old name', () => {
    expect(formatClock(Date.parse('2026-10-03T15:59:00Z'), 'Australia/Sydney')).toBe('Sun 1:59 am AEST');
    expect(formatClock(Date.parse('2026-10-03T16:00:00Z'), 'Australia/Sydney')).toBe('Sun 3:00 am AEDT');
    expect(formatClock(Date.parse('2026-10-03T15:59:00Z'), 'Australia/Sydney')).toBe('Sun 1:59 am AEST');
  });

  it('resolves the three menu modes', () => {
    expect(clockZone('place', 'Australia/Perth')).toBe('Australia/Perth');
    expect(clockZone('utc', 'Australia/Perth')).toBe('UTC');
    expect(clockZone('place', '')).toBe('UTC');
    expect(clockZone('device', 'Australia/Perth').length).toBeGreaterThan(0);
  });

  it('anchors an open playhead to the wall clock, not the model run', () => {
    const manifest = { run: '2026-10-09T00:00:00Z', forecastHours: [0, 3, 96] } as ChartManifest;
    // 00Z is 8:00 am AWST. The open minute is 6 h 4 min later, not minute 0.
    expect(nowMinuteOf(manifest, NOW)).toBeCloseTo(364, 5);
    expect(formatClock(Date.parse('2026-10-09T00:00:00Z'), 'Australia/Perth')).toBe('Fri 8:00 am AWST');
  });
});
