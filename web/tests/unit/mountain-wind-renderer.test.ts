import {describe,it,expect} from 'vitest';
import {createMountainWindRenderer} from '../../src/lib/mountain-wind-renderer';
import {globalEquirectangular,type Camera} from '../../src/lib/lambert';
import type {MountainStreamline} from '../../src/lib/mountain-streamlines';
const slice={lat:28,lon:87,bearingRadians:0,halfWidthM:5000,halfDepthM:1000,baseM:4000};
const camera:Camera={centerX:87,centerY:28,halfWidth:.1,halfHeight:.1,slice};
const path={phase:0,points:[-.02,0,.02].map(lon=>({lat:28,lon:87+lon,heightM:9000,speedMs:20,w:1,cloudDensity:0}))} as MountainStreamline;
function context(){let strokes=0;return {ctx:{save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},stroke(){strokes++}} as unknown as CanvasRenderingContext2D,strokes:()=>strokes};}
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
