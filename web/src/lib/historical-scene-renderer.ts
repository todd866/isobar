import { mapProject, type Camera, type Lambert } from './lambert';
import type { ElevationAt } from './map-generalise';
import type { DrawnLabel, LabelBox } from './overlay';
import { featurePosition, featureVisible, historyLayer, type HistoryLayer, type HistoricalScene } from './historical-scenes';

/** Reserve active vessels before pressure labels and peaks are placed. */
export function historicalShipBoxes(scene:HistoricalScene,geo:Lambert,camera:Camera,elevation:ElevationAt|null,width:number,height:number,time:number,enabled:Record<HistoryLayer,boolean>):LabelBox[]{
  if(!enabled.ships)return [];
  const zoom=Math.log2(360*height/(256*camera.halfHeight*2));
  return scene.features.flatMap(f=>{
    if(historyLayer(f)!=='ships'||!featureVisible(f,time,zoom))return [];
    const p=featurePosition(f,time);if(!p)return [];
    const q=mapProject(geo,camera,p[1],p[0],(elevation?.(p[0],p[1])??0)+12);if(!q)return [];
    const x=(q.x+1)*width/2,y=(1-q.y)*height/2;
    return x>=8&&y>=8&&x<=width-8&&y<=height-8?[{x:x-11,y:y-11,w:22,h:22}]:[];
  });
}

/** Scene geometry lives on the same camera and collision grid as weather and towns. */
export function drawHistoricalScene(ctx:CanvasRenderingContext2D,scene:HistoricalScene,geo:Lambert,camera:Camera,elevation:ElevationAt|null,width:number,height:number,time:number,enabled:Record<HistoryLayer,boolean>,avoid:LabelBox[],ink:{ink:string;halo:string}):{labels:DrawnLabel[];markers:LabelBox[]}{
  const zoom=Math.log2(360*height/(256*camera.halfHeight*2));
  const labels:DrawnLabel[]=[],markers:LabelBox[]=[],taken=avoid.slice();
  const project=(p:number[])=>{const q=mapProject(geo,camera,p[1],p[0],(elevation?.(p[0],p[1])??0)+12);return q?{x:(q.x+1)*width/2,y:(1-q.y)*height/2}:null;};
  const intersects=(b:LabelBox)=>taken.some(a=>b.x-4<a.x+a.w&&a.x<b.x+b.w+4&&b.y-3<a.y+a.h&&a.y<b.y+b.h+3);
  ctx.save();ctx.font='600 12px ui-sans-serif, system-ui, sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';ctx.lineJoin='round';
  const priority=(f:typeof scene.features[number])=>f.geometry.type!=='Point'?-1:historyLayer(f)==='ships'?0:1;
  for(const f of [...scene.features].sort((a,b)=>priority(a)-priority(b))){
    const layer=historyLayer(f);
    if(!enabled[layer]||!featureVisible(f,time,zoom))continue;
    // Country names give way to the operational view as the user approaches Normandy.
    if(f.kind==='political-area'&&zoom>7)continue;
    const color=layer==='ships'?'#267aaf':f.kind==='military-unit'?'#a54b43':layer==='political'?ink.ink:'#9a6918';
    if(f.geometry.type==='LineString'||f.geometry.type==='MultiLineString'){
      ctx.strokeStyle=layer==='political'?ink.ink:color;ctx.globalAlpha=.6;ctx.lineWidth=layer==='routes'?1.8:1.2;ctx.setLineDash([5,4]);ctx.beginPath();let connected=false;
      for(const line of (f.geometry.type==='MultiLineString'?f.geometry.coordinates:[f.geometry.coordinates]) as number[][][]){connected=false;for(const p of line){const q=project(p);if(!q){connected=false;continue;}if(connected)ctx.lineTo(q.x,q.y);else ctx.moveTo(q.x,q.y);connected=true;}}
      ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;continue;
    }
    const pos=featurePosition(f,time),p=pos?project(pos):null;
    if(!p||p.x<8||p.y<8||p.x>width-8||p.y>height-8)continue;
    const marker={x:p.x-7,y:p.y-7,w:14,h:14};
    if(intersects(marker))continue;
    ctx.strokeStyle=ink.halo;ctx.fillStyle=color;ctx.lineWidth=3;
    ctx.beginPath();
    if(layer==='ships'){ctx.moveTo(p.x,p.y-7);ctx.lineTo(p.x+4,p.y+5);ctx.lineTo(p.x-4,p.y+5);ctx.closePath();}
    else if(f.kind==='military-unit'){ctx.rect(p.x-6,p.y-4,12,8);}
    else if(f.kind==='airborne-drop-zone'){ctx.moveTo(p.x,p.y-5);ctx.lineTo(p.x+5,p.y);ctx.lineTo(p.x,p.y+5);ctx.lineTo(p.x-5,p.y);ctx.closePath();}
    else if(layer!=='political'){ctx.arc(p.x,p.y,4,0,Math.PI*2);}
    ctx.stroke();ctx.fill();
    if(f.kind==='military-unit'){ctx.strokeStyle=ink.halo;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(p.x-4,p.y-3);ctx.lineTo(p.x+4,p.y+3);ctx.moveTo(p.x-4,p.y+3);ctx.lineTo(p.x+4,p.y-3);ctx.stroke();}
    const text=f.label??(layer==='political'?f.title:f.title.replace('German ','').replace('Infantry Division','Inf.').replace('Panzer Division','Panzer').split(' · ')[0]);
    const w=ctx.measureText(text).width,h=17;
    const candidates=[{x:p.x+10,y:p.y-h/2},{x:p.x-w-10,y:p.y-h/2},{x:p.x-w/2,y:p.y-h-10},{x:p.x-w/2,y:p.y+10}];
    const box=candidates.map(b=>({...b,w,h})).find(b=>b.x>=6&&b.y>=6&&b.x+w<=width-6&&b.y+h<=height-6&&!intersects(b));
    taken.push(marker);markers.push(marker);
    if(!box)continue;
    ctx.lineWidth=3.5;ctx.strokeStyle=ink.halo;ctx.strokeText(text,box.x,box.y+h/2);ctx.fillStyle=ink.ink;ctx.fillText(text,box.x,box.y+h/2);labels.push({...box,text});taken.push(box);
  }
  ctx.restore();return {labels,markers};
}
