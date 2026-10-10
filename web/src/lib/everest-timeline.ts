/** Minute-resolution reconstruction, not minute-accurate historical tracking. */
import route from './terrain/everest-route.json';
import type {LoadedChart} from './chart-store';
import type {ElevationAt} from './map-generalise';
import {everestAtmosphere} from './everest';

export const EVEREST_TRACK_METHOD='everest-expedition-minute-v1';
export const EVEREST_CLOCK={offsetMinutes:330,kind:'assumed-expedition-clock',note:'Published expedition clock readings are placed on UTC+05:30 for playback; clock equivalence is an assumption.'} as const;
const local=(text:string)=>Date.parse(`${text}:00+05:30`);
const anchorIndex=(name:string)=>{
 const anchor=route.receipt.stage_anchors.find(a=>a.name===name)!;
 let best=0,distance=Infinity;
 route.points.forEach((p,i)=>{const d=(p.lat-anchor.lat)**2+(p.lon-anchor.lon)**2;if(d<distance){best=i;distance=d;}});
 return best;
};
const col=anchorIndex('South Col'),camp=anchorIndex('Camp IX'),south=anchorIndex('South Summit'),summit=route.points.length-1;
export const EVEREST_TRACK_START=Date.parse('1953-05-28T00:00:00Z');
export const EVEREST_TRACK_END=Date.parse('1953-05-30T00:00:00Z');
export interface ExpeditionAnchor {timeMs:number;routeIndex:number;name:string;timing:'reported'|'estimated';source:string|null;note?:string;}
const source='https://www.alpinejournal.org.uk/Contents/Contents_1954_files/AJ59%201954%20235-238%20Hillary%20Everest%20%284%29.pdf';
const hunt='https://www.alpinejournal.org.uk/Contents/Contents_1953_files/AJ59%201953%20107-122%20Hunt%20Westmacott%20%281%29%20Everest%20Narrative.pdf';
export const EVEREST_TRACK_ANCHORS:readonly ExpeditionAnchor[]=[
 {timeMs:EVEREST_TRACK_START,routeIndex:col,name:'South Col camp',timing:'estimated',source:null},
 {timeMs:local('1953-05-28T08:00'),routeIndex:col,name:'Leave South Col',timing:'estimated',source:null},
 {timeMs:local('1953-05-28T14:30'),routeIndex:camp,name:'Camp IX',timing:'reported',source},
 {timeMs:local('1953-05-29T06:30'),routeIndex:camp,name:'Leave Camp IX',timing:'reported',source,note:'Hillary says about06:30; Hunt says about06:00. Model uses Hillary.'},
 {timeMs:local('1953-05-29T09:00'),routeIndex:south,name:'South Summit',timing:'reported',source:hunt},
 {timeMs:local('1953-05-29T09:10'),routeIndex:south,name:'Resume climbing',timing:'estimated',source:null},
 {timeMs:local('1953-05-29T11:30'),routeIndex:summit,name:'Summit',timing:'reported',source:hunt},
 {timeMs:local('1953-05-29T11:45'),routeIndex:summit,name:'Leave summit',timing:'reported',source:hunt},
 {timeMs:local('1953-05-29T12:45'),routeIndex:south,name:'Return to South Summit',timing:'reported',source:hunt},
 {timeMs:local('1953-05-29T14:00'),routeIndex:camp,name:'Return to Camp IX',timing:'reported',source:hunt},
 {timeMs:local('1953-05-29T14:30'),routeIndex:camp,name:'Leave Camp IX',timing:'estimated',source:null},
 {timeMs:local('1953-05-29T15:45'),routeIndex:col,name:'South Col',timing:'estimated',source:hunt,note:'Reported before16:00;15:45 is the selected estimate.'},
 {timeMs:EVEREST_TRACK_END,routeIndex:col,name:'South Col camp',timing:'estimated',source:null},
];
const distance=(a:typeof route.points[number],b:typeof route.points[number])=>Math.hypot((a.lat-b.lat)*111132,(a.lon-b.lon)*111320*Math.cos(a.lat*Math.PI/180));
// Elevation corrections meet approximate camp/summit heights while retaining DEM shape.
const heights=[{index:col,height:7864},{index:camp,height:8504},{index:south,height:8750},{index:summit,height:8849}];
function heightAt(index:number){
 const point=route.points[index];let i=0;while(i<heights.length-2&&index>heights[i+1].index)i++;
 const a=heights[i],b=heights[i+1],t=Math.max(0,Math.min(1,(index-a.index)/(b.index-a.index)));
 return point.elevation_m+(a.height-route.points[a.index].elevation_m)*(1-t)+(b.height-route.points[b.index].elevation_m)*t;
}
const segments=EVEREST_TRACK_ANCHORS.slice(0,-1).map((a,i)=>{
 const b=EVEREST_TRACK_ANCHORS[i+1],direction=Math.sign(b.routeIndex-a.routeIndex);
 const indices=[a.routeIndex],costs=[0];
 if(direction)for(let index=a.routeIndex;index!==b.routeIndex;index+=direction){
  const next=index+direction,up=Math.max(0,heightAt(next)-heightAt(index)),down=Math.max(0,heightAt(index)-heightAt(next));
  // Steeper uphill terrain takes more of the fixed anchor-to-anchor time.
  costs.push(costs.at(-1)!+distance(route.points[index],route.points[next])+up*8+down*2);indices.push(next);
 }
 return{a,b,indices,costs,total:costs.at(-1)!};
});
export interface EverestTeamPosition {
 timeMs:number;lat:number;lon:number;heightM:number;terrainHeightM:number;routeIndex:number;
 phase:'climbing'|'descending'|'stopped';stage:string;nextAnchor:string;
 provenance:{kind:'synthetic';method:string;clock:typeof EVEREST_CLOCK;from:ExpeditionAnchor;to:ExpeditionAnchor};
}
/** Deterministic continuous interpolation; exported records sample this every minute. */
export function everestTeamPosition(timeMs:number):EverestTeamPosition|null{
 if(!Number.isFinite(timeMs)||timeMs<EVEREST_TRACK_START||timeMs>EVEREST_TRACK_END)return null;
 const segment=segments.find(s=>timeMs<s.b.timeMs)??segments.at(-1)!;
 const {a,b,indices,costs,total}=segment;
 const fraction=(timeMs-a.timeMs)/(b.timeMs-a.timeMs),target=Math.max(0,Math.min(1,fraction))*total;
 let step=0;while(step<costs.length-2&&costs[step+1]<target)step++;
 const first=indices[step],last=indices[Math.min(step+1,indices.length-1)];
 const mix=total?Math.max(0,Math.min(1,(target-costs[step])/Math.max(1e-9,(costs[step+1]??total)-costs[step]))):0;
 const p=route.points[first],q=route.points[last];
 return{timeMs,lat:p.lat+(q.lat-p.lat)*mix,lon:p.lon+(q.lon-p.lon)*mix,heightM:heightAt(first)+(heightAt(last)-heightAt(first))*mix,terrainHeightM:p.elevation_m+(q.elevation_m-p.elevation_m)*mix,routeIndex:first+(last-first)*mix,phase:a.routeIndex===b.routeIndex?'stopped':b.routeIndex>a.routeIndex?'climbing':'descending',stage:a.name,nextAnchor:b.name,provenance:{kind:'synthetic',method:EVEREST_TRACK_METHOD,clock:EVEREST_CLOCK,from:a,to:b}};
}
export function everestTeamWeather(chart:LoadedChart,position:EverestTeamPosition,elevation:ElevationAt|null){
 // Prepared route terrain keeps the estimate available before interactive DEM tiles arrive.
 const ground:ElevationAt=(lon,lat)=>elevation?.(lon,lat)??position.terrainHeightM;
 const terrain=ground(position.lon,position.lat)!;
 const start=Date.parse(chart.manifest.run)+chart.manifest.forecastHours[0]*3600000;
 const end=Date.parse(chart.manifest.run)+chart.manifest.forecastHours.at(-1)!*3600000;
 if(position.timeMs<start-3600000||position.timeMs>end+3600000)return null;
 const windTime=Math.max(start,Math.min(end,position.timeMs));
 const value=everestAtmosphere(chart,position.timeMs,ground,windTime).surface(position.lat,position.lon);
 if(!value)return null;
 return{temperatureC:value.temperature-.006*(position.heightM-terrain),windKt:Math.hypot(value.u,value.v)/.514444,windFromDeg:(Math.atan2(-value.u,-value.v)*180/Math.PI+360)%360,rhPct:value.rh,pressureHPa:1013.25*Math.exp(-position.heightM/8000),kind:'synthetic' as const,windTimeMs:windTime,temporalBasis:windTime===position.timeMs?'interpolated':'endpoint-held-under-1h',windReferenceM:2,terrainBasis:elevation?.(position.lon,position.lat)!=null?'interactive-dem':'prepared-route'};
}
export function buildEverestMinuteTrack(){
 const records:EverestTeamPosition[]=[];
 for(let time=EVEREST_TRACK_START;time<EVEREST_TRACK_END;time+=60000)records.push(everestTeamPosition(time)!);
 return records;
}
