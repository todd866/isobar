/** Georeferenced modern photography. This module never changes terrain heights.
 * UTM source pixels remain in their original grid; geographic bounding boxes
 * are only for selection, never used as an affine texture placement. */
export interface ImageryReceipt {
  asset: string;
  acquisition_datetime: string;
  projection: string;
  native_pixel_size_m: number;
  pixel_window: {width:number;height:number};
  utm_bounds_m: {west:number;south:number;east:number;north:number};
  geographic_bounds_wgs84: {west:number;south:number;east:number;north:number};
  attribution: string;
  sha256: string;
}
type Six = [number,number,number,number,number,number];
export interface ImageryMapping {
  /** Longitude/latitude in degrees, subtracted before shader evaluation. */
  origin: [number,number];
  /** c, dx, dy, dx², dx*dy, dy²; UV origin is the PNG's top left. */
  u: Six;
  v: Six;
  edgeUv: [number,number];
}

/** WGS84 UTM45N; deliberately restricted to the bounded Everest material. */
export function everestUtm(lon:number,lat:number):[number,number] {
  if(!Number.isFinite(lon)||!Number.isFinite(lat)||lon<84||lon>90||lat<0||lat>84)throw new Error('Outside UTM45N imagery domain');
  const a=6378137,e=.00669437999014,k=.9996,r=lat*Math.PI/180,L=(lon-87)*Math.PI/180;
  const s=Math.sin(r),c=Math.cos(r),t=Math.tan(r)**2,ep=e/(1-e),C=ep*c*c,A=c*L,N=a/Math.sqrt(1-e*s*s);
  const M=a*((1-e/4-3*e**2/64-5*e**3/256)*r-(3*e/8+3*e**2/32+45*e**3/1024)*Math.sin(2*r)+(15*e**2/256+45*e**3/1024)*Math.sin(4*r)-35*e**3/3072*Math.sin(6*r));
  return [500000+k*N*(A+(1-t+C)*A**3/6+(5-18*t+t*t+72*C-58*ep)*A**5/120),k*(M+N*Math.tan(r)*(A*A/2+(5-t+9*C+4*C*C)*A**4/24+(61-58*t+t*t+600*C-330*ep)*A**6/720))];
}

export function validateImageryReceipt(r:ImageryReceipt):void {
  const b=r.utm_bounds_m,g=r.geographic_bounds_wgs84,p=r.pixel_window;
  if(r.projection!=='EPSG:32645'||!b||!g||!p||r.native_pixel_size_m!==10||!Number.isFinite(Date.parse(r.acquisition_datetime))||!r.attribution||!r.asset||! /^[a-f0-9]{64}$/.test(r.sha256))throw new Error('Invalid imagery provenance or projection');
  if(![b.west,b.south,b.east,b.north,g.west,g.south,g.east,g.north].every(Number.isFinite)||!(b.east>b.west&&b.north>b.south&&g.east>g.west&&g.north>g.south)||g.east-g.west>.3||g.north-g.south>.3||![p.width,p.height].every(n=>Number.isInteger(n)&&n>=32&&n<=2048))throw new Error('Imagery exceeds bounded material extent');
  if(Math.abs(b.east-b.west-p.width*10)>.01||Math.abs(b.north-b.south-p.height*10)>.01)throw new Error('Imagery pixel grid differs from source bounds');
  everestUtm(g.west,g.south);everestUtm(g.east,g.north);
  const centre=exactImageryUv(r,(g.west+g.east)/2,(g.south+g.north)/2);
  if(centre.some(v=>Math.abs(v-.5)>.05))throw new Error('Geographic bounds do not describe the UTM crop');
}

export function exactImageryUv(r:ImageryReceipt,lon:number,lat:number):[number,number] {
  const [x,y]=everestUtm(lon,lat),b=r.utm_bounds_m;
  return [(x-b.west)/(b.east-b.west),(b.north-y)/(b.north-b.south)];
}

/** A local quadratic avoids expensive projection trig and large UTM subtraction
 * per fragment. Tested across the entire <=20.48km crop against full projection.
 * CPU uses doubles; shader uniforms fit normal highp floats. */
export function imageryMapping(r:ImageryReceipt):ImageryMapping {
  validateImageryReceipt(r);
  const g=r.geographic_bounds_wgs84,origin:[number,number]=[(g.west+g.east)/2,(g.south+g.north)/2],d=.01;
  const at=(x:number,y:number)=>exactImageryUv(r,origin[0]+x,origin[1]+y);
  const c=at(0,0),xp=at(d,0),xm=at(-d,0),yp=at(0,d),ym=at(0,-d),pp=at(d,d),pm=at(d,-d),mp=at(-d,d),mm=at(-d,-d);
  const coefficients=(i:number):Six=>[c[i],(xp[i]-xm[i])/(2*d),(yp[i]-ym[i])/(2*d),(xp[i]+xm[i]-2*c[i])/(2*d*d),(pp[i]-pm[i]-mp[i]+mm[i])/(4*d*d),(yp[i]+ym[i]-2*c[i])/(2*d*d)];
  return {origin,u:coefficients(0),v:coefficients(1),edgeUv:[16/r.pixel_window.width,16/r.pixel_window.height]};
}
export function mappedImageryUv(m:ImageryMapping,lon:number,lat:number):[number,number] {
  const x=lon-m.origin[0],y=lat-m.origin[1],evalAt=(c:Six)=>c[0]+c[1]*x+c[2]*y+c[3]*x*x+c[4]*x*y+c[5]*y*y;
  return [evalAt(m.u),evalAt(m.v)];
}
export function imageryEdgeWeight(m:ImageryMapping,u:number,v:number):number {
  const smooth=(t:number)=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
  return smooth(Math.min(u,1-u)/m.edgeUv[0])*smooth(Math.min(v,1-v)/m.edgeUv[1]);
}

/** Renderer integration: upload PNG without UNPACK_FLIP_Y_WEBGL (top-left UV),
 * LINEAR_MIPMAP_LINEAR minification, LINEAR magnification, CLAMP_TO_EDGE; generate
 * mipmaps. Bind these uniforms, call imageryColour(lon,lat), and blend returned
 * RGB by alpha before weather ink. Multiply by modest relief light only: source
 * photography already contains sunlight/shadows. No image request per frame.
 * Transparent nodata and a 16-source-pixel border reveal the ordinary basemap. */
export const IMAGERY_MATERIAL_GLSL = `
uniform sampler2D uImagery;
uniform vec2 uImageryOrigin;
uniform vec3 uImageryU0, uImageryU1, uImageryV0, uImageryV1;
uniform vec2 uImageryEdge;
vec4 imageryColour(float lon, float lat) {
  vec2 d=vec2(lon,lat)-uImageryOrigin;
  vec3 linear=vec3(1.0,d.x,d.y), quadratic=vec3(d.x*d.x,d.x*d.y,d.y*d.y);
  vec2 uv=vec2(dot(uImageryU0,linear)+dot(uImageryU1,quadratic),dot(uImageryV0,linear)+dot(uImageryV1,quadratic));
  if(any(lessThan(uv,vec2(0.0)))||any(greaterThan(uv,vec2(1.0))))return vec4(0.0);
  vec2 fade=smoothstep(vec2(0.0),uImageryEdge,min(uv,1.0-uv));
  vec4 colour=texture(uImagery,uv);
  colour.a*=fade.x*fade.y;
  return colour;
}`;
