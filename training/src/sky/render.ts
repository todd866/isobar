/**
 * Sky section renderer (Canvas 2D). Draws a SkyState as a W–E section about
 * 40 NM wide, surface to FL450, with clouds shaped by type and lit by the
 * sun's real position. Deterministic: every random choice is seeded by the
 * aerodrome, the model run and the layer, so playback never reshuffles cloud.
 *
 * Cost model: a state is drawn once into a cached bitmap, incrementally
 * (a few milliseconds per animation frame), and the visible canvas only
 * crossfades cached bitmaps. No per-frame noise.
 */
import { FT_PER_M, coverSegments, hashString, rng, type SkyLayer, type SkyState } from './physics.ts';

export const FT_MAX = 45000;
const H0 = 5000;
export const SECTION_KM = 74; // 40 NM
const TOP_PX = 4;
/** Ground band height: 16 px, or 4 px in a thumbnail. */
const groundPx = (height: number) => (height < 80 ? 4 : 16);

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Canvas = HTMLCanvasElement | OffscreenCanvas;

export interface SkyOptions {
  width: number;
  height: number;
  dpr: number;
  dark: boolean;
  /** Seed text: aerodrome and run. */
  seed: string;
  /** Distance to the coast along the section, km (negative = west); null inland. */
  coastKm: number | null;
  /** A thumbnail: clouds, precipitation, ground and the 0 °C line; no text, barbs or ticks. */
  compact?: boolean;
}

/* ---------- geometry ---------- */

export function yForFt(ft: number, height: number): number {
  const sea = height - groundPx(height);
  const f = Math.log1p(Math.max(0, ft) / H0) / Math.log1p(FT_MAX / H0);
  return sea - (sea - TOP_PX) * Math.min(1.02, f);
}

export function ftForY(y: number, height: number): number {
  const sea = height - groundPx(height);
  const f = (sea - y) / (sea - TOP_PX);
  return H0 * Math.expm1(f * Math.log1p(FT_MAX / H0));
}

/* ---------- colour ---------- */

type RGB = [number, number, number];
const hex = (value: string): RGB => [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, f: number): RGB => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
const css = (c: RGB, alpha = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`;
const luminance = (c: RGB) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

interface Light {
  top: RGB;
  horizon: RGB;
  glow: RGB;
  glowAlpha: number;
  lit: RGB;
  shade: RGB;
  base: RGB;
  land: RGB;
  sea: RGB;
  rain: RGB;
  /** Light direction in the section plane: +x east, +y up. */
  lx: number;
  ly: number;
  /** 0 day … 1 night. */
  night: number;
  stars: number;
}

// Keyframes on sun elevation, degrees.
const KEYS: { e: number; top: string; horizon: string; glow: string; glowAlpha: number; lit: string; shade: string; base: string; land: string; sea: string }[] = [
  { e: -18, top: '#04060c', horizon: '#0f1626', glow: '#2a2a33', glowAlpha: 0, lit: '#373e4c', shade: '#212631', base: '#1a1e27', land: '#14170f', sea: '#0b1520' },
  { e: -8, top: '#0b1226', horizon: '#26304d', glow: '#4a3a52', glowAlpha: 0.25, lit: '#4c5166', shade: '#2a2e3d', base: '#22252f', land: '#1d2116', sea: '#121f30' },
  { e: -2, top: '#1d2b4f', horizon: '#c9876e', glow: '#f09a6a', glowAlpha: 0.55, lit: '#e3a28c', shade: '#4d4c63', base: '#3a394d', land: '#2e3220', sea: '#22364d' },
  { e: 4, top: '#3c62a0', horizon: '#f2c9a0', glow: '#ffb070', glowAlpha: 0.5, lit: '#ffe1bd', shade: '#8a8698', base: '#5e5a6c', land: '#59603d', sea: '#355a78' },
  { e: 12, top: '#3f74bd', horizon: '#c4dbef', glow: '#fff1d8', glowAlpha: 0.25, lit: '#fffaf2', shade: '#949fb0', base: '#6c7686', land: '#6f7a4c', sea: '#3d6f93' },
  { e: 40, top: '#2f6bbf', horizon: '#b8d5ee', glow: '#ffffff', glowAlpha: 0, lit: '#ffffff', shade: '#9aa6b7', base: '#717c8d', land: '#78824f', sea: '#3c7299' },
];

export function lightFor(elevationDeg: number, azimuthDeg: number, dark: boolean): Light {
  const e = Math.max(KEYS[0].e, Math.min(KEYS[KEYS.length - 1].e, elevationDeg));
  let i = 0;
  while (i + 2 < KEYS.length && e > KEYS[i + 1].e) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const f = (e - a.e) / (b.e - a.e);
  const pick = (key: 'top' | 'horizon' | 'glow' | 'lit' | 'shade' | 'base' | 'land' | 'sea') => mix(hex(a[key]), hex(b[key]), f);
  const night = Math.max(0, Math.min(1, (2 - elevationDeg) / 12));
  const light: Light = {
    top: pick('top'), horizon: pick('horizon'), glow: pick('glow'), glowAlpha: a.glowAlpha + (b.glowAlpha - a.glowAlpha) * f,
    lit: pick('lit'), shade: pick('shade'), base: pick('base'), land: pick('land'), sea: pick('sea'),
    rain: mix([110, 122, 140], [40, 46, 58], night),
    lx: Math.sin((azimuthDeg * Math.PI) / 180) * Math.cos((Math.max(0, elevationDeg) * Math.PI) / 180),
    ly: Math.max(0.15, Math.sin((Math.max(0, elevationDeg) * Math.PI) / 180)),
    night,
    stars: Math.max(0, Math.min(1, (-6 - elevationDeg) / 8)),
  };
  if (dark && night < 1) {
    // A dark page dims the daylight sky rather than inverting it.
    const dim = (c: RGB, amount: number) => mix(c, [10, 14, 22], amount * (1 - night));
    light.top = dim(light.top, 0.55);
    light.horizon = dim(light.horizon, 0.55);
    light.lit = dim(light.lit, 0.32);
    light.shade = dim(light.shade, 0.42);
    light.base = dim(light.base, 0.45);
    light.land = dim(light.land, 0.5);
    light.sea = dim(light.sea, 0.5);
    light.glowAlpha *= 0.7;
  }
  return light;
}

/* ---------- canvas helpers ---------- */

function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  return canvas;
}

function context(canvas: Canvas): Ctx {
  return canvas.getContext('2d') as Ctx;
}

interface Painter {
  ctx: Ctx;
  w: number;
  h: number;
  light: Light;
  y: (ft: number) => number;
  pxPerKm: number;
}

/** A shaded puff: brighter toward the light, darker away from it. */
function puff(ctx: Ctx, x: number, y: number, r: number, light: Light, depthShade: number, alpha = 1) {
  if (r <= 0.3) return;
  const ox = x + light.lx * r * 0.45;
  const oy = y - light.ly * r * 0.5;
  const g = ctx.createRadialGradient(ox, oy, r * 0.05, x, y, r * 1.05);
  const lit = mix(light.lit, light.shade, depthShade * 0.3);
  const edge = mix(mix(lit, light.shade, 0.55), light.base, depthShade * 0.4);
  // Soft rim: the edge fades so overlapping puffs read as one billowing surface.
  g.addColorStop(0, css(lit, alpha));
  g.addColorStop(0.65, css(mix(lit, edge, 0.25), alpha));
  g.addColorStop(0.9, css(mix(lit, edge, 0.6), alpha * 0.9));
  g.addColorStop(1, css(edge, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Darken toward a flat base: the thicker the cloud, the darker its base. */
function baseShade(ctx: Ctx, x0: number, x1: number, topY: number, baseY: number, light: Light, strength: number) {
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  const g = ctx.createLinearGradient(0, topY, 0, baseY);
  g.addColorStop(0, css(light.base, 0));
  g.addColorStop(0.55, css(light.base, 0.12 * strength));
  g.addColorStop(1, css(light.base, Math.min(0.85, 0.5 * strength + 0.15)));
  ctx.fillStyle = g;
  ctx.fillRect(x0, topY - 2, x1 - x0, baseY - topY + 4);
  if (light.night > 0.6) {
    // City light from below on a moonless night.
    const u = ctx.createLinearGradient(0, baseY - 10, 0, baseY);
    u.addColorStop(0, 'rgba(160,110,60,0)');
    u.addColorStop(1, `rgba(160,110,60,${0.22 * light.night})`);
    ctx.fillStyle = u;
    ctx.fillRect(x0, baseY - 10, x1 - x0, 12);
  }
  ctx.restore();
}

/* ---------- cloud types ---------- */

interface LayerPx {
  layer: SkyLayer;
  baseY: number;
  topY: number;
  topKnown: boolean;
  seed: number;
  segments: [number, number][];
}

const NOMINAL_DEPTH: Record<SkyLayer['type'], number> = {
  cumulus: 2500, towering: 12000, cumulonimbus: 30000, stratocumulus: 1500, stratus: 800,
  altostratus: 5000, altocumulus: 1500, cirrus: 3000, fog: 300,
};

/** Cumulus: flat base, heaped cauliflower dome. */
function cumulus(p: Painter, cx: number, cw: number, baseY: number, topY: number, random: () => number, columnar = 0) {
  const { ctx, light } = p;
  const ch = Math.max(8, baseY - topY);
  topY = baseY - ch;
  const half = cw / 2;
  const depthShade = Math.min(1, ch / 140);
  const rBase = Math.max(2.2, Math.min(half * 0.55, ch * (columnar ? 0.28 : 0.45), 16));
  const power = columnar ? 2.6 : 1.6;
  const envelope = (u: number) => {
    const a = Math.min(1, Math.abs(u));
    return Math.pow(Math.max(0, 1 - Math.pow(a, power)), columnar ? 0.35 : 0.6);
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx - half - rBase * 5, topY - rBase * 4, cw + rBase * 10, baseY - topY + rBase * 4);
  ctx.clip();
  // A solid body under the puffs so no sky shows between them.
  const body = ctx.createLinearGradient(0, topY, 0, baseY);
  body.addColorStop(0, css(light.lit));
  body.addColorStop(1, css(mix(light.lit, mix(light.shade, light.base, 0.4 * depthShade), 0.55)));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(cx - half * 0.95, baseY);
  for (let u = -1; u <= 1.0001; u += 0.05) ctx.lineTo(cx + u * half * 0.95, baseY - envelope(u) * ch * 0.93);
  ctx.lineTo(cx + half * 0.95, baseY);
  ctx.closePath();
  ctx.fill();
  // Billows on the outline: each row puts a puff at both ends of the dome,
  // with an occasional soft interior billow for texture.
  const rows = Math.max(1, Math.ceil(ch / (rBase * 0.8)));
  for (let row = 0; row < rows; row++) {
    const v = row / rows;
    const yc = baseY - rBase * 0.35 - v * (ch - rBase * 0.7);
    let span = 0;
    for (let u = 0; u <= 1; u += 0.02) if (envelope(u) >= v) span = u;
    const rRow = rBase * (1 - v * 0.4) * (0.8 + random() * 0.4);
    for (const sideSign of [-1, 1]) {
      const x = cx + sideSign * Math.max(0, span * half * 0.95 - rRow * 0.6) + (random() - 0.5) * rRow * 0.4;
      puff(ctx, x, yc, rRow * (0.9 + random() * 0.3), light, depthShade * (1 - v));
    }
    if (random() < 0.45 && span * half > rRow * 1.5) {
      puff(ctx, cx + (random() - 0.5) * span * half, yc, rRow * (0.8 + random() * 0.4), light, depthShade * (1 - v), 0.55);
    }
  }
  // Cauliflower crown: small puffs along the top of the dome.
  const crown = Math.max(3, Math.round(cw / (rBase * 0.9)));
  for (let k = 0; k < crown; k++) {
    const u = -0.85 + (1.7 * (k + random() * 0.6)) / crown;
    const h = envelope(u) * ch;
    const r = rBase * (0.45 + random() * 0.4) * (0.6 + 0.4 * envelope(u));
    puff(ctx, cx + u * half, baseY - h + r * 0.55, r, light, 0);
  }
  ctx.restore();
  // Flat base: cut everything below it.
  ctx.clearRect(cx - half - rBase * 3, baseY, cw + rBase * 6, rBase * 3);
}

/** Towering cumulus: two or three turrets of different height. */
function towering(p: Painter, cx: number, cw: number, baseY: number, topY: number, random: () => number) {
  const ch = baseY - topY;
  const turrets = cw > 50 ? 3 : 2;
  const order = Array.from({ length: turrets }, (_, i) => i).sort(() => random() - 0.5);
  for (const i of order) {
    const share = cw / turrets;
    const x = cx - cw / 2 + share * (i + 0.5) + (random() - 0.5) * share * 0.2;
    const tall = i === Math.floor(turrets / 2) ? 1 : 0.45 + random() * 0.4;
    cumulus(p, x, share * 1.35, baseY, baseY - ch * tall, random, 1);
  }
}

/** Cumulonimbus: a dark-based tower to the equilibrium level with an anvil spreading downwind. */
function cumulonimbus(p: Painter, cx: number, cw: number, baseY: number, topY: number, random: () => number, windSign: number, topKnown: boolean) {
  const { ctx, light, w } = p;
  const ch = baseY - topY;
  const anvilThick = Math.max(6, ch * 0.13);
  const towerTop = topY + anvilThick * 0.4;
  // Anvil first so the tower's crown sits in front of it.
  const reach = Math.min(w * 0.42, Math.max(cw * 1.6, w * 0.26));
  const back = reach * 0.22;
  const dir = windSign === 0 ? 1 : windSign;
  const x0 = cx - dir * back;
  const x1 = cx + dir * reach;
  const g = ctx.createLinearGradient(0, topY, 0, topY + anvilThick * 1.6);
  g.addColorStop(0, css(light.lit, topKnown ? 0.97 : 0.6));
  g.addColorStop(0.6, css(mix(light.lit, light.shade, 0.55), topKnown ? 0.95 : 0.55));
  g.addColorStop(1, css(light.shade, topKnown ? 0.9 : 0.5));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x0, topY + anvilThick * 0.6);
  ctx.quadraticCurveTo(cx - dir * back * 0.4, topY - 1, cx, topY);
  ctx.lineTo(x1 - dir * reach * 0.1, topY + 1);
  ctx.quadraticCurveTo(x1, topY + 1.5, x1 + dir * 4, topY + anvilThick * 0.25);
  ctx.quadraticCurveTo(cx + dir * reach * 0.55, topY + anvilThick * 0.55, cx + dir * cw * 0.35, topY + anvilThick * 1.9);
  ctx.lineTo(cx - dir * cw * 0.3, topY + anvilThick * 1.6);
  ctx.closePath();
  ctx.fill();
  // Fibrous trailing edge of the anvil: ice streaming downwind.
  ctx.save();
  ctx.lineCap = 'round';
  for (let k = 0; k < 26; k++) {
    const t = 0.45 + random() * 0.6;
    const xs = cx + dir * reach * t;
    const ys = topY + 1 + random() * anvilThick * 0.7;
    ctx.strokeStyle = css(light.lit, 0.12 + random() * 0.22);
    ctx.lineWidth = 0.5 + random() * 0.9;
    ctx.beginPath();
    ctx.moveTo(xs, ys);
    ctx.quadraticCurveTo(xs + dir * (8 + random() * 14), ys + 1 + random() * 3, xs + dir * (14 + random() * 22), ys + 3 + random() * 6);
    ctx.stroke();
  }
  ctx.restore();
  // Main tower and flanking turrets.
  cumulus(p, cx, cw, baseY, towerTop, random, 1);
  cumulus(p, cx - cw * 0.45, cw * 0.6, baseY, baseY - ch * 0.42, random, 1);
  cumulus(p, cx + cw * 0.5, cw * 0.55, baseY, baseY - ch * 0.3, random, 1);
  // Overshooting top.
  for (let k = 0; k < 4; k++) puff(ctx, cx + (k - 1.5) * cw * 0.09, topY + 1 - random() * 2, Math.max(2, cw * 0.09), light, 0);
  // A dark, heavy base.
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  const b = ctx.createLinearGradient(0, baseY - ch * 0.35, 0, baseY);
  b.addColorStop(0, css(light.base, 0));
  b.addColorStop(1, css(mix(light.base, [20, 24, 32], 0.4), 0.85));
  ctx.fillStyle = b;
  ctx.fillRect(cx - cw * 1.2, baseY - ch * 0.35, cw * 2.4, ch * 0.35 + 2);
  ctx.restore();
}

/** Stratocumulus: a lumpy sheet of rolls with darker undersides. */
function stratocumulus(p: Painter, x0: number, x1: number, baseY: number, topY: number, random: () => number) {
  const { ctx, light } = p;
  const th = Math.max(4, baseY - topY);
  const rollW = Math.max(10, Math.min(34, th * 2.4));
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0 - rollW, topY - th, x1 - x0 + rollW * 2, th * 2 + 2);
  ctx.clip();
  for (let x = x0 + rollW * 0.4; x < x1 - rollW * 0.3; x += rollW * (0.62 + random() * 0.2)) {
    const ry = th * (0.5 + random() * 0.18);
    const rx = rollW * (0.55 + random() * 0.15);
    const yc = baseY - ry * 0.95 + (random() - 0.5) * th * 0.15;
    const g = ctx.createLinearGradient(0, yc - ry, 0, yc + ry);
    g.addColorStop(0, css(light.lit, 0.97));
    g.addColorStop(0.55, css(mix(light.lit, light.shade, 0.55), 0.97));
    g.addColorStop(1, css(light.shade, 0.97));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, yc, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    // A small heap on some rolls.
    if (random() < 0.5) puff(ctx, x + (random() - 0.5) * rx, yc - ry * 0.7, ry * 0.55, light, 0.2, 0.95);
  }
  ctx.restore();
  ctx.clearRect(x0 - rollW, baseY, x1 - x0 + rollW * 2, th);
  baseShade(ctx, x0 - rollW, x1 + rollW, topY, baseY, light, Math.min(1, th / 30));
}

/** Stratus: a flat grey sheet, textured, with a ragged underside. */
function stratus(p: Painter, x0: number, x1: number, baseY: number, topY: number, random: () => number, ragged: boolean) {
  const { ctx, light } = p;
  const th = Math.max(3, baseY - topY);
  const grey = mix(light.lit, light.shade, 0.6);
  const g = ctx.createLinearGradient(0, topY, 0, baseY);
  g.addColorStop(0, css(mix(light.lit, light.shade, 0.3), 0.95));
  g.addColorStop(1, css(mix(light.shade, light.base, 0.5), 0.97));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x0, baseY);
  // Gently undulating top.
  for (let x = x0; x <= x1; x += 6) ctx.lineTo(x, topY + Math.sin(x * 0.07 + random() * 0.3) * th * 0.08 + (random() - 0.5) * 1.2);
  ctx.lineTo(x1, baseY);
  ctx.closePath();
  ctx.fill();
  // Stretched texture.
  for (let k = 0; k < Math.max(6, (x1 - x0) / 10); k++) {
    const x = x0 + random() * (x1 - x0);
    const y = topY + random() * th;
    ctx.fillStyle = css(random() < 0.5 ? light.lit : light.base, 0.07 + random() * 0.06);
    ctx.beginPath();
    ctx.ellipse(x, y, 8 + random() * 22, 0.8 + random() * Math.min(3, th * 0.25), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (ragged) {
    // Fractus hanging below the base.
    for (let x = x0 + 4; x < x1 - 4; x += 5 + random() * 9) {
      ctx.fillStyle = css(grey, 0.35 + random() * 0.3);
      ctx.beginPath();
      ctx.ellipse(x, baseY + 1 + random() * 3, 3 + random() * 7, 1 + random() * 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Soft ends.
  feather(ctx, x0, x1, topY - 4, baseY + 6);
}

/** Fade a band's two ends into the sky so sheets do not end in a hard wall. */
function feather(ctx: Ctx, x0: number, x1: number, top: number, bottom: number) {
  const fade = Math.min(14, (x1 - x0) / 4);
  if (fade < 2) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  for (const [a, b] of [[x0, x0 + fade], [x1, x1 - fade]] as const) {
    const g = ctx.createLinearGradient(a, 0, b, 0);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(Math.min(a, b), top, fade, bottom - top);
  }
  ctx.restore();
}

/** Altostratus: a grey translucent veil, smooth, faintly streaked. */
function altostratus(p: Painter, x0: number, x1: number, baseY: number, topY: number, random: () => number) {
  const { ctx, light } = p;
  const th = Math.max(4, baseY - topY);
  const g = ctx.createLinearGradient(0, topY, 0, baseY);
  g.addColorStop(0, css(mix(light.lit, light.shade, 0.25), 0));
  g.addColorStop(0.18, css(mix(light.lit, light.shade, 0.25), 0.5));
  g.addColorStop(0.5, css(mix(light.lit, light.shade, 0.5), 0.72));
  g.addColorStop(1, css(light.shade, 0.82));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x0, baseY);
  for (let x = x0; x <= x1; x += 8) ctx.lineTo(x, topY + Math.sin(x * 0.03 + 1.3) * th * 0.06 + random() * 1.5);
  for (let x = x1; x >= x0; x -= 8) ctx.lineTo(x, baseY + Math.sin(x * 0.05) * 1.2 + random());
  ctx.closePath();
  ctx.fill();
  ctx.lineCap = 'round';
  for (let k = 0; k < (x1 - x0) / 7; k++) {
    const x = x0 + random() * (x1 - x0);
    const y = topY + random() * th;
    ctx.strokeStyle = css(random() < 0.6 ? light.lit : light.shade, 0.1 + random() * 0.1);
    ctx.lineWidth = 0.6 + random();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 10 + random() * 30, y + (random() - 0.5) * 2);
    ctx.stroke();
  }
  feather(ctx, x0, x1, topY - 4, baseY + 4);
}

/** Altocumulus: rows of small shaded cloudlets in waves. */
function altocumulus(p: Painter, x0: number, x1: number, baseY: number, topY: number, random: () => number) {
  const { ctx, light } = p;
  const th = Math.max(4, baseY - topY);
  const r = Math.max(2, Math.min(5.5, th * 0.38));
  const rows = Math.max(1, Math.min(2, Math.round(th / (r * 2))));
  const phase = random() * 6;
  if (th > r * 5) {
    // A deep mid-level layer: a thin veil above the cloudlet rows.
    const veilTop = topY;
    const veilBase = baseY - r * 3;
    const g = ctx.createLinearGradient(0, veilTop, 0, veilBase);
    g.addColorStop(0, css(light.lit, 0));
    g.addColorStop(1, css(mix(light.lit, light.shade, 0.4), 0.32));
    ctx.fillStyle = g;
    ctx.fillRect(x0, veilTop, x1 - x0, veilBase - veilTop);
    feather(ctx, x0, x1, veilTop, veilBase);
  }
  for (let row = 0; row < rows; row++) {
    const y = baseY - r - row * r * 1.6;
    for (let x = x0 + r; x < x1 - r; x += r * (2.1 + random() * 0.9)) {
      const yy = y + Math.sin(x * 0.09 + phase) * r * 0.5 + (random() - 0.5) * r * 0.4;
      const rr = r * (0.75 + random() * 0.45);
      puff(ctx, x, yy, rr, light, 0.1);
      puff(ctx, x + rr * 0.8, yy + rr * 0.15, rr * 0.7, light, 0.15);
      ctx.fillStyle = css(light.base, 0.25);
      ctx.fillRect(x - rr, yy + rr * 0.55, rr * 2.2, rr * 0.45);
    }
  }
  ctx.clearRect(x0 - r * 3, baseY + 0.5, x1 - x0 + r * 6, r * 3);
}

/** Cirrus: thin, fibrous, translucent streaks with hooked ends; a faint veil when the cover is high. */
function cirrus(p: Painter, x0: number, x1: number, baseY: number, topY: number, oktas: number, random: () => number, windSign: number) {
  const { ctx, light } = p;
  const th = Math.max(4, baseY - topY);
  const ink = mix(light.lit, [255, 255, 255], 0.3);
  if (oktas >= 6) {
    const g = ctx.createLinearGradient(0, topY, 0, baseY);
    g.addColorStop(0, css(ink, 0));
    g.addColorStop(0.5, css(ink, 0.16));
    g.addColorStop(1, css(ink, 0.04));
    ctx.fillStyle = g;
    ctx.fillRect(x0, topY, x1 - x0, th);
    feather(ctx, x0, x1, topY, baseY);
  }
  ctx.lineCap = 'round';
  const dir = windSign === 0 ? 1 : windSign;
  const streaks = Math.max(2, Math.round((x1 - x0) / 18));
  for (let st = 0; st < streaks; st++) {
    const x = x0 + random() * (x1 - x0);
    const y = topY + th * (0.15 + random() * 0.75);
    const len = 18 + random() * 40;
    const fall = 2 + random() * Math.min(12, th * 0.5);
    const fibres = 8 + Math.floor(random() * 8);
    // A brighter tuft at the head (the generating cell)...
    ctx.fillStyle = css(ink, 0.18 + random() * 0.12);
    ctx.beginPath();
    ctx.ellipse(x, y, 3 + random() * 4, 1 + random() * 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // ...and fine fibres of falling ice trailing downwind and down (uncinus hooks).
    for (let f = 0; f < fibres; f++) {
      const off = (random() - 0.5) * 6;
      const l = len * (0.5 + random() * 0.6);
      const drop = fall * (0.6 + random() * 0.8);
      ctx.strokeStyle = css(ink, 0.1 + random() * 0.22);
      ctx.lineWidth = 0.35 + random() * 0.55;
      ctx.beginPath();
      ctx.moveTo(x + (random() - 0.5) * 3, y + off * 0.3);
      ctx.bezierCurveTo(x + dir * l * 0.45, y + off * 0.6, x + dir * l * 0.8, y + off + drop * 0.25, x + dir * l, y + off + drop);
      ctx.stroke();
    }
  }
}

/** Fog, mist or haze: a band from the ground, densest at the surface. */
function fogBand(p: Painter, topY: number, groundY: number, kind: string, visM: number | null, random: () => number) {
  const { ctx, light, w } = p;
  const haze = kind === 'HZ' || kind === 'FU' || kind === 'DU' || kind === 'SA';
  const tint: RGB = haze ? mix([196, 170, 128], light.shade, 0.35) : mix(mix(light.lit, [246, 248, 250], 0.5), mix(light.shade, light.base, 0.5), 0.1 + 0.7 * light.night);
  const dense = kind === 'FG' || kind === 'VV' ? 0.97 : haze ? 0.45 : 0.6;
  const visFactor = visM == null ? 1 : Math.max(0.6, Math.min(1.1, 1.2 - visM / 8000));
  const top = Math.min(topY, groundY - 24);
  const g = ctx.createLinearGradient(0, top - 6, 0, groundY);
  g.addColorStop(0, css(tint, 0));
  g.addColorStop(0.3, css(tint, dense * visFactor * 0.85));
  g.addColorStop(1, css(tint, dense * visFactor));
  ctx.fillStyle = g;
  ctx.fillRect(0, top - 6, w, groundY - top + 6 + groundPx(p.h));
  for (let x = 0; x < w; x += 8 + random() * 10) {
    ctx.fillStyle = css(tint, (0.25 + random() * 0.3) * dense);
    ctx.beginPath();
    ctx.ellipse(x, top + random() * 4, 10 + random() * 18, 2 + random() * 3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // A soft shadowed line under the fog top so it reads against a pale horizon.
  const edge = ctx.createLinearGradient(0, top - 2, 0, top + 6);
  edge.addColorStop(0, css(light.shade, 0));
  edge.addColorStop(0.5, css(light.shade, 0.18 * dense));
  edge.addColorStop(1, css(light.shade, 0));
  ctx.fillStyle = edge;
  ctx.fillRect(0, top - 2, w, 8);
}

/* ---------- precipitation ---------- */

interface Shaft {
  x0: number;
  x1: number;
  topY: number;
  bottomY: number;
  kind: SkyLayer['precip'];
  heavy: boolean;
  /** Freezing level, px, or null: snow above it, rain below. */
  freezeY: number | null;
  slant: number;
}

function precipitation(ctx: Ctx, shaft: Shaft, light: Light, random: () => number, alpha: number) {
  const { x0, x1, topY, bottomY, kind, heavy, freezeY, slant } = shaft;
  const h = bottomY - topY;
  if (h <= 2 || x1 - x0 < 2) return;
  const virga = kind === 'virga';
  const rainInk = heavy ? mix(light.rain, [30, 34, 44], 0.45) : light.rain;
  // The curtain.
  const curtain = ctx.createLinearGradient(0, topY, 0, bottomY);
  const strength = (heavy ? 0.42 : kind === 'drizzle' ? 0.2 : virga ? 0.3 : 0.24) * alpha;
  curtain.addColorStop(0, css(rainInk, strength));
  curtain.addColorStop(virga ? 1 : 0.85, css(rainInk, virga ? 0 : strength * 0.8));
  if (!virga) curtain.addColorStop(1, css(rainInk, strength * 0.35));
  ctx.fillStyle = curtain;
  ctx.beginPath();
  const inset = (x1 - x0) * 0.08;
  ctx.moveTo(x0 + inset, topY);
  ctx.lineTo(x1 - inset, topY);
  if (virga) {
    ctx.quadraticCurveTo(x1 + slant * 0.3, topY + h * 0.6, x1 - inset + slant, bottomY);
    ctx.lineTo(x0 + inset + slant, bottomY);
    ctx.quadraticCurveTo(x0 + slant * 0.3, topY + h * 0.6, x0 + inset, topY);
  } else {
    ctx.lineTo(x1 - inset + slant, bottomY);
    ctx.lineTo(x0 + inset + slant, bottomY);
  }
  ctx.closePath();
  ctx.fill();
  // Streaks, drops or flakes.
  const density = kind === 'drizzle' ? 0.9 : heavy ? 0.38 : virga ? 0.3 : 0.2;
  const n = Math.round((x1 - x0) * density * Math.max(1, h / 60));
  ctx.lineCap = 'round';
  for (let k = 0; k < n; k++) {
    const t = random();
    const y = topY + t * h;
    const along = (y - topY) / h;
    const x = x0 + inset + random() * (x1 - x0 - inset * 2) + slant * along;
    const fade = virga ? (1 - along) ** 1.4 : 1;
    const snow = kind === 'snow' || (freezeY != null && y < freezeY);
    if (snow) {
      ctx.fillStyle = css(mix(light.lit, [255, 255, 255], 0.5), (0.55 + random() * 0.4) * fade * alpha);
      ctx.beginPath();
      ctx.arc(x, y, 0.7 + random() * 0.8, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'drizzle') {
      ctx.fillStyle = css(mix(rainInk, light.shade, 0.3), 0.6 * fade * alpha);
      ctx.fillRect(x, y, 0.9, 1.8);
    } else {
      const len = heavy ? 6 + random() * 6 : 4 + random() * 4;
      ctx.strokeStyle = css(mix(rainInk, light.lit, 0.25), (heavy ? 0.6 : 0.45) * fade * alpha);
      ctx.lineWidth = heavy ? 0.9 : 0.7;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (slant / h) * len, y + len);
      ctx.stroke();
    }
  }
}

function lightning(ctx: Ctx, x: number, topY: number, bottomY: number, random: () => number) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,248,200,0.95)';
  ctx.shadowColor = 'rgba(255,240,170,0.9)';
  ctx.shadowBlur = 6;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  let px = x;
  let py = topY;
  ctx.moveTo(px, py);
  while (py < bottomY) {
    py += 5 + random() * 8;
    px += (random() - 0.5) * 9;
    ctx.lineTo(px, Math.min(py, bottomY));
  }
  ctx.stroke();
  ctx.restore();
}

/* ---------- wind barbs ---------- */

/** A conventional plan-view barb: shaft toward where the wind comes from, feathers on the clockwise side. */
export function drawBarb(ctx: Ctx, x: number, y: number, kt: number, fromDeg: number, ink: string, length = 15) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 1.1;
  ctx.lineCap = 'round';
  if (kt < 2.5) {
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.rotate((fromDeg * Math.PI) / 180);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -length);
  ctx.stroke();
  let value = Math.round(kt / 5) * 5;
  let along = -length;
  // Southern-hemisphere convention: feathers on the left of the shaft looking downwind.
  const side = -1;
  while (value >= 50) {
    ctx.beginPath();
    ctx.moveTo(0, along);
    ctx.lineTo(side * 7, along + 2);
    ctx.lineTo(0, along + 4.5);
    ctx.closePath();
    ctx.fill();
    along += 5.5;
    value -= 50;
  }
  while (value >= 10) {
    ctx.beginPath();
    ctx.moveTo(0, along);
    ctx.lineTo(side * 7, along - 2.5);
    ctx.stroke();
    along += 3;
    value -= 10;
  }
  if (value >= 5) {
    if (along === -length) along += 3;
    ctx.beginPath();
    ctx.moveTo(0, along);
    ctx.lineTo(side * 3.6, along - 1.3);
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------- labels ---------- */

const fmtFt = (ft: number) => (Math.round(ft / 100) * 100).toLocaleString('en-AU');

interface Ink { text: string; halo: string; muted: string; fz: string; ice: string }

function inkFor(light: Light): Ink {
  const bright = luminance(mix(light.top, light.horizon, 0.5)) > 0.42;
  return bright
    ? { text: '#0f1c2a', halo: 'rgba(255,255,255,0.78)', muted: 'rgba(15,28,42,0.72)', fz: '#1d63b3', ice: '#1e7fb8' }
    : { text: '#eef3f8', halo: 'rgba(5,9,16,0.72)', muted: 'rgba(230,238,246,0.72)', fz: '#7cc2ff', ice: '#7fd4ff' };
}

function label(ctx: Ctx, text: string, x: number, y: number, ink: Ink, opts: { align?: CanvasTextAlign; size?: number; weight?: number; colour?: string; italic?: boolean } = {}) {
  ctx.save();
  ctx.font = `${opts.italic ? 'italic ' : ''}${opts.weight ?? 600} ${opts.size ?? 10.5}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = opts.align ?? 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = ink.halo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = opts.colour ?? ink.text;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/* ---------- the state, drawn ---------- */

const typeWord: Partial<Record<SkyLayer['type'], string>> = { cumulonimbus: 'CB', towering: 'TCU' };

export function layerLabel(layer: SkyLayer): string {
  const word = typeWord[layer.type];
  const top = layer.topFtAmsl != null && layer.topFtAmsl - layer.baseFtAmsl >= 400 ? `–${fmtFt(layer.topFtAmsl)}` : '';
  return `${layer.change ? `${layer.change} ` : ''}${layer.cover}${word ? ` ${word}` : ''} ${fmtFt(layer.baseFtAmsl)}${top}`;
}

/** The low-level wind's eastward sign (rain drifts downwind) and the anvil's direction (wind near the top). */
function eastward(state: SkyState, ft: number): number {
  if (!state.winds.length) return 0;
  let best = state.winds[0];
  for (const wind of state.winds) if (Math.abs(wind.ftAmsl - ft) < Math.abs(best.ftAmsl - ft)) best = wind;
  // Blowing toward = from + 180; east component of the motion.
  return -best.kt * Math.sin((best.fromDeg * Math.PI) / 180);
}

function stateLayers(state: SkyState, options: SkyOptions, h: number, w: number): LayerPx[] {
  const out: LayerPx[] = [];
  state.layers.forEach((layer, index) => {
    if (layer.type === 'fog') return;
    const topFt = layer.topFtAmsl ?? Math.min(FT_MAX * 0.97, layer.baseFtAmsl + NOMINAL_DEPTH[layer.type]);
    const baseY = yForFt(layer.baseFtAmsl, h);
    const topY = Math.min(baseY - 4, yForFt(topFt, h));
    // Seeded by aerodrome, run, layer type and a 2,000 ft base band: the same
    // cloud keeps its shape and gaps while its top and base drift.
    const seed = hashString(`${options.seed}|${layer.type}|${Math.round(layer.baseFtAmsl / 2000)}|${layer.secondary ? index : ''}`);
    const pieces = layer.type === 'cumulus' ? Math.max(2, Math.round(w / 95))
      : layer.type === 'towering' ? Math.max(1, Math.round(w / 160))
        : layer.type === 'cumulonimbus' ? Math.max(1, Math.round(w / 260))
          : layer.type === 'altocumulus' ? Math.max(2, Math.round(w / 120))
            : layer.type === 'cirrus' ? Math.max(2, Math.round(w / 110))
              : Math.max(2, Math.round(w / 150));
    // A temporary state shares the picture: draw it in the half downwind of the station.
    out.push({ layer, baseY, topY, topKnown: layer.topFtAmsl != null, seed, segments: coverSegments(layer.oktas, seed, pieces) });
  });
  return out;
}

/**
 * Draw one state into `ctx` (CSS pixels; caller sets the dpr transform).
 * A generator: it yields between layers so a caller can spread the work over
 * animation frames. Run to completion with `drawSkySync`.
 */
export function* drawSky(ctx: Ctx, state: SkyState, options: SkyOptions, scratch: { clouds: Canvas; layer: Canvas }): Generator<void, void, void> {
  const { width: w, height: h, dpr } = options;
  const light = lightFor(state.sun.elevationDeg, state.sun.azimuthDeg, options.dark);
  const ink = inkFor(light);
  const sea = h - groundPx(h);
  const groundY = yForFt(state.elevationFt, h);
  const pxPerKm = w / SECTION_KM;
  const random = rng(hashString(`${options.seed}|sky`));

  // Sky.
  const sky = ctx.createLinearGradient(0, 0, 0, sea);
  sky.addColorStop(0, css(light.top));
  sky.addColorStop(0.75, css(mix(light.top, light.horizon, 0.7)));
  sky.addColorStop(1, css(light.horizon));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  if (light.glowAlpha > 0.01) {
    const side = light.lx >= 0 ? w : 0;
    const glow = ctx.createRadialGradient(side, sea, 0, side, sea, w * 0.7);
    glow.addColorStop(0, css(light.glow, light.glowAlpha));
    glow.addColorStop(1, css(light.glow, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, sea);
  }
  if (light.stars > 0.05) {
    const starRandom = rng(hashString(`${options.seed}|stars`));
    for (let k = 0; k < (w * h) / 1400; k++) {
      const x = starRandom() * w;
      const y = starRandom() * sea * 0.8;
      ctx.fillStyle = `rgba(230,236,255,${(0.2 + starRandom() * 0.6) * light.stars})`;
      ctx.fillRect(x, y, starRandom() < 0.1 ? 1.4 : 0.9, starRandom() < 0.1 ? 1.4 : 0.9);
    }
  }
  // Grid: a few true-altitude ticks.
  ctx.fillStyle = css(luminance(light.top) > 0.3 ? [255, 255, 255] : [200, 215, 235], 0.13);
  for (const ft of [5000, 10000, 20000, 30000, 40000]) ctx.fillRect(0, Math.round(yForFt(ft, h)), w, 1 / dpr);
  yield;

  // Clouds, each layer on its own scratch so shading stays inside the cloud.
  const clouds = scratch.clouds;
  const cctx = context(clouds);
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  cctx.clearRect(0, 0, clouds.width, clouds.height);
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const lctx = context(scratch.layer);
  const painterFor = (target: Ctx): Painter => ({ ctx: target, w, h, light, y: (ft) => yForFt(ft, h), pxPerKm });
  const layersPx = stateLayers(state, options, h, w);
  const shafts: { shaft: Shaft; alpha: number; thunder: boolean }[] = [];
  const freezeY = state.freezingFt != null ? yForFt(state.freezingFt, h) : null;
  const lowWind = eastward(state, state.elevationFt + 3000);
  const slantFor = (height: number) => Math.max(-0.35, Math.min(0.35, lowWind / 60)) * height;

  // High cloud first (furthest), low last.
  const order = [...layersPx].sort((a, b) => a.baseY - b.baseY);
  for (const lp of order) {
    const { layer, baseY, topY, segments } = lp;
    const layerRandom = rng(lp.seed);
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, scratch.layer.width, scratch.layer.height);
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const painter = painterFor(lctx);
    const topWind = Math.sign(eastward(state, layer.topFtAmsl ?? layer.baseFtAmsl + 20000));
    const precipCells: [number, number][] = [];
    if (layer.type === 'cumulus' || layer.type === 'towering') {
      for (const [s0, s1] of segments) {
        const x0 = s0 * w;
        const x1 = s1 * w;
        // Each cumulus is a heap about twice as wide as it is deep on screen.
        const depthPx = baseY - topY;
        const target = layer.type === 'towering' ? Math.max(34, Math.min(80, depthPx * 0.7)) : Math.max(20, Math.min(72, depthPx * 2.2));
        const n = Math.max(1, Math.round((x1 - x0) / target));
        for (let k = 0; k < n; k++) {
          const cw = (x1 - x0) / n;
          const cx = x0 + cw * (k + 0.5) + (layerRandom() - 0.5) * cw * 0.15;
          // Individual cumulus differ in height; the profile's top is the tallest.
          const tall = 0.55 + layerRandom() * 0.45;
          const top = baseY - (baseY - topY) * (k === Math.floor(n / 2) ? 1 : tall);
          if (layer.type === 'towering') towering(painter, cx, cw * 1.1, baseY, top, layerRandom);
          else cumulus(painter, cx, cw * (0.8 + layerRandom() * 0.25), baseY, top, layerRandom);
        }
        precipCells.push([x0 + (x1 - x0) * 0.15, x1 - (x1 - x0) * 0.15]);
      }
    } else if (layer.type === 'cumulonimbus') {
      // The widest piece is the storm; the rest grow as towering cumulus.
      const widest = segments.reduce((best, seg) => (seg[1] - seg[0] > best[1] - best[0] ? seg : best), segments[0] ?? [0.4, 0.6]);
      for (const seg of segments) {
        if (seg === widest) continue;
        const cx = ((seg[0] + seg[1]) / 2) * w;
        towering(painter, cx, Math.max(30, (seg[1] - seg[0]) * w), baseY, baseY - (baseY - topY) * 0.45, layerRandom);
      }
      const cw = Math.max(46, Math.min(w * 0.24, (widest[1] - widest[0]) * w * 0.8));
      // Keep the anvil on the picture: centre the storm upwind of the middle.
      const cx = Math.max(cw, Math.min(w - cw, ((widest[0] + widest[1]) / 2) * w - topWind * w * 0.12));
      cumulonimbus(painter, cx, cw, baseY, topY, layerRandom, topWind, lp.topKnown);
      precipCells.push([cx - cw * 0.7, cx + cw * 0.6]);
    } else {
      for (const [s0, s1] of segments) {
        const x0 = s0 * w;
        const x1 = s1 * w;
        if (layer.type === 'stratocumulus') stratocumulus(painter, x0, x1, baseY, topY, layerRandom);
        else if (layer.type === 'stratus') stratus(painter, x0, x1, baseY, topY, layerRandom, layer.precip !== 'none');
        else if (layer.type === 'altostratus') altostratus(painter, x0, x1, baseY, topY, layerRandom);
        else if (layer.type === 'altocumulus') altocumulus(painter, x0, x1, baseY, topY, layerRandom);
        else if (layer.type === 'cirrus') cirrus(painter, x0, x1, baseY, topY, layer.oktas, layerRandom, topWind);
        precipCells.push([x0 + (x1 - x0) * 0.08, x1 - (x1 - x0) * 0.08]);
      }
    }
    if (layer.type === 'cumulus' || layer.type === 'towering' || layer.type === 'cumulonimbus') {
      // One shading pass per layer: darker toward the shared flat base.
      baseShade(lctx, 0, w, topY, baseY, light, Math.min(1, (baseY - topY) / 90));
    }
    if (!lp.topKnown) {
      // Unknown top: fade the cloud out above its nominal depth's lower half.
      lctx.save();
      lctx.globalCompositeOperation = 'destination-out';
      const g = lctx.createLinearGradient(0, topY - 8, 0, topY + (baseY - topY) * 0.6);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.fillRect(0, 0, w, topY + (baseY - topY) * 0.6);
      lctx.restore();
    }
    cctx.save();
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.globalAlpha = layer.secondary ? 0.5 : layer.source === 'model' ? 0.92 : 1;
    cctx.drawImage(scratch.layer as CanvasImageSource, 0, 0);
    cctx.restore();
    if (layer.precip !== 'none') {
      const bottomFt = layer.precipBottomFtAmsl ?? state.elevationFt;
      const bottomY = Math.min(groundY, yForFt(bottomFt, h));
      // Rain under part of each cell, not the whole cloud.
      for (const [c0, c1] of precipCells) {
        const width = c1 - c0;
        const share = layer.heavy || layer.type === 'stratus' || layer.precip === 'drizzle' ? 0.75 : 0.35 + layerRandom() * 0.35;
        const r0 = c0 + width * (1 - share) * (0.2 + layerRandom() * 0.6);
        const r1 = r0 + width * share;
        shafts.push({
          shaft: { x0: r0, x1: Math.min(c1, r1), topY: baseY, bottomY, kind: layer.precip, heavy: layer.heavy, freezeY: layer.precip === 'virga' || layer.precip === 'snow' ? (layer.precip === 'virga' ? freezeY : null) : freezeY, slant: slantFor(bottomY - baseY) },
          alpha: layer.secondary ? 0.5 : 1,
          thunder: layer.thunder,
        });
      }
    }
    yield;
  }

  // Icing: tint and hatch cloud between 0 and −20 °C.
  if (state.icing.length) {
    cctx.save();
    cctx.globalCompositeOperation = 'source-atop';
    for (const band of state.icing) {
      const y0 = yForFt(band.topFt, h);
      const y1 = yForFt(band.baseFt, h);
      cctx.fillStyle = 'rgba(90,190,255,0.13)';
      cctx.fillRect(0, y0, w, y1 - y0);
      cctx.strokeStyle = 'rgba(40,140,220,0.2)';
      cctx.lineWidth = 0.8;
      cctx.beginPath();
      for (let x = -40; x < w + 40; x += 6) { cctx.moveTo(x, y1); cctx.lineTo(x + (y1 - y0), y0); }
      cctx.stroke();
    }
    cctx.restore();
  }

  // Precipitation sits behind the clouds' bases but in front of the sky.
  for (const { shaft, alpha } of shafts) precipitation(ctx, shaft, light, random, alpha);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(clouds as CanvasImageSource, 0, 0);
  ctx.restore();
  for (const { shaft, thunder, alpha } of shafts) {
    if (thunder && alpha === 1) lightning(ctx, (shaft.x0 + shaft.x1) / 2 + shaft.slant * 0.2, shaft.topY + 2, shaft.topY + (shaft.bottomY - shaft.topY) * 0.75, random);
  }
  yield;

  // Fog, mist or haze over everything near the ground.
  const fog = state.layers.find((layer) => layer.type === 'fog');
  if (fog && state.obscuration) {
    ctx.save();
    ctx.globalAlpha = fog.secondary ? 0.5 : 1;
    fogBand(painterFor(ctx as Ctx), yForFt(fog.topFtAmsl ?? state.elevationFt + 300, h), groundY, state.obscuration.kind, state.obscuration.visM, random);
    ctx.restore();
  }

  // Ground: land, sea along the section, the aerodrome at the centre.
  ctx.fillStyle = css(light.land);
  ctx.fillRect(0, groundY, w, h - groundY);
  if (options.coastKm != null) {
    const coastX = w / 2 + options.coastKm * pxPerKm;
    ctx.fillStyle = css(light.sea);
    if (options.coastKm < 0) ctx.fillRect(0, sea, Math.max(0, coastX), groundPx(h));
    else ctx.fillRect(Math.min(w, coastX), sea, w, groundPx(h));
  }
  const ground = ctx.createLinearGradient(0, groundY, 0, h);
  ground.addColorStop(0, 'rgba(255,255,255,0.12)');
  ground.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = ground;
  ctx.fillRect(0, groundY, w, h - groundY);
  ctx.fillStyle = luminance(light.land) > 0.25 ? 'rgba(40,40,44,0.85)' : 'rgba(150,150,160,0.6)';
  ctx.fillRect(w / 2 - 14, groundY, 28, 1.6);
  ctx.fillRect(w / 2 - 1, groundY - 5, 2, 5);
  ctx.fillRect(w / 2 - 2.5, groundY - 7, 5, 2.4);
  yield;

  if (options.compact) {
    if (state.freezingFt != null) {
      ctx.fillStyle = ink.fz;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(0, Math.round(yForFt(state.freezingFt, h)), w, 1);
      ctx.globalAlpha = 1;
    }
    return;
  }
  // Freezing level and −20 °C.
  const right = w - 46;
  if (state.freezingFt != null) {
    const y = yForFt(state.freezingFt, h);
    ctx.save();
    ctx.strokeStyle = ink.fz;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.restore();
    label(ctx, `0°C ${fmtFt(state.freezingFt)}`, right - 3, y - 7, ink, { align: 'right', colour: ink.fz, size: 10 });
  }
  if (state.minus20Ft != null && state.minus20Ft < FT_MAX) {
    const y = yForFt(state.minus20Ft, h);
    ctx.save();
    ctx.strokeStyle = ink.fz;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.setLineDash([1.5, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.restore();
    label(ctx, `−20°C`, right - 3, y - 7, ink, { align: 'right', colour: ink.fz, size: 9.5, weight: 500 });
  }
  for (const band of state.icing) {
    const y0 = yForFt(band.topFt, h);
    const y1 = yForFt(band.baseFt, h);
    ctx.fillStyle = ink.ice;
    ctx.fillRect(31, y0, 2.5, Math.max(1, y1 - y0));
  }

  // Axis: true altitude, ft AMSL.
  for (const ft of [5000, 10000, 20000, 30000, 40000]) {
    const y = yForFt(ft, h);
    label(ctx, ft === 40000 ? '40k ft' : `${ft / 1000}k`, 4, y, ink, { size: 9.5, weight: 500, colour: ink.muted });
  }

  // Layer labels at their bases, left side, kept apart.
  const placed: number[] = [];
  const labels = state.layers
    .filter((layer) => layer.type !== 'fog')
    .map((layer) => ({ layer, y: yForFt(layer.baseFtAmsl, h) + 8 }))
    .sort((a, b) => b.y - a.y);
  for (const item of labels) {
    let y = Math.min(item.y, groundY - 6);
    while (placed.some((p) => Math.abs(p - y) < 12)) y -= 12;
    placed.push(y);
    label(ctx, layerLabel(item.layer), 38, y, ink, {
      colour: item.layer.type === 'cumulonimbus' ? (ink.text === '#0f1c2a' ? '#b3261e' : '#ff8a80') : item.layer.source === 'model' || item.layer.secondary ? ink.muted : ink.text,
      italic: item.layer.source === 'model',
      weight: item.layer.secondary ? 500 : 600,
    });
  }
  if (fog && state.obscuration) {
    const vis = state.obscuration.visM;
    const text = `${state.obscuration.kind}${vis != null && vis < 10000 ? ` ${vis >= 5000 ? `${vis / 1000} km` : `${vis.toLocaleString('en-AU')} m`}` : ''}`;
    label(ctx, text, w / 2 + 20, groundY - 9, ink, { size: 10 });
  }
  label(ctx, `${state.icao} ${state.elevationFt} ft`, w / 2, h - groundPx(h) / 2, { ...ink, halo: 'rgba(0,0,0,0.35)' }, { align: 'center', size: 9.5, weight: 600, colour: 'rgba(255,255,255,0.92)' });
  label(ctx, 'W', 5, h - groundPx(h) / 2, { ...ink, halo: 'rgba(0,0,0,0.35)' }, { size: 9, weight: 600, colour: 'rgba(255,255,255,0.85)' });
  label(ctx, 'E', w - 5, h - groundPx(h) / 2, { ...ink, halo: 'rgba(0,0,0,0.35)' }, { align: 'right', size: 9, weight: 600, colour: 'rgba(255,255,255,0.85)' });

  // Winds by level on the right, with the key.
  if (state.winds.length) {
    ctx.fillStyle = luminance(light.top) > 0.25 ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.18)';
    ctx.fillRect(w - 40, 0, 40, sea);
    let lastY = Infinity;
    for (const wind of [...state.winds].sort((a, b) => a.ftAmsl - b.ftAmsl)) {
      const y = yForFt(wind.ftAmsl, h);
      if (y < 30 || y > sea - 6 || lastY - y < 17) continue;
      lastY = y;
      drawBarb(ctx, w - 20, y, wind.kt, wind.fromDeg, ink.text);
    }
    // Key: half 5, full 10, pennant 50 kt.
    const keyY = 11;
    const keyX = w - 132;
    ctx.fillStyle = luminance(light.top) > 0.25 ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.4)';
    ctx.fillRect(keyX - 4, keyY - 8, 136, 16);
    ([[5, 0, '5'], [10, 34, '10'], [50, 72, '50 kt']] as const).forEach(([kt, dx, text]) => {
      drawBarb(ctx, keyX + dx + 14, keyY + 3, kt, 270, ink.text, 12);
      label(ctx, text, keyX + dx + 16, keyY, ink, { size: 9.5, weight: 500 });
    });
  }
  if (!state.hasProfile) {
    label(ctx, 'No model profile: tops, winds and 0°C unknown', w / 2, 14, ink, { align: 'center', size: 10, weight: 500, colour: ink.muted });
  }
}

export function drawSkySync(ctx: Ctx, state: SkyState, options: SkyOptions, scratch: { clouds: Canvas; layer: Canvas }) {
  const steps = drawSky(ctx, state, options, scratch);
  while (!steps.next().done) { /* run to completion */ }
}

/** A stable key for a state's picture: what changes it, rounded to what can be seen. */
export function stateKey(state: SkyState, options: SkyOptions): string {
  const r = (value: number | null, step: number) => (value == null ? '-' : Math.round(value / step));
  const layers = state.layers.map((l) => [l.type[0] + l.type[2], r(l.baseFtAmsl, 100), r(l.topFtAmsl, 100), l.oktas, l.precip[0], l.heavy ? 1 : 0, l.thunder ? 1 : 0, l.secondary ? 1 : 0, l.change ?? '', r(l.precipBottomFtAmsl, 250), l.source[0]].join(':'));
  const winds = state.winds.map((w) => `${r(w.kt, 5)}/${r(w.fromDeg, 10)}`).join(',');
  return [
    options.seed, options.width, options.height, options.dpr, options.dark ? 1 : 0, options.coastKm, options.compact ? 'c' : '',
    state.icao, state.elevationFt, r(state.sun.elevationDeg, 2), state.sun.azimuthDeg > 180 ? 'w' : 'e',
    r(state.freezingFt, 100), r(state.minus20Ft, 100), state.icing.map((b) => `${r(b.baseFt, 100)}-${r(b.topFt, 100)}`).join(','),
    state.obscuration ? `${state.obscuration.kind}${state.obscuration.visM}` : '', layers.join('|'), winds, state.hasProfile ? 1 : 0,
  ].join('#');
}

/* ---------- the animator: cached states, crossfades, frame stats ---------- */

interface Built { key: string; canvas: Canvas }

export interface FrameStats { frames: number[]; builds: number[] }

/**
 * Owns the visible canvas. `show()` sets the target state; the picture for a
 * new state is built incrementally (≤ ~6 ms of drawing per frame) into a cache,
 * then crossfaded in over 220 ms. States already in the cache are instant.
 */
export class SkyAnimator {
  private canvas: HTMLCanvasElement;
  private cache = new Map<string, Built>();
  private shown: Built | null = null;
  private previous: Built | null = null;
  private fadeStart = 0;
  private building: { key: string; canvas: Canvas; steps: Generator<void, void, void>; started: number } | null = null;
  private pending: { state: SkyState; options: SkyOptions; key: string } | null = null;
  private raf = 0;
  private scratch: { clouds: Canvas; layer: Canvas } | null = null;
  readonly stats: FrameStats = { frames: [], builds: [] };
  fadeMs = 220;
  budgetMs = 6;
  maxCache = 24;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  show(state: SkyState, options: SkyOptions) {
    const key = stateKey(state, options);
    if (this.canvas.width !== Math.round(options.width * options.dpr) || this.canvas.height !== Math.round(options.height * options.dpr)) {
      this.canvas.width = Math.round(options.width * options.dpr);
      this.canvas.height = Math.round(options.height * options.dpr);
      this.shown = null;
      this.previous = null;
    }
    if (this.shown?.key === key && !this.building) return;
    this.pending = { state, options, key };
    this.kick();
  }

  /** Draw a state synchronously (tests, screenshots). */
  showNow(state: SkyState, options: SkyOptions) {
    this.show(state, options);
    while (this.pending || this.building) this.step(performance.now(), Infinity);
    this.previous = null;
    this.paint(performance.now() + this.fadeMs);
  }

  dispose() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cache.clear();
  }

  private kick() {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  private tick(now: number) {
    this.raf = 0;
    const t0 = performance.now();
    this.step(now, this.budgetMs);
    const fading = this.paint(now);
    this.stats.frames.push(performance.now() - t0);
    if (this.stats.frames.length > 2000) this.stats.frames.splice(0, 1000);
    if (fading || this.pending || this.building) this.kick();
  }

  private step(now: number, budget: number) {
    const start = performance.now();
    if (this.pending && (!this.building || this.building.key !== this.pending.key)) {
      const { state, options, key } = this.pending;
      const hit = this.cache.get(key);
      if (hit) {
        this.cache.delete(key);
        this.cache.set(key, hit);
        this.present(hit, now);
        this.pending = null;
        this.building = null;
        return;
      }
      const canvas = makeCanvas(Math.round(options.width * options.dpr), Math.round(options.height * options.dpr));
      const ctx = context(canvas);
      ctx.setTransform(options.dpr, 0, 0, options.dpr, 0, 0);
      if (!this.scratch || this.scratch.clouds.width !== canvas.width || this.scratch.clouds.height !== canvas.height) {
        this.scratch = { clouds: makeCanvas(canvas.width, canvas.height), layer: makeCanvas(canvas.width, canvas.height) };
      }
      this.building = { key, canvas, steps: drawSky(ctx, state, options, this.scratch), started: performance.now() };
      this.pending = null;
    }
    while (this.building && performance.now() - start < budget) {
      const built = this.building;
      if (built.steps.next().done) {
        this.stats.builds.push(performance.now() - built.started);
        const entry = { key: built.key, canvas: built.canvas };
        this.cache.set(built.key, entry);
        while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value as string);
        this.building = null;
        this.present(entry, now);
      }
    }
  }

  private present(entry: Built, now: number) {
    if (this.shown?.key === entry.key) return;
    this.previous = this.shown;
    this.shown = entry;
    this.fadeStart = now;
  }

  /** Returns true while a crossfade is running. */
  private paint(now: number): boolean {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this.shown) return false;
    const f = this.previous ? Math.min(1, (now - this.fadeStart) / this.fadeMs) : 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    if (this.previous && f < 1) {
      ctx.drawImage(this.previous.canvas as CanvasImageSource, 0, 0);
      ctx.globalAlpha = f;
    }
    ctx.drawImage(this.shown.canvas as CanvasImageSource, 0, 0);
    ctx.globalAlpha = 1;
    if (f >= 1) this.previous = null;
    return f < 1;
  }
}

/** Metres → feet, re-exported for callers that only import the renderer. */
export const feet = (m: number) => m * FT_PER_M;
