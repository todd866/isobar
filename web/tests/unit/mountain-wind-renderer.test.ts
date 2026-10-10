import {describe,it,expect} from 'vitest';
import {createMountainWindRenderer} from '../../src/lib/mountain-wind-renderer';
import {globalEquirectangular,type Camera} from '../../src/lib/lambert';
import type {MountainStreamline} from '../../src/lib/mountain-streamlines';
const slice={lat:28,lon:87,bearingRadians:0,halfWidthM:5000,halfDepthM:1000,baseM:4000};
const camera:Camera={centerX:87,centerY:28,halfWidth:.1,halfHeight:.1,slice};
const path={phase:0,points:[-.02,0,.02].map(lon=>({lat:28,lon:87+lon,heightM:9000,speedMs:20,w:1,cloudDensity:0}))} as MountainStreamline;
function context(){let strokes=0;return {ctx:{save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},stroke(){strokes++},createLinearGradient(){return{addColorStop(){}}}} as unknown as CanvasRenderingContext2D,strokes:()=>strokes};}
describe('sliced mountain wind',()=>{
 it('draws retained points and rejects paths outside the footprint',()=>{
  const draw=createMountainWindRenderer(),c=context();
  expect(draw(c.ctx,[path],globalEquirectangular(),camera,1000,600,1,false).flows).toBe(1);expect(c.strokes()).toBeGreaterThan(0);
  const outside={...path,points:path.points.map(p=>({...p,lat:29}))};
  expect(draw(c.ctx,[outside],globalEquirectangular(),camera,1000,600,1,false).flows).toBe(0);
 });
 it('invalidates projected paths when the slice changes without moving the camera',()=>{
  const draw=createMountainWindRenderer(),c=context();
  expect(draw(c.ctx,[path],globalEquirectangular(),camera,1000,600,1,false).flows).toBe(1);
  expect(draw(c.ctx,[path],globalEquirectangular(),{...camera,slice:{...slice,lat:30}},1000,600,1,false).flows).toBe(0);
 });
});

function draw(zoom:number,seconds:number){
 const segments:number[]=[],heads:number[]=[];let x=0,y=0;
 const ctx={save(){},restore(){},beginPath(){},stroke(){},
  moveTo(a:number,b:number){x=a;y=b;heads.push(a);},
  lineTo(a:number,b:number){segments.push(Math.hypot(a-x,b-y));},
  createLinearGradient(){return{addColorStop(){}};},
 } as unknown as CanvasRenderingContext2D;
 const points=Array.from({length:47},(_,i)=>({lat:0,lon:(i-23)*.001,heightM:6000,speedMs:15,w:1,cloudDensity:0}));
 const result=createMountainWindRenderer()(ctx,[{points,phase:.2}],globalEquirectangular(),{centerX:0,centerY:0,halfWidth:zoom,halfHeight:zoom},1280,720,seconds,false);
 return{segments,heads,result};
}
describe('mountain wind parcels',()=>{
 it('keeps visible trails short at overview and close zoom',()=>{
  for(const zoom of [.1,.025,.012]){
   const {segments,result}=draw(zoom,1);
   expect(result.flows).toBeGreaterThan(0);
   expect(Math.max(...segments)).toBeLessThanOrEqual(22.00001);
   expect(segments.reduce((a,b)=>a+b,0)).toBeLessThanOrEqual(66.00001);
  }
 });
 it('moves parcels downstream rather than leaving a static full path',()=>{
  expect(draw(.1,1).heads).not.toEqual(draw(.1,2).heads);
 });
});
