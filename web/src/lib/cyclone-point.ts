import {smoothGrid} from './contour';
import {blendFrame,chartFrame,type LoadedChart} from './chart-store';
import {frameBlend} from './interpolate';
import {sampleFrame} from './point/ground';
import {createWindSampler} from './flow-wind';
import {cycloneAt,cycloneScalar} from './historical-cyclone';
import type {PointModel} from './point/openmeteo';
export function cyclonePoint(chart:LoadedChart,time:number,lat:number,lon:number):{model:PointModel;pressure:number|null}|null{
 const m=chart.manifest,minute=(time-Date.parse(m.run))/60000-m.forecastHours[0]*60;
 const blend=frameBlend(m.forecastHours,m.forecastHours[0]*60+minute),storm=cycloneAt(chart.cyclone,time);
 if(!blend||!storm)return null;
 const scalar=(name:string)=>{const spec=m.variables[name];return spec?sampleFrame(blendFrame(chartFrame(chart,name,blend.i0),chartFrame(chart,name,blend.i1),blend.t,spec),m,lon,lat):null;};
 const pressureGrid=blendFrame(chartFrame(chart,'mslp',blend.i0),chartFrame(chart,'mslp',blend.i1),blend.t,m.variables.mslp);
 const environment=smoothGrid(smoothGrid(pressureGrid,m.nx,m.ny,m.wrapsLongitude),m.nx,m.ny,m.wrapsLongitude);
 const wind=createWindSampler(chart,minute)?.(lon,lat),pressure=cycloneScalar(storm,lon,lat,sampleFrame(environment,m,lon,lat),'mslp');
 const surface={temperature2mC:scalar('t2m'),dewPoint2mC:null,windSpeed10mKt:wind?Math.hypot(wind.u,wind.v):null,windDirection10m:wind?(Math.atan2(-wind.u,-wind.v)*180/Math.PI+360)%360:null,cloudCoverPct:null,precipitationMm:null,surfacePressureHpa:null};
 const model:PointModel={latitude:lat,longitude:lon,elevationM:null,provenance:{source:'Reconstruction',model:'Best-track vortex + ERA5',run:m.run,cycle:false},surface:[surface,surface],series:{icao:'HISTORY',lat,lon,elevationFt:0,coastKm:null,source:'Reconstruction',model:'Best-track vortex + ERA5',run:m.run,runKnown:false,time:[time-1,time+1],levels:[]}};
 return{model,pressure};
}
