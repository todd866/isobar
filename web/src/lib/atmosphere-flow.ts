/** Spatial pressure-level vectors. Motion is illustrative; direction and height are sampled. */
import { mapProject, type Camera, type Lambert } from './lambert';
import type { PointModel } from './point/openmeteo';
export interface AtmosphereVector { lat: number; lon: number; heightM: number; u: number; v: number; w: number | null; pressure: number; phase: number; }
const LEVELS = [[925, 750], [850, 1500], [700, 3000], [500, 5500], [300, 9000]] as const;
/** Orbit latitude can pass the poles; sample the equivalent physical location. */
function geographicCentre(lat: number, lon: number) {
  lat = ((lat + 180) % 360 + 360) % 360 - 180;
  if (lat > 90) { lat = 180 - lat; lon += 180; }
  else if (lat < -90) { lat = -180 - lat; lon += 180; }
  return {lat, lon: ((lon + 180) % 360 + 360) % 360 - 180};
}
/** Smooth, deterministic wind shear and overturning cells for visual development.
 * This is synthetic at every location and date, never a weather reconstruction. */
export function syntheticAtmosphereWind(lat: number, lon: number, heightM: number, timeMs: number) {
  ({lat, lon} = geographicCentre(lat, lon));
  const phase = timeMs / 3600000 * .12;
  const x = lon * Math.PI * 6, y = lat * Math.PI * 6;
  const z = Math.max(0, Math.min(1, heightM / 10000));
  const cell = Math.cos(x + phase) * Math.cos(y - phase * .4);
  return { u: 8 + 20 * z + 3 * Math.sin(x + phase) * Math.cos(Math.PI * z),
    v: -5 + 16 * z + 3 * Math.sin(y - phase * .4) * Math.cos(Math.PI * z),
    w: 2.5 * cell * Math.sin(Math.PI * z) };
}
export function syntheticAtmosphereProfile(lat: number, lon: number, timeMs: number): PointModel {
  ({lat, lon} = geographicCentre(lat, lon));
  const run = new Date(timeMs).toISOString();
  return {latitude: lat, longitude: lon, elevationM: 0, surface: [],
    provenance: {source: 'Synthetic', model: 'Illustrative', run, cycle: false},
    series: {icao: 'ILLUSTRATIVE', lat, lon, elevationFt: 0, coastKm: null, source: 'Synthetic', model: 'Illustrative', run, runKnown: false,
      time: [timeMs - 3600000, timeMs + 3600000], levels: LEVELS.map(([hPa, z]) => {
        const wind = syntheticAtmosphereWind(lat, lon, z, timeMs);
        const speed = Math.hypot(wind.u, wind.v) / .514444;
        const from = (Math.atan2(-wind.u, -wind.v) * 180 / Math.PI + 360) % 360;
        return {hPa, z: [z, z], t: [25 - z * .0065, 25 - z * .0065], rh: [65, 65],
          cc: [hPa === 850 || hPa === 700 ? 65 : 0, hPa === 850 || hPa === 700 ? 65 : 0],
          ws: [speed, speed], wd: [from, from], w: [wind.w, wind.w]};
      })}};
}
export function syntheticAtmosphereVectors(lat: number, lon: number, halfHeight: number, aspect: number, timeMs: number): AtmosphereVector[] {
  if (![lat, lon, halfHeight, aspect, timeMs].every(Number.isFinite) || halfHeight <= 0 || halfHeight >= 6 || aspect <= 0) return [];
  ({lat, lon} = geographicCentre(lat, lon));
  // Geographic lattice stays fixed during a drag, instead of travelling with the camera.
  const spacing = 2 ** Math.ceil(Math.log2(halfHeight / 1.5));
  const lonSpacing = spacing / Math.max(.2, Math.cos(lat * Math.PI / 180));
  const south = Math.max(-90, Math.floor((lat - halfHeight * 2) / spacing) * spacing);
  const north = Math.min(90, lat + halfHeight * 2);
  const west = Math.floor((lon - halfHeight * aspect * 2) / lonSpacing) * lonSpacing;
  const east = lon + halfHeight * aspect * 2;
  const vectors: AtmosphereVector[] = [];
  for (let y = south; y <= north && vectors.length < 1800; y += spacing) for (let x = west; x <= east && vectors.length < 1800; x += lonSpacing) {
    for (const [pressure, heightM] of LEVELS) {
      const wind = syntheticAtmosphereWind(y, x, heightM, timeMs);
      vectors.push({lat: y, lon: x, heightM, ...wind, pressure, phase: ((Math.sin(y * 57 + x * 31 + pressure) * 43758.5) % 1 + 1) % 1});
    }
  }
  return vectors;
}
export function drawAtmosphereFlow(ctx: CanvasRenderingContext2D, vectors: readonly AtmosphereVector[], geo: Lambert, camera: Camera, width: number, height: number, seconds: number, dark: boolean): {layers: number; flows: number} {
  const layers = new Set<number>(); let flows = 0;
  // Visual separation adapts to map scale; the source profile keeps true model heights.
  const separation = 1 + (Math.min(8, Math.max(1, camera.halfHeight / .15)) - 1) * Math.sin(camera.pitch ?? 0);
  const lift = 1 + 5 * Math.sin(camera.pitch ?? 0);
  ctx.save(); ctx.lineCap = 'round'; ctx.lineWidth = 1.25;
  // Higher levels first. No cloud cylinders or displaced example column.
  for (let i = vectors.length - 1; i >= 0; i--) {
    const v = vectors[i], phase = (seconds / 5 + v.phase) % 1;
    const advance = (phase - .5) * 360;
    const screen = (time: number) => {
      const p = mapProject(geo, camera, v.lat + v.v * time / 111132, v.lon + v.u * time / (111320 * Math.max(.1, Math.cos(v.lat * Math.PI / 180))), (v.heightM + (v.w ?? 0) * time * lift) * separation);
      return p && {x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2};
    };
    const a = screen(advance - 90), b = screen(advance);
    if (!a || !b || b.x < -20 || b.x > width + 20 || b.y < -20 || b.y > height + 20) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1) continue;
    // Keep strokes legible at close zoom without hiding valid high-speed wind.
    if (length > 32) { a.x = b.x + (a.x - b.x) * 32 / length; a.y = b.y + (a.y - b.y) * 32 / length; }
    ctx.lineWidth = .85 + .75 * Math.min(1, v.heightM / 9000);
    ctx.globalAlpha = (.15 + .45 * Math.sin(Math.PI * phase)) * (v.pressure === 925 ? .7 : 1);
    ctx.strokeStyle = v.w != null && Math.abs(v.w) > .05 ? v.w > 0 ? (dark ? '#eeb172' : '#aa652f') : (dark ? '#84c6de' : '#246b89') : dark ? '#c4d8e1' : '#37596b';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x), head = Math.min(3, length / 3);
    ctx.moveTo(b.x - head * Math.cos(angle - .55), b.y - head * Math.sin(angle - .55)); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(angle + .55), b.y - head * Math.sin(angle + .55)); ctx.stroke();
    layers.add(v.pressure); flows++;
  }
  ctx.restore(); return {layers: layers.size, flows};
}
