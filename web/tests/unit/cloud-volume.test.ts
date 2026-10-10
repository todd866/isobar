import { describe, expect, it } from 'vitest';
import { cloudWorldBounds, cloudWorldPoint } from '../../src/lib/cloud-volume';
import { createTiltCamera, forwardProject } from '../../src/lib/tilt-camera';
import { buildCloudDensityTexture } from '../../src/lib/cloud-density';

describe('cloud volume camera alignment',()=>{
  it('matches terrain projection through orbit, pitch and altitude',()=>{
    for(const bearing of [0,Math.PI/2,Math.PI,5.4])for(const tilt of [.1,.5,1.25]){
      const camera=createTiltCamera({lat:27.98,lon:86.92,halfHeightDeg:.035,aspect:1.8,tiltRadians:tilt,bearingRadians:bearing,targetElevationM:6500});
      for(const height of [4000,8849,11500]){
        const world=cloudWorldPoint(camera,27.991,86.941,height);
        const relative=world.map((v,i)=>v-camera.geometry.cameraPositionM[i]);
        const dot=(axis:readonly number[])=>relative.reduce((sum,v,i)=>sum+v*axis[i],0);
        const depth=dot(camera.geometry.forward);
        const expected=forwardProject(camera,27.991,86.941,height)!;
        expect(depth).toBeCloseTo(expected.depth,5);
        expect(dot(camera.geometry.right)/(depth*camera.geometry.tangentHalfHeight*camera.aspect)).toBeCloseTo(expected.x,6);
        expect(dot(camera.geometry.up)/(depth*camera.geometry.tangentHalfHeight)).toBeCloseTo(expected.y,6);
      }
    }
  });
  it('bounds contain the density volume at different bearings',()=>{
    const data=buildCloudDensityTexture([],{bounds:{west:86.8,east:87,south:27.8,north:28.1,minHeight:0,maxHeight:13000},width:4,height:4,depth:4});
    const camera=createTiltCamera({lat:27.98,lon:86.92,halfHeightDeg:.05,aspect:1.8,tiltRadians:1,bearingRadians:2});
    const box=cloudWorldBounds(camera,data);
    for(let y=0;y<=10;y++)for(let x=0;x<=10;x++)for(const h of [0,13000]){
      const p=cloudWorldPoint(camera,27.8+y*.03,86.8+x*.02,h);
      p.forEach((v,i)=>{expect(v).toBeGreaterThanOrEqual(box.min[i]);expect(v).toBeLessThanOrEqual(box.max[i]);});
    }
  });
});
