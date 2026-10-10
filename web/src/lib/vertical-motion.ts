/** A point sounding's vertical velocity. Positive w is upward motion in m/s. */
export type VerticalMotionDirection = 'up' | 'down' | 'neutral' | 'missing';

export interface VerticalMotionCue {
  direction: VerticalMotionDirection;
  /** A display-only, bounded cue strength in [0, 1]. */
  strength: number;
  /** The finite source value, preserved in m/s when available. */
  wMs: number | null;
}

const MAX_CUE_MS = 2.5;

/**
 * Convert a point-only vertical velocity into a visual cue.
 *
 * The map's horizontal grid has no vertical-motion field. Missing, non-finite,
 * and non-numeric values remain missing; they are never treated as calm air.
 */
export function verticalMotionCue(value: unknown): VerticalMotionCue {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { direction: 'missing', strength: 0, wMs: null };
  }
  if (value === 0) return { direction: 'neutral', strength: 0, wMs: 0 };
  return {
    direction: value > 0 ? 'up' : 'down',
    strength: Math.min(1, Math.abs(value) / MAX_CUE_MS),
    wMs: value,
  };
}

/** Convert cue strength to a bounded pixel displacement for a compact graphic. */
export function verticalMotionAmplitude(value: unknown, maxPixels = 24): number {
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) return 0;
  return verticalMotionCue(value).strength * maxPixels;
}
