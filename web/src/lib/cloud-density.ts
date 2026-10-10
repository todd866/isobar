/** Bounded geographic 3D cloud density data for a WebGL R8 texture. */
import {sampleMountainCloud,terrainDisplacement,saturationVapourHPa} from './mountain-cloud';
export interface CloudDensityVector {
  lat: number;
  lon: number;
  heightM: number;
  u: number;
  v: number;
  cloudPct: number;
  w?: number | null;
  temperatureC?:number;
  rhPct?:number;
  stabilityN2?:number;
  pressureHPa?:number;
}

export interface CloudDensityBounds {
  west: number;
  east: number;
  south: number;
  north: number;
  minHeight: number;
  maxHeight: number;
}

export interface CloudDensityOptions {
  bounds?: Partial<CloudDensityBounds>;
  flowSample?: (lat:number,lon:number,height:number)=>{density:number;u:number;v:number}|null;
  terrain?: (lat: number, lon: number) => number;
  width?: number;
  height?: number;
  depth?: number;
  terrainSize?: number;
  timeSeconds?: number;
}

export interface CloudDensityTexture {
  density: Uint8Array;
  terrain: Float32Array;
  width: number;
  height: number;
  depth: number;
  terrainSize: number;
  bounds: CloudDensityBounds;
}

const MAX_SPAN = 0.5;
const DEFAULT_WIDTH = 48;
const DEFAULT_HEIGHT = 48;
const DEFAULT_DEPTH = 48;
const DEFAULT_TERRAIN_SIZE = 64;
const MAX_BYTES = 250 * 1024;

const finite = (value: number) => Number.isFinite(value);
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

function hash(value: string): number {
  let state = 2166136261;
  for (let index = 0; index < value.length; index += 1)
    state = Math.imul(state ^ value.charCodeAt(index), 16777619);
  return (state >>> 0) / 4294967296;
}

function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}

function noise3(x: number, y: number, z: number, seed: string): number {
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    z0 = Math.floor(z);
  const fx = smooth(x - x0),
    fy = smooth(y - y0),
    fz = smooth(z - z0);
  let result = 0;
  for (let dz = 0; dz < 2; dz += 1)
    for (let dy = 0; dy < 2; dy += 1)
      for (let dx = 0; dx < 2; dx += 1) {
        const weight =
          (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        result += hash(`${seed}:${x0 + dx}:${y0 + dy}:${z0 + dz}`) * weight;
      }
  return result;
}

function validBounds(
  options: CloudDensityOptions,
  vectors: readonly CloudDensityVector[],
): CloudDensityBounds {
  const valid = vectors.filter(
    (vector) =>
      finite(vector.lat) &&
      finite(vector.lon) &&
      finite(vector.heightM) &&
      finite(vector.cloudPct),
  );
  const centerLat = valid.length
    ? valid.reduce((sum, vector) => sum + vector.lat, 0) / valid.length
    : 0;
  const centerLon = valid.length
    ? valid.reduce((sum, vector) => sum + vector.lon, 0) / valid.length
    : 0;
  const supplied = options.bounds ?? {};
  const west = supplied.west ?? centerLon - 0.25;
  const east = supplied.east ?? centerLon + 0.25;
  const south = supplied.south ?? centerLat - 0.25;
  const north = supplied.north ?? centerLat + 0.25;
  const minHeight = supplied.minHeight ?? 0;
  const maxHeight = supplied.maxHeight ?? 12000;
  if (![west, east, south, north, minHeight, maxHeight].every(finite))
    throw new Error("cloud density bounds must be finite");
  if (east <= west || north <= south || maxHeight <= minHeight)
    throw new Error("cloud density bounds must be ordered");
  if (east - west > MAX_SPAN || north - south > MAX_SPAN)
    throw new Error("cloud density region exceeds 0.5 degree bound");
  return { west, east, south, north, minHeight, maxHeight };
}

function dimensions(
  options: CloudDensityOptions,
): [number, number, number, number] {
  const width = options.width ?? DEFAULT_WIDTH,
    height = options.height ?? DEFAULT_HEIGHT;
  const depth = options.depth ?? DEFAULT_DEPTH,
    terrainSize = options.terrainSize ?? DEFAULT_TERRAIN_SIZE;
  if (
    ![width, height, depth, terrainSize].every(Number.isInteger) ||
    width < 1 ||
    height < 1 ||
    depth < 1 ||
    terrainSize < 1
  )
    throw new Error("cloud density dimensions must be positive integers");
  if (width * height * depth + terrainSize * terrainSize * 4 > MAX_BYTES)
    throw new Error("cloud density texture exceeds 250 KiB bound");
  return [width, height, depth, terrainSize];
}

function terrainAt(
  sample: ((lat: number, lon: number) => number) | undefined,
  lat: number,
  lon: number,
): number {
  if (!sample) return 0;
  const value = sample(lat, lon);
  return finite(value) ? Math.max(0, value) : 0;
}

/** Build stable density and terrain textures for one small geographic volume. */
export function buildCloudDensityTexture(
  vectors: readonly CloudDensityVector[],
  options: CloudDensityOptions = {},
): CloudDensityTexture {
  const bounds = validBounds(options, vectors);
  const [width, height, depth, terrainSize] = dimensions(options);
  const terrain = new Float32Array(terrainSize * terrainSize);
  const terrainSample = options.terrain;
  for (let y = 0; y < terrainSize; y += 1) {
    const lat =
      bounds.south + ((y + 0.5) / terrainSize) * (bounds.north - bounds.south);
    for (let x = 0; x < terrainSize; x += 1) {
      const lon =
        bounds.west + ((x + 0.5) / terrainSize) * (bounds.east - bounds.west);
      terrain[y * terrainSize + x] = terrainAt(terrainSample, lat, lon);
    }
  }
  const density = new Uint8Array(width * height * depth);
  const valid = vectors.filter(
    (vector) =>
      finite(vector.lat) &&
      finite(vector.lon) &&
      finite(vector.heightM) &&
      finite(vector.cloudPct) &&
      finite(vector.u) &&
      finite(vector.v),
  );
  // World-referenced coordinates keep the field continuous when a tile pans.
  const seed = "isobar-cloud-density-v1";
  const centerLat = (bounds.south + bounds.north) / 2;
  const metresPerLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const metresPerLat = 111132;
  const terrainGrid = new Float32Array(width * height);
  const candidates: Array<
    Array<{ vector: CloudDensityVector; weight: number }>
  > = Array.from({ length: width * height }, () => []);
  for (let y = 0; y < height; y += 1) {
    const lat =
      bounds.south + ((y + 0.5) / height) * (bounds.north - bounds.south);
    for (let x = 0; x < width; x += 1) {
      const lon =
        bounds.west + ((x + 0.5) / width) * (bounds.east - bounds.west);
      const index = y * width + x;
      terrainGrid[index] = terrainAt(terrainSample, lat, lon);
      candidates[index] = (options.flowSample?[]:valid)
        .map((vector) => {
          const horizontal = Math.hypot(
            (lat - vector.lat) * metresPerLat,
            (lon - vector.lon) * metresPerLon,
          );
          return {
            vector,
            weight: Math.exp(-(horizontal * horizontal) / (3000 * 3000)),
          };
        })
        .filter((candidate) => candidate.weight > 0.001)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 24);
    }
  }
  // Sample a bounded 6 km upwind cross-section once per column. The crest
  // position is geographic, so lee-wave condensation stands still as air flows.
  const terrainPaths=candidates.map((local,index)=>{
    if(options.flowSample)return {baseline:0,crest:0,leeDistance:0,u:0,v:0};
    const y=Math.floor(index/width),x=index%width;
    const lat=bounds.south+(y+.5)/height*(bounds.north-bounds.south);
    const lon=bounds.west+(x+.5)/width*(bounds.east-bounds.west);
    const sum=local.reduce((s,c)=>s+c.weight,0)||1;
    const u=local.reduce((s,c)=>s+c.vector.u*c.weight,0)/sum;
    const v=local.reduce((s,c)=>s+c.vector.v*c.weight,0)/sum;
    const speed=Math.hypot(u,v)||1;
    const path=[terrainGrid[index]];
    let baseline=terrainGrid[index],crest=terrainGrid[index],crestIndex=0;
    for(let d=500;d<=6000;d+=500){
      const yy=lat-v/speed*d/metresPerLat,xx=lon-u/speed*d/Math.max(1,metresPerLon);
      const h=terrainAt(terrainSample,yy,xx);path.push(h);
      baseline=Math.min(baseline,h);
      if(h>crest){crest=h;crestIndex=path.length-1;}
    }
    let leeDistance=crestIndex*500;
    if(crestIndex>0&&crestIndex<path.length-1){
      const left=path[crestIndex-1],right=path[crestIndex+1],curve=left-2*crest+right;
      if(curve<-.001){
        const offset=clamp(.5*(left-right)/curve,-.5,.5);
        leeDistance+=offset*500;
        crest-=.25*(left-right)*offset;
      }
    }
    return {baseline,crest,leeDistance,u,v};
  });
  const verticalRange = bounds.maxHeight - bounds.minHeight;
  for (let z = 0; z < depth; z += 1)
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const lat =
          bounds.south + ((y + 0.5) / height) * (bounds.north - bounds.south);
        const lon =
          bounds.west + ((x + 0.5) / width) * (bounds.east - bounds.west);
        const altitude = bounds.minHeight + ((z + 0.5) / depth) * verticalRange;
        const column = y * width + x;
        if (altitude <= terrainGrid[column]) continue;
        let weather = 0, waveShape=false;
        let totalProfile=0,temperature=0,rh=0,stability=0,pressure=0;
        for (const candidate of candidates[column]) {
          const {vector,weight}=candidate;
          if([vector.temperatureC,vector.rhPct,vector.stabilityN2,vector.pressureHPa].every(Number.isFinite)){
            const w=weight*Math.exp(-(((altitude-vector.heightM)/900)**2));
            totalProfile+=w;temperature+=(vector.temperatureC!-.006*(altitude-vector.heightM))*w;
            rh+=vector.rhPct!*w;stability+=vector.stabilityN2!*w;
            pressure+=vector.pressureHPa!*Math.exp(-(altitude-vector.heightM)/8000)*w;
          }else{
            const thickness=500+clamp(vector.cloudPct,0,100)*12;
            weather=Math.max(weather,clamp(vector.cloudPct/100,0,1)*weight*Math.exp(-((altitude-vector.heightM)**2)/(2*thickness*thickness)));
          }
        }
        const seconds=Number.isFinite(options.timeSeconds)?options.timeSeconds!:0;
        let {u,v}=terrainPaths[column];
        const shared=options.flowSample?.(lat,lon,altitude);
        if(options.flowSample){weather=shared?.density??0;u=shared?.u??0;v=shared?.v??0;waveShape=true;}
        else if(totalProfile>1e-8){
          const speed=Math.hypot(u,v),agl=altitude-terrainGrid[column];
          const path=terrainPaths[column];
          const displacement=terrainDisplacement({upwindBaselineM:path.baseline,crestM:path.crest,currentDownwindM:terrainGrid[column],distanceLeeM:path.leeDistance,windSpeedMs:Math.max(.1,speed),stabilityN2:stability/totalProfile,heightAboveGroundM:agl});
          const lift=displacement.totalM;
          const localT=temperature/totalProfile,localP=pressure/totalProfile;
          const sourceT=localT+.006*Math.max(0,lift),sourceP=localP*Math.exp(Math.max(0,lift)/8000);
          // Preserve incoming vapour mixing ratio when moving the reference
          // parcel down to its upstream altitude; warming at fixed RH adds water.
          const sourceRH=clamp(rh/totalProfile*saturationVapourHPa(localT)/saturationVapourHPa(sourceT)*sourceP/localP,0,100);
          const parcel=sampleMountainCloud({temperatureC:sourceT,rhPct:sourceRH,pressureHPa:sourceP,liftM:lift,stabilityN2:stability/totalProfile,heightAboveGroundM:agl,windSpeedMs:speed});
          weather=parcel.density;
          waveShape=path.leeDistance>0&&stability/totalProfile>1e-5&&speed>=8;
        }
        if(weather<=0)continue;
        const xMetres = lon * 111320 * Math.cos(lat*Math.PI/180)-u*seconds;
        const yMetres = lat * metresPerLat-v*seconds;
        const zMetres = altitude;
        const coarse = noise3(
          xMetres / 1800,
          yMetres / 1800,
          zMetres / 1200,
          seed,
        );
        const lobes =
          0.4 +
          0.6 *
            noise3(
              xMetres / 650,
              yMetres / 650,
              zMetres / 500,
              `${seed}:lobes`,
            );
        const edge = smooth(
          clamp(
            Math.min(altitude - bounds.minHeight, bounds.maxHeight - altitude) /
              Math.max(1, verticalRange * 0.08),
            0,
            1,
          ),
        );
        density[(z * height + y) * width + x] = Math.round(
          clamp(weather * (waveShape ? .7+.3*coarse : coarse*lobes) * edge * smooth(clamp(Math.min((x+.5)/width,1-(x+.5)/width,(y+.5)/height,1-(y+.5)/height)/.1,0,1)) * 2, 0, 1) * 255,
        );
      }
  return { density, terrain, width, height, depth, terrainSize, bounds };
}

export const cloudDensityLimits = {
  maxSpanDegrees: MAX_SPAN,
  maxBytes: MAX_BYTES,
} as const;
