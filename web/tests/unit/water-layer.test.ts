import {afterEach, beforeEach, describe, it, expect, vi} from 'vitest';
import {createWaterUploadScheduler, reuseWaterRaster, WATER_UPLOAD_SETTLE_MS} from '../../src/lib/water-layer';

describe('water upload scheduling',()=>{
 beforeEach(()=>vi.useFakeTimers());
 afterEach(()=>vi.useRealTimers());
 it('coalesces zoom updates until the gesture settles',()=>{
  const publish=vi.fn(), scheduler=createWaterUploadScheduler(publish);
  scheduler.schedule(true);
  scheduler.schedule();
  vi.advanceTimersByTime(WATER_UPLOAD_SETTLE_MS-1);
  scheduler.defer(); // Zoom can continue within the existing raster margin.
  expect(publish).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(WATER_UPLOAD_SETTLE_MS-1);
  expect(publish).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(publish).toHaveBeenCalledTimes(2);
 });
 it('cancels a pending upload when the layer is destroyed',()=>{
  const publish=vi.fn(), scheduler=createWaterUploadScheduler(publish);
  scheduler.schedule(); scheduler.cancel();
  vi.advanceTimersByTime(WATER_UPLOAD_SETTLE_MS);
  expect(publish).not.toHaveBeenCalled();
 });
});

it('reuses water coverage only inside the padded region and matching detail',()=>{
 const box={west:110,east:112,south:-33,north:-31},view={west:110.2,east:111.8,south:-32.8,north:-31.2};
 expect(reuseWaterRaster(box,view,1,1)).toBe(true);
 expect(reuseWaterRaster(box,{...view,east:112.01},1,1)).toBe(false);
 expect(reuseWaterRaster(box,view,1,.79)).toBe(false);
 expect(reuseWaterRaster(box,view,1,1.26)).toBe(false);
 expect(reuseWaterRaster(null,view,1,1)).toBe(false);
});

import {waterViewBox} from '../../src/lib/water-layer';
import {globalEquirectangular} from '../../src/lib/lambert';
import {withTilt} from '../../src/lib/tilt-navigation';
it('keeps tilted lake raster detail around the focus at every bearing',()=>{
 const geo=globalEquirectangular();
 for(const bearingRadians of [0,1.5,3]){
  const camera=withTilt(geo,{centerX:170.14,centerY:-43.6,halfWidth:.24,halfHeight:.13,bearingRadians},1.3,()=>3700,true);
  const box=waterViewBox(geo,camera)!;
  expect(box.east-box.west).toBeLessThanOrEqual(.96+1e-8);
  expect(box.north-box.south).toBeLessThanOrEqual(.96+1e-8);
  expect(box.west).toBeLessThan(170.14);expect(box.east).toBeGreaterThan(170.14);
 }
});
