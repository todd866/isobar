import { createTiltCamera, forwardProject, inverseUnproject, inverseAtAltitude, EARTH_RADIUS_M, type TiltCamera } from './tilt-camera';
import { mapUnproject, mapProject, project, unproject, type Camera, type Lambert } from './lambert';
import { clampToData, zoomWithinData, type DataFrame } from './camera';

export type TiltedCamera = Camera & { tiltCamera?: TiltCamera };
export const MAX_TILT = 75 * Math.PI / 180;
export function withTilt(geo: Lambert, camera: Camera, pitch: number, elevation?: ((lon: number, lat: number) => number | null) | null, terrainTarget = false): TiltedCamera {
  if ((pitch <= 0 && !camera.bearingRadians) || geo.projection !== 'equirectangular') return camera;
  const center = unproject(geo, camera.centerX, camera.centerY);
  if (!center) return camera;
  let tiltCamera = createTiltCamera({ ...center, halfHeightDeg: camera.halfHeight, aspect: camera.halfWidth / camera.halfHeight, tiltRadians: pitch, bearingRadians: camera.bearingRadians ?? 0, targetElevationM: terrainTarget ? Math.max(0,elevation?.(center.lon,center.lat) ?? 0) : 0 });
  // Keep the eye above the terrain underneath it, not just above the focus.
  // Limited iterations and existing DEM samples keep gestures synchronous.
  if (terrainTarget && elevation) for (let i=0;i<3;i++) {
    const eye=terrainEye(tiltCamera), ground=elevation(eye.lon,eye.lat);
    if(ground==null||eye.heightM>=ground+100)break;
    tiltCamera=createTiltCamera({...tiltCamera,targetElevationM:(tiltCamera.targetElevationM??0)+ground+100-eye.heightM});
  }
  return { ...camera, pitch, tiltCamera, surface: {
    project(lat, lon, height) { return forwardProject(tiltCamera, lat, lon, height ?? elevation?.(lon, lat) ?? 0) ?? { x: Infinity, y: Infinity, visible: false, depth: Infinity }; },
    projectAboveGround(lat, lon, height) {
      const ground = elevation?.(lon, lat) ?? 0;
      return forwardProject(tiltCamera, lat, lon, ground + Math.max(0, height)) ?? { x: Infinity, y: Infinity, visible: false, depth: Infinity };
    },
    unproject(x, y) {
      let hit = inverseUnproject(tiltCamera, x, y);
      for (let i = 0; i < 4 && hit && elevation; i++) {
        const h = elevation(hit.lon, hit.lat);
        if (h == null) break;
        hit = inverseAtAltitude(tiltCamera, x, y, Math.max(0, h)) ?? hit;
      }
      return hit;
    },
  } };
}

/** Translate the focus plane, not a near-horizon ray. Use the drag-start camera
 * and total displacement: terrain picking cannot change gain during a drag. */
export function panTilt(geo: Lambert, camera: Camera, pitch: number, dx: number, dy: number, frame: DataFrame): Camera {
  if (![dx, dy, pitch].every(Number.isFinite)) return camera;
  const bearing = camera.bearingRadians ?? 0;
  const right = dx * camera.halfWidth;
  const forward = dy * camera.halfHeight / Math.max(Math.cos(MAX_TILT), Math.cos(pitch));
  const east = right * Math.cos(bearing) + forward * Math.sin(bearing);
  const north = -right * Math.sin(bearing) + forward * Math.cos(bearing);
  // The spherical longitude metric vanishes at the poles; bound navigation gain.
  const t = Math.max(0, Math.min(1, pitch / (20 * Math.PI / 180)));
  const curvature = t * t * (3 - 2 * t);
  const longitudeScale = Math.max(.15, Math.cos(curvature * camera.centerY * Math.PI / 180));
  return clampToData(geo, { ...camera, centerX: camera.centerX - east / longitudeScale,
    centerY: camera.centerY - north }, frame);
}

/** Solve the geographic pointer anchor after zoom/pan. A ray over space cannot pan Earth. */
export function anchorTilt(geo: Lambert, camera: Camera, pitch: number, point: {lat: number; lon: number}, x: number, y: number, frame: DataFrame, elevation?: ((lon: number, lat: number) => number | null) | null, terrainTarget = false): Camera {
  let next = camera;
  for (let i = 0; i < 8; i++) {
    const hit = mapUnproject(geo, withTilt(geo, next, pitch, elevation, terrainTarget), x, y);
    if (!hit) break;
    const dLon = ((point.lon - hit.lon + 540) % 360) - 180;
    const lat = Math.max(-89.99, Math.min(89.99, next.centerY + point.lat - hit.lat));
    const p = project(geo, lat, geo.lon0 + next.centerX / geo.F + dLon);
    if (!p) break;
    next = clampToData(geo, { ...next, centerX: p.x, centerY: p.y }, frame);
    if (Math.abs(point.lat - hit.lat) + Math.abs(dLon) < 1e-7) break;
  }
  return next;
}
export function zoomTilt(geo: Lambert, camera: Camera, pitch: number, x: number, y: number, factor: number, frame: DataFrame, elevation?: ((lon: number, lat: number) => number | null) | null, terrainTarget = false): Camera {
  if (!pitch && !camera.bearingRadians) return zoomWithinData(geo, camera, x, y, factor, frame);
  const point = mapUnproject(geo, withTilt(geo, camera, pitch, elevation, terrainTarget), x, y);
  const next = zoomWithinData(geo, camera, 0, 0, factor, frame);
  return point ? anchorTilt(geo, next, pitch, point, x, y, frame, elevation, terrainTarget) : next;
}

/** Frame a useful atmospheric depth while keeping global overviews recognisable. */
export function atmosphereFramingGain(halfHeight: number): number {
  return 1 + (Math.min(8, Math.max(1, halfHeight / .12)) - 1) / (1 + (halfHeight / 6) ** 2);
}
export class TiltFraming {
  private base = 0;
  private last = 0;
  private gain = 1;
  synchronize(camera: Camera, pitch: number): void {
    if(!this.base)this.gain=atmosphereFramingGain(camera.halfHeight);
    this.base=camera.halfHeight*(1+(this.gain-1)*Math.sin(pitch)**2);
    this.last=camera.halfHeight;
  }
  apply(camera: Camera, previousPitch: number, pitch: number): Camera {
    if (!this.base || previousPitch === 0) {
      this.base = camera.halfHeight;
      this.gain = atmosphereFramingGain(this.base);
    } else if (this.last && Math.abs(camera.halfHeight - this.last) > 1e-10) {
      // Pinch remains independent: reversing tilt keeps the user's zoom change.
      this.base *= camera.halfHeight / this.last;
    }
    const scale = 1 + (this.gain - 1) * Math.sin(pitch) ** 2;
    const halfHeight = this.base / scale;
    this.last = halfHeight;
    return {...camera, halfHeight, halfWidth: camera.halfWidth * halfHeight / camera.halfHeight};
  }
}

/** Geographic point directly beneath the eye and its physical shell altitude. */
export function terrainEye(camera:TiltCamera):{lat:number;lon:number;heightM:number} {
  const [x,y,z]=camera.geometry.cameraPositionM,k=camera.geometry.curvature;
  if(k<.001)return {lat:camera.lat+y/EARTH_RADIUS_M*180/Math.PI,lon:camera.lon+x/EARTH_RADIUS_M*180/Math.PI,heightM:z};
  const radius=EARTH_RADIUS_M/k, length=Math.hypot(x,y,radius+z), p0=k*camera.lat*Math.PI/180;
  const nx=x/length,ny=y/length,nz=(radius+z)/length;
  const lat=Math.asin(Math.max(-1,Math.min(1,ny*Math.cos(p0)+nz*Math.sin(p0))))/k*180/Math.PI;
  const lon=camera.lon+Math.atan2(nx,nz*Math.cos(p0)-ny*Math.sin(p0))/k*180/Math.PI;
  return {lat,lon:((lon+180)%360+360)%360-180,heightM:length-radius};
}

/** Reversible close-approach pitch assistance; manual tilt remains an offset. */
export function mountainApproachPitch(halfHeight:number):number {
  const t=Math.max(0,Math.min(1,Math.log(.3/Math.max(.00001,halfHeight))/Math.log(150)));
  return (25*Math.PI/180)*t*t*(3-2*t);
}
export function zoomMountain(geo:Lambert,camera:Camera,pitch:number,x:number,y:number,factor:number,frame:DataFrame,elevation?:((lon:number,lat:number)=>number|null)|null,pin?:{lat:number;lon:number}):{camera:Camera;pitch:number} {
  const next=zoomTilt(geo,camera,pitch,x,y,factor,frame,elevation,true);
  const focus=pin??mapUnproject(geo,withTilt(geo,camera,pitch,elevation,true),x,y);
  if(!pitch||!focus||!elevation||geo.projection!=='equirectangular'||(elevation(focus.lon,focus.lat)??0)<500)return {camera:next,pitch};
  const assisted=Math.max(.02,Math.min(MAX_TILT,pitch+mountainApproachPitch(next.halfHeight)-mountainApproachPitch(camera.halfHeight)));
  return {camera:pin?frameTerrainPin(geo,next,assisted,pin,x,y,frame,elevation):anchorTilt(geo,next,assisted,focus,x,y,frame,elevation,true),pitch:assisted};
}

/** Solve a known pin by forward projection, avoiding approximate DEM ray inversion. */
export function frameTerrainPin(geo:Lambert,camera:Camera,pitch:number,pin:{lat:number;lon:number},x:number,y:number,frame:DataFrame,elevation?:((lon:number,lat:number)=>number|null)|null):Camera {
  if(!pitch&&!camera.bearingRadians)return anchorTilt(geo,camera,pitch,pin,x,y,frame,elevation,true);
  let next=camera;
  const screen=(c:Camera)=>mapProject(geo,withTilt(geo,c,pitch,elevation,true),pin.lat,pin.lon);
  for(let i=0;i<16;i++){
    const p=screen(next);if(!p)break;const ex=x-p.x,ey=y-p.y;if(Math.hypot(ex,ey)<1e-5)break;
    const d=Math.max(1e-7,next.halfHeight*.002),px=screen({...next,centerX:next.centerX+d}),py=screen({...next,centerY:next.centerY+d});if(!px||!py)break;
    const a=(px.x-p.x)/d,b=(py.x-p.x)/d,c=(px.y-p.y)/d,e=(py.y-p.y)/d,det=a*e-b*c;if(Math.abs(det)<1e-10)break;
    const dx=(ex*e-b*ey)/det,dy=(a*ey-ex*c)/det;
    // DEM slopes and eye clearance make this nonlinear. Backtrack rather
    // than oscillating across a ridge when a full Newton step overshoots.
    const sx=Math.max(-next.halfWidth*.5,Math.min(next.halfWidth*.5,dx)),sy=Math.max(-next.halfHeight*.5,Math.min(next.halfHeight*.5,dy));
    let accepted=false;
    for(let scale=1;scale>=1/32;scale/=2){
      const candidate=clampToData(geo,{...next,centerX:next.centerX+sx*scale,centerY:next.centerY+sy*scale},frame),q=screen(candidate);
      if(q&&Math.hypot(x-q.x,y-q.y)<Math.hypot(ex,ey)){next=candidate;accepted=true;break;}
    }
    if(!accepted)break;
  }
  return next;
}


/** Raise the eye vertically while retaining the ground focus and horizontal stand-off. */
export function liftCamera(camera: Camera, pitch: number, metres: number): {camera: Camera; pitch: number} {
  if (!Number.isFinite(metres)) return {camera,pitch};
  const rad=Math.PI/180, k=(p:number)=>{const t=Math.min(1,Math.max(0,p/(20*rad)));return t*t*(3-2*t);};
  const distance=camera.halfHeight*rad*EARTH_RADIUS_M/(Math.tan(25*rad)*Math.max(.001,k(pitch)));
  const horizontal=Math.sin(pitch)*distance;
  const vertical=Math.max(100,horizontal/Math.tan(MAX_TILT),Math.cos(pitch)*distance+metres);
  const nextPitch=Math.atan2(horizontal,vertical), nextDistance=Math.hypot(horizontal,vertical);
  const halfHeight=nextDistance*Math.tan(25*rad)*Math.max(.001,k(nextPitch))/EARTH_RADIUS_M/rad;
  return {camera:{...camera,halfHeight,halfWidth:camera.halfWidth*halfHeight/camera.halfHeight},pitch:nextPitch};
}
