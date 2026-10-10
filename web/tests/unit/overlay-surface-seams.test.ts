import {describe,it,expect} from 'vitest';
import {globalEquirectangular} from '../../src/lib/lambert';
import {withTilt} from '../../src/lib/tilt-navigation';
import {projectedPaths,projectedStrokePaths} from '../../src/lib/overlay';
const geo=globalEquirectangular();
describe('surface projection seams',()=>{
 for(const pitch of [.001,.02,.15,1.3])for(const bearingRadians of [0,Math.PI/2,Math.PI]){
  it(`never joins a wrapped back seam at pitch ${pitch} bearing ${bearingRadians}`,()=>{
   const camera=withTilt(geo,{centerX:100,centerY:30,halfWidth:130,halfHeight:65,bearingRadians},pitch);
   // A short source segment at -80 degrees crosses the camera-relative seam.
   const lon=[-82,-81,-80,-79,-78],lat=[35,35,35,35,35];
   for(const project of [projectedPaths,projectedStrokePaths])for(const path of project(geo,camera,1400,700,lon,lat,false)){
    for(let i=1;i<path.points.length;i++){
     const a=path.points[i-1],b=path.points[i];if(a&&b)expect(Math.hypot(b.x-a.x,b.y-a.y)).toBeLessThan(350);
    }
   }
  });
 }
});
