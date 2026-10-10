import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export type Runtime = 'claude' | 'codex' | 'cursor';
export interface Capacity { ok: boolean; runtimes?: Runtime[]; reason?: string }
export const MAX_CAPACITY_AGE_SECONDS = 15 * 60;
export const CLAUDE_FLOOR = { fiveHour: 25, week: 20 };

/** Unknown, stale and reset-elapsed readings never authorize subscription use. */
export function remaining(raw: unknown, service: string, pool: string, now = Date.now()): number | null {
  const feed = raw as { services?: Record<string, { pools?: { pool?: string; remainingPct?: number; ageSeconds?: number; asOf?: string; resetAt?: string; freshness?: string }[] }> } | null;
  const pools = feed?.services?.[service]?.pools;
  const row = Array.isArray(pools) ? pools.find((row) => row.pool === pool) : null;
  if (!row || row.freshness !== 'fresh' || typeof row.ageSeconds !== 'number' || row.ageSeconds < 0 || row.ageSeconds > MAX_CAPACITY_AGE_SECONDS ||
      typeof row.remainingPct !== 'number' || !Number.isFinite(row.remainingPct) || row.remainingPct < 0 || row.remainingPct > 100 ||
      !row.asOf || !Number.isFinite(Date.parse(row.asOf)) || now - Date.parse(row.asOf) > MAX_CAPACITY_AGE_SECONDS * 1000 || Date.parse(row.asOf) > now + 60_000 ||
      !row.resetAt || !Number.isFinite(Date.parse(row.resetAt)) || Date.parse(row.resetAt) <= now) return null;
  return row.remainingPct;
}

/** Isobar yields altogether when Claude is low, preserving md3's primary window.
 * With unknown Claude capacity, only independently known fallback pools may run. */
export function chooseRuntimes(raw: unknown, fallbacks: readonly Runtime[] = [], now = Date.now()): Capacity {
  const fiveHour = remaining(raw, 'claude', '5h', now), week = remaining(raw, 'claude', '7d', now);
  if ((fiveHour !== null && fiveHour < CLAUDE_FLOOR.fiveHour) || (week !== null && week < CLAUDE_FLOOR.week)) {
    return { ok: false, runtimes: [], reason: 'claude-low' };
  }
  const runtimes: Runtime[] = [];
  if (fiveHour !== null && week !== null) runtimes.push('claude');
  if (fallbacks.includes('codex') && (remaining(raw, 'codex', 'codex:primary', now) ?? 0) >= 15) runtimes.push('codex');
  // Pin Grok to the Cursor pool; API pool headroom never qualifies it.
  if (fallbacks.includes('cursor') && (remaining(raw, 'cursor', 'cursor', now) ?? 0) >= 15) runtimes.push('cursor');
  return { ok: runtimes.length > 0, runtimes, reason: runtimes.length ? 'ready' : 'capacity-unknown' };
}

export function readCapacity(fallbacks: readonly Runtime[] = []): Promise<Capacity> {
  return new Promise((resolve) => {
    execFile(path.join(os.homedir(), '.local/bin/ai-capacity'), ['--json'], { timeout: 5_000, maxBuffer: 128_000 }, (error, stdout) => {
      if (error) return resolve({ ok: false, runtimes: [], reason: 'capacity-unavailable' });
      try { resolve(chooseRuntimes(JSON.parse(stdout), fallbacks)); }
      catch { resolve({ ok: false, runtimes: [], reason: 'capacity-unavailable' }); }
    });
  });
}
