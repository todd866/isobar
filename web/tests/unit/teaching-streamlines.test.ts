import {it,expect} from 'vitest';
import {seaBreezeStreamlines} from '../../src/lib/teaching-streamlines';
import {sampleTeachingAtmosphere} from '../../src/lib/atmosphere-teaching';
const field={kind:'sea-breeze' as const,lat:-31.95,lon:115.86,groundM:0,timeMs:Date.UTC(2026,0,15,6)};
it('closed teaching paths follow all four branches of the actual velocity field',()=>{
 const paths=seaBreezeStreamlines(field,()=>0);expect(paths).toHaveLength(9);
 for(const path of paths){
  const a=path.points[0],b=path.points.at(-1)!;
  expect(Math.hypot(a.lon-b.lon,a.lat-b.lat,a.heightM-b.heightM)).toBeLessThan(1e-8);
  let up=false,down=false,onshore=false,offshore=false;
  for(let i=1;i<path.points.length-1;i++){
   const p=path.points[i],prev=path.points[i-1],next=path.points[i+1];
   const f=sampleTeachingAtmosphere(field,p.lat,p.lon,p.heightM);
   const dx=(next.lon-prev.lon)*111320*Math.cos(field.lat*Math.PI/180),dz=next.heightM-prev.heightM;
   const dot=(dx*f.u+dz*f.w)/Math.hypot(dx,dz)/Math.hypot(f.u,f.w);
   expect(dot).toBeGreaterThan(.99);
   up ||= f.w>.1;down ||= f.w<-.1;onshore ||= f.u>1;offshore ||= f.u< -1;
  }
  expect([up,down,onshore,offshore]).toEqual([true,true,true,true]);
 }
});
it('does not connect a closed path through blocking terrain',()=>{
 expect(seaBreezeStreamlines(field,()=>3000)).toEqual([]);
});
