/**
 * Close-zoom water tiles. OpenFreeMap serves OpenMapTiles water polygons
 * (OpenStreetMap, ODbL). ESA WorldCover's WMTS reset the connection, so the
 * finer shoreline is the OSM water layer, cached like the terrain tiles.
 *
 * Planning budget: 32 tiles × 64 KiB of coordinates = 2 MiB. A view asks for
 * at most 24 tiles. A tile over the coordinate budget keeps its largest rings.
 */

import { tilesForBox, type GeoBox, type TileKey } from './terrain/terrarium';

export const WATER_TILEJSON = 'https://tiles.openfreemap.org/planet';
/** Pinned build, used when the tilejson cannot be read. */
export const WATER_TILE_TEMPLATE = 'https://tiles.openfreemap.org/planet/20261004_113936_pt/{z}/{x}/{y}.pbf';
export const WATER_CACHE_TILES = 32;
export const WATER_COORD_BUDGET = 64 * 1024;
export const WATER_CACHE_BUDGET = WATER_CACHE_TILES * WATER_COORD_BUDGET;
export const WATER_MAX_VIEW_TILES = 24;
export const WATER_MIN_ZOOM = 8;
export const WATER_MAX_ZOOM = 12;

export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** Tile zoom whose count stays inside the view budget, centre tiles first. */
export function planWaterTiles(box: GeoBox): { z: number; tiles: TileKey[] } {
  let z = WATER_MAX_ZOOM;
  let tiles = tilesForBox(box, z);
  while (z > WATER_MIN_ZOOM && tiles.length > WATER_MAX_VIEW_TILES) {
    z -= 1;
    tiles = tilesForBox(box, z);
  }
  if (tiles.length > WATER_MAX_VIEW_TILES) tiles = tiles.slice(0, WATER_MAX_VIEW_TILES);
  return { z, tiles };
}

export async function resolveWaterTemplate(fetchJson: (url: string) => Promise<unknown> = defaultTileJson): Promise<string> {
  try {
    const json = await fetchJson(WATER_TILEJSON);
    const tiles = json && typeof json === 'object' ? (json as { tiles?: unknown }).tiles : null;
    const first = Array.isArray(tiles) ? tiles[0] : null;
    if (typeof first === 'string' && first.includes('{z}') && first.includes('{x}') && first.includes('{y}')) return first;
  } catch {
    /* the pinned build still draws; a 404 leaves Natural Earth lakes in place */
  }
  return WATER_TILE_TEMPLATE;
}

async function defaultTileJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`tilejson ${response.status}`);
  return response.json();
}
