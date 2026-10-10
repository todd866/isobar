import { describe, expect, it } from 'vitest';
import { verticalMotionAmplitude, verticalMotionCue } from '../../src/lib/vertical-motion';

describe('vertical motion cues', () => {
  it('keeps missing and non-finite w separate from neutral air', () => {
    expect(verticalMotionCue(undefined)).toEqual({ direction: 'missing', strength: 0, wMs: null });
    expect(verticalMotionCue(null).direction).toBe('missing');
    expect(verticalMotionCue(Number.NaN).direction).toBe('missing');
    expect(verticalMotionCue(Infinity).direction).toBe('missing');
    expect(verticalMotionCue(0)).toEqual({ direction: 'neutral', strength: 0, wMs: 0 });
  });

  it('uses the sign of w in m/s and bounds the display cue', () => {
    expect(verticalMotionCue(0.8)).toEqual({ direction: 'up', strength: 0.32, wMs: 0.8 });
    expect(verticalMotionCue(-1.25)).toEqual({ direction: 'down', strength: 0.5, wMs: -1.25 });
    expect(verticalMotionCue(99).strength).toBe(1);
    expect(verticalMotionCue(-99).strength).toBe(1);
    expect(verticalMotionAmplitude(99, 24)).toBe(24);
  });

  it('rejects non-numeric values and invalid pixel bounds', () => {
    expect(verticalMotionCue('0.8 m/s')).toEqual({ direction: 'missing', strength: 0, wMs: null });
    expect(verticalMotionAmplitude(1, 0)).toBe(0);
    expect(verticalMotionAmplitude(1, Number.NaN)).toBe(0);
  });
});
