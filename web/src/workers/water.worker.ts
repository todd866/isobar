/// <reference lib="webworker" />
/**
 * Close-zoom water off the main thread. Fetches OpenMapTiles water polygons,
 * decodes them, and keeps a bounded cache. A failed tile stays missing: the
 * Natural Earth lake is already on the plate.
 */
import { decodeWaterPolygons, type DecodedRing } from '../lib/water-mvt';
import { tileUrl, WATER_CACHE_TILES } from '../lib/water-tiles';
import type { TileKey } from '../lib/terrain/terrarium';

interface PlanMessage {
  type: 'plan';
  id: number;
  z: number;
  tiles: TileKey[];
  template: string;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const RETRY_MS = 30_000;
const CONCURRENCY = 4;

const cache = new Map<string, DecodedRing[]>();
const missing = new Set<string>();
const failed = new Map<string, number>();
const inflight = new Map<string, AbortController>();
let queue: TileKey[] = [];
let template = '';
let current: PlanMessage | null = null;

function keyOf(tile: TileKey): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function lookup(tile: TileKey): DecodedRing[] | null | undefined {
  const key = keyOf(tile);
  const hit = cache.get(key);
  if (hit) return hit;
  if (missing.has(key)) return null;
  const when = failed.get(key);
  if (when !== undefined && Date.now() - when < RETRY_MS) return null;
  return undefined;
}

function remember(key: string, rings: DecodedRing[]) {
  cache.set(key, rings);
  while (cache.size > WATER_CACHE_TILES) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
}

async function load(tile: TileKey) {
  const key = keyOf(tile);
  const controller = new AbortController();
  inflight.set(key, controller);
  try {
    const response = await fetch(tileUrl(template, tile.z, tile.x, tile.y), { signal: controller.signal, cache: 'force-cache' });
    if (response.status === 404 || response.status === 204) missing.add(key);
    else if (!response.ok) failed.set(key, Date.now());
    else {
      remember(key, decodeWaterPolygons(new Uint8Array(await response.arrayBuffer()), tile.z, tile.x, tile.y));
      failed.delete(key);
    }
  } catch {
    if (!controller.signal.aborted) failed.set(key, Date.now());
  } finally {
    inflight.delete(key);
    if (!controller.signal.aborted) publish();
    pump();
  }
}

function pump() {
  while (inflight.size < CONCURRENCY && queue.length) {
    const tile = queue.shift() as TileKey;
    if (lookup(tile) !== undefined || inflight.has(keyOf(tile))) continue;
    void load(tile);
  }
}

function publish() {
  const message = current;
  if (!message) return;
  const ready = message.tiles.filter((tile) => lookup(tile));
  if (!ready.length) return;
  const tiles = ready.map((tile) => ({
    z: tile.z,
    x: tile.x,
    y: tile.y,
    rings: lookup(tile) as DecodedRing[],
  }));
  scope.postMessage({ type: 'water', id: message.id, tiles, cached: cache.size });
}

scope.onmessage = (event: MessageEvent<PlanMessage>) => {
  const message = event.data;
  if (message.type !== 'plan') return;
  current = message;
  template = message.template;
  const wanted = new Set(message.tiles.map(keyOf));
  for (const [key, controller] of inflight) {
    if (!wanted.has(key)) {
      controller.abort();
      inflight.delete(key);
    }
  }
  queue = message.tiles.filter((tile) => lookup(tile) === undefined);
  pump();
  publish();
};
