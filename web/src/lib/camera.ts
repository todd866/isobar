import { australiaLambert, project, unproject, type Camera, type Lambert } from './lambert';

/** Mainland, Tasmania and the Top End/Cape York, with a small margin. */
const FRAME = { west: 112.5, east: 154, south: -44, north: -10 };

function australiaBox(): { centerX: number; centerY: number; halfWidth: number; halfHeight: number } {
  const geo = australiaLambert();
  const { west, east, south, north } = FRAME;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let lon = west; lon <= east; lon += 0.5) {
    for (const lat of [south, north]) {
      const point = project(geo, lat, lon);
      if (!point) continue;
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }
  for (let lat = south; lat <= north; lat += 0.5) {
    for (const lon of [west, east]) {
      const point = project(geo, lat, lon);
      if (!point) continue;
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }
  return {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    halfWidth: ((maxX - minX) * 1.04) / 2,
    halfHeight: ((maxY - minY) * 1.04) / 2,
  };
}

export function australiaFrameAspect(): number {
  const box = australiaBox();
  return box.halfWidth / box.halfHeight;
}

export function fitAustralia(width: number, height: number): Camera {
  const box = australiaBox();
  const aspect = width / Math.max(1, height);
  let { halfWidth, halfHeight } = box;
  if (halfWidth / halfHeight < aspect) halfWidth = halfHeight * aspect;
  else halfHeight = halfWidth / aspect;
  return { centerX: box.centerX, centerY: box.centerY, halfWidth, halfHeight };
}

export function zoomAbout(geo: Lambert, camera: Camera, clipX: number, clipY: number, factor: number): Camera {
  const next = {
    ...camera,
    halfWidth: camera.halfWidth * factor,
    halfHeight: camera.halfHeight * factor,
  };
  const before = unproject(geo, camera.centerX + clipX * camera.halfWidth, camera.centerY + clipY * camera.halfHeight);
  if (!before) return next;
  const projected = project(geo, before.lat, before.lon);
  if (!projected) return next;
  next.centerX = projected.x - clipX * next.halfWidth;
  next.centerY = projected.y - clipY * next.halfHeight;
  return next;
}

export function panBy(camera: Camera, clipDx: number, clipDy: number): Camera {
  return {
    ...camera,
    centerX: camera.centerX - clipDx * camera.halfWidth,
    centerY: camera.centerY - clipDy * camera.halfHeight,
  };
}

/** A geographic box the view must stay inside (the data grid less its faded edge). */
export interface DataBox {
  west: number;
  east: number;
  south: number;
  north: number;
}

export function insetBox(box: DataBox, degrees: number): DataBox {
  return { west: box.west + degrees, east: box.east - degrees, south: box.south + degrees, north: box.north - degrees };
}

const EDGE_SAMPLES = 16;

/** True when every point on the camera's edge lies inside `box` (so the whole view does). */
export function cameraInside(geo: Lambert, camera: Camera, box: DataBox): boolean {
  const { centerX, centerY, halfWidth, halfHeight } = camera;
  if (geo.projection === 'equirectangular') {
    const worldHalfWidth = 180 * geo.F;
    return halfWidth <= worldHalfWidth + 1e-6
      && centerY - halfHeight >= box.south - 1e-6
      && centerY + halfHeight <= box.north + 1e-6;
  }
  const test = (x: number, y: number) => {
    const point = unproject(geo, centerX + x * halfWidth, centerY + y * halfHeight);
    return !!point && point.lon >= box.west && point.lon <= box.east && point.lat >= box.south && point.lat <= box.north;
  };
  for (let k = 0; k <= EDGE_SAMPLES; k += 1) {
    const t = (k / EDGE_SAMPLES) * 2 - 1;
    if (!test(t, -1) || !test(t, 1) || !test(-1, t) || !test(1, t)) return false;
  }
  return true;
}

function sized(camera: Camera, halfWidth: number): Camera {
  return { ...camera, halfWidth, halfHeight: halfWidth * (camera.halfHeight / camera.halfWidth) };
}

/** Moves the centre from `from` (valid) toward `to` along one axis as far as the box allows. */
function slide(geo: Lambert, from: Camera, toX: number, toY: number, box: DataBox): Camera {
  const at = { ...from, centerX: toX, centerY: toY };
  if (cameraInside(geo, at, box)) return at;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 18; k += 1) {
    const mid = (lo + hi) / 2;
    const probe = { ...from, centerX: from.centerX + (toX - from.centerX) * mid, centerY: from.centerY + (toY - from.centerY) * mid };
    if (cameraInside(geo, probe, box)) lo = mid;
    else hi = mid;
  }
  return { ...from, centerX: from.centerX + (toX - from.centerX) * lo, centerY: from.centerY + (toY - from.centerY) * lo };
}

/** The valid centre nearest `target`, starting from a centre `anchor` known to be valid at this size. */
function nearestInside(geo: Lambert, target: Camera, anchor: Camera, box: DataBox): Camera {
  let camera = { ...target, centerX: anchor.centerX, centerY: anchor.centerY };
  camera = slide(geo, camera, target.centerX, camera.centerY, box);
  camera = slide(geo, camera, camera.centerX, target.centerY, box);
  camera = slide(geo, camera, target.centerX, camera.centerY, box);
  return camera;
}

export interface DataFrame {
  /** Australia framed as closely as the data allows: the view on open and on Recenter. */
  home: Camera;
  /** The widest view that stays inside the data: the zoom-out limit. */
  widest: Camera;
  box: DataBox;
}

/**
 * Cover-fit framing: the view never shows past the data grid, at any panel size.
 * Australia is fitted when the data reaches far enough; otherwise the view zooms
 * in until it fits, centred as near Australia as the grid allows.
 */
export function frameData(geo: Lambert, width: number, height: number, box: DataBox, focus?: { lat: number; lon: number }): DataFrame {
  if (geo.projection === 'equirectangular') {
    const worldHalfWidth = 180 * geo.F;
    const aspect = width / Math.max(1, height);
    const halfHeight = aspect >= 2 ? worldHalfWidth / aspect : 90;
    const halfWidth = halfHeight * aspect;
    const widest = { centerX: 0, centerY: 0, halfWidth, halfHeight };
    if (!focus) return { home: widest, widest, box };
    const homeHalfWidth = Math.min(45 * geo.F, 25 * aspect);
    const homeHalfHeight = homeHalfWidth / aspect;
    const point = project(geo, Math.max(box.south, Math.min(box.north, focus.lat)), focus.lon);
    if (!point) return { home: widest, widest, box };
    const centerY = Math.max(box.south + homeHalfHeight, Math.min(box.north - homeHalfHeight, point.y));
    const home = { centerX: point.x, centerY, halfWidth: homeHalfWidth, halfHeight: homeHalfHeight };
    return { home, widest, box };
  }
  const australia = fitAustralia(width, height);
  const aspect = australia.halfWidth / australia.halfHeight;
  // The box's projected extent bounds every candidate centre.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let k = 0; k <= 40; k += 1) {
    const lon = box.west + ((box.east - box.west) * k) / 40;
    const lat = box.south + ((box.north - box.south) * k) / 40;
    for (const point of [project(geo, box.south, lon), project(geo, box.north, lon), project(geo, lat, box.west), project(geo, lat, box.east)]) {
      if (!point) continue;
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }
  const placeAt = (halfWidth: number): Camera | null => {
    let best: Camera | null = null;
    let bestDistance = Infinity;
    const steps = 16;
    for (let i = 0; i <= steps; i += 1) {
      for (let j = 0; j <= steps; j += 1) {
        const camera = {
          centerX: minX + ((maxX - minX) * i) / steps,
          centerY: minY + ((maxY - minY) * j) / steps,
          halfWidth,
          halfHeight: halfWidth / aspect,
        };
        const distance = Math.hypot(camera.centerX - australia.centerX, camera.centerY - australia.centerY);
        if (distance < bestDistance && cameraInside(geo, camera, box)) {
          best = camera;
          bestDistance = distance;
        }
      }
    }
    return best;
  };
  let lo = 0;
  let hi = Math.max(maxX - minX, (maxY - minY) * aspect) / 2;
  let widest: Camera | null = null;
  for (let k = 0; k < 18; k += 1) {
    const mid = (lo + hi) / 2;
    const found = placeAt(mid);
    if (found) {
      lo = mid;
      widest = found;
    } else hi = mid;
  }
  if (!widest) return { home: australia, widest: australia, box };
  widest = nearestInside(geo, { ...widest, centerX: australia.centerX, centerY: australia.centerY }, widest, box);
  const home = nearestInside(geo, sized(australia, Math.min(australia.halfWidth, widest.halfWidth)), widest, box);
  return { home, widest, box };
}

/** Closest zoom, as a fraction of home: about 60 km across over Australia (owner, 9 Oct: "I need to be able to zoom in more"). */
export const ZOOM_IN_LIMIT = 64;
/** 222 m north–south at closest global view; measured DEM resolution is independent. */
export const MIN_GLOBAL_HALF_HEIGHT = .001;

/** Limits zoom (1/ZOOM_IN_LIMIT of home to the widest view) and keeps the whole view inside the data. */
export function clampToData(geo: Lambert, camera: Camera, frame: DataFrame): Camera {
  const min = geo.projection === 'equirectangular' ? MIN_GLOBAL_HALF_HEIGHT * camera.halfWidth / camera.halfHeight : frame.home.halfWidth / ZOOM_IN_LIMIT;
  const halfWidth = Math.min(frame.widest.halfWidth, Math.max(min, camera.halfWidth));
  const target = sized(camera, halfWidth);
  if (cameraInside(geo, target, frame.box)) return target;
  // Any view no larger than the widest one fits at the widest view's centre.
  return nearestInside(geo, target, frame.widest, frame.box);
}

/** Clamp scale before solving the pointer anchor. Otherwise repeated pinches
 * at the zoom limit drift sideways despite no longer changing scale. Geographic
 * coverage still takes precedence when an anchored view reaches the grid edge.
 */
export function zoomWithinData(geo: Lambert, camera: Camera, clipX: number, clipY: number, factor: number, frame: DataFrame): Camera {
  if (![clipX, clipY, factor].every(Number.isFinite) || factor <= 0 || !(camera.halfWidth > 0)) return camera;
  // Geographic zoom is independent of weather resolution; close terrain does not imply finer forecast data.
  const floor = geo.projection === 'equirectangular' && camera.halfHeight > 0 ? MIN_GLOBAL_HALF_HEIGHT * (camera.halfWidth / camera.halfHeight) : frame.home.halfWidth / ZOOM_IN_LIMIT;
  const width = Math.min(frame.widest.halfWidth, Math.max(floor, camera.halfWidth * factor));
  return clampToData(geo, zoomAbout(geo, camera, clipX, clipY, width / camera.halfWidth), frame);
}

/** Australia's extremities: Steep Point, Cape Byron, South East Cape (Tasmania), Cape York. */
const COAST_EXTENT = { west: 113.2, east: 153.6, south: -43.6, north: -10.7 };

/** True when the whole mainland and Tasmania are inside the camera. */
export function showsAustralia(geo: Lambert, camera: Camera): boolean {
  if (geo.projection === 'equirectangular') return false;
  const { west, east, south, north } = COAST_EXTENT;
  for (let k = 0; k <= 20; k += 1) {
    const lon = west + ((east - west) * k) / 20;
    const lat = south + ((north - south) * k) / 20;
    for (const point of [project(geo, south, lon), project(geo, north, lon), project(geo, lat, west), project(geo, lat, east)]) {
      if (!point) return false;
      if (Math.abs(point.x - camera.centerX) > camera.halfWidth || Math.abs(point.y - camera.centerY) > camera.halfHeight) return false;
    }
  }
  return true;
}

const aspectCache = new Map<string, { min: number; max: number }>();

/**
 * The panel aspect ratios (width / height) at which the data grid can frame all
 * of Australia. Outside this range the panel is narrowed instead of the map
 * showing past the data.
 */
export function australiaAspects(geo: Lambert, box: DataBox): { min: number; max: number } {
  if (geo.projection === 'equirectangular') return { min: 0, max: Infinity };
  const key = `${box.west}:${box.east}:${box.south}:${box.north}`;
  const cached = aspectCache.get(key);
  if (cached) return cached;
  const fits = (aspect: number) => showsAustralia(geo, frameData(geo, 1000 * aspect, 1000, box).home);
  let lo = 1;
  let hi = 3;
  for (let k = 0; k < 14; k += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  const max = lo;
  lo = 0.3;
  hi = 1;
  for (let k = 0; k < 14; k += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  const result = { min: hi, max };
  aspectCache.set(key, result);
  return result;
}
