import { mapProject, type Camera, type Lambert } from './lambert';
import type { ElevationAt } from './map-generalise';
import type { DrawnLabel, LabelBox } from './overlay';
import { EVEREST_ROUTE } from './everest';
import reconstructed from './terrain/everest-route.json';

/** Camps share the map's label reservations, including peaks and controls. */
export function drawEverestRoute(ctx:CanvasRenderingContext2D,geo:Lambert,camera:Camera,elevation:ElevationAt|null,width:number,height:number,avoid:LabelBox[],ink:{ink:string;halo:string}):DrawnLabel[] {
  if(camera.halfHeight>.3)return [];
  const points=EVEREST_ROUTE.map(p=>{
    const projected=mapProject(geo,camera,p.lat,p.lon,(elevation?.(p.lon,p.lat)??p.heightM)+40);
    return projected?{...p,x:(projected.x+1)*width/2,y:(1-projected.y)*height/2}:null;
  });
  const labels:DrawnLabel[]=[],taken=avoid.slice();
  ctx.save();ctx.strokeStyle='#df9138';ctx.lineWidth=2;ctx.setLineDash([4,4]);ctx.beginPath();
  let connected=false;
  // Prepared DEM-guided geometry is shared by all viewers; never solve a route
  // during animation. Break the path where the 3D surface occludes it.
  for(const p of reconstructed.points){
    const q=mapProject(geo,camera,p.lat,p.lon,(elevation?.(p.lon,p.lat)??p.elevation_m)+8);
    if(!q){connected=false;continue;}
    const x=(q.x+1)*width/2,y=(1-q.y)*height/2;
    if(connected)ctx.lineTo(x,y);else ctx.moveTo(x,y);connected=true;
  }
  ctx.stroke();ctx.setLineDash([]);ctx.font='600 12px ui-sans-serif, system-ui, sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';ctx.lineJoin='round';
  // Major anchors first. Intermediate camps appear only once the view has room.
  for(const i of camera.halfHeight>.09?[0,3]:[0,3,4,2,1]){
    const p=points[i];if(!p||p.x<4||p.x>width-4||p.y<4||p.y>height-4)continue;
    ctx.fillStyle='#df9138';ctx.beginPath();ctx.arc(p.x,p.y,3,0,Math.PI*2);ctx.fill();
    const w=ctx.measureText(p.name).width,h=16;
    const candidates=[{x:p.x+8,y:p.y-h/2},{x:p.x-w-8,y:p.y-h/2},{x:p.x-w/2,y:p.y-h-9},{x:p.x-w/2,y:p.y+9}];
    const label=candidates.map(p=>({...p,w,h})).find(b=>b.x>=6&&b.y>=6&&b.x+w<=width-6&&b.y+h<=height-6&&!taken.some(a=>b.x-4<a.x+a.w&&a.x<b.x+w+4&&b.y-3<a.y+a.h&&a.y<b.y+h+3));
    if(!label)continue;
    const box={...label,text:p.name};labels.push(box);taken.push(box);
    ctx.lineWidth=3.5;ctx.strokeStyle=ink.halo;ctx.strokeText(p.name,label.x,label.y+h/2);ctx.fillStyle=ink.ink;ctx.fillText(p.name,label.x,label.y+h/2);
  }
  ctx.restore();return labels;
}
