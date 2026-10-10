/** Local synthetic vortex, conditioned on a best track; never changes archived grids. */
export interface CycloneFix {time:string;lat:number;lon:number;windKt:number;pressureHpa:number}
export interface CycloneProfile {exponent:number;blendStartKm:number;blendEndKm:number}
export interface HistoricalCyclone {method:'compact-vortex-v1';rmwKm:number;profile?:CycloneProfile;track:CycloneFix[];source:string}
export interface CycloneState extends CycloneFix {rmwKm:number;profile?:CycloneProfile}
export const DEFAULT_CYCLONE_PROFILE:CycloneProfile={exponent:2,blendStartKm:70,blendEndKm:120};
export function cycloneProfile(s:CycloneState){return s.profile??DEFAULT_CYCLONE_PROFILE;}
const smooth=(a:number,b:number,x:number)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
export function validateCyclone(raw:unknown):HistoricalCyclone|undefined{
 if(raw==null)return undefined;
 const c=raw as HistoricalCyclone;
 if(c.method!=='compact-vortex-v1'||!Number.isFinite(c.rmwKm)||c.rmwKm<5||c.rmwKm>(c.profile?100:30)||typeof c.source!=='string'||!Array.isArray(c.track)||c.track.length<2||c.track.length>100)throw Error('Invalid historical cyclone');
 if(c.profile!==undefined){const p=c.profile;if(!p||typeof p!=='object'||![p.exponent,p.blendStartKm,p.blendEndKm].every(Number.isFinite)||p.exponent<1||p.exponent>3||p.blendStartKm<c.rmwKm||p.blendEndKm<=p.blendStartKm||p.blendEndKm>1000)throw Error('Invalid cyclone profile');}
 c.track.forEach((f,i)=>{if(!Number.isFinite(Date.parse(f.time))||(i&&Date.parse(f.time)<=Date.parse(c.track[i-1].time))||!Number.isFinite(f.lat)||Math.abs(f.lat)>60||!Number.isFinite(f.lon)||Math.abs(f.lon)>180||!Number.isFinite(f.windKt)||f.windKt<0||f.windKt>180||!Number.isFinite(f.pressureHpa)||f.pressureHpa<870||f.pressureHpa>1030)throw Error('Invalid cyclone fix');});
 return c;
}
export function cycloneAt(c:HistoricalCyclone|undefined,time:number):CycloneState|null{
 if(!c||!Number.isFinite(time)||time<Date.parse(c.track[0].time)||time>Date.parse(c.track.at(-1)!.time))return null;
 const i=Math.max(1,c.track.findIndex(f=>Date.parse(f.time)>=time)),a=c.track[i-1],b=c.track[i];
 const t=(time-Date.parse(a.time))/(Date.parse(b.time)-Date.parse(a.time));
 const lerp=(x:number,y:number)=>x+(y-x)*t;
 return{time:new Date(time).toISOString(),lat:lerp(a.lat,b.lat),lon:lerp(a.lon,b.lon),windKt:lerp(a.windKt,b.windKt),pressureHpa:lerp(a.pressureHpa,b.pressureHpa),rmwKm:c.rmwKm,profile:c.profile};
}
export function cycloneShape(s:CycloneState,lon:number,lat:number){
 const x=(lon-s.lon)*111.32*Math.cos(s.lat*Math.PI/180),y=(lat-s.lat)*111.132,r=Math.hypot(x,y);
 const profile=cycloneProfile(s),q=(s.rmwKm/Math.max(.01,r))**profile.exponent;
 return{x,y,r,weight:1-smooth(profile.blendStartKm,profile.blendEndKm,r),pressureFraction:Math.exp(-q),speed:s.windKt*Math.sqrt(q*Math.exp(1-q))};
}
export function cycloneScalar(s:CycloneState|null,lon:number,lat:number,background:number|null,field:string):number|null{
 if(!s||background==null||!['mslp','wind'].includes(field))return background;
 const p=cycloneShape(s,lon,lat);
 const value=field==='wind'?p.speed:s.pressureHpa+(background-s.pressureHpa)*p.pressureFraction;
 return background+(value-background)*p.weight;
}
export function cycloneWind(s:CycloneState|null,lon:number,lat:number,bg:{u:number;v:number}|null){
 if(!s||!bg)return bg;
 const p=cycloneShape(s,lon,lat);if(!p.weight)return bg;
 // Hemisphere-dependent circulation, with an assumed 15-degree surface inflow.
 const sign=s.lat<0?1:-1,r=Math.max(.0001,p.r),inflow=Math.sin(Math.PI/12),tangent=Math.cos(Math.PI/12);
 const u=(sign*p.y*tangent-p.x*inflow)/r,v=(-sign*p.x*tangent-p.y*inflow)/r;
 const speed=cycloneScalar(s,lon,lat,Math.hypot(bg.u,bg.v),'wind')!;
 const bx=bg.u*(1-p.weight)+u*p.speed*p.weight,by=bg.v*(1-p.weight)+v*p.speed*p.weight,n=Math.hypot(bx,by);
 return n>1e-9?{u:bx/n*speed,v:by/n*speed}:{u:0,v:0};
}
/** Same radial speed profile as CPU point/vector sampling, evaluated per pixel. */
export const CYCLONE_GLSL=`
uniform vec4 uCyclone; // lon, lat, wind kt, rmw km (zero disables)
uniform vec3 uCycloneProfile; // radial exponent, blend start/end km
float cycloneSpeed(float lon,float lat,float background){
 if(uCyclone.w<=0.0)return background;
 vec2 d=vec2((lon-uCyclone.x)*111.32*cos(radians(uCyclone.y)),(lat-uCyclone.y)*111.132);
 float r=length(d),q=pow(uCyclone.w/max(.01,r),uCycloneProfile.x);
 float speed=uCyclone.z*sqrt(q*exp(1.0-q));
 return mix(background,speed,1.0-smoothstep(uCycloneProfile.y,uCycloneProfile.z,r));
}`;
