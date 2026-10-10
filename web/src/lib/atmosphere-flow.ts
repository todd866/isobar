import { atmosphereSliceWeight, sliceSegmentRange, slicePoint, type AtmosphereSlice } from './atmosphere-slice';
/** Spatial pressure-level vectors. Motion is illustrative; direction and height are sampled. */
import { mapProject, type Camera, type Lambert } from './lambert';
import type { PointModel } from './point/openmeteo';
export interface AtmosphereVector { lat: number; lon: number; heightM: number; u: number; v: number; w: number | null; pressure: number; phase: number; }
export interface AtmosphereTrajectoryPoint { lat: number; lon: number; heightM: number; time: number; }
export type AtmosphereTerrain = (lon: number, lat: number) => number | null;
const LEVELS = [[925, 750], [850, 1500], [700, 3000], [500, 5500], [300, 9000]] as const;
const CELL_TOP_M = 10000;
const CELL_W_MAX = 2.5;
/** Orbit latitude can pass the poles; sample the equivalent physical location. */
function geographicCentre(lat: number, lon: number) {
  lat = ((lat + 180) % 360 + 360) % 360 - 180;
  if (lat > 90) { lat = 180 - lat; lon += 180; }
  else if (lat < -90) { lat = -180 - lat; lon += 180; }
  return {lat, lon: ((lon + 180) % 360 + 360) % 360 - 180};
}
/** Smooth, deterministic shear and an idealised divergence-free overturning cell.
 * This is synthetic at every location and date, never a weather reconstruction. */
export function syntheticAtmosphereWind(lat: number, lon: number, heightM: number, timeMs: number) {
  ({lat, lon} = geographicCentre(lat, lon));
  const phase = timeMs / 3600000 * .12;
  const x = lon * Math.PI * 6, y = lat * Math.PI * 6;
  const z = Math.max(0, Math.min(1, heightM / 10000));
  const cellX = x + phase, cellY = y - phase * .4;
  const horizontalShape = Math.cos(Math.PI * z);
  // uCell and vCell are the horizontal components of one analytic cell.
  // Their divergence is balanced by the derivative of wCell, so the
  // illustrative air mass does not appear or disappear between levels.
  const kx = 6 * Math.PI / (111320 * Math.max(.1, Math.cos(lat * Math.PI / 180)));
  const ky = 6 * Math.PI / 111132;
  // w is a closed branch: zero at the floor and top, with rising and sinking
  // halves. The horizontal return terms are its analytic divergence partner.
  const uCell = -CELL_W_MAX * Math.PI / (2 * CELL_TOP_M * kx) * horizontalShape * Math.sin(cellX) * Math.cos(cellY);
  const vCell = -CELL_W_MAX * Math.PI / (2 * CELL_TOP_M * ky) * horizontalShape * Math.cos(cellX) * Math.sin(cellY);
  const wCell = CELL_W_MAX * Math.sin(Math.PI * z) * Math.cos(cellX) * Math.cos(cellY);
  return { u: 8 + 20 * z + uCell,
    v: -5 + 16 * z + vCell,
    w: wCell };
}
export function syntheticAtmosphereProfile(lat: number, lon: number, timeMs: number, terrain?: AtmosphereTerrain): PointModel {
  ({lat, lon} = geographicCentre(lat, lon));
  const sampledGround = terrain?.(lon, lat);
  const ground = sampledGround != null && Number.isFinite(sampledGround) ? sampledGround : 0;
  const run = new Date(timeMs).toISOString();
  return {latitude: lat, longitude: lon, elevationM: ground, surface: [],
    provenance: {source: 'Synthetic', model: 'Illustrative', run, cycle: false},
    series: {icao: 'ILLUSTRATIVE', lat, lon, elevationFt: ground / .3048, coastKm: null, source: 'Synthetic', model: 'Illustrative', run, runKnown: false,
      time: [timeMs - 3600000, timeMs + 3600000], levels: LEVELS.map(([hPa, z]) => {
        const wind = syntheticAtmosphereWind(lat, lon, z, timeMs);
        const speed = Math.hypot(wind.u, wind.v) / .514444;
        const from = (Math.atan2(-wind.u, -wind.v) * 180 / Math.PI + 360) % 360;
        const heightM = z;
        if (sampledGround != null && Number.isFinite(sampledGround) && heightM < ground + 50) return null;
        return {hPa, z: [heightM, heightM], t: [25 - heightM * .0065, 25 - heightM * .0065], rh: [65, 65],
          cc: [hPa === 850 || hPa === 700 ? 65 : 0, hPa === 850 || hPa === 700 ? 65 : 0],
          ws: [speed, speed], wd: [from, from], w: [wind.w, wind.w]};
      }).filter((level): level is NonNullable<typeof level> => level !== null)}};
}
export function syntheticAtmosphereVectors(lat: number, lon: number, halfHeight: number, aspect: number, timeMs: number, slice?: AtmosphereSlice, terrain?: AtmosphereTerrain): AtmosphereVector[] {
  if (![lat, lon, halfHeight, aspect, timeMs].every(Number.isFinite) || halfHeight <= 0 || halfHeight >= 6 || aspect <= 0) return [];
  ({lat, lon} = geographicCentre(lat, lon));
  if(slice){
    const result:AtmosphereVector[]=[];
    for(let x=-6;x<=6;x++)for(const y of [-.55,0,.55]){
      const point=slicePoint(slice,x/7*slice.halfWidthM,y*slice.halfDepthM);if(!point)continue;
      for(const [pressure,heightM] of LEVELS){const ground=terrain?.(point.lon,point.lat);if(ground!=null&&Number.isFinite(ground)&&heightM<ground+50)continue;const wind=syntheticAtmosphereWind(point.lat,point.lon,heightM,timeMs);result.push({...point,heightM,...wind,pressure,phase:((x+6)*.618+(y+.55)*.37)%1});}
    }
    return result;
  }
  // Geographic lattice stays fixed during a drag, instead of travelling with the camera.
  const spacing = 2 ** Math.ceil(Math.log2(halfHeight / 1.5));
  const lonSpacing = spacing / Math.max(.2, Math.cos(lat * Math.PI / 180));
  const south = Math.max(-90, Math.floor((lat - halfHeight * 2) / spacing) * spacing);
  const north = Math.min(90, lat + halfHeight * 2);
  const west = Math.floor((lon - halfHeight * aspect * 2) / lonSpacing) * lonSpacing;
  const east = lon + halfHeight * aspect * 2;
  const vectors: AtmosphereVector[] = [];
  for (let y = south; y <= north && vectors.length < 1800; y += spacing) for (let x = west; x <= east && vectors.length < 1800; x += lonSpacing) {
    for (const [pressure, agl] of LEVELS) {
      const ground = terrain?.(x, y);
      const heightM = agl;
      if (ground != null && Number.isFinite(ground) && heightM < ground + 50) continue;
      const wind = syntheticAtmosphereWind(y, x, heightM, timeMs);
      vectors.push({lat: y, lon: x, heightM, ...wind, pressure, phase: ((Math.sin(y * 57 + x * 31 + pressure) * 43758.5) % 1 + 1) % 1});
    }
  }
  return vectors;
}

function advanceTrajectoryPoint(point: AtmosphereTrajectoryPoint, dt: number, timeMs: number): AtmosphereTrajectoryPoint {
  const velocity = (sample: AtmosphereTrajectoryPoint) => {
    // The selected forecast field is frozen while tracers move through it.
    // Animation is visual transport, not a second forecast-time clock.
    const wind = syntheticAtmosphereWind(sample.lat, sample.lon, sample.heightM, timeMs);
    return {lat: wind.v / 111132, lon: wind.u / (111320 * Math.max(.1, Math.cos(sample.lat * Math.PI / 180))), heightM: wind.w ?? 0};
  };
  const first = velocity(point);
  const middle: AtmosphereTrajectoryPoint = {
    lat: point.lat + first.lat * dt * .5, lon: point.lon + first.lon * dt * .5,
    heightM: point.heightM + first.heightM * dt * .5, time: point.time + dt * .5,
  };
  const second = velocity(middle);
  return {lat: point.lat + second.lat * dt, lon: point.lon + second.lon * dt,
    heightM: point.heightM + second.heightM * dt, time: point.time + dt};
}

// Geographic keys retain paths when a pan recreates the visible vector array.
const trajectoryCache = new Map<string, AtmosphereTrajectoryPoint[]>();
const TRAJECTORY_MIN_TIME = -270;
const TRAJECTORY_MAX_TIME = 180;
const TRAJECTORY_STEP = 15;

function cachedAtmosphereTrajectory(vector: AtmosphereVector, timeMs: number): AtmosphereTrajectoryPoint[] {
  const key = `${vector.lat}:${vector.lon}:${vector.heightM}:${timeMs}`;
  const cached = trajectoryCache.get(key);
  if (cached) { trajectoryCache.delete(key); trajectoryCache.set(key, cached); return cached; }
  let point: AtmosphereTrajectoryPoint = {lat: vector.lat, lon: vector.lon, heightM: vector.heightM, time: 0};
  const backward: AtmosphereTrajectoryPoint[] = [point];
  for (let t = 0; t > TRAJECTORY_MIN_TIME; t -= TRAJECTORY_STEP) {
    point = advanceTrajectoryPoint(point, -TRAJECTORY_STEP, timeMs);
    backward.push(point);
  }
  backward.reverse();
  point = {lat: vector.lat, lon: vector.lon, heightM: vector.heightM, time: 0};
  const forward: AtmosphereTrajectoryPoint[] = [point];
  for (let t = 0; t < TRAJECTORY_MAX_TIME; t += TRAJECTORY_STEP) {
    point = advanceTrajectoryPoint(point, TRAJECTORY_STEP, timeMs);
    forward.push(point);
  }
  const result = [...backward.slice(0, -1), ...forward];
  trajectoryCache.set(key, result);
  while (trajectoryCache.size > 4096) trajectoryCache.delete(trajectoryCache.keys().next().value!);
  return result;
}

function interpolateTrajectory(path: readonly AtmosphereTrajectoryPoint[], time: number): AtmosphereTrajectoryPoint {
  const clamped = Math.max(path[0].time, Math.min(path[path.length - 1].time, time));
  const index = Math.max(0, Math.min(path.length - 2, Math.floor((clamped - TRAJECTORY_MIN_TIME) / TRAJECTORY_STEP)));
  const first = path[index], second = path[index + 1];
  const fraction = second.time === first.time ? 0 : (clamped - first.time) / (second.time - first.time);
  return {lat: first.lat + (second.lat - first.lat) * fraction, lon: first.lon + (second.lon - first.lon) * fraction,
    heightM: first.heightM + (second.heightM - first.heightM) * fraction, time: clamped};
}

/** Build a short RK2 path through the same analytic field used by profiles.
 * The seed is the zero-time anchor; callers choose the moving window around it.
 * Fixed samples keep drawing bounded and make the path deterministic for a
 * selected forecast time. */
export function buildAtmosphereTrajectory(vector: AtmosphereVector, timeMs: number, startTime: number, endTime: number, samples = 7): AtmosphereTrajectoryPoint[] {
  if (![timeMs, startTime, endTime].every(Number.isFinite) || endTime <= startTime) return [];
  const count = Math.max(3, Math.min(9, Math.floor(samples)));
  const path = cachedAtmosphereTrajectory(vector, timeMs);
  const result: AtmosphereTrajectoryPoint[] = [];
  for (let i = 0; i < count; i++) result.push(interpolateTrajectory(path, startTime + (endTime - startTime) * i / (count - 1)));
  return result;
}

export function drawAtmosphereFlow(ctx: CanvasRenderingContext2D, vectors: readonly AtmosphereVector[], geo: Lambert, camera: Camera, width: number, height: number, seconds: number, dark: boolean, terrain?: AtmosphereTerrain, selectedTimeMs = 0): {layers: number; flows: number} {
  const layers = new Set<number>(); let flows = 0;
  // Visual separation adapts to map scale; the source profile keeps true model heights.
  const separation = 1 + (Math.min(8, Math.max(1, camera.halfHeight / .15)) - 1) * Math.sin(camera.pitch ?? 0);
  ctx.save(); ctx.lineCap = 'round'; ctx.lineWidth = 1.25;
  // Higher levels first. No cloud cylinders or displaced example column.
  for (let i = vectors.length - 1; i >= 0; i--) {
    const v = vectors[i], phase = (seconds / 5 + v.phase) % 1;
    const advance = (phase - .5) * 360;
    const path=buildAtmosphereTrajectory(v, selectedTimeMs, advance-90, advance, 7);
    if(path.length<2)continue;
    if (terrain && path.some(sample => {
      const ground = terrain(sample.lon, sample.lat);
      return ground != null && Number.isFinite(ground) && sample.heightM < ground + 50;
    })) continue;
    const screen = (sample: AtmosphereTrajectoryPoint) => {
      const p=mapProject(geo,camera.slice?{...camera,slice:undefined}:camera,sample.lat,sample.lon,sample.heightM*separation);
      return p && {x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2};
    };
    const middle=path[Math.floor(path.length/2)];
    const weight=atmosphereSliceWeight(camera.slice,middle.lat,middle.lon);
    if(weight<=0)continue;
    ctx.lineWidth = .85 + .75 * Math.min(1, v.heightM / 9000);
    ctx.globalAlpha = weight * (.15 + .45 * Math.sin(Math.PI * phase)) * (v.pressure === 925 ? .7 : 1);
    const visible:Array<{a:{x:number;y:number};b:{x:number;y:number};end:AtmosphereTrajectoryPoint}>=[];
    for(let segment=1;segment<path.length;segment++) {
      const start=path[segment-1], end=path[segment];
      const range=sliceSegmentRange(camera.slice,{lat:start.lat,lon:start.lon},{lat:end.lat,lon:end.lon});
      if(!range)continue;
      const pointAt=(fraction:number):AtmosphereTrajectoryPoint=>({
        lat:start.lat+(end.lat-start.lat)*fraction, lon:start.lon+(end.lon-start.lon)*fraction,
        heightM:start.heightM+(end.heightM-start.heightM)*fraction, time:start.time+(end.time-start.time)*fraction,
      });
      const clippedStart=screen(pointAt(range[0])), clippedEnd=screen(pointAt(range[1]));
      if(!clippedStart||!clippedEnd)continue;
      const length=Math.hypot(clippedEnd.x-clippedStart.x,clippedEnd.y-clippedStart.y);
      if(length<.01)continue;
      visible.push({a:clippedStart,b:clippedEnd,end:pointAt(range[1])});
    }
    if(!visible.length)continue;
    // Draw only a bounded tail measured backwards from the arrowhead. This
    // keeps close zoom readable without replacing the curve with a long rod.
    let remaining=48;
    for(let segment=visible.length-1;segment>=0&&remaining>0;segment--) {
      const item=visible[segment], segmentLength=Math.hypot(item.b.x-item.a.x,item.b.y-item.a.y);
      const fraction=Math.min(1,remaining/segmentLength), startX=item.b.x+(item.a.x-item.b.x)*fraction, startY=item.b.y+(item.a.y-item.b.y)*fraction;
      const colourWind=syntheticAtmosphereWind(item.end.lat,item.end.lon,item.end.heightM,selectedTimeMs);
      ctx.strokeStyle = colourWind.w > .05 ? (dark ? '#eeb172' : '#aa652f') : colourWind.w < -.05 ? (dark ? '#84c6de' : '#246b89') : dark ? '#c4d8e1' : '#37596b';
      ctx.beginPath(); ctx.moveTo(startX,startY); ctx.lineTo(item.b.x,item.b.y); ctx.stroke();
      remaining-=segmentLength*fraction;
    }
    const last=visible[visible.length-1], b=last.b;
    if (b.x < -20 || b.x > width + 20 || b.y < -20 || b.y > height + 20) continue;
    const previous=last.a;
    const length = Math.hypot(b.x - previous.x, b.y - previous.y);
    if (48-remaining < 1 || length < .001) continue;
    const angle = Math.atan2(b.y - previous.y, b.x - previous.x), head = Math.min(3, (48-remaining) / 3);
    const colourWind=syntheticAtmosphereWind(last.end.lat,last.end.lon,last.end.heightM,selectedTimeMs);
    ctx.strokeStyle = colourWind.w > .05 ? (dark ? '#eeb172' : '#aa652f') : colourWind.w < -.05 ? (dark ? '#84c6de' : '#246b89') : dark ? '#c4d8e1' : '#37596b';
    ctx.beginPath();
    ctx.moveTo(b.x - head * Math.cos(angle - .55), b.y - head * Math.sin(angle - .55)); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(angle + .55), b.y - head * Math.sin(angle + .55)); ctx.stroke();
    layers.add(v.pressure); flows++;
  }
  ctx.restore(); return {layers: layers.size, flows};
}
