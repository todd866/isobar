import { mapProjectAboveGround, mapUnproject } from './lambert';
/** Published 10 m flow, beneath the isobars. Screen-area density, geographic
 * trajectories, bounded Canvas2D paths, and no camera-triggered field reset. */
import { type LoadedChart } from './chart-store';
import { createWindSampler, type WindSampler, type WindDisplaySource } from './flow-wind';
import {
  advectInto, ageFade, cameraBounds, FLOW_FADE_SECONDS, FLOW_LIFE_SECONDS, hash01,
  MIN_STREAK_SPEED_MS, particleCount, smoothFade, stepParticle, streakInk,
  type GeoPoint, type Particle,
} from './flow';
import { project, unproject, type Camera, type Lambert } from './lambert';

export interface FlowSample {
  lon: number;
  lat: number;
  /** Mean eastward degrees of particles that advected this frame. */
  shift: number;
  /** Mean degrees travelled by particles that advected this frame. */
  travel: number;
  drawn: number;
  mode: 'live' | 'static' | 'waiting';
  windSource: WindDisplaySource;
}

export interface FlowDraw {
  chart: LoadedChart;
  /** Minutes after the first forecast hour, the playhead. */
  minute: number;
  geo: Lambert;
  camera: Camera;
  dark: boolean;
  windLens: boolean;
  reduced: boolean;
  dt: number;
  cssWidth: number;
  cssHeight: number;
}

// Fine opacity steps include near-zero ink: the old four buckets made even a
// dying streak jump back to 15% opacity. Paths remain batched, not per-particle.
const OPACITY_STEPS = 64;
const MAX_ALPHA = 0.8;
interface Tracer extends Particle { retiring: number | null; windAt?: WindSampler }

export interface FlowLayer {
  draw(input: FlowDraw): FlowSample;
  sample(): FlowSample;
  destroy(): void;
}

export function createFlowLayer(canvas: HTMLCanvasElement): FlowLayer | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  let particles: Tracer[] = [];
  let outgoing: Tracer[] = [];
  let serial = 0;
  let appearance = 0;
  let sourceAppearance = FLOW_FADE_SECONDS;
  let previousSampler: WindSampler | null = null;
  let previousCamera: Camera | null = null;
  let previousChart: LoadedChart | null = null;
  let densityChanged = false;
  const buckets: number[][] = Array.from({ length: OPACITY_STEPS }, () => []);
  let latest: FlowSample = { lon: 0, lat: 0, shift: 0, travel: 0, drawn: 0, mode: 'waiting', windSource: 'unavailable' };

  return {
    sample: () => latest,
    destroy() { particles = []; outgoing = []; },
    draw(input) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = input.cssWidth, height = input.cssHeight;
      // Keep continental/world views quiet. A fixed 34 px trail spans many
      // different weather systems when the whole world fits on the screen.
      const flatBounds = input.geo.projection === 'equirectangular' ? null : cameraBounds(input.geo, { ...input.camera, surface: undefined });
      const latitudeSpan = input.geo.projection === 'equirectangular' ? input.camera.halfHeight * 2
        : flatBounds ? flatBounds.north - flatBounds.south : 180;
      const overviewScale = Math.max(0.5, Math.min(1, Math.sqrt(24 / Math.max(24, latitudeSpan))));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const windAt = createWindSampler(input.chart, input.minute);
      if (previousChart !== input.chart) {
        particles = []; outgoing = []; previousChart = input.chart;
        previousSampler = null; sourceAppearance = FLOW_FADE_SECONDS;
      }
      if (!windAt || !(width > 0 && height > 0)) {
        latest = { ...latest, drawn: 0, shift: 0, travel: 0, mode: 'waiting', windSource: 'unavailable' };
        canvas.dataset.windSource = 'unavailable';
        if (canvas.dataset.flow !== 'waiting') canvas.dataset.flow = 'waiting';
        return latest;
      }
      const count = particleCount(width * height, input.windLens);
      const dt = Math.min(0.05, Math.max(0, input.dt));
      if (previousSampler && previousSampler.source !== windAt.source && particles.length && !input.reduced) {
        // Crossfade ink, not vectors: opposing winds must never cancel to a
        // blank calm frame. Reuse the same positions and the existing 2N cap.
        outgoing = particles.slice(0, count).map((p) => ({ ...p, retiring: 0, windAt: previousSampler! }));
        sourceAppearance = 0;
      }
      previousSampler = windAt;
      sourceAppearance = input.reduced ? FLOW_FADE_SECONDS : Math.min(FLOW_FADE_SECONDS, sourceAppearance + dt);
      const source: WindDisplaySource = sourceAppearance < FLOW_FADE_SECONDS ? `to-${windAt.source}` : windAt.source;
      if (canvas.dataset.windSource !== source) canvas.dataset.windSource = source;
      const screen = (p: GeoPoint) => toScreen(input.geo, input.camera, p.lat, p.lon, width, height);
      // About four tracers per screen cell. Replenish the sparsest cells, so
      // zooming out does not leave all the ink clustered in the old viewport.
      const cols = Math.max(1, Math.round(Math.sqrt(count / 4 * width / height)));
      const rows = Math.max(1, Math.round(count / 4 / cols));
      const occupancy = new Uint16Array(cols * rows);
      const cellOf = (p: GeoPoint) => {
        const s = screen(p);
        if (!s || s.x < 0 || s.x >= width || s.y < 0 || s.y >= height) return -1;
        return Math.floor(s.y / height * rows) * cols + Math.floor(s.x / width * cols);
      };
      for (const p of particles) { const cell = cellOf(p); if (cell >= 0) occupancy[cell] += 1; }
      const spawn = (age = 0): Tracer => {
        const id = serial++;
        let cell = id % occupancy.length;
        for (let j = 1; j < occupancy.length; j += 1) {
          const next = (id + j) % occupancy.length;
          if (occupancy[next] < occupancy[cell]) cell = next;
        }
        occupancy[cell] += 1;
        const x = ((cell % cols) + hash01(id * 2 + 1)) / cols;
        const y = (Math.floor(cell / cols) + hash01(id * 2 + 2)) / rows;
        const geo = mapUnproject(input.geo, input.camera, x * 2 - 1, 1 - y * 2);
        const lon = geo?.lon ?? NaN, lat = geo?.lat ?? NaN;
        return { lon, lat, seedLon: lon, seedLat: lat, age, retiring: null };
      };
      const retire = (p: Tracer) => {
        // At most one outgoing population; the new population fades in while
        // the old one fades out at its own geographic positions.
        if (!input.reduced && outgoing.length < count) { p.retiring = 0; outgoing.push(p); }
      };
      const initial = particles.length === 0;
      while (particles.length < count) {
        // Stagger lifetimes but fade the entire first appearance in below.
        particles.push(spawn(initial ? hash01(serial + 71) * FLOW_LIFE_SECONDS : 0));
      }
      while (particles.length > count) retire(particles.pop()!);
      if (previousCamera && (previousCamera.pitch !== input.camera.pitch || previousCamera.centerX !== input.camera.centerX || previousCamera.centerY !== input.camera.centerY ||
        previousCamera.halfWidth !== input.camera.halfWidth || previousCamera.halfHeight !== input.camera.halfHeight)) densityChanged = true;
      previousCamera = { ...input.camera };
      const cap = Math.ceil(count / occupancy.length * 1.5);
      let redistribution = Math.max(1, Math.ceil(count * dt));
      let crowded = false;
      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        const cell = cellOf(p);
        const expired = !input.reduced && p.age + dt >= FLOW_LIFE_SECONDS;
        const excess = densityChanged && cell >= 0 && occupancy[cell] > cap;
        if (excess) crowded = true;
        if (cell < 0 || expired || (excess && redistribution > 0)) {
          if (cell >= 0) occupancy[cell] -= 1;
          if (!expired && cell >= 0) { retire(p); redistribution -= 1; }
          particles[i] = spawn();
        }
      }
      if (!crowded) densityChanged = false;
      for (const bucket of buckets) bucket.length = 0;
      let shift = 0, travel = 0, shifted = 0, drawn = 0;
      let probeLon = particles[0]?.lon ?? 0, probeLat = particles[0]?.lat ?? 0;
      // A separate appearance fade avoids a fully bright first frame while
      // preserving a uniform age distribution (no mass respawn 12 s later).
      if (initial) appearance = 0;
      appearance = Math.min(FLOW_FADE_SECONDS, appearance + dt);
      const drawParticle = (p: Tracer, index: number) => {
        if (p.retiring !== null && p.age + dt >= FLOW_LIFE_SECONDS) { p.age = FLOW_LIFE_SECONDS; return; }
        const sample = p.windAt ?? windAt;
        const wind = sample(p.lon, p.lat);
        if (!wind) { p.age = FLOW_LIFE_SECONDS; return; }
        const beforeLon = p.lon, beforeLat = p.lat;
        const retiredForTurn = stepParticle(p, wind.u, wind.v, dt, input.reduced);
        if (index === 0) { probeLon = p.lon; probeLat = p.lat; }
        if (retiredForTurn) return;
        if (p.retiring === null) {
          shift += p.lon - beforeLon; travel += Math.hypot(p.lon - beforeLon, p.lat - beforeLat); shifted += 1;
        } else p.retiring += dt;
        const headWind = sample(p.lon, p.lat);
        if (!headWind || Math.hypot(headWind.u, headWind.v) < MIN_STREAK_SPEED_MS) return;
        const ink = streakInk(Math.hypot(headWind.u, headWind.v), input.windLens);
        const fade = input.reduced ? 1 : ageFade(p.age) * smoothFade(appearance / FLOW_FADE_SECONDS) *
          (p.retiring === null ? smoothFade(sourceAppearance / FLOW_FADE_SECONDS) : smoothFade(1 - p.retiring / FLOW_FADE_SECONDS));
        const alpha = ink.alpha * fade;
        if (alpha < MAX_ALPHA / OPACITY_STEPS / 2) return;
        let here = screen(p);
        if (!here) return;
        // Fade at the viewport edge before recycling an offscreen particle.
        const edge = smoothFade(Math.min(here.x, here.y, width - here.x, height - here.y) / 24);
        const length = (input.reduced ? Math.min(ink.lengthPx, 9) : ink.lengthPx) * overviewScale;
        const tail = { lon: p.lon, lat: p.lat };
        let vector: { u: number; v: number } | null = headWind;
        let tailHeading = Math.atan2(vector.v, vector.u);
        let tailTurn = 0;
        // Short backwards integration preserves curvature and the model's
        // cross-isobar component. Never rotate a vector to match a contour.
        let emitted = false;
        for (let part = 0; part < 3 && vector; part += 1) {
          if (Math.hypot(vector.u, vector.v) < MIN_STREAK_SPEED_MS) break;
          const ahead = { lon: tail.lon, lat: tail.lat };
          advectInto(ahead, tail.lon, tail.lat, vector.u, vector.v, 60);
          const tip = screen(ahead);
          if (!tip) break;
          const projectedSpeed = Math.hypot(tip.x - here.x, tip.y - here.y);
          if (!(projectedSpeed > 0) || projectedSpeed > width * 0.4) break;
          const tiltGeometry = input.camera.pitch
            ? (input.camera as Camera & { tiltCamera?: { geometry?: { physicalScaleMPerClip?: number } } }).tiltCamera?.geometry
            : undefined;
          const metresPerPixel = tiltGeometry?.physicalScaleMPerClip
            ? tiltGeometry.physicalScaleMPerClip * 2 / Math.max(1, height)
            : 0;
          // Flat mode retains its historical screen-length normalization. In
          // 3D, choose one world-space scale for the whole frame instead, so
          // the same physical streak naturally foreshortens with perspective.
          const segmentSeconds = metresPerPixel > 0
            ? Math.max(0.25, length * metresPerPixel / 3 / Math.max(MIN_STREAK_SPEED_MS, Math.hypot(vector.u, vector.v)))
            : 60 * length / 3 / projectedSpeed;
          advectInto(tail, tail.lon, tail.lat, vector.u, vector.v, -segmentSeconds);
          const end = screen(tail);
          if (!end || Math.abs(end.x - here.x) > width * 0.4) break;
          // Validate the far end before emitting the segment: it may have
          // crossed into a calm/missing cell or a tight rotating eddy.
          const next = sample(tail.lon, tail.lat);
          if (!next || Math.hypot(next.u, next.v) < MIN_STREAK_SPEED_MS) break;
          const nextHeading = Math.atan2(next.v, next.u);
          let delta = nextHeading - tailHeading;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          tailTurn += Math.abs(delta);
          // Stop before a sharp bend instead of drawing a hooked little
          // polygon through an eddy or a poorly resolved direction change.
          if (Math.abs(delta) > Math.PI / 8 || tailTurn > Math.PI / 4) break;
          tailHeading = nextHeading;
          const beyond = { lon: tail.lon, lat: tail.lat };
          advectInto(beyond, tail.lon, tail.lat, next.u, next.v, 60);
          const endTip = screen(beyond);
          if (!endTip) break;
          const endSpeed = Math.hypot(endTip.x - end.x, endTip.y - end.y);
          if (!(endSpeed > 0) || endSpeed > width * 0.4) break;
          const arm = Math.hypot(end.x - here.x, end.y - here.y) / 3;
          const bucket = Math.round(alpha * edge * (1 - part * 0.3) / MAX_ALPHA * OPACITY_STEPS) - 1;
          if (bucket >= 0) {
            // Cubic endpoint tangents follow the sampled wind. Adjacent
            // pieces share that tangent, so there are no three-stick elbows.
            buckets[Math.min(OPACITY_STEPS - 1, bucket)].push(here.x, here.y,
              here.x - (tip.x - here.x) / projectedSpeed * arm,
              here.y - (tip.y - here.y) / projectedSpeed * arm,
              end.x + (endTip.x - end.x) / endSpeed * arm,
              end.y + (endTip.y - end.y) / endSpeed * arm, end.x, end.y);
            emitted = true;
          }
          here = end;
          vector = next;
        }
        if (emitted) drawn += 1;
      };
      particles.forEach(drawParticle);
      outgoing.forEach((p) => drawParticle(p, -1));
      outgoing = outgoing.filter((p) => p.retiring! < FLOW_FADE_SECONDS && p.age < FLOW_LIFE_SECONDS);
      ctx.lineCap = 'round';
      ctx.lineWidth = input.windLens ? 1.35 : 1.15;
      ctx.strokeStyle = input.dark ? '#e4dccb' : '#1a3340';
      for (let b = 0; b < buckets.length; b += 1) {
        const seg = buckets[b];
        if (!seg.length) continue;
        ctx.globalAlpha = (b + 1) / OPACITY_STEPS * MAX_ALPHA;
        ctx.beginPath();
        for (let i = 0; i < seg.length; i += 8) {
          ctx.moveTo(seg[i], seg[i + 1]);
          ctx.bezierCurveTo(seg[i + 2], seg[i + 3], seg[i + 4], seg[i + 5], seg[i + 6], seg[i + 7]);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const mode = input.reduced ? 'static' : 'live';
      latest = { lon: probeLon, lat: probeLat, shift: shifted ? shift / shifted : 0, travel: shifted ? travel / shifted : 0, drawn, mode, windSource: source };
      if (canvas.dataset.flow !== mode) canvas.dataset.flow = mode;
      return latest;
    },
  };
}

function toScreen(geo: Lambert, camera: Camera, lat: number, lon: number, width: number, height: number): { x: number; y: number } | null {
  if (camera.surface) {
    // Published flow is a 10 m wind vector. Keep the entire short streak at
    // that level so tilted terrain can occlude it without turning wind into a
    // volumetric effect or inventing a vertical component.
    const p = mapProjectAboveGround(geo, camera, lat, lon, 10);
    return p && { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 };
  }
  const projected = project(geo, lat, lon);
  if (!projected) return null;
  if (geo.projection === 'equirectangular') {
    const period = 360 * geo.F;
    projected.x += Math.round((camera.centerX - projected.x) / period) * period;
  }
  return {
    x: (1 + (projected.x - camera.centerX) / camera.halfWidth) * width / 2,
    y: (1 - (projected.y - camera.centerY) / camera.halfHeight) * height / 2,
  };
}
