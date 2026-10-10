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
   let shown=false;
   for(let i=1;i<path.points.length;i++){
    const a=path.points[i-1],b=path.points[i];if(!a.visible||!b.visible)continue;
    const cloud=(a.source.cloudDensity+b.source.cloudDensity)/2;
    ctx.globalAlpha=.6*(1-.55*cloud)*Math.min(a.weight,b.weight);ctx.strokeStyle=colour((a.source.w+b.source.w)/2,dark);ctx.lineWidth=1.45;
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();shown=true;
   }
   if(!shown||path.duration<=0)continue;flows++;heights.add(Math.round(path.points[0].source.heightM/1000));
   // Three arrowheads travel downstream at one consistent illustrative rate.
   for(let particle=0;particle<3;particle++){
    const t=((seconds*16/path.duration+path.phase+particle/3)%1)*path.duration;
    const index=path.points.findIndex(p=>p.time>=t);if(index<1)continue;
    const a=path.points[index-1],b=path.points[index];if(!a.visible||!b.visible)continue;
    const mix=(t-a.time)/Math.max(.001,b.time-a.time),x=a.x+(b.x-a.x)*mix,y=a.y+(b.y-a.y)*mix,angle=Math.atan2(b.y-a.y,b.x-a.x);
    ctx.globalAlpha=.95*(1-.65*b.source.cloudDensity)*b.weight;ctx.strokeStyle=colour(b.source.w,dark);ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(x-5*Math.cos(angle-.55),y-5*Math.sin(angle-.55));ctx.lineTo(x,y);ctx.lineTo(x-5*Math.cos(angle+.55),y-5*Math.sin(angle+.55));ctx.stroke();
   }
  }ctx.restore();return{flows,layers:heights.size};
 };
}
