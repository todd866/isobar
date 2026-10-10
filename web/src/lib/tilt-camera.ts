/** Variable-curvature global camera. Coordinates are normalized by Earth radius. */
export const EARTH_RADIUS_M = 6_371_000;
const DEG = Math.PI / 180, TWENTY = 20 * DEG, TAN25 = Math.tan(25 * DEG), SMALL_K = 1e-3;

export interface TiltCameraInput { lat: number; lon: number; halfHeightDeg: number; aspect: number; tiltRadians: number; }
export interface CameraPoint { x: number; y: number; visible: boolean; depth: number; }
export interface SurfacePoint { lat: number; lon: number; }
export interface CameraGeometry {
  radiusM: number; cameraPositionM: readonly [number, number, number]; cameraPositionNormalized: readonly [number, number, number];
  forward: readonly [number, number, number]; right: readonly [number, number, number]; up: readonly [number, number, number];
  tangentHalfHeight: number; physicalScaleMPerClip: number; curvature: number; effectiveRadiusM: number;
}
export interface TiltCamera extends TiltCameraInput { halfHeightRadians: number; halfWidthRadians: number; geometry: CameraGeometry; }

const dot = (a: readonly [number, number, number], b: readonly [number, number, number]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: readonly [number, number, number], b: readonly [number, number, number], f = 1): readonly [number, number, number] => [a[0] + b[0] * f, a[1] + b[1] * f, a[2] + b[2] * f];
const scale = (a: readonly [number, number, number], f: number): readonly [number, number, number] => [a[0] * f, a[1] * f, a[2] * f];
const norm = (a: readonly [number, number, number]): readonly [number, number, number] => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };
const wrapLon = (v: number) => ((v + 180) % 360 + 360) % 360 - 180;
const smoothstep = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };

export function createTiltCamera(input: TiltCameraInput): TiltCamera {
  if (![input.lat, input.lon, input.halfHeightDeg, input.aspect, input.tiltRadians].every(Number.isFinite) || input.lat < -90 || input.lat > 90 || input.halfHeightDeg <= 0 || input.aspect <= 0) throw new Error('Invalid tilt camera input');
  const halfHeightDeg = Math.min(179.999, input.halfHeightDeg), tiltRadians = Math.max(0, Math.min(75 * DEG, input.tiltRadians));
  const halfHeightRadians = halfHeightDeg * DEG, k = smoothstep(tiltRadians / TWENTY), s = Math.sin(tiltRadians), c = Math.cos(tiltRadians);
  const distance = halfHeightRadians / (TAN25 * Math.max(k, SMALL_K));
  const eye: readonly [number, number, number] = [0, -s * distance, c * distance];
  const forward: readonly [number, number, number] = [0, s, -c], up: readonly [number, number, number] = [0, c, s];
  return { ...input, halfHeightDeg, tiltRadians, halfHeightRadians, halfWidthRadians: halfHeightRadians * input.aspect, geometry: {
    radiusM: EARTH_RADIUS_M, cameraPositionM: scale(eye, EARTH_RADIUS_M), cameraPositionNormalized: eye, forward, right: [1, 0, 0], up,
    tangentHalfHeight: TAN25 * k, physicalScaleMPerClip: EARTH_RADIUS_M * halfHeightRadians, curvature: k, effectiveRadiusM: k ? EARTH_RADIUS_M / k : Infinity,
  } };
}

interface Surface { point: readonly [number, number, number]; normal: readonly [number, number, number]; centerZ: number; radius: number; }
function surface(camera: TiltCamera, lat: number, lon: number, heightM: number): Surface {
  const k = camera.geometry.curvature;
  if (k < SMALL_K) return { point: [wrapLon(lon - camera.lon) * DEG, (lat - camera.lat) * DEG, heightM / EARTH_RADIUS_M], normal: [0, 0, 1], centerZ: -1 / SMALL_K, radius: 1 / SMALL_K + heightM / EARTH_RADIUS_M };
  const re = 1 / k, phi = k * lat * DEG, phi0 = k * camera.lat * DEG, lambda = k * wrapLon(lon - camera.lon) * DEG;
  const normal: readonly [number, number, number] = [Math.cos(phi) * Math.sin(lambda), Math.sin(phi) * Math.cos(phi0) - Math.cos(phi) * Math.cos(lambda) * Math.sin(phi0), Math.cos(phi) * Math.cos(lambda) * Math.cos(phi0) + Math.sin(phi) * Math.sin(phi0)];
  return { point: [re * normal[0] + normal[0] * heightM / EARTH_RADIUS_M, re * normal[1] + normal[1] * heightM / EARTH_RADIUS_M, re * (normal[2] - 1) + normal[2] * heightM / EARTH_RADIUS_M], normal, centerZ: -re, radius: re + heightM / EARTH_RADIUS_M };
}

function perspective(camera: TiltCamera, lat: number, lon: number, heightM: number): CameraPoint {
  const data = surface(camera, lat, lon, heightM), origin = camera.geometry.cameraPositionNormalized;
  const relative: readonly [number, number, number] = [data.point[0] - origin[0], data.point[1] - origin[1], data.point[2] - origin[2]], depth = dot(relative, camera.geometry.forward);
  const y = relative[1] * camera.geometry.up[1] + relative[2] * camera.geometry.up[2];
  // Clouds and aircraft are visible from below their altitude shell. Occlusion
  // belongs to the ground sphere, not the normal of that higher shell.
  const re = -data.centerZ, length2 = dot(relative, relative);
  const t = Math.max(0, Math.min(1, -(dot(origin, relative) + re * relative[2]) / length2));
  const closest = add(origin, relative, t);
  const clearance = dot(closest, closest) + 2 * re * closest[2];
  return { x: relative[0] / (depth * camera.geometry.tangentHalfHeight * camera.aspect), y: y / (depth * camera.geometry.tangentHalfHeight), visible: depth > 0 && clearance >= -1e-10, depth: depth * EARTH_RADIUS_M };
}

export function forwardProject(camera: TiltCamera, lat: number, lon: number, heightM = 0): CameraPoint | null {
  if (![lat, lon, heightM].every(Number.isFinite) || lat < -90 || lat > 90 || heightM < -EARTH_RADIUS_M) return null;
  if (camera.geometry.curvature < SMALL_K) return { x: wrapLon(lon - camera.lon) * DEG / camera.halfWidthRadians, y: (lat - camera.lat) * DEG / camera.halfHeightRadians, visible: true, depth: EARTH_RADIUS_M };
  return perspective(camera, lat, lon, heightM);
}

function inverseAnalytic(camera: TiltCamera, clipX: number, clipY: number, heightM: number): SurfacePoint | null {
  const k = camera.geometry.curvature;
  if (k < SMALL_K) { const lat = camera.lat + clipY * camera.halfHeightDeg; return lat < -90 || lat > 90 ? null : { lat, lon: wrapLon(camera.lon + clipX * camera.halfHeightDeg * camera.aspect) }; }
  const d = camera.geometry.tangentHalfHeight, origin = camera.geometry.cameraPositionNormalized;
  const direction = norm([clipX * d * camera.aspect, camera.geometry.forward[1] + clipY * d * camera.geometry.up[1], camera.geometry.forward[2] + clipY * d * camera.geometry.up[2]]);
  const re = 1 / k, radius = re + heightM / EARTH_RADIUS_M, oc: readonly [number, number, number] = [origin[0], origin[1], origin[2] + re];
  const b = dot(oc, direction), c = dot(origin, origin) + 2 * origin[2] * re - 2 * re * heightM / EARTH_RADIUS_M - (heightM / EARTH_RADIUS_M) ** 2, discriminant = b * b - c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant), q = b < 0 ? -b + root : -b - root, t0 = q, t1 = c / q, t = Math.min(t0 > 0 ? t0 : Infinity, t1 > 0 ? t1 : Infinity);
  if (!Number.isFinite(t)) return null;
  const hit = add(origin, direction, t), nx = hit[0] / radius, ny = hit[1] / radius, nz = (hit[2] + re) / radius, phi0 = k * camera.lat * DEG;
  const lat = Math.asin(Math.max(-1, Math.min(1, ny * Math.cos(phi0) + nz * Math.sin(phi0)))) / k / DEG;
  if (lat < -90 || lat > 90) return null;
  const delta = Math.atan2(nx, nz * Math.cos(phi0) - ny * Math.sin(phi0)) / k / DEG;
  if (Math.abs(delta) > 180 + 1e-8) return null;
  return { lat, lon: wrapLon(camera.lon + delta) };
}

export function inverseAtAltitude(camera: TiltCamera, clipX: number, clipY: number, heightM: number): SurfacePoint | null { return [clipX, clipY, heightM].every(Number.isFinite) && heightM >= -EARTH_RADIUS_M ? inverseAnalytic(camera, clipX, clipY, heightM) : null; }
export function inverseUnproject(camera: TiltCamera, clipX: number, clipY: number): SurfacePoint | null { return inverseAtAltitude(camera, clipX, clipY, 0); }

/** Matching normalized variable-curvature formulas for a WebGL geoOf implementation. */
export const TILT_CAMERA_GLSL = `
const float EARTH_RADIUS_M=6371000.0;
vec3 variableSurface(float lat,float lon,float lat0,float lon0,float k,float h){float re=1.0/max(k,0.001),p=k*lat,p0=k*lat0,l=k*(mod(lon-lon0+3.14159265,6.2831853)-3.14159265);vec3 n=vec3(cos(p)*sin(l),sin(p)*cos(p0)-cos(p)*cos(l)*sin(p0),cos(p)*cos(l)*cos(p0)+sin(p)*sin(p0));return re*n+vec3(0,0,-re)+n*(h/EARTH_RADIUS_M);}
bool variableGeo(vec2 clip,vec4 cam,float aspect,float k,vec3 eye,vec3 forward,vec3 up,float heightM,out float lat,out float lon){if(k<0.001){lat=cam.x+clip.y*cam.z;lon=cam.y+clip.x*cam.z*aspect;return lat>=-1.5707963&&lat<=1.5707963;}float d=0.46630766*k;vec3 ray=normalize(forward+vec3(1,0,0)*(clip.x*d*aspect)+up*(clip.y*d));float re=1.0/k,radius=re+heightM/EARTH_RADIUS_M;vec3 oc=eye+vec3(0,0,re);float b=dot(oc,ray),c=dot(eye,eye)+2.0*eye.z*re-2.0*re*heightM/EARTH_RADIUS_M-pow(heightM/EARTH_RADIUS_M,2.0),disc=b*b-c;if(disc<0.0)return false;float q=b<0.0?-b+sqrt(disc):-b-sqrt(disc),t=min(q,c/q);if(t<=0.0)return false;vec3 hit=eye+ray*t;float p0=k*cam.x,nx=hit.x/radius,ny=hit.y/radius,nz=(hit.z+re)/radius;lat=asin(clamp(ny*cos(p0)+nz*sin(p0),-1.0,1.0))/k;lon=cam.y+atan(nx,nz*cos(p0)-ny*sin(p0))/k;return lat>=-1.5707963&&lat<=1.5707963&&abs(lon-cam.y)<=3.1415927;}`;
