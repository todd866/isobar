/** Everest v2: archived surface wind + explicit local reconstruction assumptions.
 * No claim of resolved turbulence, observed cloud geometry or exact camp tracks. */
import approach from './terrain/everest-approach.json';
import type { LoadedChart } from './chart-store';
import { createWindSampler } from './flow-wind';
import type { ElevationAt } from './map-generalise';
import type { PointModel } from './point/openmeteo';
import type { AtmosphereVector } from './atmosphere-flow';

export const EVEREST_SOURCE = 'https://www.cambridge.org/core/services/aop-cambridge-core/content/view/E895474FE6DD9C0B32F0C765D29EA100/S0022143000025284a.pdf/notes-on-temperature-and-snow-conditions-in-the-everest-region-in-spring-1952-and-1953.pdf';
export const EVEREST_METHOD = 'everest-terrain-v2';
// Approximate schematic geographic anchors; not surveyed 1953 camp positions.
export const EVEREST_ROUTE = [
  { name: 'Base camp', lat: 28.002, lon: 86.852, heightM: 5486 },
  { name: 'Khumbu Icefall', lat: 27.991, lon: 86.869, heightM: 5800 },
  { name: 'Western Cwm', lat: 27.980, lon: 86.898, heightM: 6462 },
  { name: 'South Col', lat: 27.971, lon: 86.929, heightM: 7864 },
  { name: 'Camp IX', lat: 27.982, lon: 86.931, heightM: 8504 },
  { name: 'Everest', lat: 27.9881, lon: 86.9250, heightM: 8849 },
] as const;
export const EVEREST_DETAILS = 'Everest terrain v2: bounded synthetic wind shear, ridge speed-up, lee shelter, slope steering, terrain-following vertical motion and multiscale gusts driven by archived ERA5 surface wind and modern terrain. This is a heuristic reconstruction, not CFD or an observation. Lapse rate, daily cycle, humidity and vertical motion are generated assumptions. Optional mountain clouds use a bounded parcel-condensation and standing-wave approximation (mountain-cloud-v1), rendered as a 3D density field; moisture, stability and cloud geometry are synthetic, with no resolved CFD or ice microphysics. Temperature baseline: Pugh’s 29 May 1953 Camp IX reading, −27.2°C at 27,900 ft; published 03:00 time is not assigned a UTC offset. The ascent line is synthetic, generated from modern elevation data within approximate historical route corridors; camp positions remain approximate. Hillary/Tenzing positions are estimated each minute along this route, with documented camp/summit time anchors and terrain-weighted pacing between them. Stops and untimed return stages are modelled. Expedition clock readings use an assumed UTC+05:30 playback alignment. Position weather is synthetic at 2 m above the route terrain; archived wind is interpolated, with at most one hour of explicitly marked endpoint holding. Political borders are omitted pending a dated layer; shipping is not reconstructed for 1953.';
export interface EverestVector extends AtmosphereVector { cloudPct: number; temperatureC:number; rhPct:number; stabilityN2:number; pressureHPa:number; }
const clamp = (v:number,a:number,b:number) => Math.max(a,Math.min(b,v));
const TAU = Math.PI * 2;

export function everestAtmosphere(chart: LoadedChart, validMs: number, elevation: ElevationAt | null, windTimeMs=validMs) {
  const minute = (windTimeMs-Date.parse(chart.manifest.run))/60000-chart.manifest.forecastHours[0]*60;
  const horizon=(chart.manifest.forecastHours.at(-1)!-chart.manifest.forecastHours[0])*60;
  const sample = Number.isFinite(minute)&&minute>=0&&minute<=horizon ? createWindSampler(chart,minute) : null;
  const ground = (lat:number,lon:number) => lat>=27&&lat<=29&&lon>=86&&lon<=88 ? elevation?.(lon,lat) ?? null : null;
  function at(lat:number,lon:number,z:number,minimumClearanceM=50) {
    const terrain=ground(lat,lon), wind=sample?.(lon,lat);
    if(terrain==null||!wind||z<terrain+minimumClearanceM) return null;
    const agl=z-terrain, shear=1+Math.log1p(agl/100)*.22;
    // Surface sampler is knots; vector renderer uses metres per second.
    const u=wind.u*.514444*shear, v=wind.v*.514444*shear;
    const d=.003, east=ground(lat,lon+d),west=ground(lat,lon-d),north=ground(lat+d,lon),south=ground(lat-d,lon);
    const dx=east!=null&&west!=null?(east-west)/(2*d*111320*Math.cos(lat*Math.PI/180)):0;
    const dy=north!=null&&south!=null?(north-south)/(2*d*111132):0;
    const dxM=d*111320*Math.cos(lat*Math.PI/180), dyM=d*111132;
    const curvature=east!=null&&west!=null&&north!=null&&south!=null
      ? (east+west+north+south-4*terrain)/((dxM+dyM)*.5*(dxM+dyM)*.5)
      : 0;
    const curvatureSignal=clamp(curvature*3000,-1,1);
    const slope=Math.hypot(dx,dy);
    const uphillU=slope>1e-6?dx/slope:0, uphillV=slope>1e-6?dy/slope:0;
    const alongU=-uphillV, alongV=uphillU;
    const flow=Math.hypot(u,v), along=u*alongU+v*alongV, uphill=u*uphillU+v*uphillV;
    // Flow is accelerated over exposed ridges and sheltered on the lee side;
    // the bounded turn toward the contour keeps vectors terrain-following.
    const coupling=Math.exp(-agl/1800), exposure=clamp(slope/0.35,0,1)*coupling;
    const ridge=clamp(1+0.32*exposure-0.18*exposure*clamp(-uphill/(flow||1),0,1)-0.12*curvatureSignal*coupling,.65,1.4);
    const turn=0.28*exposure*clamp(Math.abs(along)/(flow||1),0,1);
    const steeredU=u*(1-turn)+alongU*along*turn;
    const steeredV=v*(1-turn)+alongV*along*turn;
    const seconds=validMs/1000, eastM=lon*111320*Math.cos(lat*Math.PI/180),northM=lat*111132;
    const gust=1+coupling*(.08*Math.sin(TAU*(eastM/1800+northM/2400-seconds/900))+.04*Math.sin(TAU*(northM/450-seconds/240)));
    const u2=steeredU*ridge*gust, v2=steeredV*ridge*gust;
    const w=clamp(((u2*dx+v2*dy)+0.04*flow*curvatureSignal)*Math.exp(-agl/1800),-3,3);
    // Published reading anchors the vertical baseline, not a falsely timed observation.
    const phase=TAU*((validMs/3600000+lon/15)%24)/24;
    const temperature=-27.2+(8503.92-z)*.006+2*Math.cos(phase-Math.PI);
    const rh=clamp(55+20*Math.sin(phase)+w*8-(agl/1000)*3,15,98);
    return {u:u2,v:v2,w,temperature,rh,cloud:clamp((rh-75)*4,0,90),pressure:1013.25*Math.exp(-z/8000)};
  }
  function profile(lat:number,lon:number):PointModel|null {
    const terrain=ground(lat,lon);if(terrain==null)return null;
    const run=new Date(validMs).toISOString();
    const levels=[50,100,250,500,1000,2000,3500].map(agl=>{
      const z=terrain+agl,a=at(lat,lon,z);if(!a)return null;
      const ws=Math.hypot(a.u,a.v)/.514444,wd=(Math.atan2(-a.u,-a.v)*180/Math.PI+360)%360;
      return {hPa:a.pressure,z:[z,z],t:[a.temperature,a.temperature],rh:[a.rh,a.rh],cc:[a.cloud,a.cloud],ws:[ws,ws],wd:[wd,wd],w:[a.w,a.w]};
    }).filter((v):v is NonNullable<typeof v>=>v!==null);
    if(!levels.length)return null;
    return {latitude:lat,longitude:lon,elevationM:terrain,surface:[],provenance:{source:'Reconstruction',model:EVEREST_METHOD,run,cycle:false},series:{icao:'EVEREST',lat,lon,elevationFt:terrain/.3048,coastKm:null,source:'Reconstruction',model:EVEREST_METHOD,run,runKnown:false,time:[validMs-3600000,validMs+3600000],levels}};
  }
  function vectors(lat:number,lon:number,halfHeight:number,aspect:number):EverestVector[] {
    if(halfHeight<=0||halfHeight>=1||aspect<=0)return [];
    const levels=[50,100,250,700,1800,3500],result:EverestVector[]=[];
    let spacing=2**Math.ceil(Math.log2(halfHeight/2));
    // Coarsen the whole lattice uniformly instead of truncating one side at 900.
    const count=()=> (Math.ceil(halfHeight*4/spacing)+2)*(Math.ceil(halfHeight*aspect*4/spacing)+2)*levels.length;
    while(count()>900)spacing*=2;
    for(let y=Math.floor((lat-halfHeight*2)/spacing)*spacing;y<=lat+halfHeight*2;y+=spacing){
      for(let x=Math.floor((lon-halfHeight*aspect*2)/spacing)*spacing;x<=lon+halfHeight*aspect*2;x+=spacing){
        const terrain=ground(y,x);if(terrain==null)continue;
        for(const agl of levels){const heightM=terrain+agl,a=at(y,x,heightM);if(a)result.push({lat:y,lon:x,heightM,u:a.u,v:a.v,w:a.w,pressure:Math.round(a.pressure),cloudPct:a.cloud,temperatureC:a.temperature,rhPct:clamp(a.rh-a.w*8,10,99),stabilityN2:9.80665/(a.temperature+273.15)*(.0098-.006),pressureHPa:a.pressure,phase:((Math.sin(y*57+x*31+agl)*43758.5)%1+1)%1});}
      }
    }return result;
  }
  return {profile,vectors,at,surface:(lat:number,lon:number)=>{const z=ground(lat,lon);return z==null?null:at(lat,lon,z+2,2);}};
}

export const EVEREST_EVENTS: Record<string,{title:string;detail:string;source:string}>={
  ...Object.fromEntries(approach.milestones.flatMap(m=>{const dates=m.date.includes('/')?[m.date.slice(0,10),m.date.slice(0,8)+m.date.split('/')[1]]:[m.date];return dates.map(date=>[date,{title:m.place,detail:m.event,source:m.sourceUrl}]);})),
  '1953-05-29':{title:'First ascent',detail:'Edmund Hillary and Tenzing Norgay reach the summit of Everest.',source:'https://nzhistory.govt.nz/edmund-hillary-and-tensing-norgay-reach-summit-of-everest'},
};
