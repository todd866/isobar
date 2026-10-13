import {expect,it} from 'vitest';
import {pressureLabelPoint,pressureTextureSample} from '../../src/lib/pressure-label';
it('reattaches a stale label to the displayed pressure level',()=>{
 const sample=(lon:number,lat:number)=>1000+lon*2+lat*.5;
 const p=pressureLabelPoint(4,1,1012,sample)!;
 expect(p).not.toBeNull();expect(sample(p.lon,p.lat)).toBeCloseTo(1012,3);
 expect(pressureLabelPoint(4,1,1012,()=>1000)).toBeNull();
 expect(pressureLabelPoint(4,1,1012,()=>null)).toBeNull();
});
it('samples the same moving endpoint field across the dateline',()=>{
 const values=Float32Array.from([1000,1010,1002,1012,1004,1014,1006,1016,1000,1010,1002,1012,1004,1014,1006,1016]);
 const grid={nx:4,ny:2,west:-180,north:45,step:90,wrapsLongitude:true};
 expect(pressureTextureSample(values,grid,.5,135,0)).toBe(1008);
 expect(pressureTextureSample(values,grid,.5,-225,0)).toBe(1008);
 expect(pressureTextureSample(values,grid,.5,0,90)).toBeNull();
});
