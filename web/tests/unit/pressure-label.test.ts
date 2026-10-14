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

it('finds a fast-moving level beyond the old five-degree worker neighbourhood',()=>{
 const sample=(lon:number,lat:number)=>1000+lon*.3+lat*.05;
 const p=pressureLabelPoint(0,0,1006,sample);
 expect(p).not.toBeNull();
 expect(sample(p!.lon,p!.lat)).toBeCloseTo(1006,3);
});

it('keeps a nonlinear search on its nearby branch and rejects a missing domain',()=>{
 const sample=(lon:number,lat:number)=>Math.abs(lon)>30||Math.abs(lat)>10?null:1000+lon*lon*.05;
 const p=pressureLabelPoint(2,0,1020,sample)!;
 expect(p.lon).toBeCloseTo(20,2);
 expect(Math.hypot(p.lon-2,p.lat)).toBeLessThanOrEqual(32);
 expect(pressureLabelPoint(2,0,1100,sample)).toBeNull();
});

it('preserves pressure edge endpoints and missing samples',()=>{
 const values=Float32Array.from([1000,1010,1002,1012,1004,1014,1006,1016]);
 const grid={nx:2,ny:2,west:0,north:1,step:1,wrapsLongitude:false};
 expect(pressureTextureSample(values,grid,0,1,0)).toBe(1006);
 expect(pressureTextureSample(values,grid,1,1,0)).toBe(1016);
 expect(pressureTextureSample(values,grid,.5,-.01,1)).toBeNull();
 values[0]=NaN;
 expect(pressureTextureSample(values,grid,.5,.5,.5)).toBeNull();
});
