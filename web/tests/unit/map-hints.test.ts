import { describe, expect, it } from 'vitest';
import {
  HINT_KEY, currentHint, dismissHint, emptyHints, hintCopy, readHintState, writeHintState,
} from '../../src/lib/map-hints';

function memory() {
  const bag = new Map<string, string>();
  return {
    getItem: (key: string) => bag.get(key) ?? null,
    setItem: (key: string, value: string) => { bag.set(key, value); },
  };
}

describe('map hints', () => {
  it('shows one hint at a time, in order, and ignores a later action', () => {
    let state = emptyHints();
    expect(currentHint(state)).toBe('point');
    expect(hintCopy('point', false)).toBe('Tap the map for the air above a point');
    state = dismissHint(state, 'lens');
    expect(currentHint(state)).toBe('point');
    state = dismissHint(state, 'point');
    expect(currentHint(state)).toBe('gesture');
    expect(hintCopy('gesture', true)).toContain('pinch to zoom');
    expect(hintCopy('gesture', false)).toContain('two fingers to tilt');
    state = dismissHint(state, 'gesture');
    expect(currentHint(state)).toBe('lens');
    expect(hintCopy('lens', false)).toBe('Pick a lens below for rain, wind, temp or flying');
    state = dismissHint(state, 'lens');
    expect(currentHint(state)).toBeNull();
  });

  it('stores a dismissal and treats a broken store as unseen', () => {
    const store = memory();
    writeHintState(store, { ...emptyHints(), point: true });
    expect(store.getItem(HINT_KEY)).toContain('"point":true');
    expect(readHintState(store).point).toBe(true);
    expect(readHintState(store).gesture).toBe(false);
    expect(readHintState({ getItem: () => '{' }).point).toBe(false);
    expect(readHintState({ getItem: () => { throw new Error('blocked'); } }).lens).toBe(false);
    expect(() => writeHintState({ setItem: () => { throw new Error('blocked'); } }, emptyHints())).not.toThrow();
  });
});
