import { describe, expect, it } from 'vitest';
import { layoutAtmosphereHeightGuide, drawAtmosphereHeightGuide, atmosphereHeightGuideBoxes } from '../../src/lib/atmosphere-height-guide';
import { thinTiltedPlaces } from '../../src/lib/places';
import { globalEquirectangular, type Camera } from '../../src/lib/lambert';

describe('lateral label layout', () => {
  it('omits a packed ruler and suppresses SFC beside a summit', () => {
    const geo = globalEquirectangular();
    const camera = {
      centerX: 0, centerY: 0, halfWidth: 1, halfHeight: 1,
      surface: { project: (_lat: number, _lon: number, height = 0) => ({ x: 0, y: .65 - height / 10_000, visible: true, depth: 1000 }), unproject: () => null },
    } as Camera;
    const field = { kind: 'mountain-wave', lat: 0, lon: 0, groundM: 0 } as never;
    const layout = layoutAtmosphereHeightGuide(geo, camera, 200, 300, field, [{ x: 100, y: 52.5 }]);
    expect(layout).not.toBeNull();
    expect(layout!.labels.some(label => label.text === 'SFC')).toBe(false);
    const packedCamera = { ...camera, surface: { ...camera.surface!, project: (_lat: number, _lon: number, height = 0) => ({ x: 0, y: .65 - height / 100_000, visible: true, depth: 1000 }) } } as Camera;
    const packed = layoutAtmosphereHeightGuide(geo, packedCamera, 200, 300, field, [{ x: 0, y: 0 }]);
    expect(packed).toBeNull();
  });

  it('reserves the current ruler position after the camera moves before its canvas repaints', () => {
    const geo = globalEquirectangular();
    const makeCamera = (x: number): Camera => ({centerX: 0, centerY: 0, halfWidth: .3, halfHeight: .2,
      surface: {project: (_lat, _lon, height = 0) => ({x, y: .6 - height / 10000, visible: true, depth: 1000}), unproject: () => null}});
    const canvas = {};
    const ctx = new Proxy({canvas}, {get: (target, key) => key === 'canvas' ? target.canvas : () => {}}) as unknown as CanvasRenderingContext2D;
    const field = {kind: 'mountain-wave', lat: 0, lon: 0, groundM: 0} as never;
    drawAtmosphereHeightGuide(ctx, geo, makeCamera(0), 800, 500, field, false);
    const before = atmosphereHeightGuideBoxes(canvas, geo, makeCamera(0), 800, 500);
    const after = atmosphereHeightGuideBoxes(canvas, geo, makeCamera(.2), 800, 500);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].x - before[0].x).toBeCloseTo(80);
    expect(atmosphereHeightGuideBoxes(null, geo, makeCamera(0), 800, 500)).toEqual([]);
  });

  it('thins distant horizon places while retaining ranked near labels', () => {
    const places = [
      { name: 'Near', x: 20, y: 220, depth: 100 },
      { name: 'Horizon A', x: 20, y: 20, depth: 400 },
      { name: 'Horizon B', x: 80, y: 24, depth: 500 },
      { name: 'Horizon C', x: 140, y: 28, depth: 600 },
    ];
    const thin = thinTiltedPlaces(places, 300);
    expect(thin.map(place => place.name)).toContain('Near');
    expect(thin.length).toBeLessThan(places.length);
  });
});
