import { afterEach, describe, expect, it, vi } from 'vitest';
import { globalEquirectangular } from '../../src/lib/lambert';
import { withTilt } from '../../src/lib/tilt-navigation';
import { createTerrainLayer } from '../../src/lib/terrain/terrain-layer';
import * as planning from '../../src/lib/terrain/terrain-plan';
import { MERCATOR_LIMIT } from '../../src/lib/terrain/terrarium';

const geo = globalEquirectangular();
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('terrain layer requests', () => {
  it.each([-31.95, 31.95])('keeps the pending mosaic when a horizon crosses DEM coverage at %s', lat => {
    const postMessage = vi.fn();
    let worker: { onmessage?: (event: { data: unknown }) => void };
    vi.stubGlobal('Worker', class {
      onmessage = undefined;
      postMessage = postMessage;
      terminate() {}
      constructor() { worker = this; }
    });
    const onMosaic = vi.fn();
    const layer = createTerrainLayer(onMosaic)!;
    const camera = withTilt(geo, { centerX: 115.86, centerY: lat, halfHeight: 12, halfWidth: 21.6 }, .9, () => 0, true);
    try {
      for (let i = 0; i < 3; i += 1) layer.update(geo, camera, 1280, 1);
      expect(postMessage).toHaveBeenCalledTimes(1);
      const { id, plan } = postMessage.mock.calls[0][0];
      for (const mosaic of [plan, plan.far]) {
        expect(mosaic.box.south).toBeGreaterThanOrEqual(-MERCATOR_LIMIT);
        expect(mosaic.box.north).toBeLessThanOrEqual(MERCATOR_LIMIT);
      }
      const reply = { type: 'mosaic', id, ...plan, covered: 10, data: new Uint16Array(0), tiles: { needed: 1, loaded: 1, missing: 0, cached: 0 } };
      worker!.onmessage!({ data: reply });
      expect(onMosaic).toHaveBeenCalledWith(reply);
      layer.update(geo, camera, 1280, 1);
      expect(layer.stats().mosaics).toBe(1);
      expect(postMessage).toHaveBeenCalledTimes(1);
    } finally { layer.destroy(); }
  });
});

it('reuses planning for identical inputs and replans when a footprint or budget changes', () => {
  vi.stubGlobal('Worker', class { postMessage() {} terminate() {} });
  const plan = vi.spyOn(planning, 'planTerrainMosaics');
  const layer = createTerrainLayer(() => {})!;
  const make = (lat = 27.9881, pitch = .06, height = 8500) => withTilt(geo,
    { centerX: 86.925, centerY: lat, halfHeight: .002, halfWidth: .0036 }, pitch, () => height, true);
  try {
    for (let i = 0; i < 3; i += 1) layer.update(geo, make(), 1280, 1);
    expect(plan).toHaveBeenCalledTimes(1);
    layer.update(geo, make(27.99), 1280, 1);
    layer.update(geo, make(27.99, .1), 1280, 1);
    layer.update(geo, make(27.99, .1, 8000), 1280, 1);
    layer.update(geo, make(27.99, .1, 8000), 640, 1);
    layer.update(geo, make(27.99, .1, 8000), 640, 2);
    expect(plan).toHaveBeenCalledTimes(6);
  } finally { layer.destroy(); }
});
