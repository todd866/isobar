/** Project cached physical streamlines through the shared terrain camera. */
import type {MountainStreamline,StreamlinePoint} from './mountain-streamlines';
import type {TiltedCamera} from './tilt-navigation';
import type {Camera,Lambert} from './lambert';
import {mapProject} from './lambert';
import { atmosphereSliceWeight } from './atmosphere-slice';
import { cachedAtmosphereSliceDepthGrid, sampleAtmosphereSliceDepth } from './atmosphere-slice-depth';
type ScreenPoint={x:number;y:number;time:number;visible:boolean;weight:number;source:StreamlinePoint};
type ScreenPath={points:ScreenPoint[];duration:number;phase:number};
const colour=(w:number,dark:boolean)=>w>.15?(dark?'#ffbd75':'#ad4e17'):w<-.15?(dark?'#83d9ff':'#126d9a'):(dark?'#d3e7f1':'#29536a');
export function createMountainWindRenderer(){
 let lastPaths:readonly MountainStreamline[]|null=null,lastKey='',projected:ScreenPath[]=[];
 return (ctx:CanvasRenderingContext2D,paths:readonly MountainStreamline[],geo:Lambert,camera:Camera,width:number,height:number,seconds:number,dark:boolean)=>{
  const slice=camera.slice;
  const sliceKey=slice?[slice.lat,slice.lon,slice.bearingRadians,slice.halfWidthM,slice.halfDepthM,slice.baseM]:[];
  const key=[camera.centerX,camera.centerY,camera.halfHeight,camera.halfWidth,camera.pitch,camera.bearingRadians,(camera as TiltedCamera).tiltCamera?.targetElevationM,width,height,...sliceKey].join(':');
  if(lastPaths!==paths||lastKey!==key){
   // Small shared-view depth grid, rebuilt only for a new camera or wind field.
   const depth=new Float32Array(32*24);depth.fill(Infinity);
   const sliceDepth=slice&&camera.surface?cachedAtmosphereSliceDepthGrid(camera,slice):null;
   if(sliceDepth)for(let y=0;y<24;y++)for(let x=0;x<32;x++)depth[y*32+x]=sampleAtmosphereSliceDepth(sliceDepth,2*(x+.5)/32-1,1-2*(y+.5)/24);
   else if(camera.surface)for(let y=0;y<24;y++)for(let x=0;x<32;x++){
     const hit=camera.surface.unproject((x+.5)/16-1,1-(y+.5)/12);
     const p=hit?camera.surface.project(hit.lat,hit.lon):null;
     if(p?.visible&&Number.isFinite(p.depth))depth[y*32+x]=p.depth;
   }
   projected=paths.map(path=>{
    let time=0;
    const points=path.points.map((p,i)=>{
     if(i){const previous=path.points[i-1];const distance=Math.hypot((p.lat-previous.lat)*111132,(p.lon-previous.lon)*111320*Math.cos(p.lat*Math.PI/180),p.heightM-previous.heightM);time+=distance/Math.max(.1,(p.speedMs+previous.speedMs)/2);}
     const screen=mapProject(geo,camera,p.lat,p.lon,p.heightM);
     const weight=atmosphereSliceWeight(slice,p.lat,p.lon);
     if(!screen)return{x:0,y:0,time,visible:false,weight,source:p};
     const x=(screen.x+1)*width/2,y=(1-screen.y)*height/2;
     const cellX=Math.max(0,Math.min(31,Math.floor(x/width*32))),cellY=Math.max(0,Math.min(23,Math.floor(y/height*24)));
     const groundDepth=depth[cellY*32+cellX];
     const pointDepth=camera.surface?.project(p.lat,p.lon,p.heightM).depth??0;
     return{x,y,time,source:p,weight,visible:x>=-20&&x<=width+20&&y>=-20&&y<=height+20&&pointDepth<=groundDepth+100};
    });return{points,duration:time,phase:path.phase};
   });lastPaths=paths;lastKey=key;
  }
  let flows=0;const heights=new Set<number>();ctx.save();ctx.lineCap='round';ctx.lineJoin='round';
  for(const path of projected){
   if(path.duration<=0)continue;
   let shown=false;
   // Keep the physical path, but reveal only small advecting parcels. A pixel
   // budget stops a close camera turning a short parcel into a screen-wide rod.
   for(let particle=0;particle<3;particle++){
    const t=((seconds*16/path.duration+path.phase+particle/3)%1)*path.duration;
    const index=path.points.findIndex(p=>p.time>=t);if(index<1)continue;
    const a=path.points[index-1],b=path.points[index];if(!a.visible||!b.visible||Math.min(a.weight,b.weight)<=0)continue;
    const mix=(t-a.time)/Math.max(.001,b.time-a.time);
    let x=a.x+(b.x-a.x)*mix,y=a.y+(b.y-a.y)*mix,left=22;
    // Fade at path boundaries; never draw a connection across the wrap.
    const fade=Math.min(1,t/Math.min(8,path.duration*.12),(path.duration-t)/Math.min(8,path.duration*.12));
    for(let j=index-1;j>=0&&left>0;j--){
     const end=path.points[j];if(!end.visible||end.weight<=0)break;
     const distance=Math.hypot(end.x-x,end.y-y);if(distance<.01)continue;
     const length=Math.min(left,distance),ratio=length/distance;
     const nx=x+(end.x-x)*ratio,ny=y+(end.y-y)*ratio;
     const gradient=ctx.createLinearGradient(x,y,nx,ny);
     const opacity=(remaining:number)=>.8*fade*(1-.65*b.source.cloudDensity)*Math.min(a.weight,b.weight,end.weight)*remaining/22;
     const tint=colour(b.source.w,dark);
     gradient.addColorStop(0,tint+Math.round(255*opacity(left)).toString(16).padStart(2,'0'));
     gradient.addColorStop(1,tint+Math.round(255*opacity(left-length)).toString(16).padStart(2,'0'));
     ctx.globalAlpha=1;ctx.strokeStyle=gradient;ctx.lineWidth=1.8;
     ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(nx,ny);ctx.stroke();
     shown=true;left-=length;x=nx;y=ny;
    }
   }
   if(shown){flows++;heights.add(Math.round(path.points[0].source.heightM/1000));}
  }ctx.restore();return{flows,layers:heights.size};
 };
}
