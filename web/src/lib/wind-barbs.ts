import {createWindSampler} from './flow-wind';
import { mapProject, mapProjectAboveGround, mapUnproject } from './lambert';
import type { LoadedChart } from './chart-store';
import { blendReady, chartFrame } from './chart-store';
import { frameBlend } from './interpolate';
import { project, unproject, type Camera, type Lambert } from './lambert';

/** Sample a single cell in time, preserving missing values. Components are m/s. */
export function windComponent(chart: LoadedChart, name: string, cell: number, minute: number): number | null {
  const m = chart.manifest, spec = m.variables[name];
  const blend = frameBlend(m.forecastHours, m.forecastHours[0] * 60 + minute);
  if (!spec || !blend || !blendReady(chart, name, blend.i0, blend.i1)) return null;
  const a = chartFrame(chart, name, blend.i0)[cell], b = chartFrame(chart, name, blend.i1)[cell];
  if (a == null || b == null || a === spec.fill || b === spec.fill) return null;
  return (a + (b - a) * blend.t) * spec.scale + spec.offset;
}

const WIND_HEIGHT_M = 10;
const STAFF_PIXELS = 23;
const EARTH_RADIUS_M = 6_371_000;

function offsetGeo(lat: number, lon: number, eastM: number, northM: number): { lat: number; lon: number } {
  const distance = Math.hypot(eastM, northM);
  if (!(distance > 0)) return { lat, lon };
  const bearing = Math.atan2(eastM, northM), angular = distance / EARTH_RADIUS_M;
  const phi1 = lat * Math.PI / 180;
  const phi2 = Math.asin(Math.max(-1, Math.min(1, Math.sin(phi1) * Math.cos(angular) + Math.cos(phi1) * Math.sin(angular) * Math.cos(bearing))));
  const lambda2 = lon * Math.PI / 180 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(phi1), Math.cos(angular) - Math.sin(phi1) * Math.sin(phi2));
  return { lat: phi2 * 180 / Math.PI, lon: lambda2 * 180 / Math.PI };
}

function metresPerPixel(camera: Camera, height: number): number {
  const tilted = (camera as Camera & { tiltCamera?: { geometry?: { physicalScaleMPerClip?: number } } }).tiltCamera?.geometry?.physicalScaleMPerClip;
  if (tilted && Number.isFinite(tilted)) return tilted * 2 / Math.max(1, height);
  return camera.halfHeight * Math.PI / 180 * EARTH_RADIUS_M * 2 / Math.max(1, height);
}

function screenPoint(geo: Lambert, camera: Camera, lat: number, lon: number, width: number, height: number, aboveGround = WIND_HEIGHT_M): { x: number; y: number } | null {
  const p = camera.surface
    ? mapProjectAboveGround(geo, camera, lat, lon, aboveGround)
    : project(geo, lat, lon);
  if (!p) return null;
  if (!camera.surface && geo.projection === 'equirectangular') {
    const period = 360 * geo.F;
    p.x += Math.round((camera.centerX - p.x) / period) * period;
  }
  return camera.surface
    ? { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 }
    : { x: (1 + (p.x - camera.centerX) / camera.halfWidth) * width / 2, y: (1 - (p.y - camera.centerY) / camera.halfHeight) * height / 2 };
}

function drawProjectedBarb(ctx: CanvasRenderingContext2D, geo: Lambert, camera: Camera, ll: { lat: number; lon: number }, u: number, v: number, kt: number, width: number, height: number): boolean {
  const speed = Math.hypot(u, v);
  if (!(speed > 0)) return false;
  // A barb points from the source toward where the air came from. Every
  // point is projected independently through the globe/terrain camera: the
  // shaft and feathers therefore foreshorten and can disappear behind Earth.
  const staffMeters = STAFF_PIXELS * metresPerPixel(camera, height);
  const fromEast = -u / speed * staffMeters, fromNorth = -v / speed * staffMeters;
  const shaftTip = offsetGeo(ll.lat, ll.lon, fromEast, fromNorth);
  const base = screenPoint(geo, camera, ll.lat, ll.lon, width, height);
  const tip = screenPoint(geo, camera, shaftTip.lat, shaftTip.lon, width, height);
  if (!base || !tip || !Number.isFinite(tip.x + tip.y)) return false;
  const shaftLength = Math.hypot(tip.x - base.x, tip.y - base.y);
  if (!(shaftLength > 0.35) || shaftLength > Math.max(width, height) * 0.45) return false;
  const fromEastUnit = fromEast / staffMeters, fromNorthUnit = fromNorth / staffMeters;
  const hemisphere = ll.lat < 0 ? 1 : -1;
  const sideEast = hemisphere * -fromNorthUnit, sideNorth = hemisphere * fromEastUnit;
  const pointAt = (distanceM: number, sideM = 0) => {
    const p = offsetGeo(ll.lat, ll.lon, fromEastUnit * distanceM + sideEast * sideM, fromNorthUnit * distanceM + sideNorth * sideM);
    return screenPoint(geo, camera, p.lat, p.lon, width, height);
  };
  const stroke = (a: {x: number; y: number} | null, b: {x: number; y: number} | null) => {
    if (!a || !b) return;
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  };
  ctx.beginPath(); stroke(base, tip); ctx.stroke();
  let value = Math.round(kt / 5) * 5;
  let along = staffMeters;
  const feather = staffMeters * 0.24;
  while (value >= 50) {
    const a = pointAt(along), b = pointAt(along - feather, feather), c = pointAt(along + feather * 0.35, feather);
    if (a && b && c) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.fill(); }
    along -= feather * 0.72; value -= 50;
  }
  while (value >= 10) {
    stroke(pointAt(along), pointAt(along - feather * 0.7, feather));
    along -= feather * 0.58; value -= 10;
  }
  if (value >= 5) stroke(pointAt(along), pointAt(along - feather * 0.45, feather * 0.55));
  ctx.stroke();
  return true;
}

/** Matches OwnWindBarb(..., YES) in Sources/ownchart.m, in canvas y-down coordinates.
 * Thin conventional barbs. Shaft points FROM the wind; feathers are on its SH side. */
export function drawWindBarbs(ctx: CanvasRenderingContext2D, chart: LoadedChart, geo: Lambert, camera: Camera, width: number, height: number, dpr: number, minute: number, dark: boolean) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = dark ? '#ebe4d6' : '#202e38';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.65;
  const m = chart.manifest;
  const screen = (lat: number, lon: number) => {
    if (camera.surface) {
      const p = mapProject(geo, camera, lat, lon);
      return p && { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 };
    }
    const p = project(geo, lat, lon);
    if (p && geo.projection === 'equirectangular') {
      const period = 360 * geo.F;
      p.x += Math.round((camera.centerX - p.x) / period) * period;
    }
    return p && { x: (1 + (p.x - camera.centerX) / camera.halfWidth) * width / 2, y: (1 - (p.y - camera.centerY) / camera.halfHeight) * height / 2 };
  };
  const cycloneSample=chart.cyclone?createWindSampler(chart,minute):null;
  // Screen-spaced sampling keeps density and cost bounded while zooming.
  for (let y = 50; y < height - 20; y += 58) for (let x = 28; x < width - 20; x += 58) {
    const ll = mapUnproject(geo, camera, x / width * 2 - 1, 1 - y / height * 2);
    if (!ll || (!m.wrapsLongitude && (ll.lon < m.west || ll.lon > m.east)) || ll.lat > m.north || ll.lat < m.south) continue;
    const column = Math.round((ll.lon - m.west) / m.step);
    const i = m.wrapsLongitude ? ((column % m.nx) + m.nx) % m.nx : column;
    const j = Math.round((m.north - ll.lat) / (m.north - m.south) * (m.ny - 1));
    const reconstructed=cycloneSample?.(ll.lon,ll.lat);
    const u = reconstructed?.u??windComponent(chart, 'u10', j * m.nx + i, minute), v = reconstructed?.v??windComponent(chart, 'v10', j * m.nx + i, minute);
    if (u == null || v == null) continue;
    const kt = Math.hypot(u, v) * (reconstructed?1:1.943844);
    if (kt < 2.5) { ctx.beginPath(); ctx.arc(x, y, 2, 0, 2 * Math.PI); ctx.stroke(); continue; }
    if (camera.surface) {
      drawProjectedBarb(ctx, geo, camera, ll, u, v, kt, width, height);
      continue;
    }
    const from = screen(Math.max(-90, Math.min(90, ll.lat - v * 0.01)), ll.lon - u * 0.01 / Math.max(0.001, Math.cos(ll.lat * Math.PI / 180)));
    if (!from) continue;
    if (!camera.surface && geo.projection === 'equirectangular') {
      const period = 360 * geo.F / (2 * camera.halfWidth) * width;
      from.x += Math.round((x - from.x) / period) * period;
    }
    const angle = Math.atan2(from.y - y, from.x - x);
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
    if (ll.lat >= 0) ctx.scale(1, -1);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(23, 0); ctx.stroke();
    let value = Math.round(kt / 5) * 5, along = 23;
    while (value >= 50) { ctx.beginPath(); ctx.moveTo(along, 0); ctx.lineTo(along - 5, 0); ctx.lineTo(along + 2, -8); ctx.closePath(); ctx.fill(); along -= 7; value -= 50; }
    while (value >= 10) { ctx.beginPath(); ctx.moveTo(along, 0); ctx.lineTo(along + 3, -8); ctx.stroke(); along -= 4; value -= 10; }
    if (value >= 5) { ctx.beginPath(); ctx.moveTo(along, 0); ctx.lineTo(along + 1.5, -4); ctx.stroke(); }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
