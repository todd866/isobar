import raw from '../../../tools/history/katrina-marine-sources.json';
import {mapProject,type Camera,type Lambert} from './lambert';
import type {DrawnLabel,LabelBox} from './overlay';
export type MarineMode='off'|'waves'|'surge';
export interface MarineObservation {time:string;wave_height_m:number|null;dominant_period_s?:number|null}
export interface MarineStation {id:string;name:string;lat:number;lon:number;source_url?:string;position_valid_until?:string;observations:MarineObservation[]}
export interface SurgeMark {id:string;name:string;lat:number;lon:number;value_m:number;datum:string;kind:string;source_url:string;label?:string}
export interface HistoricalSatellite {date:string;url:string;bounds:{west:number;east:number;south:number;north:number};label:string;source_url:string;time_basis:string}
export interface MarineData {stations:MarineStation[];surge:SurgeMark[];satellites:HistoricalSatellite[]}
const source=raw as unknown as Partial<MarineData>&{station?:Omit<MarineStation,'observations'>;observations?:MarineObservation[]};
export const KATRINA_MARINE:MarineData={stations:source.stations??(source.station?[{...source.station,observations:source.observations??[]}]:[]),surge:source.surge??[],satellites:source.satellites??[]};
export function marineForEvent(event:string|undefined){return event==='katrina-2005'?KATRINA_MARINE:null;}
export function marineObservation(station:MarineStation,time:number):MarineObservation|null{
 if(!Number.isFinite(time)||(station.position_valid_until&&time>=Date.parse(station.position_valid_until)))return null;
 const closest=station.observations.reduce<MarineObservation|null>((best,o)=>!best||Math.abs(Date.parse(o.time)-time)<Math.abs(Date.parse(best.time)-time)?o:best,null);
 return closest&&Math.abs(Date.parse(closest.time)-time)<=45*60000?closest:null;
}
export function satelliteForDate(data:MarineData|null,time:number){return Number.isFinite(time)?data?.satellites.find(p=>p.date===new Date(time).toISOString().slice(0,10))??null:null;}
/** Measured points, never a flood extent or interpolated offshore observation. */
export function drawHistoricalMarine(ctx:CanvasRenderingContext2D,data:MarineData,mode:MarineMode,time:number,geo:Lambert,camera:Camera,width:number,height:number,avoid:LabelBox[],dark:boolean):DrawnLabel[]{
 if(mode==='surge'&&time<Date.parse('2005-08-29'))return [];
 if(mode==='off'||time<Date.parse('2005-08-28')||time>=Date.parse('2005-08-30'))return [];
 const values=mode==='waves'?data.stations.flatMap(s=>{const o=marineObservation(s,time);return o?.wave_height_m!=null&&Number.isFinite(o.wave_height_m)?[{lat:s.lat,lon:s.lon,text:`${s.id} · ${o.wave_height_m.toFixed(1)} m${o.dominant_period_s!=null?` · ${o.dominant_period_s.toFixed(0)} s`:''} · ${o.time.slice(11,16)}Z`}]:[]}):data.surge.map(s=>({lat:s.lat,lon:s.lon,text:`${s.label??s.name} · ${s.value_m.toFixed(1)} m`}));
 const labels:DrawnLabel[]=[],boxes=[...avoid];ctx.save();ctx.font='600 12px ui-sans-serif, system-ui, sans-serif';ctx.textBaseline='middle';ctx.textAlign='left';
 for(const value of values){const p=mapProject(geo,camera,value.lat,value.lon);if(!p)continue;const x=(p.x+1)*width/2,y=(1-p.y)*height/2,w=ctx.measureText(value.text).width;
  if(x<8||y<8||x>width-8||y>height-8)continue;
  const candidates=[{x:x+10,y:y-9,w,h:18},{x:x-w-10,y:y-9,w,h:18},{x:x-w/2,y:y-28,w,h:18}];
  const box=candidates.find(b=>b.x>=4&&b.x+b.w<=width-4&&b.y>=4&&b.y+b.h<=height-4&&!boxes.some(a=>b.x<a.x+a.w+4&&a.x<b.x+b.w+4&&b.y<a.y+a.h+3&&a.y<b.y+b.h+3));if(!box)continue;
  ctx.fillStyle=dark?'#82d4ed':'#00677e';ctx.strokeStyle=dark?'#142b38':'#fff';ctx.lineWidth=3;ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.stroke();ctx.fill();
  ctx.lineWidth=4;ctx.strokeText(value.text,box.x,box.y+9);ctx.fillText(value.text,box.x,box.y+9);labels.push({...box,text:value.text});boxes.push(box);
 }ctx.restore();return labels;
}
