import dday from '../../../tools/history/dday-scene.json';
import context from '../../../tools/history/dday-context.json';
export type HistoryLayer='political'|'military'|'ships';
export interface HistoryFeature {
 id:string;kind:string;title:string;geometry:{type:string;coordinates:unknown};
 date_validity:{date_start:string;date_end:string;time_basis:string};
 source_refs:string[];status:string;precision_m:number;detail_zoom:number;
 geometry_method:string;note?:string;
 track?:{time:string;coordinates:number[]}[];
}
export interface HistorySource {id:string;title:string;url:string}
export const DDAY_FEATURES=[...dday.features,...context.features] as HistoryFeature[];
export const DDAY_SOURCES=[...dday.provenance.sources,...context.provenance.sources] as HistorySource[];
export function historyLayer(f:HistoryFeature):HistoryLayer{
 return /ship|naval/.test(f.kind)?'ships':/political|occupation|border|country/.test(f.kind)?'political':'military';
}
export function featureVisible(f:HistoryFeature,time:number,zoom:number){
 if(!Number.isFinite(time))return false;
 const date=new Date(time).toISOString().slice(0,10);
 return date>=f.date_validity.date_start&&date<=f.date_validity.date_end&&zoom>=(f.detail_zoom??(historyLayer(f)==='political'?2:7));
}
/** Continuous synthetic vessel positions; no extrapolation outside the dated track. */
export function featurePosition(f:HistoryFeature,time:number):number[]|null{
 if(!f.track)return f.geometry.type==='Point'?f.geometry.coordinates as number[]:null;
 const track=f.track;
 if(!Number.isFinite(time)||track.length<2)return null;
 if(time<Date.parse(track[0].time)||time>Date.parse(track.at(-1)!.time))return null;
 const i=Math.max(1,track.findIndex(p=>Date.parse(p.time)>=time)),a=track[i-1],b=track[i];
 const t=(time-Date.parse(a.time))/(Date.parse(b.time)-Date.parse(a.time));
 return a.coordinates.map((n,j)=>n+(b.coordinates[j]-n)*t);
}
