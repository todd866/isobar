import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPressureLabelLayer } from '../../src/lib/pressure-label-layer';
import { globalEquirectangular } from '../../src/lib/lambert';
import { AUS_UNITS } from '../../src/lib/units';

const geo = globalEquirectangular(0, 0);
const camera = { centerX: 0, centerY: 0, halfWidth: 20, halfHeight: 10 };
const ctx = {
  setTransform: vi.fn(), clearRect: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(),
  beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
} as any;

function box(lon = 0) {
  return { x: 378 + lon * 20, y: 192, w: 44, h: 16, text: '1000' };
}

describe('pressure label placement retention', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retains an unmatched candidate for two refreshes, then lets it fade', () => {
    const canvas: any = { dataset: {}, style: {}, setAttribute: vi.fn(), width: 0, height: 0, getContext: () => ctx };
    vi.stubGlobal('document', { createElement: () => canvas });
    const layer = createPressureLabelLayer({ after: vi.fn() } as any);
    const draw = () => layer.draw(geo, camera, 800, 400, 1, undefined, 1, false, AUS_UNITS, [], true);

    layer.place([box()], [1000], geo, camera, 800, 400, AUS_UNITS);
    draw();
    expect(layer.labels()).toHaveLength(1);
    const firstAlpha = layer.labels()[0].alpha;

    layer.place([], [1000], geo, camera, 800, 400, AUS_UNITS);
    draw();
    expect(layer.labels()).toHaveLength(1);
    const secondAlpha = layer.labels()[0].alpha;
    layer.place([], [1000], geo, camera, 800, 400, AUS_UNITS);
    draw();
    expect(layer.labels()).toHaveLength(1);
    expect(secondAlpha).toBeGreaterThan(firstAlpha);
    const heldAlpha = layer.labels()[0].alpha;

    layer.place([], [1000], geo, camera, 800, 400, AUS_UNITS);
    draw();
    // The third refresh removes the candidate from placement; the animation
    // state then begins its normal fade from the last retained position.
    expect(layer.labels()).toHaveLength(1);
    expect(layer.labels()[0].alpha).toBeLessThan(heldAlpha);
  });

  it('uses a nearby replacement without duplicating the retained label', () => {
    const canvas: any = { dataset: {}, style: {}, setAttribute: vi.fn(), width: 0, height: 0, getContext: () => ctx };
    vi.stubGlobal('document', { createElement: () => canvas });
    const layer = createPressureLabelLayer({ after: vi.fn() } as any);
    const draw = () => layer.draw(geo, camera, 800, 400, 1, undefined, 1, false, AUS_UNITS, [], true);

    layer.place([box()], [1000], geo, camera, 800, 400, AUS_UNITS);
    draw();
    layer.place([box(0.2)], [1000], geo, camera, 800, 400, AUS_UNITS);
    draw();
    expect(layer.labels()).toHaveLength(1);
  });
});
