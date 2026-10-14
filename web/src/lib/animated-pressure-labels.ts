import { mapProject, mapUnproject, type Camera, type Lambert } from './lambert';
import { pressureLabelPoint } from './pressure-label';
import type { ChartInk, LabelBox } from './overlay';

/** A label candidate from the current overlay pass. x/y are its box origin. */
export interface AnimatedPressureLabelCandidate {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** A stable id is preferred; the fallback is kind + level/text. */
  key?: string;
  kind?: 'isobar' | 'centre';
  level?: number;
  lon?: number;
  lat?: number;
}

export interface AnimatedPressureLabel {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  alpha: number;
  kind: 'isobar' | 'centre';
  level?: number;
  lon: number;
  lat: number;
}

interface LabelEntry extends AnimatedPressureLabel {
  pending?: { x: number; y: number; lon: number; lat: number; w: number; h: number; text: string };
}

export interface AnimatedPressureLabelState {
  labels: Map<string, LabelEntry>;
}

export interface AnimatedPressureLabelOptions {
  geo: Lambert;
  camera: Camera;
  width: number;
  height: number;
  /** The displayed pressure field. Isobar labels are reattached to this level. */
  pressureSample?: (lon: number, lat: number) => number | null;
  avoid?: LabelBox[];
  pressureStep?: number;
  formatPressure?: (hpa: number) => string;
  maxMove?: number;
  fadePerFrame?: number;
}

export interface AnimatedPressureLabelFrame {
  state: AnimatedPressureLabelState;
  labels: AnimatedPressureLabel[];
}

const DEFAULT_MAX_MOVE = 3;
const DEFAULT_FADE = 0.12;

export function createAnimatedPressureLabelState(): AnimatedPressureLabelState {
  return { labels: new Map() };
}

function candidateKey(candidate: AnimatedPressureLabelCandidate): string {
  if (candidate.key) return candidate.key;
  return `${candidate.kind ?? 'isobar'}:${candidate.level ?? candidate.text}`;
}

function candidateGeo(candidate: AnimatedPressureLabelCandidate, options: AnimatedPressureLabelOptions): { lon: number; lat: number } | null {
  if (Number.isFinite(candidate.lon) && Number.isFinite(candidate.lat)) return { lon: candidate.lon!, lat: candidate.lat! };
  const point = mapUnproject(options.geo, options.camera,
    ((candidate.x + candidate.w / 2) / options.width) * 2 - 1,
    1 - ((candidate.y + candidate.h / 2) / options.height) * 2);
  return point && Number.isFinite(point.lon + point.lat) ? { lon: point.lon, lat: point.lat } : null;
}

function screenPoint(lon: number, lat: number, options: AnimatedPressureLabelOptions): { x: number; y: number } | null {
  const point = mapProject(options.geo, options.camera, lat, lon);
  return point && Number.isFinite(point.x + point.y)
    ? { x: (point.x + 1) * options.width / 2, y: (1 - point.y) * options.height / 2 }
    : null;
}

function centreTypeMatches(
  lon: number,
  lat: number,
  text: string,
  sample: (lon: number, lat: number) => number | null,
  h: number,
): boolean {
  const type = text.trim().charAt(0);
  if (type !== 'H' && type !== 'L') return false;
  const centre = sample(lon, lat);
  const neighbours = [
    sample(lon + h, lat), sample(lon - h, lat), sample(lon, lat + h), sample(lon, lat - h),
    sample(lon + h, lat + h), sample(lon - h, lat + h),
    sample(lon + h, lat - h), sample(lon - h, lat - h),
  ];
  if (centre == null || !Number.isFinite(centre)
    || neighbours.some((value) => value == null || !Number.isFinite(value))) return false;
  const isHigher = neighbours.every((value) => centre! >= value!);
  const isLower = neighbours.every((value) => centre! <= value!);
  return type === 'H' ? isHigher : isLower;
}

/** Refine a worker centre toward the local pressure extremum for this frame. */
export function pressureCentrePoint(
  lon: number,
  lat: number,
  sample: (lon: number, lat: number) => number | null,
  h = 0.5,
): { lon: number; lat: number } | null {
  let x = lon;
  let y = lat;
  for (let i = 0; i < 6; i += 1) {
    const c = sample(x, y);
    const e = sample(x + h, y), w = sample(x - h, y);
    const n = sample(x, y + h), s = sample(x, y - h);
    const ne = sample(x + h, y + h), nw = sample(x - h, y + h);
    const se = sample(x + h, y - h), sw = sample(x - h, y - h);
    if ([c, e, w, n, s, ne, nw, se, sw].some((v) => v == null || !Number.isFinite(v))) return null;
    const dx = (e! - w!) / (2 * h), dy = (n! - s!) / (2 * h);
    const dxx = (e! - 2 * c! + w!) / (h * h);
    const dyy = (n! - 2 * c! + s!) / (h * h);
    const dxy = (ne! - nw! - se! + sw!) / (4 * h * h);
    const det = dxx * dyy - dxy * dxy;
    if (det < 1e-8) return null;
    const stepX = (dyy * dx - dxy * dy) / det;
    const stepY = (dxx * dy - dxy * dx) / det;
    if (!Number.isFinite(stepX + stepY)) return null;
    const scale = Math.min(1, 2 / Math.max(Math.abs(stepX), Math.abs(stepY), 2));
    x -= stepX * scale;
    y -= stepY * scale;
    if (Math.hypot(stepX, stepY) < 0.001) return { lon: x, lat: y };
  }
  return { lon: x, lat: y };
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function moveToward(x: number, y: number, targetX: number, targetY: number, maxMove: number): { x: number; y: number } {
  const dx = targetX - x;
  const dy = targetY - y;
  const distance = Math.hypot(dx, dy);
  if (distance <= maxMove || distance === 0) return { x: targetX, y: targetY };
  return { x: x + dx * maxMove / distance, y: y + dy * maxMove / distance };
}

function visibleLabel(entry: LabelEntry): AnimatedPressureLabel {
  const { pending: _pending, ...label } = entry;
  return label;
}

function labelCentre(entry: Pick<AnimatedPressureLabel, 'x' | 'y' | 'w' | 'h' | 'kind'>): { x: number; y: number } {
  return { x: entry.x + entry.w / 2, y: entry.y + (entry.kind === 'centre' ? 26 : entry.h / 2) };
}

/** Paint labels using the same compact halo and H/L geometry as overlay.ts. */
export function paintAnimatedPressureLabels(
  ctx: CanvasRenderingContext2D,
  labels: readonly AnimatedPressureLabel[],
  ink: Pick<ChartInk, 'line' | 'halo'>,
): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const label of labels) {
    const point = labelCentre(label);
    ctx.globalAlpha = label.alpha;
    if (label.kind === 'centre') {
      ctx.strokeStyle = ink.line;
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      ctx.moveTo(point.x - 5, point.y);
      ctx.lineTo(point.x + 5, point.y);
      ctx.moveTo(point.x, point.y - 5);
      ctx.lineTo(point.x, point.y + 5);
      ctx.stroke();
      const text = (value: string, font: string, y: number) => {
        ctx.font = font;
        if (ink.halo) { ctx.lineWidth = 2; ctx.strokeStyle = ink.halo; ctx.strokeText(value, point.x, y); }
        ctx.fillStyle = ink.line;
        ctx.fillText(value, point.x, y);
      };
      const [kind, value] = label.text.split(/\s+/, 2);
      text(kind, '700 18px ui-sans-serif, system-ui, sans-serif', point.y - 15);
      text(value ?? '', '600 11px ui-sans-serif, system-ui, sans-serif', point.y + 15);
    } else {
      ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
      if (ink.halo) { ctx.lineWidth = 2; ctx.strokeStyle = ink.halo; ctx.strokeText(label.text, point.x, point.y); }
      ctx.fillStyle = ink.line;
      ctx.fillText(label.text, point.x, point.y);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Advance the overlay labels by one render frame. Existing labels retain their
 * world anchor, and isobars are solved back onto the displayed pressure field.
 * A discontinuity fades at the old position before taking the new position;
 * ordinary motion is clamped to three pixels; a placement over 36 pixels away
 * is a discontinuity. Fast forecast motion can briefly lead a fading label.
 */
export function updateAnimatedPressureLabels(
  previous: AnimatedPressureLabelState,
  candidates: readonly AnimatedPressureLabelCandidate[],
  options: AnimatedPressureLabelOptions,
): AnimatedPressureLabelFrame {
  const maxMove = Math.max(0, options.maxMove ?? DEFAULT_MAX_MOVE);
  const fade = Math.min(1, Math.max(0.01, options.fadePerFrame ?? DEFAULT_FADE));
  const next = new Map<string, LabelEntry>();
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const geo = candidateGeo(candidate, options);
    if (!geo) continue;
    const kind = candidate.kind ?? 'isobar';
    let targetGeo = geo;
    const old = previous.labels.get(key);
    // Keep the accepted world anchor while the worker changes its sampled
    // fraction along the same line.
    const anchor = old && !old.pending && options.pressureSample ? { lon: old.lon, lat: old.lat } : geo;
    if (kind === 'centre' && options.pressureSample) {
      const refined = pressureCentrePoint(anchor.lon, anchor.lat, options.pressureSample, options.pressureStep);
      if (!refined) continue;
      if (!centreTypeMatches(
        refined.lon, refined.lat, candidate.text, options.pressureSample, options.pressureStep ?? 0.5,
      )) continue;
      targetGeo = refined;
    }
    if (kind === 'isobar') targetGeo = anchor;
    if (kind === 'isobar' && candidate.level !== undefined && options.pressureSample) {
      const onLine = pressureLabelPoint(targetGeo.lon, targetGeo.lat, candidate.level, options.pressureSample);
      const replacement = onLine ?? pressureLabelPoint(geo.lon, geo.lat, candidate.level, options.pressureSample);
      if (!replacement) continue;
      targetGeo = replacement;
    }
    const target = screenPoint(targetGeo.lon, targetGeo.lat, options);
    if (!target) continue;
    const w = candidate.w;
    const h = candidate.h;
    const targetBox = { x: target.x - w / 2, y: target.y - (kind === 'centre' ? 26 : h / 2) };
    const targetLabelBox = { ...targetBox, w, h };
    if (targetLabelBox.x < 0 || targetLabelBox.y < 0 || targetLabelBox.x + w > options.width || targetLabelBox.y + h > options.height
      || options.avoid?.some((box) => overlaps(targetLabelBox, box))
      || [...next.values()].some(box => box.alpha > 0 && overlaps(targetLabelBox, box))) continue;
    const value = kind === 'centre' ? options.pressureSample?.(targetGeo.lon, targetGeo.lat) : null;
    const text = value != null && options.formatPressure ? `${candidate.text[0]} ${options.formatPressure(value)}` : candidate.text;
    if (!old) {
      next.set(key, {
        key, x: targetBox.x, y: targetBox.y, w, h, text,
        alpha: fade, kind, level: candidate.level, lon: targetGeo.lon, lat: targetGeo.lat,
      });
      continue;
    }

    const oldCenter = labelCentre(old);
    const distance = Math.hypot(target.x - oldCenter.x, target.y - oldCenter.y);
    const entry: LabelEntry = { ...old, w, h, text, kind, level: candidate.level };
    if (old.pending) {
      entry.pending = { x: target.x, y: target.y, lon: targetGeo.lon, lat: targetGeo.lat, w, h, text: candidate.text };
      if (old.alpha === 0) {
        entry.x = target.x - w / 2;
        entry.y = target.y - (kind === 'centre' ? 26 : h / 2);
        entry.lon = targetGeo.lon;
        entry.lat = targetGeo.lat;
        entry.pending = undefined;
        entry.alpha = fade;
      } else entry.alpha = Math.max(0, old.alpha - fade);
    } else if (distance > Math.max(36, maxMove)) {
      entry.pending = { x: target.x, y: target.y, lon: targetGeo.lon, lat: targetGeo.lat, w, h, text: candidate.text };
      entry.alpha = Math.max(0, old.alpha - fade);
    } else {
      const moved = moveToward(oldCenter.x, oldCenter.y, target.x, target.y, maxMove);
      entry.x = moved.x - w / 2;
      entry.y = moved.y - (kind === 'centre' ? 26 : h / 2);
      entry.lon = targetGeo.lon;
      entry.lat = targetGeo.lat;
      entry.alpha = Math.min(1, old.alpha + fade);
    }
    next.set(key, entry);
  }

  for (const [key, old] of previous.labels) {
    if (next.has(key)) continue;
    const entry = { ...old, alpha: old.alpha - fade };
    if (entry.alpha > 0) next.set(key, entry);
  }

  return { state: { labels: next }, labels: [...next.values()].filter((label) => label.alpha > 0).map(visibleLabel) };
}
