import { mapProject, type Camera, type Lambert } from './lambert';
import type { TeachingAtmosphereContext } from './atmosphere-teaching';
import { slicePoint } from './atmosphere-slice';

/** A geographic altitude ruler shares true heights with wind and clouds. */
export function drawAtmosphereHeightGuide(ctx:CanvasRenderingContext2D,geo:Lambert,camera:Camera,width:number,height:number,field:TeachingAtmosphereContext,dark:boolean) {
  const anchor=camera.slice?slicePoint(camera.slice,-camera.slice.halfWidthM*.8,0):{lat:field.lat,lon:field.lon};
  if(!anchor)return;
  const levels=field.kind==='sea-breeze'?[0,500,1000,1500,2000,2500]:field.kind==='mountain-wave'?[0,2000,4000,6000,8000,10000,12000]:[0,2000,4000,6000,8000,10000];
  const points=levels.map(z=>{
    const p=mapProject(geo,camera,anchor.lat,anchor.lon,field.groundM+z);
    return p?{x:(p.x+1)*width/2,y:(1-p.y)*height/2,z}:null;
  }).filter((p):p is NonNullable<typeof p>=>p!=null&&p.x>42&&p.x<width-70&&p.y>48&&p.y<height-32);
  if(points.length<2)return;
  if(Math.hypot(points[0].x-points.at(-1)!.x,points[0].y-points.at(-1)!.y)<55)return;
  ctx.save();ctx.strokeStyle=dark?'#b7d3df':'#426b80';ctx.fillStyle=dark?'#d9e9ef':'#284f63';ctx.globalAlpha=.55;
  ctx.lineWidth=1;ctx.setLineDash([2,5]);ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);
  for(const p of points.slice(1))ctx.lineTo(p.x,p.y);ctx.stroke();ctx.setLineDash([]);
  ctx.font='11px system-ui, sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';
  let previous=-Infinity;
  for(const p of points){
    if(Math.abs(p.y-previous)<23)continue;previous=p.y;
    ctx.globalAlpha=.7;ctx.beginPath();ctx.moveTo(p.x-3,p.y);ctx.lineTo(p.x+5,p.y);ctx.stroke();
    const label=p.z===0?'SFC':`${Math.round((field.groundM+p.z)/.3048/100)/10}k ft`;
    ctx.lineWidth=3;ctx.strokeStyle=dark?'#142735':'#f1f6f8';ctx.strokeText(label,p.x+9,p.y);
    ctx.globalAlpha=.9;ctx.fillText(label,p.x+9,p.y);ctx.strokeStyle=dark?'#b7d3df':'#426b80';ctx.lineWidth=1;
  }
  ctx.restore();
}
