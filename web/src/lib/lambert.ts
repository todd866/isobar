import { atmosphereSliceWeight, type AtmosphereSlice } from './atmosphere-slice';
/** Tangent Lambert conformal. Australia uses 130°E and the 30°S standard parallel. */

export interface Lambert {
  projection: 'lambert' | 'equirectangular';
  lon0: number;
  parallel: number;
  n: number;
  F: number;
  rho0: number;
  valid: boolean;
}

export function lambertMake(centralMeridianDeg: number, parallelDeg: number): Lambert {
  const phi = (parallelDeg * Math.PI) / 180;
  const n = Math.sin(phi);
  if (Math.abs(n) < 1e-8) return { projection: 'lambert', lon0: centralMeridianDeg, parallel: parallelDeg, n, F: 0, rho0: 0, valid: false };
  const t1 = Math.tan(Math.PI / 4 + phi / 2);
  if (!(t1 > 0)) return { projection: 'lambert', lon0: centralMeridianDeg, parallel: parallelDeg, n, F: 0, rho0: 0, valid: false };
  const F = (Math.cos(phi) * t1 ** n) / n;
  const rho0 = F / t1 ** n;
  if (!Number.isFinite(F) || !Number.isFinite(rho0)) {
    return { projection: 'lambert', lon0: centralMeridianDeg, parallel: parallelDeg, n, F, rho0, valid: false };
  }
  return { projection: 'lambert', lon0: centralMeridianDeg, parallel: parallelDeg, n, F, rho0, valid: true };
}

export function australiaLambert(): Lambert {
  return lambertMake(130, -30);
}

/** World plate: longitude is continuous around a chosen centre and latitude is
 * linear. The cosine scale keeps east/west distances visually stable around
 * the latitude currently being shown while retaining a single CPU/GPU model. */
export function globalEquirectangular(centralMeridianDeg = 0, centreLatitudeDeg = 0): Lambert {
  const cos = Math.cos((centreLatitudeDeg * Math.PI) / 180);
  return { projection: 'equirectangular', lon0: centralMeridianDeg, parallel: centreLatitudeDeg, n: 0, F: cos, rho0: 0, valid: Number.isFinite(cos) && cos > 0 };
}

function longitudeDelta(longitude: number, centre: number): number {
  let delta = longitude - centre;
  while (delta < -180) delta += 360;
  while (delta >= 180) delta -= 360;
  return delta;
}

function rhoAt(geo: Lambert, latitudeDeg: number): number {
  const t = Math.tan(Math.PI / 4 + (latitudeDeg * Math.PI) / 180 / 2);
  if (!(t > 0)) return NaN;
  return geo.F / t ** geo.n;
}

export function project(geo: Lambert, latitude: number, longitude: number): { x: number; y: number } | null {
  if (geo.projection === 'equirectangular') {
    if (!geo.valid || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90) return null;
    const x = longitudeDelta(longitude, geo.lon0) * geo.F;
    if (!Number.isFinite(x)) return null;
    return { x, y: latitude };
  }
  if (!geo.valid || latitude <= -89 || latitude >= 89) return null;
  const rho = rhoAt(geo, latitude);
  if (!Number.isFinite(rho)) return null;
  const theta = geo.n * ((longitude - geo.lon0) * Math.PI) / 180;
  const x = rho * Math.sin(theta);
  const y = geo.rho0 - rho * Math.cos(theta);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function unproject(geo: Lambert, x: number, y: number): { lat: number; lon: number } | null {
  if (geo.projection === 'equirectangular') {
    if (!geo.valid || !Number.isFinite(x) || !Number.isFinite(y) || y < -90 || y > 90) return null;
    return { lat: y, lon: geo.lon0 + x / geo.F };
  }
  if (!geo.valid) return null;
  const dx = x;
  const dy = geo.rho0 - y;
  const theta = geo.n < 0 ? Math.atan2(-dx, -dy) : Math.atan2(dx, dy);
  const rho = (geo.n < 0 ? -1 : 1) * Math.hypot(dx, dy);
  if (!(Math.abs(rho) > 1e-15)) return null;
  const base = geo.F / rho;
  if (!(base > 0)) return null;
  const t = base ** (1 / geo.n);
  if (!(t > 0) || !Number.isFinite(t)) return null;
  const lat = (2 * Math.atan(t) - Math.PI / 2) * 180 / Math.PI;
  const lon = geo.lon0 + (theta / geo.n) * 180 / Math.PI;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

export interface SurfaceProjection {
  project(lat: number, lon: number, heightM?: number): { x: number; y: number; visible: boolean; depth: number };
  /** Height above the terrain sample, for atmospheric vectors and tracers. */
  projectAboveGround?(lat: number, lon: number, heightM: number): { x: number; y: number; visible: boolean; depth: number };
  unproject(x: number, y: number): { lat: number; lon: number } | null;
}

export interface Camera {
  /** Optional geographic cut through terrain and every atmospheric level. */
  slice?: AtmosphereSlice;
  /** Transient render projection; never stored as navigation state. */
  surface?: SurfaceProjection;
  pitch?: number;
  /** Clockwise look bearing in 3D; zero is north. */
  bearingRadians?: number;
  centerX: number;
  centerY: number;
  halfWidth: number;
  halfHeight: number;
}

export function cameraProject(camera: Camera, x: number, y: number): { x: number; y: number } {
  return {
    x: (x - camera.centerX) / camera.halfWidth,
    y: (y - camera.centerY) / camera.halfHeight,
  };
}

/** Shared geographic projection for all map ink and picking. */
export function mapProject(geo: Lambert, camera: Camera, lat: number, lon: number, heightM?: number): {x: number; y: number} | null {
  if (atmosphereSliceWeight(camera.slice, lat, lon) <= 0) return null;
  if (camera.surface) {
    const p = camera.surface.project(lat, lon, heightM);
    return p.visible && Number.isFinite(p.x + p.y) ? p : null;
  }
  const p = project(geo, lat, lon);
  if (!p) return null;
  if (geo.projection === 'equirectangular') p.x += Math.round((camera.centerX - p.x) / (360 * geo.F)) * 360 * geo.F;
  return cameraProject(camera, p.x, p.y);
}

/** Project a point a small physical distance above sampled terrain. */
export function mapProjectAboveGround(geo: Lambert, camera: Camera, lat: number, lon: number, heightM: number): {x: number; y: number} | null {
  if (atmosphereSliceWeight(camera.slice, lat, lon) <= 0) return null;
  if (!camera.surface) return mapProject(geo, camera, lat, lon);
  const p = camera.surface.projectAboveGround
    ? camera.surface.projectAboveGround(lat, lon, heightM)
    : camera.surface.project(lat, lon, heightM);
  return p.visible && Number.isFinite(p.x + p.y) ? { x: p.x, y: p.y } : null;
}

export function mapUnproject(geo: Lambert, camera: Camera, x: number, y: number): {lat: number; lon: number} | null {
  return camera.surface ? camera.surface.unproject(x, y) : unproject(geo, camera.centerX + x * camera.halfWidth, camera.centerY + y * camera.halfHeight);
}
