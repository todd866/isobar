/// <reference lib="webworker" />
/**
 * Terrain off the main thread: fetches terrarium tiles nearest the view centre
 * first, decodes them (createImageBitmap + OffscreenCanvas), keeps a bounded
 * LRU of decoded tiles, and composites the equirectangular mosaic the WebGL
 * plate samples. Missing fine tiles fall back to measured ancestors; an area
 * with no measured tile stays uncovered, never invented relief.
 */
import {
  elevationsAlong, sampleTiles, sectionTrack, SECTION_ZOOM, type DecodedTile, type SectionSample,
} from '../lib/point/terrain-section';
import {
  compositeMosaic,
  decodeTerrarium,
  latToTileY,
  lonToTileX,
  tileKey,
  tilesForBox,
  tileUrl,
  TILE_SIZE,
  wrapTileX,
  type TerrainPlan,
  type TileKey,
} from '../lib/terrain/terrarium';

interface PlanMessage {
  type: 'plan';
  id: number;
  plan: TerrainPlan;
  template?: string;
}

interface SectionMessage {
  type: 'section';
  id: number;
  lat: number;
  lon: number;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
/** 64 tiles × 512 kB (binary16) = 32 MB. */
const CACHE_TILES = 64;
const CONCURRENCY = 6;
const RETRY_MS = 30_000;

const cache = new Map<string, Uint16Array>();
const missing = new Set<string>();
const failed = new Map<string, number>();
const inflight = new Map<string, AbortController>();
let queue: TileKey[] = [];
let current: PlanMessage | null = null;
let composeTimer = 0;
let template: string | undefined;
let wanted = new Set<string>();

function lookup(z: number, x: number, y: number): Uint16Array | null | undefined {
  const key = tileKey(z, x, y);
  const tile = cache.get(key);
  if (tile) return tile;
  if (missing.has(key)) return null;
  const when = failed.get(key);
  if (when !== undefined && Date.now() - when < RETRY_MS) return null;
  return undefined;
}

function remember(key: string, tile: Uint16Array) {
  cache.set(key, tile);
  while (cache.size > CACHE_TILES) {
    const oldest = [...cache.keys()].find(candidate => !wanted.has(candidate));
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

let canvas: OffscreenCanvas | null = null;

async function decode(blob: Blob): Promise<Uint16Array> {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  if (!canvas) canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('no 2d context');
  ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
  ctx.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
  bitmap.close();
  return decodeTerrarium(ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data);
}

async function load(tile: TileKey) {
  const key = tileKey(tile.z, tile.x, tile.y);
  const controller = new AbortController();
  inflight.set(key, controller);
  try {
    const response = await fetch(tileUrl(tile.z, tile.x, tile.y, template), { signal: controller.signal, cache: 'force-cache' });
    if (response.status === 404 || response.status === 204) missing.add(key);
    else if (!response.ok) failed.set(key, Date.now());
    else {
      const decoded = await decode(await response.blob());
      remember(key, decoded);
      failed.delete(key);
    }
  } catch {
    if (!controller.signal.aborted) failed.set(key, Date.now());
  } finally {
    inflight.delete(key);
    if (!controller.signal.aborted) scheduleCompose();
    pump();
  }
}

function pump() {
  while (inflight.size < CONCURRENCY && queue.length) {
    const tile = queue.shift() as TileKey;
    if (lookup(tile.z, tile.x, tile.y) !== undefined || inflight.has(tileKey(tile.z, tile.x, tile.y))) continue;
    void load(tile);
  }
}

function compose() {
  composeTimer = 0;
  const message = current;
  if (!message) return;
  const { plan } = message;
  const mosaic = compositeMosaic(plan.box, plan.width, plan.height, plan.z, lookup);
  const needed = tilesForBox(plan.box, plan.z);
  let loaded = 0;
  let absent = 0;
  for (const tile of needed) {
    const key = tileKey(tile.z, tile.x, tile.y);
    const state = lookup(tile.z, tile.x, tile.y);
    if (state) {
      // Touch: the view's tiles are the most recently used.
      cache.delete(key);
      cache.set(key, state);
      loaded += 1;
    }
    else if (state === null) absent += 1;
  }
  scope.postMessage({
    type: 'mosaic',
    id: message.id,
    z: plan.z,
    box: mosaic.box,
    width: mosaic.width,
    height: mosaic.height,
    data: mosaic.data,
    covered: mosaic.covered,
    tiles: { needed: needed.length, loaded, missing: absent, cached: cache.size },
  }, [mosaic.data.buffer]);
}

function scheduleCompose() {
  // Several tiles land together on a fast connection: one composite for them.
  if (!composeTimer) composeTimer = setTimeout(compose, 200) as unknown as number;
}

/** Full-precision terrarium bytes. A 404 stays a gap and is not logged on the page. */
async function decodeNative(blob: Blob): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: image.width, height: image.height, data: image.data };
}

async function sampleSection(lat: number, lon: number): Promise<SectionSample[]> {
  const track = sectionTrack(lat, lon);
  const z = SECTION_ZOOM;
  const wanted = new Map<string, TileKey>();
  const n = 2 ** z;
  for (const point of track) {
    const x = wrapTileX(Math.floor(lonToTileX(point.lon, z)), z);
    const y = Math.floor(latToTileY(point.lat, z));
    if (y < 0 || y >= n) continue;
    wanted.set(tileKey(z, x, y), { z, x, y });
  }
  const tiles: DecodedTile[] = [];
  await Promise.all([...wanted.values()].map(async (tile) => {
    try {
      const response = await fetch(template ? tileUrl(tile.z, tile.x, tile.y, template) : tileUrl(tile.z, tile.x, tile.y), { cache: 'force-cache' });
      if (!response.ok) return;
      const decoded = await decodeNative(await response.blob());
      if (!decoded) return;
      tiles.push({ z: tile.z, x: tile.x, y: tile.y, width: decoded.width, height: decoded.height, rgba: decoded.data });
    } catch {
      /* A failed tile leaves a gap. */
    }
  }));
  return elevationsAlong(track, (sampleLon, sampleLat) => sampleTiles(tiles, sampleLon, sampleLat));
}

scope.onmessage = (event: MessageEvent<PlanMessage | SectionMessage>) => {
  const message = event.data;
  if (message.type === 'section') {
    const id = message.id;
    void sampleSection(message.lat, message.lon)
      .then((samples) => scope.postMessage({ type: 'section', id, samples }))
      .catch(() => scope.postMessage({ type: 'section', id, samples: [] }));
    return;
  }
  if (message.type !== 'plan') return;
  current = message;
  template = message.template;
  const needed = tilesForBox(message.plan.box, message.plan.z);
  // Two parent levels arrive first so unavailable local high-detail tiles do
  // not erase measured relief. Ancestors are deduplicated and share the LRU.
  const ancestors=new Map<string,TileKey>();
  for(const tile of needed)for(let level=2;level>=1;level--){
    if(tile.z<level)continue;const parent={z:tile.z-level,x:tile.x>>level,y:tile.y>>level};
    ancestors.set(tileKey(parent.z,parent.x,parent.y),parent);
  }
  // Keep the complete active set within the decoded cache budget, preserving
  // every primary tile and preferring the broadest fallback coverage.
  const parents=[...ancestors.values()].sort((a,b)=>a.z-b.z).slice(0,Math.max(0,CACHE_TILES-needed.length));
  const candidates=[...parents,...needed];
  wanted = new Set(candidates.map((tile) => tileKey(tile.z, tile.x, tile.y)));
  for (const [key, controller] of inflight) {
    if (!wanted.has(key)) {
      controller.abort();
      inflight.delete(key);
    }
  }
  queue = candidates.filter((tile) => lookup(tile.z, tile.x, tile.y) === undefined);
  pump();
  // Paint what is already cached (or its ancestors) now; arrivals refine it.
  // A zoom sends plans in bursts; composite only the last of them.
  clearTimeout(composeTimer);
  composeTimer = setTimeout(compose, 16) as unknown as number;
};
