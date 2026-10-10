/**
 * Mapbox vector tiles, enough of the protobuf to read OpenMapTiles `water`
 * polygons. Coordinates are tile-local; y grows south.
 */

import { tileXToLon, tileYToLat } from './terrain/terrarium';
import { WATER_COORD_BUDGET } from './water-tiles';

export interface DecodedRing {
  lon: Float32Array;
  lat: Float32Array;
}

function varint(bytes: Uint8Array, index: number): [number, number] {
  let value = 0;
  let shift = 0;
  while (index < bytes.length && shift <= 28) {
    const byte = bytes[index];
    index += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 128) return [value, index];
    shift += 7;
  }
  return [value, index];
}

function skip(bytes: Uint8Array, index: number, wire: number): number {
  if (wire === 0) return varint(bytes, index)[1];
  if (wire === 1) return index + 8;
  if (wire === 5) return index + 4;
  if (wire === 2) {
    const [length, next] = varint(bytes, index);
    return next + length;
  }
  return bytes.length;
}

function zag(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

function packed(bytes: Uint8Array): number[] {
  const values: number[] = [];
  let index = 0;
  while (index < bytes.length) {
    const [value, next] = varint(bytes, index);
    if (next === index) break;
    values.push(value);
    index = next;
  }
  return values;
}

function ringsOf(geometry: number[], z: number, x: number, y: number, extent: number): DecodedRing[] {
  const rings: { x: number[]; y: number[] }[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let current: { x: number[]; y: number[] } | null = null;
  let index = 0;
  while (index < geometry.length) {
    const command = geometry[index];
    index += 1;
    const id = command & 7;
    const count = command >> 3;
    if (id === 1) {
      for (let i = 0; i < count && index + 1 < geometry.length; i += 1) {
        cursorX += zag(geometry[index]);
        cursorY += zag(geometry[index + 1]);
        index += 2;
        current = { x: [cursorX], y: [cursorY] };
        rings.push(current);
      }
    } else if (id === 2 && current) {
      for (let i = 0; i < count && index + 1 < geometry.length; i += 1) {
        cursorX += zag(geometry[index]);
        cursorY += zag(geometry[index + 1]);
        index += 2;
        current.x.push(cursorX);
        current.y.push(cursorY);
      }
    } else if (id === 7) {
      current = null;
    } else {
      break;
    }
  }
  const out: DecodedRing[] = [];
  for (const ring of rings) {
    if (ring.x.length < 3) continue;
    const lon = new Float32Array(ring.x.length);
    const lat = new Float32Array(ring.y.length);
    for (let i = 0; i < ring.x.length; i += 1) {
      lon[i] = tileXToLon(x + ring.x[i] / extent, z);
      lat[i] = tileYToLat(y + ring.y[i] / extent, z);
    }
    out.push({ lon, lat });
  }
  return out;
}

function area(ring: DecodedRing): number {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let i = 0; i < ring.lon.length; i += 1) {
    west = Math.min(west, ring.lon[i]);
    east = Math.max(east, ring.lon[i]);
    south = Math.min(south, ring.lat[i]);
    north = Math.max(north, ring.lat[i]);
  }
  return Math.max(0, east - west) * Math.max(0, north - south);
}

/** Keep the largest rings inside the coordinate budget. A lake above ~0.01°² always stays. */
export function capRings(rings: DecodedRing[], budget = WATER_COORD_BUDGET): DecodedRing[] {
  const ranked = rings.map((ring) => ({ ring, area: area(ring), bytes: ring.lon.length * 8 }));
  ranked.sort((a, b) => b.area - a.area || b.bytes - a.bytes);
  const kept: DecodedRing[] = [];
  let used = 0;
  for (const item of ranked) {
    const protect = item.area >= 0.01;
    if (!protect && used + item.bytes > budget && kept.length) continue;
    kept.push(item.ring);
    used += item.bytes;
  }
  return kept;
}

/** Water polygons in one tile. Lines and points are ignored. */
export function decodeWaterPolygons(bytes: Uint8Array, z: number, x: number, y: number): DecodedRing[] {
  const rings: DecodedRing[] = [];
  let index = 0;
  while (index < bytes.length) {
    const [key, afterKey] = varint(bytes, index);
    if (afterKey === index) break;
    index = afterKey;
    const field = key >> 3;
    const wire = key & 7;
    if (wire !== 2) {
      index = skip(bytes, index, wire);
      continue;
    }
    const [length, start] = varint(bytes, index);
    const layer = bytes.subarray(start, start + length);
    index = start + length;
    if (field !== 3) continue;
    let name = '';
    let extent = 4096;
    const features: Uint8Array[] = [];
    let cursor = 0;
    while (cursor < layer.length) {
      const [layerKey, next] = varint(layer, cursor);
      if (next === cursor) break;
      cursor = next;
      const layerField = layerKey >> 3;
      const layerWire = layerKey & 7;
      if (layerWire === 2) {
        const [size, body] = varint(layer, cursor);
        const raw = layer.subarray(body, body + size);
        cursor = body + size;
        if (layerField === 1) name = new TextDecoder().decode(raw);
        else if (layerField === 2) features.push(raw);
      } else if (layerWire === 0) {
        const [value, nextValue] = varint(layer, cursor);
        cursor = nextValue;
        if (layerField === 5 && value > 0) extent = value;
      } else {
        cursor = skip(layer, cursor, layerWire);
      }
    }
    if (name !== 'water') continue;
    for (const feature of features) {
      let featureType = 0;
      let geometry: number[] | null = null;
      let featureCursor = 0;
      while (featureCursor < feature.length) {
        const [featureKey, nextFeature] = varint(feature, featureCursor);
        if (nextFeature === featureCursor) break;
        featureCursor = nextFeature;
        const featureField = featureKey >> 3;
        const featureWire = featureKey & 7;
        if (featureWire === 0) {
          const [value, nextValue] = varint(feature, featureCursor);
          featureCursor = nextValue;
          if (featureField === 3) featureType = value;
        } else if (featureWire === 2) {
          const [size, body] = varint(feature, featureCursor);
          const raw = feature.subarray(body, body + size);
          featureCursor = body + size;
          if (featureField === 4) geometry = packed(raw);
        } else {
          featureCursor = skip(feature, featureCursor, featureWire);
        }
      }
      if (featureType === 3 && geometry) rings.push(...ringsOf(geometry, z, x, y, extent));
    }
  }
  return capRings(rings);
}
