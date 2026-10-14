import {slicePoint} from '../../src/lib/atmosphere-slice';
import {describe,it,expect} from 'vitest';
import {globalEquirectangular} from '../../src/lib/lambert';
import {withTilt,zoomTilt,terrainEye} from '../../src/lib/tilt-navigation';
import {viewGeoBox} from '../../src/lib/terrain/terrain-layer';
import {inverseUnproject,visibleTerrainBounds} from '../../src/lib/tilt-camera';
import {frameData} from '../../src/lib/camera';
const geo=globalEquirectangular();
describe('high mountain camera and terrain coverage',()=>{
  it('requests a bounded slab across the dateline at every bearing',()=>{
    for(const lon of [179.999,-179.999,86.9])for(const bearingRadians of [0,.7,Math.PI/2,Math.PI]){
      const slice={lat:28,lon,bearingRadians,halfWidthM:10000,halfDepthM:1600,baseM:0};
      const camera={centerX:lon,centerY:28,halfHeight:.1,halfWidth:.2,slice};
      const box=viewGeoBox(geo,camera)!;
      expect(box.east-box.west).toBeGreaterThan(0);expect(box.east-box.west).toBeLessThan(1);
      for(const x of [-1,0,1])for(const y of [-1,0,1]){
        const p=slicePoint(slice,x*slice.halfWidthM,y*slice.halfDepthM)!;
        const unwrapped=lon+((p.lon-lon+540)%360-180);
        expect(unwrapped).toBeGreaterThanOrEqual(box.west-1e-9);expect(unwrapped).toBeLessThanOrEqual(box.east+1e-9);
        expect(p.lat).toBeGreaterThanOrEqual(box.south-1e-9);expect(p.lat).toBeLessThanOrEqual(box.north+1e-9);
      }
    }
  });
  it('coarse coverage includes the visible mountain footprint and GPU sea-level seed rays',()=>{
    for(const aspect of [.5,2.5,5])for(const halfHeight of [.1,.04,.0075]){
      const camera=withTilt(geo,{centerX:86.925,centerY:27.9881,halfHeight,halfWidth:halfHeight*aspect},Math.PI/4,()=>8500,true);
      const box=visibleTerrainBounds(camera.tiltCamera!)!;
      expect(camera.tiltCamera!.geometry.cameraPositionM[2]).toBeGreaterThan(8500);
      for(const x of [-1,0,1])for(const y of [-1,0,1])for(const p of [camera.surface!.unproject(x,y),inverseUnproject(camera.tiltCamera!,x,y)]){
        expect(p).not.toBeNull();expect(p!.lat).toBeGreaterThanOrEqual(box.south-1e-9);expect(p!.lat).toBeLessThanOrEqual(box.north+1e-9);expect(p!.lon).toBeGreaterThanOrEqual(box.west-1e-9);expect(p!.lon).toBeLessThanOrEqual(box.east+1e-9);
      }
    }
  });
  it('raises the eye over a wall behind a low focus',()=>{
    const dem=(lon:number,lat:number)=>lat<27.987?9000:6000;
    const c=withTilt(geo,{centerX:86.925,centerY:27.9881,halfHeight:.002,halfWidth:.004},1.2,dem,true).tiltCamera!;
    const eye=terrainEye(c);expect(eye.heightM-dem(eye.lon,eye.lat)).toBeGreaterThanOrEqual(99.9);
  });
  it('preserves the mountain pinch anchor and removes tilt when returning to 2D',()=>{
    const cam={centerX:86.925,centerY:27.9881,halfHeight:.04,halfWidth:.1};
    const frame=frameData(geo,1200,600,{west:-180,east:180,south:-90,north:90},{lat:27.9881,lon:86.925});
    const before=withTilt(geo,cam,.7,()=>8500,true).surface!.unproject(.2,-.15)!;
    const next=zoomTilt(geo,cam,.7,.2,-.15,.6,frame,()=>8500,true);
    const after=withTilt(geo,next,.7,()=>8500,true).surface!.unproject(.2,-.15)!;
    expect(after.lat).toBeCloseTo(before.lat,5);expect(after.lon).toBeCloseTo(before.lon,5);
    expect(withTilt(geo,next,0,()=>8500,true)).toBe(next);
  });
});

it('tilted coverage reaches the capped visible horizon instead of the last edge ray',()=>{
 const camera=withTilt(geo,{centerX:86.925,centerY:27.9881,halfHeight:.1,halfWidth:.25},1.3,()=>6000,true);
 const box=viewGeoBox(geo,camera)!;
 expect(box.north).toBeGreaterThanOrEqual(camera.centerY+1.49);
 expect(box.south).toBeLessThanOrEqual(camera.centerY-1.49);
 expect(box.east-box.west).toBeLessThanOrEqual(3.001);
});

it('keeps tilted horizon bounds continuous across the dateline',()=>{
 for(const lon of [179.99,-179.99])for(const bearingRadians of [0,1.5,3,4.5]){
  const camera=withTilt(geo,{centerX:lon,centerY:-43,halfHeight:.1,halfWidth:.25,bearingRadians},1.3,()=>3000,true);
  const box=viewGeoBox(geo,camera)!;
  expect(box.west).toBeLessThan(lon);expect(box.east).toBeGreaterThan(lon);
  expect(box.east-box.west).toBeLessThanOrEqual(3.001);
 }
});
