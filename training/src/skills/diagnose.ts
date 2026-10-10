import type { Diagnosis } from './types.ts';

/** The entered number, if it is one of the drill's known misses. */
export function diagnose(
  spec: { value: number; tolerance: number; diagnoses: Diagnosis[] },
  entered: number,
): Diagnosis | null {
  if (!Number.isFinite(entered)) return null;
  if (Math.abs(entered - spec.value) <= spec.tolerance) return null;
  let best: Diagnosis | null = null;
  let bestGap = Infinity;
  for (const item of spec.diagnoses) {
    const scale = Math.max(1, Math.abs(item.value), Math.abs(entered));
    const gap = Math.abs(entered - item.value);
    const window = Math.max(spec.tolerance * 0.5, scale * 1e-8, 1e-6);
    if (gap <= window && gap < bestGap) {
      best = item;
      bestGap = gap;
    }
  }
  return best;
}
