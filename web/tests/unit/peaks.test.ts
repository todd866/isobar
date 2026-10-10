import { describe, expect, it } from 'vitest';
import { globalEquirectangular } from '../../src/lib/lambert';
import { AUS_UNITS } from '../../src/lib/units';
import { DAY_PLACES } from '../../src/lib/places';
import {
  SUMMITS, drawPeaks, peakText, prominenceFloorM, selectPeaks, snapToSummit,
} from '../../src/lib/peaks';

const EIGHT = ['Everest', 'K2', 'Kangchenjunga', 'Lhotse', 'Makalu', 'Cho Oyu', 'Dhaulagiri', 'Manaslu', 'Nanga Parbat', 'Annapurna', 'Gasherbrum I', 'Broad Peak', 'Gasherbrum II', 'Shishapangma'];
const SEVEN = ['Everest', 'Aconcagua', 'Denali', 'Kilimanjaro', 'Elbrus', 'Vinson', 'Puncak Jaya', 'Mont Blanc', 'Kosciuszko'];

describe('summit labels', () => {
  it('lists the eight-thousanders, the Seven Summits and a surveyed elevation with a source', () => {
    for (const name of [...EIGHT, ...SEVEN, 'Aoraki']) {
      expect(SUMMITS.filter((peak) => peak.name === name)).toHaveLength(1);
    }
    expect(SUMMITS.filter((peak) => peak.elevationM >= 8000)).toHaveLength(14);
    const everest = SUMMITS.find((peak) => peak.name === 'Everest')!;
    expect(everest.elevationM).toBe(8849);
    expect(everest.lat).toBeCloseTo(27.99, 1);
    expect(everest.lon).toBeCloseTo(86.93, 1);
    expect(SUMMITS.find((peak) => peak.name === 'Aoraki')!.elevationM).toBe(3724);
    expect(SUMMITS.find((peak) => peak.name === 'Mont Blanc')!.elevationM).toBe(4808);
    for (const peak of SUMMITS) {
      expect(peak.source.length).toBeGreaterThan(3);
      expect(peak.prominenceM).toBeGreaterThan(0);
      expect(peak.prominenceM).toBeLessThanOrEqual(peak.elevationM + 1);
      expect(peak.lat).toBeGreaterThanOrEqual(-90);
      expect(peak.lat).toBeLessThanOrEqual(90);
    }
    expect(peakText(everest, { ...AUS_UNITS, height: 'm' })).toBe('Everest 8,849 m');
    expect(peakText(everest, AUS_UNITS)).toBe('Everest 29,032 ft');
  });

  it('ranks by prominence so a world view keeps Everest and K2 and a close view adds Lhotse', () => {
    expect(prominenceFloorM(320)).toBeGreaterThanOrEqual(4000);
    const world = selectPeaks(SUMMITS, 320);
    expect(world.map((peak) => peak.name)).toContain('Everest');
    expect(world.map((peak) => peak.name)).toContain('K2');
    expect(world.map((peak) => peak.name)).not.toContain('Lhotse');
    expect(world.map((peak) => peak.name)).not.toContain('Kosciuszko');
    expect(world[0].prominenceM).toBeGreaterThanOrEqual(world[1].prominenceM);
    const regional = selectPeaks(SUMMITS, 15);
    expect(regional.map((peak) => peak.name)).toContain('Kosciuszko');
    expect(regional.map((peak) => peak.name)).not.toContain('Lhotse');
    expect(selectPeaks(SUMMITS, 3).map((peak) => peak.name)).toContain('Lhotse');
  });

  it('drops an overlapping lesser summit and snaps a nearby tap to the one that was drawn', () => {
    // The summit sits near the top of a narrow map, so the only free label
    // pocket is below the mark. The lesser name collides with it and is left out.
    const geo = globalEquirectangular(87, 28);
    const camera = { centerX: 0, centerY: 23.92, halfWidth: 4, halfHeight: 6 };
    const texts: string[] = [];
    const ctx = {
      font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: 'round', textAlign: 'left' as CanvasTextAlign, textBaseline: 'middle' as CanvasTextBaseline,
      save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, fill() {}, stroke() {},
      measureText() { return { width: 50 }; },
      fillText(text: string) { texts.push(text); },
      strokeText() {},
    };
    const twins = [
      { name: 'High', lat: 28, lon: 87, elevationM: 8000, prominenceM: 8000, source: 'test survey' },
      { name: 'Low', lat: 28, lon: 87, elevationM: 7000, prominenceM: 7000, source: 'test survey' },
    ];
    const drawn = drawPeaks(ctx as unknown as CanvasRenderingContext2D, twins, geo, camera, 70, 100, [], DAY_PLACES, { ...AUS_UNITS, height: 'm' });
    expect(drawn.names).toEqual(['High 8,000 m']);
    expect(texts).toContain('High 8,000 m');
    expect(texts).not.toContain('Low 7,000 m');
    const blocked = drawPeaks(ctx as unknown as CanvasRenderingContext2D, twins, geo, camera, 800, 500, [{ x: 0, y: 0, w: 800, h: 500 }], DAY_PLACES, AUS_UNITS);
    expect(blocked.placed).toEqual([]);
    expect(snapToSummit(drawn.placed[0].x + 10, drawn.placed[0].y, drawn.placed)?.name).toBe('High');
    expect(snapToSummit(drawn.placed[0].x + 40, drawn.placed[0].y, drawn.placed)).toBeNull();
    expect(snapToSummit(drawn.placed[0].label.x + 4, drawn.placed[0].label.y + 4, drawn.placed)?.name).toBe('High');
  });
});
