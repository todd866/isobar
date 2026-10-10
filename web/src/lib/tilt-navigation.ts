import { createTiltCamera, forwardProject, inverseUnproject, inverseAtAltitude, type TiltCamera } from './tilt-camera';
import { mapUnproject, project, unproject, type Camera, type Lambert } from './lambert';
import { clampToData, zoomWithinData, type DataFrame } from './camera';

export type TiltedCamera = Camera & { tiltCamera?: TiltCamera };
export const MAX_TILT = 75 * Math.PI / 180;
export function withTilt(geo: Lambert, camera: Camera, pitch: number, elevation?: ((lon: number, lat: number) => number | null) | null): TiltedCamera {
  if (pitch <= 0 || geo.projection !== 'equirectangular') return camera;
  const center = unproject(geo, camera.centerX, camera.centerY);
  if (!center) return camera;
  const tiltCamera = createTiltCamera({ ...center, halfHeightDeg: camera.halfHeight, aspect: camera.halfWidth / camera.halfHeight, tiltRadians: pitch });
  return { ...camera, pitch, tiltCamera, surface: {
    project(lat, lon, height) { return forwardProject(tiltCamera, lat, lon, height ?? elevation?.(lon, lat) ?? 0) ?? { x: Infinity, y: Infinity, visible: false, depth: Infinity }; },
    projectAboveGround(lat, lon, height) {
      const ground = elevation?.(lon, lat) ?? 0;
      return forwardProject(tiltCamera, lat, lon, ground + Math.max(0, height)) ?? { x: Infinity, y: Infinity, visible: false, depth: Infinity };
    },
    unproject(x, y) {
      let hit = inverseUnproject(tiltCamera, x, y);
      for (let i = 0; i < 4 && hit && elevation; i++) {
        const h = elevation(hit.lon, hit.lat);
        if (h == null) break;
        hit = inverseAtAltitude(tiltCamera, x, y, Math.max(0, h)) ?? hit;
      }
      return hit;
    },
  } };
}

/** Solve the geographic pointer anchor after zoom/pan. A ray over space cannot pan Earth. */
export function anchorTilt(geo: Lambert, camera: Camera, pitch: number, point: {lat: number; lon: number}, x: number, y: number, frame: DataFrame, elevation?: ((lon: number, lat: number) => number | null) | null): Camera {
  let next = camera;
  for (let i = 0; i < 8; i++) {
    const hit = mapUnproject(geo, withTilt(geo, next, pitch, elevation), x, y);
    if (!hit) break;
    const dLon = ((point.lon - hit.lon + 540) % 360) - 180;
    const lat = Math.max(-89.99, Math.min(89.99, next.centerY + point.lat - hit.lat));
    const p = project(geo, lat, geo.lon0 + next.centerX / geo.F + dLon);
    if (!p) break;
    next = clampToData(geo, { ...next, centerX: p.x, centerY: p.y }, frame);
    if (Math.abs(point.lat - hit.lat) + Math.abs(dLon) < 1e-7) break;
  }
  return next;
}
export function zoomTilt(geo: Lambert, camera: Camera, pitch: number, x: number, y: number, factor: number, frame: DataFrame, elevation?: ((lon: number, lat: number) => number | null) | null): Camera {
  if (!pitch) return zoomWithinData(geo, camera, x, y, factor, frame);
  const point = mapUnproject(geo, withTilt(geo, camera, pitch, elevation), x, y);
  const next = zoomWithinData(geo, camera, 0, 0, factor, frame);
  return point ? anchorTilt(geo, next, pitch, point, x, y, frame, elevation) : next;
}
