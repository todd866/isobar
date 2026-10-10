/** A bounded, horizontal slice through the atmosphere map. */
export interface AtmosphereSlice {
  lat: number;
  lon: number;
  /** Horizontal depth normal, clockwise from north (radians). */
  bearingRadians: number;
  halfWidthM: number;
  halfDepthM: number;
  baseM: number;
}

export interface SliceCoordinates {
  acrossM: number;
  depthM: number;
}

export interface AtmosphereSliceMesh {
  /** Interleaved longitude, latitude, bottom flag, wall flag. */
  vertices: Float32Array;
  indices: Uint16Array;
}

const METRES_PER_LATITUDE_DEGREE = 111_132;
const METRES_PER_LONGITUDE_DEGREE = 111_320;
const MAX_COLUMNS = 256;
const MAX_ROWS = 64;

function validSlice(slice: AtmosphereSlice | undefined): slice is AtmosphereSlice {
  return slice != null && Number.isFinite(slice.lat) && slice.lat >= -90 && slice.lat <= 90 &&
    Number.isFinite(slice.lon) && Number.isFinite(slice.bearingRadians) &&
    Number.isFinite(slice.halfWidthM) && slice.halfWidthM > 0 &&
    Number.isFinite(slice.halfDepthM) && slice.halfDepthM > 0 && Number.isFinite(slice.baseM);
}

function wrapLongitude(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/** Keep mesh coordinates on the same continuous longitude branch as its centre. */
function meshPoint(slice: AtmosphereSlice, acrossM: number, depthM: number): { lat: number; lon: number } | null {
  const point = slicePoint(slice, acrossM, depthM);
  if (!point) return null;
  const centre = wrapLongitude(slice.lon);
  const delta = ((point.lon - centre + 540) % 360 + 360) % 360 - 180;
  return { lat: point.lat, lon: centre + delta };
}

/** Convert a geographic point into metres in the slice's across/depth plane. */
export function sliceCoordinates(slice: AtmosphereSlice, lat: number, lon: number): SliceCoordinates {
  if (!validSlice(slice) || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) {
    return { acrossM: Number.NaN, depthM: Number.NaN };
  }
  const eastM = ((wrapLongitude(lon) - wrapLongitude(slice.lon) + 540) % 360 - 180) *
    METRES_PER_LONGITUDE_DEGREE * Math.cos(slice.lat * Math.PI / 180);
  const northM = (lat - slice.lat) * METRES_PER_LATITUDE_DEGREE;
  const sin = Math.sin(slice.bearingRadians);
  const cos = Math.cos(slice.bearingRadians);
  return { acrossM: eastM * cos - northM * sin, depthM: eastM * sin + northM * cos };
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

/** Return the smooth footprint weight, including the 25% outer fade band. */
export function atmosphereSliceWeight(slice: AtmosphereSlice | undefined, lat: number, lon: number): number {
  if (slice === undefined) return 1;
  if (!validSlice(slice)) return 0;
  const { acrossM, depthM } = sliceCoordinates(slice, lat, lon);
  if (!Number.isFinite(acrossM) || !Number.isFinite(depthM)) return 0;
  const across = Math.abs(acrossM);
  const depth = Math.abs(depthM);
  if (across > slice.halfWidthM || depth > slice.halfDepthM) return 0;
  const widthFade = smoothstep((slice.halfWidthM - across) / (slice.halfWidthM * 0.25));
  const depthFade = smoothstep((slice.halfDepthM - depth) / (slice.halfDepthM * 0.25));
  return Math.min(widthFade, depthFade);
}

/** Convert slice-plane metres back to geographic coordinates. */
export function slicePoint(slice: AtmosphereSlice, acrossM: number, depthM: number): { lat: number; lon: number } | null {
  if (!validSlice(slice) || !Number.isFinite(acrossM) || !Number.isFinite(depthM)) return null;
  const sin = Math.sin(slice.bearingRadians);
  const cos = Math.cos(slice.bearingRadians);
  const eastM = acrossM * cos + depthM * sin;
  const northM = -acrossM * sin + depthM * cos;
  const lat = slice.lat + northM / METRES_PER_LATITUDE_DEGREE;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  const cosLat = Math.cos(slice.lat * Math.PI / 180);
  if (Math.abs(cosLat) < 1e-12) return { lat, lon: wrapLongitude(slice.lon) };
  const lon = wrapLongitude(slice.lon + eastM / (METRES_PER_LONGITUDE_DEGREE * cosLat));
  return Number.isFinite(lon) ? { lat, lon } : null;
}

/** Build a top surface, vertical perimeter walls, and a flat base for DEM sampling. */
export function buildTerrainSliceMesh(slice: AtmosphereSlice, columns = 192, rows = 32): AtmosphereSliceMesh {
  const empty = (): AtmosphereSliceMesh => ({ vertices: new Float32Array(), indices: new Uint16Array() });
  if (!validSlice(slice) || !Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns > MAX_COLUMNS || rows > MAX_ROWS) return empty();
  const vertices: number[] = [];
  const indices: number[] = [];
  const addVertex = (across: number, depth: number, bottom: number, wall: number): number => {
    const point = meshPoint(slice, across, depth);
    if (!point) return -1;
    const index = vertices.length / 4;
    vertices.push(point.lon, point.lat, bottom, wall);
    return index;
  };
  const quad = (a: number, b: number, c: number, d: number): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    indices.push(a, b, c, a, c, d);
  };
  const top: number[][] = [];
  for (let row = 0; row <= rows; row += 1) {
    const line: number[] = [];
    const depth = -slice.halfDepthM + 2 * slice.halfDepthM * row / rows;
    for (let column = 0; column <= columns; column += 1) {
      line.push(addVertex(-slice.halfWidthM + 2 * slice.halfWidthM * column / columns, depth, 0, 0));
    }
    top.push(line);
  }
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    quad(top[row][column], top[row][column + 1], top[row + 1][column + 1], top[row + 1][column]);
  }
  const wallEdge = (points: [number, number][]): void => {
    for (let i = 0; i < points.length - 1; i += 1) {
      const [aAcross, aDepth] = points[i];
      const [bAcross, bDepth] = points[i + 1];
      const a = addVertex(aAcross, aDepth, 0, 1);
      const b = addVertex(bAcross, bDepth, 0, 1);
      const c = addVertex(bAcross, bDepth, 1, 1);
      const d = addVertex(aAcross, aDepth, 1, 1);
      quad(a, b, c, d);
    }
  };
  const front: [number, number][] = [];
  const back: [number, number][] = [];
  for (let column = 0; column <= columns; column += 1) {
    const across = -slice.halfWidthM + 2 * slice.halfWidthM * column / columns;
    front.push([across, -slice.halfDepthM]);
    back.push([across, slice.halfDepthM]);
  }
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let row = 0; row <= rows; row += 1) {
    const depth = -slice.halfDepthM + 2 * slice.halfDepthM * row / rows;
    left.push([-slice.halfWidthM, depth]);
    right.push([slice.halfWidthM, depth]);
  }
  wallEdge(front); wallEdge(back); wallEdge(left); wallEdge(right);
  const base = [
    addVertex(-slice.halfWidthM, -slice.halfDepthM, 1, 1),
    addVertex(slice.halfWidthM, -slice.halfDepthM, 1, 1),
    addVertex(slice.halfWidthM, slice.halfDepthM, 1, 1),
    addVertex(-slice.halfWidthM, slice.halfDepthM, 1, 1),
  ];
  quad(base[0], base[3], base[2], base[1]);
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

/** Clip a geographic segment to the slab; returns its retained parametric interval. */
export function sliceSegmentRange(slice: AtmosphereSlice | undefined, a: {lat:number;lon:number}, b: {lat:number;lon:number}): [number,number] | null {
  if (!slice) return [0,1];
  const p=sliceCoordinates(slice,a.lat,a.lon), q=sliceCoordinates(slice,b.lat,b.lon);
  if (![p.acrossM,p.depthM,q.acrossM,q.depthM].every(Number.isFinite)) return null;
  let enter=0,leave=1;
  for(const [start,end,bound] of [[p.acrossM,q.acrossM,slice.halfWidthM],[p.depthM,q.depthM,slice.halfDepthM]]){
    const delta=end-start;
    if(Math.abs(delta)<1e-9){if(Math.abs(start)>bound)return null;continue;}
    const x=(-bound-start)/delta,y=(bound-start)/delta;
    enter=Math.max(enter,Math.min(x,y));leave=Math.min(leave,Math.max(x,y));
    if(enter>=leave)return null;
  }
  return [enter,leave];
}

/** Content identity for GPU and projection caches, including in-place caller edits. */
export function atmosphereSliceKey(slice:AtmosphereSlice):string {
  return [slice.lat,slice.lon,slice.bearingRadians,slice.halfWidthM,slice.halfDepthM,slice.baseM].join(':');
}

/** Keep the untextured cut base just below the lowest measured mesh vertex. */
export function terrainSliceBase(slice:AtmosphereSlice,elevation:(lon:number,lat:number)=>number|null):number|null {
  const {vertices}=buildTerrainSliceMesh(slice);let minimum=Infinity;
  for(let i=0;i<vertices.length;i+=4){
    if(vertices[i+2]!==0||vertices[i+3]!==0)continue;
    const h=elevation(vertices[i],vertices[i+1]);if(h==null||!Number.isFinite(h))return null;
    minimum=Math.min(minimum,h);
  }
  return Number.isFinite(minimum)?minimum-600:null;
}

/** Sweep normal to the cut from a fixed origin, never accumulating coordinate drift. */
export function offsetAtmosphereSlice(origin:AtmosphereSlice, metres:number):AtmosphereSlice|null {
  const centre=slicePoint(origin,0,metres);
  return centre?{...origin,...centre}:null;
}
