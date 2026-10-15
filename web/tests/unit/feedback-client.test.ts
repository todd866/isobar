import { describe, expect, it } from 'vitest';
import { FeedbackBuffer } from '../../src/lib/feedback/buffer';
import { localISO, makeSnapshot } from '../../src/lib/feedback/snapshot';

describe('feedback history', () => {
  it('evicts old entries and caps bursts at 500, newest last', () => {
    let now = 0; const buffer = new FeedbackBuffer(() => now);
    buffer.add('old'); now = 60_001;
    for (let i = 0; i < 510; i++) buffer.add('seek', i);
    expect(buffer.snapshot()).toHaveLength(500);
    expect(buffer.snapshot()[0].data).toBe(10);
    expect(buffer.snapshot().at(-1)?.data).toBe(509);
    now += 60_001; expect(buffer.snapshot()).toEqual([]);
  });
  it('copies input and output, and clears on logout', () => {
    const buffer = new FeedbackBuffer(); const data = { lens: 'wind' };
    buffer.add('lens', data); data.lens = 'rain';
    const shot = buffer.snapshot(); (shot[0].data as typeof data).lens = 'temp';
    expect(buffer.snapshot()[0].data).toEqual({ lens: 'wind' });
    buffer.clear(); expect(buffer.snapshot()).toEqual([]);
  });
});
describe('frozen capture', () => {
  it('uses place offsets including Sydney DST and Perth stability', () => {
    expect(localISO(Date.parse('2026-10-03T15:59:59Z'), 'Australia/Sydney')).toBe('2026-10-04T01:59:59+10:00');
    expect(localISO(Date.parse('2026-10-03T16:00:00Z'), 'Australia/Sydney')).toBe('2026-10-04T03:00:00+11:00');
    expect(localISO(Date.parse('2026-10-03T16:00:00Z'), 'Australia/Perth')).toBe('2026-10-04T00:00:00+08:00');
    expect(localISO(NaN, 'UTC')).toBeNull();
  });
  it('retains keypress state, missing values and legitimate zero values', () => {
    const state = { camera: { x: 0 }, playhead: null, bad: NaN };
    const record = makeSnapshot({ now: 0, zone: 'UTC', app: { version: null, build: null, commit: null }, state, recent: [] });
    state.camera.x = 10;
    expect(record.state).toEqual({ camera: { x: 0 }, playhead: null, bad: null });
    expect(record.note).toBeNull(); expect(record.files).toEqual([]);
    expect(record.captured_at).toBe('1970-01-01T00:00:00.000Z');
  });
});

it('bounds noisy error evidence beneath the request budget', () => {
  const buffer = new FeedbackBuffer();
  for (let i = 0; i < 500; i++) buffer.add('error', '🐳'.repeat(5000));
  const events = buffer.snapshot();
  expect(events.length).toBeGreaterThan(0);
  expect(new TextEncoder().encode(JSON.stringify(events)).length).toBeLessThan(61_000);
});
