import { mapProject, mapUnproject } from './lambert';
/**
 * Town names on a regional view: Natural Earth 1:10m populated places (public
 * domain; public/places/world-places.json from scripts/pack-places.mjs), ranked
 * and collision-free, as on the Mac map (Sources/gpumapview.m DrawPlaceNames).
 * Two towns of one name in view: the larger keeps its name, the smaller is
 * qualified with its region ("Vancouver WA"); with no region to tell them
 * apart, the smaller is left out.
 */
import { project, type Camera, type Lambert } from './lambert';
import { AUS_UNITS, formatRainMm, formatTempC, type DisplayUnits } from './units';
import type { DrawnLabel, LabelBox } from './overlay';

/** [name, lat, lon, rank (NE min_zoom), region code], most important first. */
export type PlaceRow = [string, number, number, number, string];

export interface PlaceCandidate {
  name: string;
  lat: number;
  lon: number;
  rank: number;
  region: string;
}

/**
 * Gives every same-name place after the first (the larger: the list is ranked)
 * its region code; drops it when that does not tell the two apart.
 */
export function dedupeNames<T extends { name: string; region: string }>(places: T[]): (T & { label: string })[] {
  const first = new Map<string, T>();
  const labels = new Set<string>();
  const out: (T & { label: string })[] = [];
  for (const place of places) {
    const prior = first.get(place.name);
    if (!prior) {
      first.set(place.name, place);
      labels.add(place.name);
      out.push({ ...place, label: place.name });
      continue;
    }
    const label = place.region ? `${place.name} ${place.region}` : '';
    if (!label || labels.has(label) || place.region === prior.region) continue;
    labels.add(label);
    out.push({ ...place, label });
  }
  return out;
}

let loading: Promise<PlaceRow[]> | null = null;

export function loadPlaces(url = '/places/world-places.json'): Promise<PlaceRow[]> {
  if (!loading) {
    loading = fetch(url)
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: unknown) => (Array.isArray(rows) ? (rows as PlaceRow[]) : []))
      .catch(() => {
        loading = null;
        return [];
      });
  }
  return loading;
}

/** A regional view is under this many degrees of longitude across. */
export const PLACES_MAX_SPAN = 45;
export const PLACES_MAX_LABELS = 40;

/**
 * Natural Earth's min_zoom, as the web-mercator zoom of this view.
 * A 700 km desktop view is about zoom 7.5, so a rank-6 town (Kelowna) is drawn.
 * Rank order in the file is population within a rank; collision is the only skip.
 */
export function placeRankLimit(spanDeg: number, widthPx: number): number {
  if (!(spanDeg > 0) || !(widthPx > 0)) return 0;
  return Math.log2((widthPx * 360) / (spanDeg * 256));
}

/** Value of the active lens at a town ("16°", "SW 12 kt", "3 mm"), or null for none. */
export type PlaceReading = (lat: number, lon: number) => string | null;

export interface PlacesInk {
  ink: string;
  halo: string;
}

export const DAY_PLACES: PlacesInk = { ink: '#263e4c', halo: 'rgba(247, 250, 248, 0.92)' };
export const NIGHT_PLACES: PlacesInk = { ink: '#e6eff2', halo: 'rgba(19, 34, 44, 0.92)' };

const placeWindows = new WeakMap<PlaceRow[], { west: number; east: number; south: number; north: number; rows: PlaceRow[] }>();
/** A padded, rank-preserving selection avoids scanning the whole gazetteer on each drag frame. */
export function regionalPlaces(rows: PlaceRow[], west: number, east: number, south: number, north: number): PlaceRow[] {
  let window = placeWindows.get(rows);
  if (!window || west < window.west || east > window.east || south < window.south || north > window.north) {
    const dx = Math.max(1, (east - west) / 2), dy = Math.max(1, (north - south) / 2);
    const bounds = { west: west - dx, east: east + dx, south: south - dy, north: north + dy };
    window = { ...bounds, rows: rows.filter(([, lat, lon]) => lat >= bounds.south && lat <= bounds.north
      && Math.ceil((bounds.west - lon) / 360) <= Math.floor((bounds.east - lon) / 360)) };
    placeWindows.set(rows, window);
  }
  return window.rows;
}

/**
 * Draws ranked town names that fit around `avoid` (isobar labels, H/L marks,
 * the map's controls). Returns the labels drawn, in drawing order.
 */
export function drawPlaces(
  ctx: CanvasRenderingContext2D,
  rows: PlaceRow[],
  geo: Lambert,
  camera: Camera,
  width: number,
  height: number,
  avoid: LabelBox[],
  ink: PlacesInk,
  reading: PlaceReading | null,
  maxLabels = PLACES_MAX_LABELS,
  measureOnly = false,
  onWater?: (lat: number, lon: number) => boolean,
): { names: string[]; labels: DrawnLabel[] } {
  const span = geo.projection === 'equirectangular' ? (camera.halfWidth * 2) / geo.F : (camera.halfWidth * 2 * 180) / Math.PI;
  if (!(span > 0) || span > PLACES_MAX_SPAN || !rows.length) return { names: [], labels: [] };
  const rankLimit = placeRankLimit(span, width);
  const toScreen = (lat: number, lon: number) => {
    if (camera.surface) {
      const p = mapProject(geo, camera, lat, lon);
      return p && { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 };
    }
    const p = project(geo, lat, lon);
    if (!p) return null;
    if (!camera.surface && geo.projection === 'equirectangular') {
      const period = 360 * geo.F;
      p.x += Math.round((camera.centerX - p.x) / period) * period;
    }
    return { x: (1 + (p.x - camera.centerX) / camera.halfWidth) * width / 2, y: (1 - (p.y - camera.centerY) / camera.halfHeight) * height / 2 };
  };
  // Candidates in view, ranked, then de-duplicated by name before placing.
  const inView: (PlaceCandidate & { x: number; y: number })[] = [];
  // Cheap geographic cull before projecting: thousands of ranked rows, a few dozen in view.
  const equirect = geo.projection === 'equirectangular';
  const centreLon = equirect ? geo.lon0 + camera.centerX / geo.F : 0;
  const halfLon = span / 2;
  const candidates = equirect && !camera.surface
    ? regionalPlaces(rows, centreLon - halfLon, centreLon + halfLon, camera.centerY - camera.halfHeight, camera.centerY + camera.halfHeight) : rows;
  for (const row of candidates) {
    const [name, lat, lon, rank, region] = row;
    if (rank > rankLimit) break;
    if (equirect && !camera.surface) {
      if (Math.abs(lat - camera.centerY) > camera.halfHeight) continue;
      const delta = ((((lon - centreLon) % 360) + 540) % 360) - 180;
      if (Math.abs(delta) > halfLon) continue;
    }
    const point = toScreen(lat, lon);
    if (!point || point.x < 4 || point.y < 4 || point.x > width - 4 || point.y > height - 4) continue;
    if (onWater?.(lat, lon)) continue;
    inView.push({ name, lat, lon, rank, region: region ?? '', x: point.x, y: point.y });
  }
  const taken = avoid.slice();
  const drawn: string[] = [];
  const labels: DrawnLabel[] = [];
  const intersects = (a: LabelBox, b: LabelBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  for (const place of dedupeNames(inView)) {
    if (drawn.length >= maxLabels) break;
    const big = place.rank <= rankLimit - 1.5;
    const nameFont = big ? '600 12px ui-sans-serif, system-ui, sans-serif' : '500 11px ui-sans-serif, system-ui, sans-serif';
    const valueFont = big ? '500 12px ui-sans-serif, system-ui, sans-serif' : '400 11px ui-sans-serif, system-ui, sans-serif';
    ctx.font = nameFont;
    const value = reading ? reading(place.lat, place.lon) : null;
    const text = value ? `${place.label}  ${value}` : place.label;
    const nameWidth = ctx.measureText(place.label).width;
    ctx.font = valueFont;
    const w = nameWidth + (value ? 6 + ctx.measureText(value).width : 0);
    const h = big ? 14 : 13;
    const r = big ? 2.2 : 1.7;
    let label: LabelBox | null = null;
    // Right, then left, above, below.
    for (let side = 0; side < 4 && !label; side += 1) {
      const lx = side === 1 ? place.x - r - 3 - w : side === 0 ? place.x + r + 3 : place.x - w / 2;
      const ly = side === 2 ? place.y - r - 2 - h : side === 3 ? place.y + r + 2 : place.y - h / 2;
      if (ly < 2 || ly + h > height - 2 || lx < 2 || lx + w > width - 2) continue;
      const box = { x: lx - 4, y: ly - 2, w: w + 8, h: h + 4 };
      if (taken.some((other) => intersects(box, other))) continue;
      label = { x: lx, y: ly, w, h };
      taken.push(box, { x: place.x - r, y: place.y - r, w: 2 * r, h: 2 * r });
    }
    if (!label) continue;
    if (!measureOnly) {
      ctx.fillStyle = ink.halo;
      ctx.beginPath();
      ctx.arc(place.x, place.y, r + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = ink.ink;
      ctx.beginPath();
      ctx.arc(place.x, place.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = ink.halo;
      ctx.lineWidth = 2;
      ctx.font = nameFont;
      ctx.strokeText(place.label, label.x, label.y + label.h / 2);
      ctx.fillText(place.label, label.x, label.y + label.h / 2);
      if (value) {
        ctx.font = valueFont;
        ctx.strokeText(value, label.x + nameWidth + 6, label.y + label.h / 2);
        ctx.fillText(value, label.x + nameWidth + 6, label.y + label.h / 2);
      }
    }
    drawn.push(text);
    labels.push({ text, x: label.x - 2, y: label.y - 1, w: label.w + 4, h: label.h + 2 });
  }
  ctx.restore();
  return { names: drawn, labels };
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Wind direction (degrees the wind blows FROM) as an 8-point compass name. */
export function compassFrom(u: number, v: number): string {
  const from = (Math.atan2(-u, -v) * 180) / Math.PI;
  return POINTS[Math.round((((from % 360) + 360) % 360) / 45) % 8];
}

/** The reading text for one lens value (Mac parity: dry rain shows nothing). */
export function readingText(field: 'rain' | 'temp' | 'wind', value: number, direction?: string | null, units: DisplayUnits = AUS_UNITS): string | null {
  if (!Number.isFinite(value)) return null;
  if (field === 'rain') {
    if (units.rain === 'in') {
      const label = formatRainMm(value, units);
      return label ? `${label} in` : null;
    }
    return value >= 0.2 ? `${Math.max(1, Math.round(value))} mm` : null;
  }
  if (field === 'wind') return `${direction ? `${direction} ` : ''}${Math.round(value)} kt`;
  return formatTempC(value, units);
}
