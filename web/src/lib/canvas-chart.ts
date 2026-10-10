import type { KiteBand } from './coastal';
import { fieldBase, fieldColor, type FieldId, type Rgba } from './field-color';
import { unproject, type Camera, type Lambert } from './lambert';

export interface CanvasLand {
  pixels: Uint8Array;
  width: number;
  height: number;
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface CanvasFrame {
  data: Uint16Array;
  scale: number;
  offset: number;
  fill: number;
}

export interface CanvasView {
  camera: Camera;
  lambert: Lambert;
  west: number;
  north: number;
  dlon: number;
  dlat: number;
  nx: number;
  ny: number;
  blend: number;
  field: FieldId;
  kiteBand?: KiteBand | null;
  dark?: boolean;
  /** 0–1 cover of the colour field over the plate. Omitted means fully covered. */
  fieldAlpha?: number;
}

const MAX_WIDTH = 480;
const MAX_HEIGHT = 320;
const PERIOD = 360;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function wrap(value: number, period: number): number {
  return ((value % period) + period) % period;
}

function decoded(frame: CanvasFrame, raw: number): number {
  return raw === frame.fill ? NaN : raw * frame.scale + frame.offset;
}

/** Missing-aware bilinear sample used by the bounded Canvas2D fallback. */
export function sampleCanvasField(
  frame: CanvasFrame,
  lon: number,
  lat: number,
  view: Pick<CanvasView, 'west' | 'north' | 'dlon' | 'dlat' | 'nx' | 'ny'>,
  wrapsLongitude: boolean,
): number {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || view.nx < 2 || view.ny < 2) return NaN;
  if (lat < Math.min(view.north, view.north + view.dlat * (view.ny - 1))
    || lat > Math.max(view.north, view.north + view.dlat * (view.ny - 1))) return NaN;
  if (!wrapsLongitude && (lon < Math.min(view.west, view.west + view.dlon * (view.nx - 1))
    || lon > Math.max(view.west, view.west + view.dlon * (view.nx - 1)))) return NaN;
  const periodCells = wrapsLongitude ? PERIOD / Math.abs(view.dlon) : view.nx - 1;
  const gxRaw = (lon - view.west) / view.dlon;
  const gx = wrapsLongitude ? wrap(gxRaw, periodCells) : gxRaw;
  const gy = clamp((lat - view.north) / view.dlat, 0, view.ny - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = gx - x0;
  const ty = gy - y0;
  let total = 0;
  let weight = 0;
  for (let dy = 0; dy <= 1; dy += 1) {
    const y = Math.min(view.ny - 1, y0 + dy);
    for (let dx = 0; dx <= 1; dx += 1) {
      const x = wrapsLongitude ? ((x0 + dx) % view.nx + view.nx) % view.nx : Math.min(view.nx - 1, x0 + dx);
      const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
      if (w === 0) continue;
      const value = decoded(frame, frame.data[y * view.nx + x]);
      if (!Number.isFinite(value)) return NaN;
      total += value * w;
      weight += w;
    }
  }
  return weight > 0 ? total / weight : NaN;
}

export function blendCanvasField(a: number, b: number, blend: number): number {
  if (blend <= 0) return a;
  if (blend >= 1) return b;
  return Number.isFinite(a) && Number.isFinite(b) ? lerp(a, b, blend) : NaN;
}

function colour(base: Rgba, tint: Rgba): Rgba {
  const alpha = clamp(tint.a, 0, 1);
  return {
    r: base.r * (1 - alpha) + tint.r * alpha,
    g: base.g * (1 - alpha) + tint.g * alpha,
    b: base.b * (1 - alpha) + tint.b * alpha,
    a: 1,
  };
}

function landAt(land: CanvasLand, lon: number, lat: number, wrapsLongitude: boolean): number {
  let xLon = lon;
  if (wrapsLongitude) xLon = land.west + wrap(xLon - land.west, PERIOD);
  const x = Math.floor(((xLon - land.west) / (land.east - land.west)) * land.width);
  const y = Math.floor(((lat - land.south) / (land.north - land.south)) * land.height);
  if (x < 0 || y < 0 || x >= land.width || y >= land.height) return 0;
  return land.pixels[y * land.width + x] > 127 ? 1 : 0;
}

function waterAt(water: CanvasLand, lon: number, lat: number): number {
  const x = Math.floor(((lon - water.west) / (water.east - water.west)) * water.width);
  const y = Math.floor(((lat - water.south) / (water.north - water.south)) * water.height);
  if (x < 0 || y < 0 || x >= water.width || y >= water.height) return 0;
  return water.pixels[y * water.width + x] > 127 ? 1 : 0;
}

export interface CanvasChart {
  resize(width: number, height: number): void;
  setLand(land: CanvasLand): void;
  setWater(water: CanvasLand | null): void;
  setFrames(a: CanvasFrame | null, b: CanvasFrame | null): void;
  draw(view: CanvasView): void;
  usable(): boolean;
  destroy(): void;
}

export function createCanvasChart(canvas: HTMLCanvasElement): CanvasChart {
  const context = canvas.getContext('2d', { alpha: false });
  let land: CanvasLand | null = null;
  let water: CanvasLand | null = null;
  let frameA: CanvasFrame | null = null;
  let frameB: CanvasFrame | null = null;
  let width = 1;
  let height = 1;
  let lastDraw = 0;
  let queued: CanvasView | null = null;
  let timer = 0;
  let scratch: HTMLCanvasElement | null = null;
  let cachedKey = '';
  let cachedLon: Float64Array | null = null;
  let cachedLat: Float64Array | null = null;
  let cachedLand: Uint8Array | null = null;
  let cachedWidth = 0;
  let cachedHeight = 0;
  let pixels: ImageData | null = null;
  let renderedKey = '';
  let frameGeneration = 0;

  const render = (view: CanvasView) => {
    if (!context || !land) return;
    const latSpan = view.lambert.projection === 'equirectangular'
      ? Math.abs(view.camera.halfHeight * 2)
      : Math.abs(view.camera.halfHeight * 2 * 180 / Math.PI);
    const maxW = latSpan < 8 ? 1280 : MAX_WIDTH;
    const maxH = latSpan < 8 ? 800 : MAX_HEIGHT;
    const ratio = Math.min(1, maxW / width, maxH / height);
    const rw = Math.max(1, Math.round(width * ratio));
    const rh = Math.max(1, Math.round(height * ratio));
    if (!pixels || pixels.width !== rw || pixels.height !== rh) pixels = context.createImageData(rw, rh);
    const image = pixels;
    const wraps = view.lambert.projection === 'equirectangular';
    const key = `${rw}:${rh}:${view.camera.centerX.toFixed(5)}:${view.camera.centerY.toFixed(5)}:${view.camera.halfWidth.toFixed(5)}:${view.camera.halfHeight.toFixed(5)}:${JSON.stringify(view.lambert)}:${land.west}:${land.east}:${land.south}:${land.north}:${water ? `${water.west}:${water.east}:${water.south}:${water.north}:${water.width}x${water.height}` : ''}`;
    const drawKey = `${key}:${view.field}:${view.kiteBand?.min}:${view.kiteBand?.max}:${Boolean(view.dark)}:${(view.fieldAlpha ?? 1).toFixed(2)}:${view.field === 'none' ? '' : `${frameGeneration}:${view.blend}`}`;
    if (drawKey === renderedKey) return;
    const sea: Rgba = view.dark ? { r: 0.137, g: 0.184, b: 0.243, a: 1 } : { r: 0.914, g: 0.937, b: 0.957, a: 1 };
    const landColour: Rgba = view.dark ? { r: 0.4, g: 0.345, b: 0.224, a: 1 } : { r: 0.945, g: 0.925, b: 0.733, a: 1 };
    if (key !== cachedKey || cachedWidth !== rw || cachedHeight !== rh || !cachedLon || !cachedLat || !cachedLand) {
      cachedKey = key;
      cachedWidth = rw;
      cachedHeight = rh;
      cachedLon = new Float64Array(rw * rh);
      cachedLat = new Float64Array(rw * rh);
      cachedLand = new Uint8Array(rw * rh);
      cachedLon.fill(NaN);
      cachedLat.fill(NaN);
      for (let py = 0; py < rh; py += 1) {
        const y = view.camera.centerY + (1 - ((py + 0.5) / rh) * 2) * view.camera.halfHeight;
        for (let px = 0; px < rw; px += 1) {
          const x = view.camera.centerX + (((px + 0.5) / rw) * 2 - 1) * view.camera.halfWidth;
          const geo = unproject(view.lambert, x, y);
          const index = py * rw + px;
          if (geo) {
            cachedLon[index] = geo.lon;
            cachedLat[index] = geo.lat;
            cachedLand[index] = water && waterAt(water, geo.lon, geo.lat) ? 0 : landAt(land, geo.lon, geo.lat, wraps);
          }
        }
      }
    }
    for (let py = 0; py < rh; py += 1) {
      for (let px = 0; px < rw; px += 1) {
        const index = (py * rw + px) * 4;
        const sampleIndex = py * rw + px;
        const lon = cachedLon![sampleIndex];
        const lat = cachedLat![sampleIndex];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
          image.data[index] = Math.round(sea.r * 255);
          image.data[index + 1] = Math.round(sea.g * 255);
          image.data[index + 2] = Math.round(sea.b * 255);
          image.data[index + 3] = 255;
          continue;
        }
        let base = cachedLand![sampleIndex] ? landColour : sea;
        const neutral = fieldBase(view.field, Boolean(view.dark), cachedLand![sampleIndex] === 1);
        const cover = view.fieldAlpha == null ? 1 : Math.max(0, Math.min(1, view.fieldAlpha));
        if (neutral && cover > 0) base = colour(base, { ...neutral, a: cover });
        let tint: Rgba = { r: 0, g: 0, b: 0, a: 0 };
        if (view.field !== 'none' && frameA && frameB) {
          const a = sampleCanvasField(frameA, lon, lat, view, wraps);
          const b = sampleCanvasField(frameB, lon, lat, view, wraps);
          const value = blendCanvasField(a, b, view.blend);
          const colour = fieldColor(view.field, value, view.kiteBand);
          tint = { r: colour.r, g: colour.g, b: colour.b, a: colour.a * cover };
        }
        const rgb = colour(base, tint);
        image.data[index] = Math.round(rgb.r * 255);
        image.data[index + 1] = Math.round(rgb.g * 255);
        image.data[index + 2] = Math.round(rgb.b * 255);
        image.data[index + 3] = 255;
      }
    }
    if (!scratch) scratch = document.createElement('canvas');
    if (scratch.width !== rw || scratch.height !== rh) { scratch.width = rw; scratch.height = rh; }
    scratch.getContext('2d')?.putImageData(image, 0, 0);
    const dpr = canvas.width / width;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.drawImage(scratch, 0, 0, rw, rh, 0, 0, width, height);
    renderedKey = drawKey;
    lastDraw = performance.now();
  };

  const schedule = () => {
    if (timer || !queued) return;
    timer = window.setTimeout(() => {
      timer = 0;
      const next = queued;
      queued = null;
      if (next) render(next);
    }, Math.max(0, 84 - (performance.now() - lastDraw)));
  };

  return {
    resize(nextWidth, nextHeight) {
      renderedKey = '';
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      canvas.width = Math.max(1, Math.round(width * Math.min(2, window.devicePixelRatio || 1)));
      canvas.height = Math.max(1, Math.round(height * Math.min(2, window.devicePixelRatio || 1)));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    },
    setLand(nextLand) { land = nextLand; cachedKey = ''; renderedKey = ''; },
    setWater(nextWater) { water = nextWater; cachedKey = ''; renderedKey = ''; },
    setFrames(a, b) { frameA = a; frameB = b; frameGeneration += 1; },
    draw(view) {
      queued = view;
      if (performance.now() - lastDraw >= 84) {
        const next = queued;
        queued = null;
        if (next) render(next);
      } else schedule();
    },
    usable() { return Boolean(context && land); },
    destroy() {
      if (timer) window.clearTimeout(timer);
      timer = 0;
      queued = null;
      frameA = null;
      frameB = null;
      land = null;
      water = null;
      cachedLon = null;
      cachedLat = null;
      cachedLand = null;
      scratch = null;
      pixels = null;
      renderedKey = '';
      cachedKey = '';
    },
  };
}
