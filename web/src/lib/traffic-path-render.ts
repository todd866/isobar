import { trafficScreen, distanceNm, type TrafficTrail } from './traffic';
import { greatCircle, type FlightRoute, type TrafficSelection } from './traffic-paths';
import type { Camera, Lambert } from './lambert';

const LIGHT = ['#007e75', '#926100', '#be234c', '#4356b4', '#843fbd', '#397920', '#b54c16', '#087aaa'];
const DARK = ['#35d6c7', '#ffca5c', '#ff718d', '#8da7ff', '#c792ff', '#8ee06e', '#ff976b', '#61b9ff'];
export function trackColor(index: number, dark: boolean): string { return (dark ? DARK : LIGHT)[index % 8]; }

type ScreenPoint = { x: number; y: number };
/** Keep endpoints and turns to within a quarter CSS pixel, after gap splitting. */
function traceRun(path: Path2D, points: readonly ScreenPoint[]): void {
  path.moveTo(points[0].x, points[0].y);
  const visit = (start: number, end: number) => {
    const a = points[start], b = points[end], dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
    let farthest = -1, error2 = .25 * .25;
    for (let i = start + 1; i < end; i++) {
      const p = points[i];
      const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
      const d = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
      if (d > error2) { farthest = i; error2 = d; }
    }
    if (farthest >= 0) { visit(start, farthest); visit(farthest, end); }
    else path.lineTo(b.x, b.y);
  };
  visit(0, points.length - 1);
}

/** Actual observations only. Gaps over five minutes are deliberately unconnected. */
export function paintTrafficPaths(ctx: CanvasRenderingContext2D, input: {
  selected: readonly TrafficSelection[];
  /** Replay clips observed paths and omits today's route prediction. */
  timeMs?: number;
  trails: ReadonlyMap<string, TrafficTrail>;
  routes: ReadonlyMap<string, FlightRoute | null>;
  geo: Lambert; camera: Camera; width: number; height: number; dark: boolean;
}): void {
  const screen = (p: { latitude: number; longitude: number }) => trafficScreen(input.geo, input.camera, input.width, input.height, p.latitude, p.longitude);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const selection of input.selected) {
    const original = input.trails.get(selection.hex);
    if (!original) continue;
    const trail = input.timeMs == null ? original : { ...original, points: original.points.filter((point) => point.timeMs <= input.timeMs!) };
    const ink = trackColor(selection.colorIndex, input.dark);
    // Batch observed segments by visual width. An eighth-pixel step keeps the
    // altitude encoding while bounding the work to 25 widths per selected path,
    // instead of two canvas strokes for each of up to 240 observations.
    const segments = new Map<number, ScreenPoint[][]>();
    let lastIndex = -1, lastWidth = -1, run: ScreenPoint[] = [];
    const positions = trail.points.map(screen);
    for (let i = 1; i < trail.points.length; i++) {
      const prior = trail.points[i - 1], point = trail.points[i];
      const elapsed = (point.timeMs - prior.timeMs) / 1000;
      if (elapsed > 300 || elapsed <= 0 || distanceNm(prior.latitude, prior.longitude, point.latitude, point.longitude) / elapsed > 1500 / 3600) continue;
      const a = positions[i - 1], b = positions[i];
      if (!a || !b || Math.abs(a.x - b.x) > input.width * .75) continue;
      const altitude = Number.isFinite(point.pressureAltitudeFt) ? point.pressureAltitudeFt! : 0;
      const thickness = Math.round((1.5 + Math.min(45000, Math.max(0, altitude)) / 15000) * 8) / 8;
      if (lastIndex !== i - 1 || thickness !== lastWidth) {
        run = [a];
        const group = segments.get(thickness) ?? [];
        group.push(run); segments.set(thickness, group);
      }
      run.push(b); lastIndex = i; lastWidth = thickness;
    }
    const paths = [...segments].map(([thickness, runs]) => {
      const path = new Path2D();
      for (const run of runs) traceRun(path, run);
      return { thickness, path };
    });
    ctx.globalAlpha = .85; ctx.strokeStyle = input.dark ? '#172536' : '#ffffff';
    for (const { thickness, path } of paths) { ctx.lineWidth = thickness + 2; ctx.stroke(path); }
    ctx.globalAlpha = .95; ctx.strokeStyle = ink;
    for (const { thickness, path } of paths) { ctx.lineWidth = thickness; ctx.stroke(path); }
    const last = trail.points.at(-1);
    const route = input.routes.get(trail.aircraft.callsign);
    if (!last || !route || input.timeMs != null) continue;
    const projected = greatCircle(last, route.destination, 64).map(screen);
    ctx.globalAlpha = .5; ctx.strokeStyle = ink; ctx.lineWidth = 1.5; ctx.setLineDash([4, 5]);
    ctx.beginPath();
    for (let i = 1; i < projected.length; i++) {
      const a = projected[i - 1], b = projected[i];
      if (a && b && Math.abs(a.x - b.x) < input.width * .75) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    }
    ctx.stroke(); ctx.setLineDash([]);
    const end = screen(route.destination);
    if (end && end.x >= 8 && end.y >= 8 && end.x <= input.width - 8 && end.y <= input.height - 8) {
      ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(end.x, end.y, 4, 0, Math.PI * 2); ctx.stroke();
      ctx.font = '600 11px system-ui'; ctx.fillStyle = ink; ctx.fillText(route.destination.icao, end.x + 7, end.y - 5);
    }
  }
  ctx.restore();
}
