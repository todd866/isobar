import { describe, expect, it } from 'vitest';
import { advancePlayback, REAL_TIME, SPEEDS, speedLabel } from '../../src/lib/playback';

describe('real time and forecast replay share one clock', () => {
  it('advances one actual second per second, including a delayed frame', () => {
    const clock = { minute: 120, playing: true, direction: 1 as const };
    expect(advancePlayback(clock, 1, REAL_TIME, 10000).minute).toBeCloseTo(120 + 1 / 60, 10);
    expect(advancePlayback(clock, 90, REAL_TIME, 10000).minute).toBe(121.5);
  });
  it('Now stays wall-clock aligned while real-time replay keeps its historical offset', () => {
    const clock = { minute: 120, playing: true, direction: 1 as const, followNow: true };
    expect(advancePlayback(clock, 60, REAL_TIME, 10000, 180).minute).toBe(180);
    expect(advancePlayback({ ...clock, followNow: false }, 60, REAL_TIME, 10000, 180).minute).toBe(121);
  });
  it('retains existing accelerated rates and pauses without losing time', () => {
    for (const rate of SPEEDS.filter((rate) => rate > 0)) {
      const clock = { minute: 120, playing: true, direction: 1 as const };
      expect(advancePlayback(clock, 1, rate, 10000).minute).toBe(120 + rate);
      expect(advancePlayback({ ...clock, playing: false }, 10, rate, 10000).minute).toBe(120);
    }
    expect(speedLabel(REAL_TIME)).toBe('Real time');
    expect(speedLabel(1)).toBe('1 min/s');
  });
});
