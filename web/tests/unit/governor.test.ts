import { describe, expect, it } from 'vitest';
import { govern, HOUR_MS, throttledTier, type GovernorRow } from '../../src/lib/chat/governor';
import type { Grade } from '../../src/lib/chat/types';
import { handoffInstead, questionNeedsArchive } from '../../src/lib/chat/handoff';

const START = new Date('2026-10-08T00:00:00Z');
const END = new Date('2026-10-28T00:00:00Z');
const NOW = new Date('2026-10-18T00:00:00Z');
const TOTAL = 240;

function at(msFromNow: number, cost: number, lane: GovernorRow['lane'] = 'api'): GovernorRow {
  return { at: new Date(NOW.getTime() + msFromNow), costUsd: cost, lane };
}

function run(rows: GovernorRow[], extra: Partial<Parameters<typeof govern>[0]> = {}) {
  return govern({ rows, now: NOW, totalUsd: TOTAL, windowStart: START, windowEnd: END, ...extra });
}

describe('global spend governor', () => {
  it('stays on opus when the hour and the day are under pace', () => {
    const rows = Array.from({ length: 12 }, (_, i) => at(-(i + 0.5) * HOUR_MS, 0.5));
    const decision = run(rows);
    expect(decision).toMatchObject({ fast: 'opus', watcher: 'haiku', digest: 'sonnet', slow: 'uncapped', steps: 0, reason: 'ok' });
  });

  it('steps one tier when the last hour is over pace and two at twice pace', () => {
    expect(run([at(-10 * 60_000, 1.5)]).fast).toBe('sonnet');
    expect(run([at(-10 * 60_000, 1.5)]).steps).toBe(1);
    expect(run([at(-10 * 60_000, 2.2)]).fast).toBe('haiku');
    expect(run([at(-10 * 60_000, 2.2)]).reason).toBe('pace');
    expect(run([at(-10 * 60_000, 9)]).fast).toBe('haiku');
  });

  it('steps on the day even when the last hour is quiet', () => {
    expect(run([at(-2 * HOUR_MS, 25)]).steps).toBe(1);
    expect(run([at(-2 * HOUR_MS, 48)]).steps).toBe(2);
    expect(run([at(-2 * HOUR_MS, 10)]).steps).toBe(0);
  });

  it('does not count an exact pace as over', () => {
    // Remaining spread over the time left: this charge is the hour's allowance at now.
    const burn = TOTAL / (TOTAL + 1);
    expect(run([at(0, burn)]).steps).toBe(0);
    expect(run([at(0, burn + 0.05)]).steps).toBe(1);
  });

  it('holds the cap until a full hour has been under pace, then recovers', () => {
    expect(run([at(-90 * 60_000, 3)])).toMatchObject({ fast: 'haiku', reason: 'recovering' });
    expect(run([at(-61 * 60_000, 3)])).toMatchObject({ fast: 'haiku', reason: 'recovering' });
    expect(run([at(-3 * HOUR_MS, 3)])).toMatchObject({ fast: 'opus', reason: 'ok', steps: 0 });
    expect(run([at(-2 * HOUR_MS, 3)])).toMatchObject({ fast: 'opus', reason: 'ok', steps: 0 });
  });

  it('ignores the slow lane and caps every API lane the same way', () => {
    const decision = run([at(-10 * 60_000, 2), { at: new Date(NOW.getTime() - 60_000), costUsd: 10_000, lane: 'slow' }]);
    expect(decision.fast).toBe('haiku');
    expect(decision.digest).toBe('haiku');
    expect(decision.watcher).toBe('haiku');
    expect(decision.slow).toBe('uncapped');
  });

  it('rests outside the window, including the edges', () => {
    expect(run([], { now: START }).reason).toBe('ok');
    expect(run([], { now: new Date(START.getTime() - 1) }).reason).toBe('window');
    expect(run([], { now: END }).reason).toBe('window');
    expect(run([], { now: new Date(END.getTime() + 1) }).fast).toBe('rest');
  });

  it('rests when the budget or the ledger cannot be priced', () => {
    expect(run([], { totalUsd: null }).reason).toBe('unknown');
    expect(run([], { totalUsd: 0 }).reason).toBe('unknown');
    expect(run([], { totalUsd: Number.NaN }).reason).toBe('unknown');
    expect(run([], { windowStart: null }).reason).toBe('unknown');
    expect(run([], { windowEnd: null }).reason).toBe('unknown');
    expect(run([], { windowStart: END, windowEnd: START }).reason).toBe('unknown');
    expect(run([{ at: new Date(NOW.getTime() - 60_000), costUsd: null, lane: 'api' }]).reason).toBe('unknown');
    expect(run([{ at: new Date(NOW.getTime() - 60_000), costUsd: Number.NaN, lane: 'api' }]).fast).toBe('rest');
    expect(run([{ at: new Date(NOW.getTime() - 60_000), costUsd: -1, lane: 'api' }]).reason).toBe('unknown');
    expect(run([{ at: new Date(START.getTime() - HOUR_MS), costUsd: null, lane: 'api' }]).reason).toBe('ok');
  });

  it('caps at haiku once the window has nothing left, and a quiet start does not', () => {
    const spent = { at: new Date(START.getTime() + 60_000), costUsd: 240, lane: 'api' as const };
    expect(run([spent]).steps).toBe(2);
    expect(run([]).steps).toBe(0);
  });

  it('drops to sonnet at a quarter of the allowance spent and haiku at half; signed-in users one model later', () => {
    const spent = (usd: number) => [{ at: new Date(START.getTime() + 60_000), costUsd: usd, lane: 'api' as const }];
    expect(run(spent(TOTAL * 0.2))).toMatchObject({ fast: 'opus', steps: 0 });
    expect(run(spent(TOTAL * 0.3))).toMatchObject({ fast: 'sonnet', steps: 1, reason: 'spend' });
    const half = run(spent(TOTAL * 0.55));
    expect(half).toMatchObject({ fast: 'haiku', digest: 'haiku', reason: 'spend' });
    const top: Grade[] = Array<Grade>(10).fill('interesting');
    const signed = (d: ReturnType<typeof run>) => throttledTier({ base: 'opus', grades: top, ceilingRatio: 0, pressure: d.pressure, share: d.share, owner: false, signedIn: true, globalCap: d.fast });
    expect(signed(run(spent(TOTAL * 0.3)))).toBe('opus');
    expect(signed(half)).toBe('sonnet');
    expect(signed(run(spent(TOTAL * 0.8)))).toBe('haiku');
    expect(throttledTier({ base: 'opus', grades: top, ceilingRatio: 0, pressure: half.pressure, share: half.share, owner: false, signedIn: false, globalCap: half.fast })).toBe('haiku');
  });

  it('cuts signed-in users by recent grades as the pace overrun grows, and keeps the owner on the global cap', () => {
    const bottom: Grade[] = [...Array<Grade>(6).fill('ordinary'), ...Array<Grade>(4).fill('off-purpose')];
    const middle: Grade[] = [...Array<Grade>(5).fill('interesting'), ...Array<Grade>(5).fill('ordinary')];
    const top: Grade[] = [...Array<Grade>(8).fill('interesting'), ...Array<Grade>(2).fill('ordinary')];
    const low = run([at(-10 * 60_000, 1.05)]);
    expect(low.steps).toBe(1);
    expect(low.pressure).toBeGreaterThan(1);
    expect(low.pressure).toBeLessThan(1.25);
    expect(throttledTier({ base: 'opus', grades: bottom, ceilingRatio: 0, pressure: low.pressure, owner: false, signedIn: true, globalCap: low.fast })).toBe('sonnet');
    expect(throttledTier({ base: 'opus', grades: middle, ceilingRatio: 0, pressure: low.pressure, owner: false, signedIn: true, globalCap: low.fast })).toBe('opus');
    expect(throttledTier({ base: 'opus', grades: top, ceilingRatio: 0, pressure: low.pressure, owner: false, signedIn: true, globalCap: low.fast })).toBe('opus');
    expect(throttledTier({ base: 'sonnet', grades: bottom, ceilingRatio: 0, pressure: low.pressure, owner: false, signedIn: true, globalCap: low.fast })).toBe('haiku');
    expect(throttledTier({ base: 'opus', grades: top, ceilingRatio: 0, pressure: low.pressure, owner: true, signedIn: true, globalCap: low.fast })).toBe('sonnet');
    expect(throttledTier({ base: 'opus', grades: top, ceilingRatio: 0, pressure: low.pressure, owner: false, signedIn: false, globalCap: low.fast })).toBe('sonnet');

    const mid = run([at(-10 * 60_000, 1.3)]);
    expect(mid.pressure).toBeGreaterThanOrEqual(1.25);
    expect(mid.pressure).toBeLessThan(1.5);
    expect(throttledTier({ base: 'opus', grades: middle, ceilingRatio: 0, pressure: mid.pressure, owner: false, signedIn: true, globalCap: mid.fast })).toBe('sonnet');
    expect(throttledTier({ base: 'opus', grades: top, ceilingRatio: 0, pressure: mid.pressure, owner: false, signedIn: true, globalCap: mid.fast })).toBe('opus');

    const high = run([at(-10 * 60_000, 1.7)]);
    expect(high.steps).toBe(1);
    expect(high.pressure).toBeGreaterThanOrEqual(1.5);
    expect(high.pressure).toBeLessThan(2);
    expect(throttledTier({ base: 'opus', grades: top, ceilingRatio: 0, pressure: high.pressure, owner: false, signedIn: true, globalCap: high.fast })).toBe('sonnet');

    const twice = run([at(-10 * 60_000, 2.2)]);
    expect(twice.pressure).toBeGreaterThanOrEqual(2);
    expect(throttledTier({ base: 'opus', grades: top, ceilingRatio: 0, pressure: twice.pressure, owner: false, signedIn: true, globalCap: twice.fast })).toBe('haiku');
    expect(throttledTier({ base: 'opus', grades: top, ceilingRatio: 1.5, pressure: twice.pressure, owner: false, signedIn: true, globalCap: twice.fast })).toBe('haiku');

    const exact = run([at(0, TOTAL / (TOTAL + 1))]);
    expect(exact.steps).toBe(0);
    expect(throttledTier({ base: 'opus', grades: bottom, ceilingRatio: 0, pressure: exact.pressure, owner: false, signedIn: true, globalCap: 'opus' })).toBe('opus');

    const held = run([at(-90 * 60_000, 1.05)]);
    expect(held.reason).toBe('recovering');
    expect(held.pressure).toBeGreaterThan(1);
    expect(held.pressure).toBeLessThan(1.25);
    expect(throttledTier({ base: 'opus', grades: bottom, ceilingRatio: 0, pressure: held.pressure, owner: false, signedIn: true, globalCap: held.fast })).toBe('sonnet');
    expect(throttledTier({ base: 'opus', grades: top, ceilingRatio: 0, pressure: held.pressure, owner: false, signedIn: true, globalCap: held.fast })).toBe('opus');
    expect(throttledTier({ base: 'opus', grades: top, ceilingRatio: 0, pressure: 0, owner: false, signedIn: true, globalCap: 'rest' })).toBe('rest');
  });

  it('offers a signed-in hard question to the slow lane only when the fast lane is below opus', () => {
    expect(questionNeedsArchive('What did the model get wrong yesterday?')).toBe(true);
    expect(questionNeedsArchive('Why is the wind backing?')).toBe(false);
    expect(handoffInstead({ signedIn: true, fastCap: 'sonnet', hard: true })).toBe(true);
    expect(handoffInstead({ signedIn: true, fastCap: 'haiku', hard: true })).toBe(true);
    expect(handoffInstead({ signedIn: true, fastCap: 'rest', hard: true })).toBe(true);
    expect(handoffInstead({ signedIn: true, fastCap: 'opus', hard: true })).toBe(false);
    expect(handoffInstead({ signedIn: false, fastCap: 'haiku', hard: true })).toBe(false);
    expect(handoffInstead({ signedIn: true, fastCap: 'haiku', hard: false })).toBe(false);
  });
});
