import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeWaterPolygons } from '../../src/lib/water-mvt';
import { WATER_CACHE_BUDGET, WATER_CACHE_TILES, WATER_COORD_BUDGET, WATER_MAX_VIEW_TILES } from '../../src/lib/water-tiles';
import {
  addWater,
  closeWater,
  featureZoom,
  lakeContains,
  lakeVisible,
  lakesInView,
  parseWater,
  rasterRings,
  riverVisible,
} from '../../src/lib/water';

const here = path.dirname(fileURLToPath(import.meta.url));
const coast = path.join(here, '../../public/coast');

const water = parseWater(
  new Uint8Array(readFileSync(path.join(coast, 'lakes.bin'))),
  new Uint8Array(readFileSync(path.join(coast, 'rivers.bin'))),
);

function inside(lon: number, lat: number): boolean {
  return lakeContains(water, lon, lat);
}

describe('natural earth water', () => {
  it('parses the packed lakes and rivers', () => {
    expect(water.rings.length).toBeGreaterThan(3000);
    expect(water.rivers.length).toBeGreaterThan(1000);
    expect(parseWater(new Uint8Array([1, 2, 3, 4]), null).rings).toEqual([]);
    const budget = JSON.parse(readFileSync(path.join(coast, 'water-budget.json'), 'utf8')) as {
      closeTiles: { cacheTiles: number; coordBudgetPerTile: number; cacheBytes: number; maxTilesPerView: number };
    };
    expect(WATER_CACHE_TILES).toBe(budget.closeTiles.cacheTiles);
    expect(WATER_COORD_BUDGET).toBe(budget.closeTiles.coordBudgetPerTile);
    expect(WATER_CACHE_BUDGET).toBe(budget.closeTiles.cacheBytes);
    expect(WATER_MAX_VIEW_TILES).toBe(budget.closeTiles.maxTilesPerView);
  });

  it('holds the named lakes and leaves towns and the ocean dry', () => {
    expect(inside(-119.5144, 49.8542)).toBe(true);
    expect(inside(-119.496, 49.888)).toBe(false);
    expect(inside(-119.594, 49.499)).toBe(false);
    expect(inside(-87.5, 47.7)).toBe(true);
    expect(inside(-82.2, 44.8)).toBe(true);
    expect(inside(-87.0, 44.0)).toBe(true);
    expect(inside(-81.2, 42.2)).toBe(true);
    expect(inside(-77.8, 43.6)).toBe(true);
    expect(inside(175.9, -38.8)).toBe(true);
    expect(inside(6.53, 46.43)).toBe(true);
    expect(inside(9.4, 47.6)).toBe(true);
    expect(inside(137.3, -28.4)).toBe(true);
    expect(inside(137.2, -29.3)).toBe(true);
    expect(inside(151.21, -33.87)).toBe(false);
    expect(inside(110, -40)).toBe(false);
    const okanagan = water.rings.find((ring) => lakeContains({ rings: [ring], rivers: [] }, -119.5144, 49.8542));
    expect(okanagan?.minZoom).toBe(6);
  });

  it('shows each lake only once the view is close enough', () => {
    expect(featureZoom(180)).toBeCloseTo(2.5, 5);
    expect(lakeVisible(1, 180)).toBe(true);
    expect(lakeVisible(1.7, 180)).toBe(true);
    expect(lakeVisible(4, 180)).toBe(false);
    expect(lakeVisible(4, 50)).toBe(true);
    expect(lakeVisible(6, 15)).toBe(true);
    expect(lakeVisible(6, 40)).toBe(false);
    expect(closeWater(1.9)).toBe(true);
    expect(closeWater(2.1)).toBe(false);
    expect(riverVisible(1, 40)).toBe(true);
    expect(riverVisible(1, 1.5)).toBe(false);
    expect(riverVisible(1, 80)).toBe(false);
    const superior = { west: -92, south: 46.5, east: -84, north: 49 };
    const mask = rasterRings(lakesInView(water, superior, 20), superior, 80, 30);
    const x = Math.floor((( -87.5 - superior.west) / (superior.east - superior.west)) * 80);
    const y = Math.floor(((47.7 - superior.south) / (superior.north - superior.south)) * 30);
    expect(mask[y * 80 + x]).toBe(255);
  });

  it('rasterises a square and only adds water', () => {
    const ring = { lon: Float32Array.of(0, 2, 2, 0), lat: Float32Array.of(0, 0, 2, 2) };
    const box = { west: 0, south: 0, east: 4, north: 4 };
    const mask = rasterRings([ring], box, 4, 4);
    expect(mask[0]).toBe(255);
    expect(mask[3 * 4 + 3]).toBe(0);
    const extra = new Uint8Array(mask.length);
    extra[15] = 255;
    const before = mask[0];
    addWater(mask, extra);
    expect(mask[0]).toBe(before);
    expect(mask[15]).toBe(255);
  });

  it('decodes the Okanagan OpenMapTiles water tile', () => {
    const bytes = new Uint8Array(readFileSync(path.join(here, '../fixtures/okanagan-z11.pbf')));
    const rings = decodeWaterPolygons(bytes, 11, 344, 695);
    expect(rings.length).toBeGreaterThan(0);
    const box = { west: -119.7, south: 49.6, east: -119.35, north: 50.05 };
    const mask = rasterRings(rings, box, 80, 80);
    const x = Math.floor((( -119.5144 - box.west) / (box.east - box.west)) * 80);
    const y = Math.floor(((49.8542 - box.south) / (box.north - box.south)) * 80);
    expect(mask[y * 80 + x]).toBe(255);
  });
});
