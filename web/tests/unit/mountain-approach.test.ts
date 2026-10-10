import {describe,it,expect} from 'vitest';
import {globalEquirectangular,mapUnproject,mapProject} from '../../src/lib/lambert';
import {frameData} from '../../src/lib/camera';
import {withTilt,zoomMountain,frameTerrainPin} from '../../src/lib/tilt-navigation';
import {terrainDetailDensity} from '../../src/lib/terrain/terrain-layer';
import {parseMapTransit} from '../../src/lib/map-transit';
const geo=globalEquirectangular(),cam={centerX:86.925,centerY:27.9881,halfHeight:.04,halfWidth:.1};
const frame=frameData(geo,1000,500,{west:-180,east:180,south:-90,north:90});
describe('shared mountain approach',()=>{
 it('adds pitch gradually, anchors the cursor and reverses its contribution',()=>{
  const dem=()=>8500,focus=mapUnproject(geo,withTilt(geo,cam,.7,dem,true),.2,-.1)!;
  const next=zoomMountain(geo,cam,.7,.2,-.1,.5,frame,dem);
  expect(next.pitch).toBeGreaterThan(.7);expect(next.pitch).toBeLessThan(.9);
  const after=mapUnproject(geo,withTilt(geo,next.camera,next.pitch,dem,true),.2,-.1)!;
  expect(after.lat).toBeCloseTo(focus.lat,5);expect(after.lon).toBeCloseTo(focus.lon,5);
  const back=zoomMountain(geo,next.camera,next.pitch,.2,-.1,2,frame,dem);
  expect(back.pitch).toBeCloseTo(.7,8);expect(back.camera.halfHeight).toBeCloseTo(cam.halfHeight,8);
  expect(back.camera.centerY).toBeCloseTo(cam.centerY,5);
 });
 it('holds a selected pin through close zoom and tilt on a steep slope',()=>{
  const dem=(lon:number,lat:number)=>8000+Math.max(-1500,Math.min(800,40000*(lat-cam.centerY)));
  const pin={lat:27.989,lon:86.927},anchor=mapProject(geo,withTilt(geo,cam,.7,dem,true),pin.lat,pin.lon)!;
  const next=zoomMountain(geo,cam,.7,anchor.x,anchor.y,.5,frame,dem,pin);
  for(const pitch of [next.pitch,1.05,.5]){
   const c=frameTerrainPin(geo,next.camera,pitch,pin,anchor.x,anchor.y,frame,dem);
   const p=mapProject(geo,withTilt(geo,c,pitch,dem,true),pin.lat,pin.lon)!;
   expect(p.x).toBeCloseTo(anchor.x,4);expect(p.y).toBeCloseTo(anchor.y,4);
  }
 });
 it('leaves 2D, low terrain and missing terrain pitch alone',()=>{
  for(const [pitch,dem] of [[0,()=>8500],[.7,()=>10],[.7,()=>null]] as const)expect(zoomMountain(geo,cam,pitch,0,0,.5,frame,dem).pitch).toBe(pitch);
 });
 it('prioritizes foreground detail within a bounded density multiplier',()=>{
  const tilted=withTilt(geo,cam,.7,()=>8500,true);
  const density=terrainDetailDensity(geo,tilted,1000,1200);
  expect(density).toBe(4000);expect(terrainDetailDensity(geo,cam,1000,1200)).toBe(1000);
 });
 it('accepts only fresh, matching, finite camera handoffs',()=>{
  const v={lat:28,lon:87,halfHeight:.01,pitch:.8,threeD:true,target:'/',savedAt:1000};
  expect(parseMapTransit(JSON.stringify(v),'/',1100)).toEqual(v);
  for(const value of [{...v,lat:100},{...v,halfHeight:0},{...v,savedAt:-400000}])expect(parseMapTransit(JSON.stringify(value),'/',1100)).toBeNull();
  expect(parseMapTransit(JSON.stringify(v),'/history',1100)).toBeNull();
 });
});
