/**
 * View water mask. Natural Earth lakes are rasterised for the camera at once.
 * At a close zoom (about 200 km or less) OSM water polygons refine that mask;
 * they only add water, so a late or missing tile cannot erase a lake.
 */
import { latitudeSpan } from './map-generalise';
import { viewGeoBox } from './terrain/terrain-layer';
import type { GeoBox } from './terrain/terrarium';
import type { Camera, Lambert } from './lambert';
import {
  addWater,
  closeWater,
  lakesInView,
  rasterRings,
  waterRasterSize,
  type LonLatBox,
  type Water,
} from './water';
import { planWaterTiles, resolveWaterTemplate } from './water-tiles';
import type { DecodedRing } from './water-mvt';

export interface WaterRaster {
  pixels: Uint8Array;
  width: number;
  height: number;
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface WaterLayer {
  update(geo: Lambert, camera: Camera, cssWidth: number, cssHeight: number): void;
  destroy(): void;
}

export function createWaterLayer(water: Water, onRaster: (raster: WaterRaster) => void): WaterLayer {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('../workers/water.worker.ts', import.meta.url));
  } catch {
    worker = null;
  }
  let id = 0;
  let key = '';
  let box: LonLatBox | null = null;
  let span = 0;
  let width = 2;
  let height = 2;
  let base: Uint8Array | null = null;
  let template: Promise<string> | null = null;
  const tiles = new Map<string, DecodedRing[]>();

  const publish = () => {
    if (!box || !base) return;
    const pixels = base.slice();
    if (closeWater(span) && tiles.size) {
      const extra = rasterRings([...tiles.values()].flatMap((rings) => rings), box, width, height);
      addWater(pixels, extra);
    }
    onRaster({ pixels, width, height, west: box.west, south: box.south, east: box.east, north: box.north });
  };

  if (worker) {
    worker.onmessage = (event: MessageEvent<{ type: string; id: number; tiles: { z: number; x: number; y: number; rings: DecodedRing[] }[] }>) => {
      const message = event.data;
      if (message.type !== 'water' || message.id !== id) return;
      let changed = false;
      for (const tile of message.tiles) {
        const tileKey = `${tile.z}/${tile.x}/${tile.y}`;
        if (tiles.has(tileKey)) continue;
        tiles.set(tileKey, tile.rings);
        changed = true;
      }
      if (changed) publish();
    };
  }

  const requestTiles = (view: GeoBox) => {
    if (!worker || !closeWater(span)) return;
    const margin = 0.2;
    const lon = view.east - view.west;
    const lat = view.north - view.south;
    const padded: GeoBox = {
      west: view.west - lon * margin,
      east: view.east + lon * margin,
      south: view.south - lat * margin,
      north: view.north + lat * margin,
    };
    if (!template) template = resolveWaterTemplate();
    const request = ++id;
    void template.then((url) => {
      if (request !== id || !worker) return;
      const plan = planWaterTiles(padded);
      const wanted = new Set(plan.tiles.map((tile) => `${plan.z}/${tile.x}/${tile.y}`));
      for (const tileKey of tiles.keys()) if (!tileKey.startsWith(`${plan.z}/`) || !wanted.has(tileKey)) tiles.delete(tileKey);
      worker.postMessage({ type: 'plan', id: request, z: plan.z, tiles: plan.tiles, template: url });
    });
  };

  return {
    update(geo, camera, cssWidth, cssHeight) {
      const view = viewGeoBox(geo, camera);
      if (!view) return;
      const nextSpan = latitudeSpan(geo, camera);
      const size = waterRasterSize(view, cssWidth, cssHeight);
      const nextKey = `${view.west.toFixed(3)}:${view.south.toFixed(3)}:${view.east.toFixed(3)}:${view.north.toFixed(3)}:${size.width}x${size.height}:${nextSpan.toFixed(2)}`;
      if (nextKey === key) return;
      id += 1; // Invalidate close-zoom replies even when the next view requests no tiles.
      key = nextKey;
      box = view;
      span = nextSpan;
      width = size.width;
      height = size.height;
      const lakes = lakesInView(water, view, nextSpan);
      base = rasterRings(lakes, view, width, height);
      if (!closeWater(nextSpan)) tiles.clear();
      publish();
      requestTiles(view);
    },
    destroy() {
      id += 1;
      worker?.terminate();
      worker = null;
      tiles.clear();
      base = null;
    },
  };
}
