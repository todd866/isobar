import { describe, expect, it } from 'vitest';
import { rainWindowSource, type RainRun } from '../../src/lib/rain-window';

const H = 3_600_000;
const latest = Date.parse('2026-10-06T12:00:00Z');

function run(id: string, runMs: number, lastHour: number): RainRun {
  return { id, runMs, has: (hour) => hour >= 0 && hour <= lastHour && hour % 3 === 0 };
}

describe('24 h rain window', () => {
  const runs = [run('12Z', latest, 96), run('00Z', latest - 12 * H, 144), run('prev12Z', latest - 24 * H, 144)];

  it('uses the run itself from +24 h', () => {
    expect(rainWindowSource(latest + 24 * H, runs)).toEqual({ id: '12Z', endHour: 24, startHour: 0 });
  });

  it('borrows the previous run for 12-21 h', () => {
    expect(rainWindowSource(latest + 15 * H, runs)).toEqual({ id: '00Z', endHour: 27, startHour: 3 });
  });

  it('goes back two runs for 0-9 h', () => {
    expect(rainWindowSource(latest, runs)).toEqual({ id: 'prev12Z', endHour: 24, startHour: 0 });
  });

  it('leaves the frame missing when no run holds both ends', () => {
    expect(rainWindowSource(latest + 3 * H, [runs[0], runs[1]])).toBeNull();
  });
});
