import {sampleTeachingAtmosphere,type TeachingAtmosphereContext} from './atmosphere-teaching';
import type {AtmosphereSlice} from './atmosphere-slice';
import type {MountainStreamline} from './mountain-streamlines';

/** Exact closed contours of the sea-breeze streamfunction. A few complete
 * circulation families show how the lower branch returns aloft; particles use
 * sampled physical speed rather than advancing uniformly around the loop. */
export function seaBreezeStreamlines(field:TeachingAtmosphereContext,terrain:(lon:number,lat:number)=>number|null,slice?:AtmosphereSlice):MountainStreamline[]{
  const paths:MountainStreamline[]=[];
  const centreY=slice?(slice.lat-field.lat)*111320:0;
  const gap=slice?Math.min(3000,slice.halfDepthM*.4):3000;
  for(const y of slice?[centreY]:[centreY-gap,centreY,centreY+gap]) for(const level of [.18,.42,.7]){
    const points=[];
    // Parametrise x smoothly; the two roots of sin²(pi*z/H) close the cell.
    const extent=6000*Math.sqrt(-Math.log(level));
    for(let i=0;i<=128;i++){
      const angle=2*Math.PI*i/128,x=-extent*Math.cos(angle);
      const sine=Math.sqrt(Math.min(1,level*Math.exp(x*x/36000000)));
      const lower=2500/Math.PI*Math.asin(sine);
      const z=i%64===0?1250:i<=64?lower:2500-lower;
      const lat=field.lat+y/111320,lon=field.lon+x/(111320*Math.max(.2,Math.cos(field.lat*Math.PI/180)));
      const heightM=field.groundM+z,ground=terrain(lon,lat);
      // Never bridge a terrain obstruction. Such a contour is omitted entirely.
      if(ground!=null&&heightM<ground+50){points.length=0;break;}
      const f=sampleTeachingAtmosphere(field,lat,lon,heightM);
      points.push({lat,lon,heightM,speedMs:Math.hypot(f.u,f.v,f.w),w:f.w,cloudDensity:f.density});
    }
    if(points.length)paths.push({points,phase:(paths.length*.381966)%1});
  }
  return paths;
}
