import {it,expect} from 'vitest';
import {atmosphereDisplayCamera,atmosphereDisplayHeight} from '../../src/lib/atmosphere-display';
import {withTilt,frameAtmosphere} from '../../src/lib/tilt-navigation';
import {globalEquirectangular,mapProject} from '../../src/lib/lambert';
import {cloudWorldBounds,cloudWorldPoint} from '../../src/lib/cloud-volume';
import {buildCloudDensityTexture} from '../../src/lib/cloud-density';
import type {TeachingAtmosphereContext} from '../../src/lib/atmosphere-teaching';
it('keeps sea-breeze wind, cloud bounds and height ruler on the same display projection',()=>{
 const field:TeachingAtmosphereContext={kind:'sea-breeze',lat:-31.95,lon:115.86,groundM:20,timeMs:0},geo=globalEquirectangular();
 for(const aspect of [.55,1.8])for(const pitch of [.8,1.25]){
  const fitted=frameAtmosphere(geo,{centerX:field.lon,centerY:field.lat,halfHeight:.1,halfWidth:.1*aspect},pitch,7500,()=>20,8000);
  const real=withTilt(geo,fitted,pitch,()=>20,true),display=atmosphereDisplayCamera(real,field);
  expect(display.surface!.project(field.lat,field.lon)).toEqual(real.surface!.project(field.lat,field.lon));
  for(const height of [20,520,2520]){
   expect(mapProject(geo,display,field.lat,field.lon,height)).toEqual(mapProject(geo,real,field.lat,field.lon,20+(height-20)*3));
   expect(Math.abs(mapProject(geo,display,field.lat,field.lon,height)!.y)).toBeLessThan(.73);
  }
  const data=buildCloudDensityTexture([],{bounds:{west:115.84,east:115.88,south:-31.97,north:-31.93,minHeight:20,maxHeight:2720},width:4,height:4,depth:4});
  const bounds=cloudWorldBounds(real.tiltCamera!,data,display.atmosphereDisplay);
  const point=cloudWorldPoint(real.tiltCamera!,field.lat,field.lon,atmosphereDisplayHeight(2720,display.atmosphereDisplay));
  point.forEach((p,i)=>{expect(p).toBeGreaterThanOrEqual(bounds.min[i]);expect(p).toBeLessThanOrEqual(bounds.max[i]);});
  expect(data.bounds.maxHeight).toBe(2720);
  expect(atmosphereDisplayCamera(real,{...field,kind:'thunderstorm'})).toBe(real);
 }
});
