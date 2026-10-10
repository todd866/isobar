import { cameraInside, clampToData, type DataFrame } from '../camera';
import { project, type Camera, type Lambert } from '../lambert';
import type { MapPoint } from './section';

export interface MapRect { left: number; top: number; width: number; height: number }

/** Screen rectangle still exposed beside/above the single point panel.
 * Read the fields: a DOMRect's left/top/width/height are prototype getters, so
 * spreading one drops them and the pan target becomes NaN. */
export function exposedMap(map: MapRect, panel: MapRect, side: boolean): MapRect {
  const base = { left: map.left, top: map.top, width: map.width, height: map.height };
  return side
    ? { ...base, width: Math.max(1, Math.min(base.width, panel.left - base.left)) }
    : { ...base, height: Math.max(1, Math.min(base.height, panel.top - base.top)) };
}

/** Use the copy next to the camera when the world has been panned over ±180°. */
export function projectPoint(geo: Lambert, point: MapPoint, camera: Camera) {
  const p = project(geo, point.lat, point.lon);
  if (p && geo.projection === 'equirectangular') {
    const world = 360 * geo.F;
    p.x += Math.round((camera.centerX - p.x) / world) * world;
  }
  return p;
}

/** Pan to the exposed centre. Only tighten scale if a grid edge prevents it. */
export function pointCamera(geo: Lambert, camera: Camera, frame: DataFrame, point: MapPoint, map: MapRect, visible: MapRect): Camera {
  const p = projectPoint(geo, point, camera);
  if (!p) return camera;
  const clipX = ((visible.left + visible.width / 2 - map.left) / map.width) * 2 - 1;
  const clipY = 1 - ((visible.top + visible.height / 2 - map.top) / map.height) * 2;
  const atScale = (scale: number): Camera => ({
    ...camera,
    centerX: p.x - clipX * camera.halfWidth * scale,
    centerY: p.y - clipY * camera.halfHeight * scale,
    halfWidth: camera.halfWidth * scale, halfHeight: camera.halfHeight * scale,
  });
  // Keep the whole canvas covered, including the part that will be revealed
  // when the panel closes. Moving past an edge can require a closer view.
  const fits = (scale: number) => cameraInside(geo, atScale(scale), frame.box);
  const target = atScale(1);
  if (fits(1)) return target;
  // A temporary point inspection may go closer than the manual zoom limit.
  // At the exact grid boundary, keep the point visible and missing data absent.
  const minScale = 1 / 1048576;
  if (!fits(minScale)) return target;
  let lo = minScale, hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return atScale(lo);
}

/** Same resize convention as the map: retain zoom and displacement from home. */
export function reframeCamera(geo: Lambert, camera: Camera, old: DataFrame, next: DataFrame): Camera {
  if (old === next) return { ...camera };
  const scaleX = next.home.halfWidth / old.home.halfWidth;
  const scaleY = next.home.halfHeight / old.home.halfHeight;
  return clampToData(geo, {
    ...camera,
    centerX: next.home.centerX + (camera.centerX - old.home.centerX) * scaleX,
    centerY: next.home.centerY + (camera.centerY - old.home.centerY) * scaleY,
    halfWidth: camera.halfWidth * scaleX,
    halfHeight: camera.halfHeight * scaleY,
  }, next);
}

export interface CameraMove {
  from: Camera;
  to: Camera;
  start: number;
  duration: number;
  /** Cubic ease-out for a map glide. Omitted pans use smoothstep. */
  ease?: 'out';
}
export function cameraDuringMove(move: CameraMove, now: number): Camera {
  const t = Math.max(0, Math.min(1, move.duration ? (now - move.start) / move.duration : 1));
  if (t === 0) return { ...move.from };
  if (t === 1) return { ...move.to };
  const ease = move.ease === 'out' ? 1 - (1 - t) ** 3 : t * t * (3 - 2 * t);
  const mix = (key: 'centerX' | 'centerY' | 'halfWidth' | 'halfHeight') => move.from[key] + (move.to[key] - move.from[key]) * ease;
  const bearing = move.from.bearingRadians ?? 0, delta = (move.to.bearingRadians ?? 0) - bearing;
  return { ...move.from, ...(move.from.bearingRadians !== undefined || move.to.bearingRadians !== undefined ? {bearingRadians: bearing + Math.atan2(Math.sin(delta), Math.cos(delta)) * ease} : {}), centerX: mix('centerX'), centerY: mix('centerY'), halfWidth: mix('halfWidth'), halfHeight: mix('halfHeight') };
}
