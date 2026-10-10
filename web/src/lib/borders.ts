/**
 * Political borders packed from Natural Earth (public domain).
 * BORD v1: three sections — country, first-level admin, disputed — each an
 * OCST-like list of open lines (uint16 count, int16 degrees × 100).
 */
import { mapProject, type Camera, type Lambert } from './lambert';

export interface BorderRing {
  lon: Float32Array;
  lat: Float32Array;
}

export interface Borders {
  country: BorderRing[];
  state: BorderRing[];
  disputed: BorderRing[];
}

export interface AdminName {
  name: string;
  lat: number;
  lon: number;
  rank: number;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readI16(bytes: Uint8Array, offset: number): number {
  const value = readU16(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function readRings(bytes: Uint8Array, cursor: { n: number }): BorderRing[] | null {
  if (cursor.n + 2 > bytes.length) return null;
  const count = readU16(bytes, cursor.n);
  cursor.n += 2;
  const rings: BorderRing[] = [];
  for (let i = 0; i < count; i += 1) {
    if (cursor.n + 2 > bytes.length) return null;
    const points = readU16(bytes, cursor.n);
    cursor.n += 2;
    if (points < 2 || cursor.n + points * 4 > bytes.length) return null;
    const lon = new Float32Array(points);
    const lat = new Float32Array(points);
    for (let p = 0; p < points; p += 1) {
      lon[p] = readI16(bytes, cursor.n) / 100;
      lat[p] = readI16(bytes, cursor.n + 2) / 100;
      cursor.n += 4;
    }
    rings.push({ lon, lat });
  }
  return rings;
}

export function parseBorders(bytes: Uint8Array): Borders | null {
  if (bytes.length < 8) return null;
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4f || bytes[2] !== 0x52 || bytes[3] !== 0x44) return null;
  if (readU16(bytes, 4) !== 1 || readU16(bytes, 6) !== 3) return null;
  const cursor = { n: 8 };
  const country = readRings(bytes, cursor);
  const state = readRings(bytes, cursor);
  const disputed = readRings(bytes, cursor);
  if (!country || !state || !disputed || cursor.n !== bytes.length) return null;
  return { country, state, disputed };
}

/** State names stay off until the shorter side of the view is inside this span. Rank is Natural Earth scalerank. */
export function adminRankLimit(spanDeg: number): number {
  if (!(spanDeg > 0) || spanDeg > 18) return -1;
  if (spanDeg > 10) return 3;
  if (spanDeg > 4) return 6;
  return 10;
}

/**
 * State and province names, only when zoomed in and only where the label
 * point is on screen and clear of `avoid`. No dot: a town already has one.
 */
export function drawAdminNames(
  ctx: CanvasRenderingContext2D,
  names: readonly AdminName[],
  geo: Lambert,
  camera: Camera,
  width: number,
  height: number,
  avoid: readonly { x: number; y: number; w: number; h: number }[],
  ink: { ink: string; halo: string },
): void {
  const spanLon = geo.projection === 'equirectangular' ? (camera.halfWidth * 2) / geo.F : (camera.halfWidth * 2 * 180) / Math.PI;
  const spanLat = geo.projection === 'equirectangular' ? Math.abs(camera.halfHeight * 2) : Math.abs(camera.halfHeight * 2 * 180 / Math.PI);
  const limit = adminRankLimit(Math.min(spanLon, spanLat));
  if (limit < 0 || !names.length) return;
  const taken = avoid.slice();
  const hits = (box: { x: number; y: number; w: number; h: number }) => taken.some((other) => (
    box.x < other.x + other.w && other.x < box.x + box.w && box.y < other.y + other.h && other.y < box.y + box.h
  ));
  ctx.save();
  ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const place of names) {
    if (place.rank > limit) continue;
    const projected = mapProject(geo, camera, place.lat, place.lon);
    if (!projected) continue;
    const x = (1 + projected.x) * width / 2;
    const y = (1 - projected.y) * height / 2;
    if (x < 28 || y < 16 || x > width - 28 || y > height - 28) continue;
    const w = ctx.measureText(place.name).width;
    const box = { x: x - w / 2 - 3, y: y - 8, w: w + 6, h: 16 };
    if (hits(box)) continue;
    ctx.lineWidth = 3;
    ctx.strokeStyle = ink.halo;
    ctx.strokeText(place.name, x, y);
    ctx.fillStyle = ink.ink;
    ctx.globalAlpha = 0.82;
    ctx.fillText(place.name, x, y);
    ctx.globalAlpha = 1;
    taken.push(box);
  }
  ctx.restore();
}
