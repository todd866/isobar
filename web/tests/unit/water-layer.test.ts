import {it,expect} from 'vitest';
import {reuseWaterRaster} from '../../src/lib/water-layer';
it('reuses water coverage only inside the padded region and matching detail',()=>{
 const box={west:110,east:112,south:-33,north:-31},view={west:110.2,east:111.8,south:-32.8,north:-31.2};
 expect(reuseWaterRaster(box,view,1,1)).toBe(true);
 expect(reuseWaterRaster(box,{...view,east:112.01},1,1)).toBe(false);
 expect(reuseWaterRaster(box,view,1,.79)).toBe(false);
 expect(reuseWaterRaster(box,view,1,1.26)).toBe(false);
 expect(reuseWaterRaster(null,view,1,1)).toBe(false);
});
