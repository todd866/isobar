import { describe, expect, it, vi } from 'vitest';
import { boxContains, tileCountForBox, tilesForBox, TILE_SIZE } from '../../src/lib/terrain/terrarium';
import { planTerrainMosaics } from '../../src/lib/terrain/terrain-plan';

const everest = { west: 81.7, east: 92.15, south: 22.75, north: 33.2 };
const focus = { west: 86.88, east: 86.98, south: 27.94, north: 28.05 };

describe('tilted terrain mosaic planning', () => {
  it('keeps a detailed Everest focus and a coarse horizon backdrop in bounds', () => {
    const plan = planTerrainMosaics(everest, focus, 900, 6_000_000);
    expect(plan.far).toBeDefined();
    expect(boxContains(plan.box, focus)).toBe(true);
    expect(boxContains(plan.far!.box, everest)).toBe(true);
    expect(plan.width * plan.height).toBeLessThanOrEqual(6_000_000);
    expect(plan.far!.width * plan.far!.height).toBeLessThanOrEqual(512_000);
    expect(plan.far!.z).toBeLessThanOrEqual(Math.max(0, plan.z - 3));
    expect((TILE_SIZE * 2 ** plan.far!.z) / 360).toBeGreaterThanOrEqual(plan.far!.width / (plan.far!.box.east - plan.far!.box.west));
    expect(tilesForBox(plan.box, plan.z).length).toBeLessThanOrEqual(40);
    expect(tilesForBox(plan.far!.box, plan.far!.z).length).toBeLessThanOrEqual(16);
  });

  it('holds the phone budget while keeping both view bounds', () => {
    const plan = planTerrainMosaics(everest, focus, 900, 1_500_000);
    expect(boxContains(plan.box, focus)).toBe(true);
    expect(boxContains(plan.far!.box, everest)).toBe(true);
    expect(plan.width * plan.height + plan.far!.width * plan.far!.height).toBeLessThanOrEqual(1_500_000);
  });

  it('wraps both near and far boxes across the dateline', () => {
    const view = { west: 178.8, east: 181.2, south: 27, north: 29 };
    const near = { west: 179.7, east: 180.3, south: 27.7, north: 28.3 };
    const plan = planTerrainMosaics(view, near, 300, 6_000_000);
    expect(boxContains(plan.box, near)).toBe(true);
    expect(boxContains(plan.far!.box, view)).toBe(true);
    expect(plan.box.west).toBeLessThan(180);
    expect(plan.box.east).toBeGreaterThan(180);
    expect(tilesForBox(plan.far!.box, plan.far!.z).every(tile => tile.x >= 0 && tile.x < 2 ** plan.far!.z)).toBe(true);
  });

  it('preserves ordinary 2D planning when there is no near view', () => {
    const plan = planTerrainMosaics(everest, null, 225, 6_000_000);
    expect(plan.far).toBeUndefined();
    expect(boxContains(plan.box, everest)).toBe(true);
  });
});


import {mosaicElevation} from '../../src/lib/terrain/elevation';
import {toHalf} from '../../src/lib/terrain/terrarium';
it('keeps missing terrain missing and blends measured near/far edges',()=>{
 const far={box:{west:-2,east:2,south:-2,north:2},width:2,height:2,z:1,covered:4,data:new Uint16Array(Array(4).fill([toHalf(4000),toHalf(1)]).flat())};
 const near={...far,box:{west:-1,east:1,south:-1,north:1},data:new Uint16Array(Array(4).fill([toHalf(6000),toHalf(1)]).flat()),far};
 const sample=mosaicElevation(near);
 expect(sample(0,0)).toBe(6000);expect(sample(1,0)).toBe(4000);expect(sample(1.5,0)).toBe(4000);expect(sample(3,0)).toBeNull();
 expect(mosaicElevation({...near,data:new Uint16Array(8)})(0,0)).toBe(4000);
 expect(mosaicElevation({...near,data:new Uint16Array(8),far:null})(0,0)).toBeNull();
});

it('chooses a far zoom without enumerating rejected tile candidates', async () => {
  const tiles = await import('../../src/lib/terrain/terrarium');
  const enumerate = vi.spyOn(tiles, 'tilesForBox');
  try {
    const plan = planTerrainMosaics(everest, { west: 86.92, east: 86.93, south: 27.98, north: 28 }, 200_000, 6_000_000);
    expect(plan.far).toBeDefined();
    expect(enumerate).not.toHaveBeenCalled();
  } finally { enumerate.mockRestore(); }
});

it('counts exactly the enumerated tiles across wrapping, poles and tile boundaries', () => {
  for (const box of [
    { west: -180, east: 180, south: -90, north: 90 },
    { west: 179, east: 181, south: -85.0511, north: 85.0511 },
    { west: -540, east: 540, south: -20, north: 20 },
    { west: -90, east: 0, south: 0, north: 45 },
    { west: 0, east: 0, south: 0, north: 0 },
    focus, everest,
  ]) for (let z = 0; z <= 5; z += 1) {
    expect(tileCountForBox(box, z)).toBe(tilesForBox(box, z).length);
  }
  expect(tileCountForBox(focus, 13)).toBe(tilesForBox(focus, 13).length);
});
