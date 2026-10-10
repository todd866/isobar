import { describe, expect, it } from 'vitest';
import { bindTrackpadPinch } from '../../src/lib/trackpad';

function gesture(target: EventTarget, type: string, scale = 1) {
  const event = Object.assign(new Event(type, { cancelable: true }), { scale, clientX: 180, clientY: 120 });
  target.dispatchEvent(event);
  return event;
}

describe('Safari map pinch lifecycle', () => {
  it('uses cumulative scales once, resets between gestures, and prevents browser zoom only on the map', () => {
    const target = new EventTarget();
    let width = 100;
    const points: number[][] = [];
    const binding = bindTrackpadPinch(target, (factor, x, y) => { width *= factor; points.push([x, y]); });
    expect(gesture(target, 'gesturestart').defaultPrevented).toBe(true);
    gesture(target, 'gesturechange', 1.25);
    gesture(target, 'gesturechange', 2);
    expect(width).toBeCloseTo(50); // not 100 / 1.25 / 2
    expect(points).toEqual([[180, 120], [180, 120]]);
    gesture(target, 'gestureend');
    expect(binding.active()).toBe(false);
    expect(gesture(target, 'gesturechange', 3).defaultPrevented).toBe(false);
    gesture(target, 'gesturestart');
    gesture(target, 'gesturechange', 0.5);
    expect(width).toBeCloseTo(100);
    binding.dispose();
    expect(gesture(target, 'gesturestart').defaultPrevented).toBe(false);
    gesture(target, 'gesturechange', 2);
    expect(width).toBeCloseTo(100);
  });

  it('ignores malformed samples without poisoning the next valid pinch', () => {
    const target = new EventTarget();
    let width = 100;
    const binding = bindTrackpadPinch(target, (factor) => { width *= factor; });
    gesture(target, 'gesturestart');
    for (const scale of [0, -1, NaN, Infinity]) gesture(target, 'gesturechange', scale);
    expect(width).toBe(100);
    gesture(target, 'gesturechange', 2);
    expect(width).toBe(50);
    binding.dispose();
  });
});
