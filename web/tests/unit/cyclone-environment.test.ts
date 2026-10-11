import {describe,expect,it} from 'vitest';
import {sampleMonotoneBicubic,type ScalarGrid} from '../../src/lib/cyclone-environment';

function grid(values:number[],nx:number,ny:number):ScalarGrid{
 return{values,nx,ny,west:-5,north:5,step:2.5,wrapsLongitude:false};
}

describe('historical cyclone environmental sampling',()=>{
 it('stays continuous across a coarse longitude cell boundary',()=>{
  const values=[] as number[];
  for(let y=0;y<6;y++)for(let x=0;x<6;x++)values.push(990+(x-2.2)**2*2+(y-2.1)**2);
  const field=grid(values,6,6);
  const boundary=-5+2*2.5;
  const eps=.00001;
  const left=sampleMonotoneBicubic(field,boundary-eps,0)!;
  const right=sampleMonotoneBicubic(field,boundary+eps,0)!;
  expect(Math.abs(left-right)).toBeLessThan(1e-3);
  const leftSlope=(left-sampleMonotoneBicubic(field,boundary-2*eps,0)!)/eps;
  const rightSlope=(sampleMonotoneBicubic(field,boundary+2*eps,0)!-right)/eps;
  expect(Math.abs(leftSlope-rightSlope)).toBeLessThan(.02);
 });

 it('never overshoots the surrounding source values',()=>{
  const values=[1000,1004,1008,1012,1001,1005,1009,1013,1002,1006,1010,1014,1003,1007,1011,1015];
  const value=sampleMonotoneBicubic(grid(values,4,4),-1.25,1.25)!;
  expect(value).toBeGreaterThanOrEqual(1000);
  expect(value).toBeLessThanOrEqual(1015);
 });

 it('wraps longitude without changing the seam value',()=>{
  const field={...grid(Array.from({length:24},(_,i)=>1000+i%6),6,4),wrapsLongitude:true};
  const west=sampleMonotoneBicubic(field,-5,1.25)!;
  const wrapped=sampleMonotoneBicubic(field,10,1.25)!;
  expect(wrapped).toBeCloseTo(west,8);
 });
});
