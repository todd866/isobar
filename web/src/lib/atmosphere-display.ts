import type {TiltedCamera} from './tilt-navigation';
import type {TeachingAtmosphereContext} from './atmosphere-teaching';
/** A shallow circulation needs visible depth. One display transform is shared
 * by wind, cloud and the labelled ruler; sampling remains in physical metres. */
export function atmosphereDisplayHeight(height:number,display?:{baseM:number;scale:number}):number {
  return display?display.baseM+(height-display.baseM)*display.scale:height;
}
export function atmosphereDisplayCamera(camera:TiltedCamera,field?:TeachingAtmosphereContext):TiltedCamera {
  if(field?.kind!=='sea-breeze'||!camera.surface)return camera;
  const surface=camera.surface,display={baseM:field.groundM,scale:3};
  return {...camera,atmosphereDisplay:display,surface:{...surface,
    project(lat,lon,height){return surface.project(lat,lon,height==null?height:atmosphereDisplayHeight(height,display));},
    projectAboveGround:surface.projectAboveGround?((lat,lon,height)=>surface.projectAboveGround!(lat,lon,height*display.scale)):undefined,
  }};
}
