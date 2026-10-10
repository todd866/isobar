import { describe, expect, it } from 'vitest';
import { enableOverlay, mapTimeState } from '../../src/lib/map-live';
describe('live map contract', () => {
  it('distinguishes live, projected and past timestamps', () => {
    expect(mapTimeState(0, 0)).toEqual({ live: true, label: 'NOW' });
    expect(mapTimeState(6 * 3600000, 0)).toEqual({ live: false, label: 'FORECAST +6 h' });
    expect(mapTimeState(0, 3600000).label).toBe('PAST −1 h');
    expect(mapTimeState(120000, 0).live).toBe(false);
  });
  it('a third optional overlay replaces oldest; repeated enable keeps ordering', () => {
    expect(enableOverlay(['tracks', 'section'], 'barbs')).toEqual({ overlays: ['section', 'barbs'], replaced: 'tracks' });
    expect(enableOverlay(['tracks', 'section'], 'tracks')).toEqual({ overlays: ['tracks', 'section'] });
  });
});
