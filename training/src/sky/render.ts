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
import { FT_PER_M, hashString, rng, type SkyLayer, type SkyState } from './physics.ts';
import { AUS_UNITS, feetToMetres, formatTempC, formatVisibilityMetres, unitKey, type DisplayUnits } from './units.ts';

import { coverageFraction, coverageSegments } from './cloud-rules.ts';
import { cloudSpritesReady, prepareCloudSprites, paintCloudSprite } from './painted.ts';

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
  /** A single vertical column: no W/E geography, aerodrome or duplicate wind key. */
  mode?: 'section' | 'column';
  /** Unknown terrain has no drawn ground; zero remains only the AMSL axis datum. */
  groundKnown?: boolean;
  /** Display units. Omitted keeps the Celsius / feet labels. */
  units?: DisplayUnits;
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

interface LayerPx {
  layer: SkyLayer; baseY: number; topY: number; topKnown: boolean;
  seed: number; segments: [number, number][];
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
    } else if (kind === 'drizzle' || freezeY == null) {
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

export function layerLabel(layer: SkyLayer, units?: DisplayUnits): string {
  const word = typeWord[layer.type];
  const height = (ft: number) => units?.height === 'm'
    ? Math.round(feetToMetres(ft)).toLocaleString('en-AU')
    : fmtFt(ft);
  const top = layer.topFtAmsl != null && layer.topFtAmsl - layer.baseFtAmsl >= 400 ? `–${height(layer.topFtAmsl)}` : '';
  return `${layer.change ? `${layer.change} ` : ''}${layer.cover}${word ? ` ${word}` : ''} ${height(layer.baseFtAmsl)}${top}`;
}

/** The low-level wind's eastward sign (rain drifts downwind) and the anvil's direction (wind near the top). */
function eastward(state: SkyState, ft: number): number {
  if (!state.winds.length) return 0;
  let best = state.winds[0];
  for (const wind of state.winds) if (Math.abs(wind.ftAmsl - ft) < Math.abs(best.ftAmsl - ft)) best = wind;
  // Blowing toward = from + 180; east component of the motion.
  return -best.kt * Math.sin((best.fromDeg * Math.PI) / 180);
}

export function stateLayers(state: SkyState, options: SkyOptions, h = options.height): LayerPx[] {
  return state.layers.flatMap((layer, index) => {
    if (layer.type === 'fog' || !Number.isFinite(layer.baseFtAmsl) || layer.baseFtAmsl < state.elevationFt) return [];
    const fraction = coverageFraction(layer.cover);
    if (fraction == null || !(layer.oktas > 0)) return [];
    if (layer.topFtAmsl != null && (!Number.isFinite(layer.topFtAmsl) || layer.topFtAmsl <= layer.baseFtAmsl)) return [];
    const seed = hashString(`${options.seed}|${layer.type}|${Math.round(layer.baseFtAmsl / 2000)}|${layer.secondary ? index : ''}`);
    const coherent = ['nimbostratus', 'cumulonimbus', 'towering'].includes(layer.type);
    const segments: [number, number][] = coherent ? [[(1 - fraction) / 2, (1 + fraction) / 2]]
      : coverageSegments(layer.cover, seed).map(s => [s.start, s.end]);
    const baseY = yForFt(layer.baseFtAmsl, h);
    const topKnown = layer.topFtAmsl != null && layer.type !== 'unknown';
    return [{ layer, baseY, topY: topKnown ? yForFt(layer.topFtAmsl!, h) : baseY, topKnown, seed, segments }];
  });
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
  const layersPx = stateLayers(state, options, h);
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
    const topWind = Math.sign(eastward(state, layer.topFtAmsl ?? layer.baseFtAmsl + 20000));
    const precipCells: [number, number][] = [];
    for (const [s0, s1] of segments) {
      const x0 = s0 * w, x1 = s1 * w;
      const painted = lp.topKnown && paintCloudSprite(lctx, layer.type, x0, topY, x1 - x0, baseY - topY,
        options.dark, light.night, topWind < 0 && (layer.type === 'cumulonimbus' || layer.type === 'cirrus'));
      if (!painted) {
        // Missing top/genus or unavailable art: retain only the known base.
        lctx.save(); lctx.strokeStyle = ink.muted; lctx.lineWidth = 1.2; lctx.setLineDash([4, 3]);
        lctx.beginPath(); lctx.moveTo(x0, baseY); lctx.lineTo(x1, baseY); lctx.stroke(); lctx.restore();
      }
      // Rain stays below its own base; the CB core, not its whole anvil, rains.
      const inset = layer.type === 'cumulonimbus' ? 0.28 : 0.08;
      precipCells.push([x0 + (x1 - x0) * inset, x1 - (x1 - x0) * inset]);
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
        const share = layer.heavy || layer.type === 'stratus' || layer.type === 'nimbostratus' || layer.precip === 'drizzle' ? 0.75 : 0.35 + layerRandom() * 0.35;
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
  if (options.groundKnown !== false) {
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
    if (options.mode !== 'column') {
      ctx.fillRect(w / 2 - 14, groundY, 28, 1.6);
      ctx.fillRect(w / 2 - 1, groundY - 5, 2, 5);
      ctx.fillRect(w / 2 - 2.5, groundY - 7, 5, 2.4);
    }
  }
  yield;

  const units = options.units ?? AUS_UNITS;
  const metricHeight = units.height === 'm';
  const showM = (ft: number) => Math.round(feetToMetres(ft)).toLocaleString('en-AU');
  const axisTick = (ft: number, withUnit: boolean) => {
    if (!metricHeight) return withUnit && ft === 40000 ? '40k ft' : `${ft / 1000}k`;
    return withUnit ? `${showM(ft)} m` : showM(ft);
  };
  const freezeText = (ft: number | null, withHeight: boolean) => {
    const temp = units.temp === 'F' ? '32°F' : '0°C';
    if (!withHeight || ft == null) return temp;
    return metricHeight ? `${temp} ${showM(ft)} m` : `${temp} ${fmtFt(ft)}`;
  };
  if (options.mode === 'column') {
    // Narrow column: real cloud/terrain heights and one altitude scale. All
    // numeric winds and temperatures live in the adjacent aligned table.
    for (const ft of [5000, 10000, 20000, 30000, 40000]) {
      label(ctx, axisTick(ft, false), 4, yForFt(ft, h), ink, { size: 10, weight: 500, colour: ink.muted });
    }
    if (state.freezingFt != null) {
      const y = yForFt(state.freezingFt, h);
      ctx.fillStyle = ink.fz;
      ctx.fillRect(0, Math.round(y), w, 1);
      label(ctx, freezeText(state.freezingFt, false), w - 4, y - 7, ink, { align: 'right', colour: ink.fz, size: 10 });
    }
    label(ctx, metricHeight ? 'm AMSL' : 'ft AMSL', 4, h - 7, ink, { size: 9, weight: 500 });
    return;
  }
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
    label(ctx, freezeText(state.freezingFt, true), right - 3, y - 7, ink, { align: 'right', colour: ink.fz, size: 10 });
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
    label(ctx, units.temp === 'F' ? (formatTempC(-20, units, { unit: true }) ?? '−4°F') : '−20°C', right - 3, y - 7, ink, { align: 'right', colour: ink.fz, size: 9.5, weight: 500 });
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
    label(ctx, axisTick(ft, ft === 40000), 4, y, ink, { size: 9.5, weight: 500, colour: ink.muted });
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
    label(ctx, layerLabel(item.layer, units), 38, y, ink, {
      colour: item.layer.type === 'cumulonimbus' ? (ink.text === '#0f1c2a' ? '#b3261e' : '#ff8a80') : item.layer.source === 'model' || item.layer.secondary ? ink.muted : ink.text,
      italic: item.layer.source === 'model',
      weight: item.layer.secondary ? 500 : 600,
    });
  }
  if (fog && state.obscuration) {
    const vis = state.obscuration.visM;
    const visLabel = vis != null && vis < 10000 ? formatVisibilityMetres(vis, units) : null;
    const text = `${state.obscuration.kind}${visLabel ? ` ${visLabel}` : ''}`;
    label(ctx, text, w / 2 + 20, groundY - 9, ink, { size: 10 });
  }
  label(ctx, `${state.icao} ${metricHeight ? `${showM(state.elevationFt)} m` : `${state.elevationFt} ft`}`, w / 2, h - groundPx(h) / 2, { ...ink, halo: 'rgba(0,0,0,0.35)' }, { align: 'center', size: 9.5, weight: 600, colour: 'rgba(255,255,255,0.92)' });
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
    label(ctx, units.temp === 'F' ? 'No model profile: tops, winds and 32°F unknown' : 'No model profile: tops, winds and 0°C unknown', w / 2, 14, ink, { align: 'center', size: 10, weight: 500, colour: ink.muted });
  }
}

export function drawSkySync(ctx: Ctx, state: SkyState, options: SkyOptions, scratch: { clouds: Canvas; layer: Canvas }) {
  const steps = drawSky(ctx, state, options, scratch);
  while (!steps.next().done) { /* run to completion */ }
}

/** A stable key for a state's picture: what changes it, rounded to what can be seen. */
export function stateKey(state: SkyState, options: SkyOptions): string {
  const r = (value: number | null, step: number) => (value == null ? '-' : Math.round(value / step));
  const layers = state.layers.map((l) => [l.type, l.cover, r(l.baseFtAmsl, 100), r(l.topFtAmsl, 100), l.oktas, l.precip[0], l.heavy ? 1 : 0, l.thunder ? 1 : 0, l.secondary ? 1 : 0, l.change ?? '', r(l.precipBottomFtAmsl, 250), l.source[0]].join(':'));
  const winds = state.winds.map((w) => `${r(w.ftAmsl, 100)}/${r(w.kt, 5)}/${r(w.fromDeg, 10)}`).join(',');
  const picture = [
    cloudSpritesReady() ? 'painted' : 'bases', options.seed, options.width, options.height, options.dpr, options.dark ? 1 : 0, options.coastKm, options.compact ? 'c' : '', options.mode ?? 'section', options.groundKnown === false ? '?' : '',
    state.icao, state.elevationFt, r(state.sun.elevationDeg, 2), state.sun.azimuthDeg > 180 ? 'w' : 'e',
    r(state.freezingFt, 100), r(state.minus20Ft, 100), state.icing.map((b) => `${r(b.baseFt, 100)}-${r(b.topFt, 100)}`).join(','),
    state.obscuration ? `${state.obscuration.kind}${state.obscuration.visM}` : '', layers.join('|'), winds, state.hasProfile ? 1 : 0,
  ].join('#');
  return options.units ? `${picture}#${unitKey(options.units)}` : picture;
}

/* ---------- the animator: cached states, crossfades, frame stats ---------- */

interface Built { key: string; canvas: Canvas }

export interface FrameStats { frames: number[]; builds: number[] }

/**
 * Owns the visible canvas. `show()` sets the target state; the picture for a
 * new state is built incrementally (a 2 ms submission budget between layers) into a cache,
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
  private disposed = false;
  private preparing = false;
  private artFailed = false;
  private latest: { state: SkyState; options: SkyOptions } | null = null;
  private scratch: { clouds: Canvas; layer: Canvas } | null = null;
  readonly stats: FrameStats = { frames: [], builds: [] };
  fadeMs = 220;
  budgetMs = 2;
  maxCache = 24;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  show(state: SkyState, options: SkyOptions) {
    if (this.disposed) return;
    this.latest = { state, options };
    if (!cloudSpritesReady() && !this.artFailed) {
      if (!this.preparing) {
        this.preparing = true;
        prepareCloudSprites().catch(() => { this.artFailed = true; }).then(() => {
          this.preparing = false;
          if (!this.disposed && this.latest) this.show(this.latest.state, this.latest.options);
        });
      }
    }
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
    this.disposed = true;
    this.latest = null; this.pending = null; this.building = null; this.shown = null; this.previous = null; this.scratch = null;
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
