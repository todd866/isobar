/**
 * View water mask. Natural Earth lakes are rasterised for the camera at once.
 * At a close zoom (about 200 km or less) OSM water polygons refine that mask;
 * they only add water, so a late or missing tile cannot erase a lake.
 */
import { latitudeSpan } from './map-generalise';
import { viewGeoBox } from './terrain/terrain-layer';
import type { GeoBox } from './terrain/terrarium';
import { unproject, type Camera, type Lambert } from './lambert';
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

/**
 * Keep texture uploads out of the middle of a pinch/trackpad zoom. Camera
 * updates arrive in a burst, so only the final raster is uploaded after the
 * gesture has been quiet for this long.
 */
export const WATER_UPLOAD_SETTLE_MS = 100;

export function createWaterUploadScheduler(publish: () => void, delay = WATER_UPLOAD_SETTLE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(immediate = false) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (immediate) {
        publish();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        publish();
      }, delay);
    },
    defer() {
      if (timer !== null) this.schedule();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Keep the measured water raster while a gesture stays inside its margin.
 * Rebuild before leaving coverage or changing detail by more than a quarter. */
export function reuseWaterRaster(box:LonLatBox|null,view:LonLatBox,span:number,nextSpan:number):boolean {
  return !!box&&span>0&&nextSpan/span>=.8&&nextSpan/span<=1.25&&closeWater(span)===closeWater(nextSpan)
    &&view.west>=box.west&&view.east<=box.east&&view.south>=box.south&&view.north<=box.north;
}

/** A tilted horizon must not spend all lake texels on distant ground. */
export function waterViewBox(geo:Lambert,camera:Camera):GeoBox|null {
  if(!camera.surface)return viewGeoBox(geo,camera);
  const focus=unproject(geo,camera.centerX,camera.centerY);
  if(!focus)return null;
  const radius=Math.max(camera.halfWidth/geo.F,camera.halfHeight)*2;
  return {west:focus.lon-radius,east:focus.lon+radius,south:Math.max(-90,focus.lat-radius),north:Math.min(90,focus.lat+radius)};
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
  let lastView = ''; 
  let box: LonLatBox | null = null;
  let span = 0;
  let width = 2;
  let height = 2;
  let viewportWidth=0,viewportHeight=0;
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

  const uploadScheduler = createWaterUploadScheduler(publish);

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
      if (changed) uploadScheduler.schedule();
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
      const view = waterViewBox(geo, camera);
      if (!view) return;
      const nextSpan = latitudeSpan(geo, camera);
      const viewKey = `${view.west}:${view.east}:${view.south}:${view.north}:${cssWidth}:${cssHeight}`;
      if (viewKey !== lastView) { lastView = viewKey; uploadScheduler.defer(); }
      if(viewportWidth===cssWidth&&viewportHeight===cssHeight&&reuseWaterRaster(box,view,span,nextSpan))return;
      viewportWidth=cssWidth;viewportHeight=cssHeight;
      const dx=(view.east-view.west)*.25,dy=(view.north-view.south)*.25;
      const rasterView={west:view.west-dx,east:view.east+dx,south:Math.max(-90,view.south-dy),north:Math.min(90,view.north+dy)};
      const size = waterRasterSize(rasterView, cssWidth*1.5, cssHeight*1.5);
      const nextKey = `${view.west.toFixed(3)}:${view.south.toFixed(3)}:${view.east.toFixed(3)}:${view.north.toFixed(3)}:${size.width}x${size.height}:${nextSpan.toFixed(2)}`;
      if (nextKey === key) return;
      id += 1; // Invalidate close-zoom replies even when the next view requests no tiles.
      const hadRaster = box !== null;
      key = nextKey;
      box = rasterView;
      span = nextSpan;
      width = size.width;
      height = size.height;
      const lakes = lakesInView(water, rasterView, nextSpan);
      base = rasterRings(lakes, rasterView, width, height);
      if (!closeWater(nextSpan)) tiles.clear();
      // The first raster is useful immediately. Subsequent camera updates are
      // coalesced until the zoom gesture has settled.
      uploadScheduler.schedule(!hadRaster);
      requestTiles(rasterView);
    },
    destroy() {
      id += 1;
      uploadScheduler.cancel();
      worker?.terminate();
      worker = null;
      tiles.clear();
      base = null;
    },
  };
}
