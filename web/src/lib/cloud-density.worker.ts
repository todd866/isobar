/// <reference lib="webworker" />
import { buildCloudDensityTexture, type CloudDensityVector, type CloudDensityBounds } from './cloud-density';
import {sampleTeachingAtmosphere,type TeachingAtmosphereContext} from './atmosphere-teaching';
import {createMountainFlowField} from './mountain-flow-field';
import {buildMountainStreamlines} from './mountain-streamlines';
import type {AtmosphereSlice} from './atmosphere-slice';
import {seaBreezeStreamlines} from './teaching-streamlines';
self.onmessage=(event:MessageEvent<{slice?:AtmosphereSlice;vectors:CloudDensityVector[];bounds:CloudDensityBounds;terrain:Float32Array;terrainSize:number;terrainBounds:CloudDensityBounds;timeSeconds:number;cloudEnabled:boolean;mountain:boolean;lenticular:boolean;teaching?:TeachingAtmosphereContext}>)=>{
 const {slice,vectors,bounds,terrain,terrainSize,terrainBounds,timeSeconds,cloudEnabled,mountain,lenticular,teaching}=event.data;
 const started=performance.now();
 try {
  const elevation=(lon:number,lat:number)=>{
   if(lon<terrainBounds.west||lon>terrainBounds.east||lat<terrainBounds.south||lat>terrainBounds.north)return null;
   const x=(lon-terrainBounds.west)/(terrainBounds.east-terrainBounds.west)*(terrainSize-1);
   const y=(lat-terrainBounds.south)/(terrainBounds.north-terrainBounds.south)*(terrainSize-1);
   const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(x0+1,terrainSize-1),y1=Math.min(y0+1,terrainSize-1);
   const top=terrain[y0*terrainSize+x0]*(1-(x-x0))+terrain[y0*terrainSize+x1]*(x-x0);
   const bottom=terrain[y1*terrainSize+x0]*(1-(x-x0))+terrain[y1*terrainSize+x1]*(x-x0);
   const value=top*(1-(y-y0))+bottom*(y-y0);return Number.isFinite(value)?value:null;
  };
  // An explicit synthetic experiment: a shallow moist layer above the summit.
  // It changes parcel inputs, never paints cloud independently of the airflow.
  const fieldVectors=lenticular?vectors.map(v=>({...v,rhPct:30+66*Math.exp(-(((v.heightM-9100)/420)**2)),stabilityN2:0.00016})):vectors;
  const field=teaching?((lat:number,lon:number,z:number)=>sampleTeachingAtmosphere(teaching,lat,lon,z)):mountain?createMountainFlowField(fieldVectors,elevation,lenticular?{moistLayerM:9100,moistLayerDepthM:420}:undefined):undefined;
  const cloud=cloudEnabled?buildCloudDensityTexture(vectors,{bounds,timeSeconds,terrain:(lat,lon)=>elevation(lon,lat)??0,flowSample:field}):null;
  const streamlines=teaching?.kind==='sea-breeze'?seaBreezeStreamlines(teaching,elevation,slice):field?buildMountainStreamlines(vectors.filter(v=>v.lon>bounds.west&&v.lon<bounds.east&&v.lat>bounds.south&&v.lat<bounds.north).map(v=>({...v,w:v.w??undefined})),(lat,lon,z)=>{const f=field(lat,lon,z);return f?{...f,cloudDensity:cloudEnabled?f.density:0}:null;},(lon,lat)=>elevation(lon,lat)??(teaching?.groundM??null),{maxPaths:64,steps:24,stepM:Math.max(40,Math.min(teaching?500:220,(bounds.north-bounds.south)*111132/70))}):[];
  self.postMessage({scenario:teaching?.kind??'reconstructed',cloud,streamlines,buildMs:performance.now()-started},{transfer:cloud?[cloud.density.buffer,cloud.terrain.buffer]:[]});
 }catch(error){self.postMessage({error:error instanceof Error?error.message:'Mountain atmosphere unavailable'});}
};
