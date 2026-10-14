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

describe('forward loop dissolve', () => {
  it('holds the endpoint for .2 seconds, then dissolves for .6 seconds', () => {
    let clock = advancePlayback({ minute: 990, playing: true, direction: 1 }, 10 / 256, 256, 1000, 100);
    expect(clock.minute).toBe(1000);
    expect(clock.wrapSeconds).toBe(0);
    clock = advancePlayback(clock, .19, 256, 1000, 100);
    expect(clock.minute).toBe(1000);
    clock = advancePlayback(clock, .11, 256, 1000, 100);
    expect(clock.minute).toBe(100);
    expect(clock.wrapSeconds).toBeCloseTo(.3);
    expect(advancePlayback({ ...clock, playing: false }, 1, 256, 1000, 100)).toEqual({ ...clock, playing: false });
    clock = advancePlayback(clock, .5, 256, 1000, 100);
    expect(clock.wrapSeconds).toBeUndefined();
    expect(clock.minute).toBeCloseTo(100);
    expect(advancePlayback(clock, .1, 256, 1000, 100).minute).toBeCloseTo(125.6);
  });
  it('accounts for crossing within a frame and resumes forward after delayed delivery', () => {
    const clock = advancePlayback({ minute: 999, playing: true, direction: -1 }, .1, 256, 1000, 100);
    expect(clock.minute).toBe(1000);
    expect(clock.wrapSeconds).toBeCloseTo(.1 - 1 / 256);
    const resumed = advancePlayback(clock, 1, 256, 1000, 100);
    expect(resumed.direction).toBe(1);
    expect(resumed.wrapSeconds).toBeUndefined();
    expect(resumed.minute).toBeGreaterThanOrEqual(100);
  });
});
