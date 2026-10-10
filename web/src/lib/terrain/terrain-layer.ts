/**
 * The map's terrain: asks the terrain worker for a mosaic covering the view
 * (plus a panning margin) and hands each finished mosaic to the plate. Nothing
 * here decodes or composites; the main thread only plans and uploads.
 */
import { mapUnproject, unproject, type Camera, type Lambert } from '../lambert';
import type { SectionSample } from '../point/terrain-section';
import { boxContains, planMosaic, reliefStrength, MERCATOR_LIMIT, type GeoBox, type TerrainPlan } from './terrarium';

export interface TerrainMosaic {
  box: GeoBox;
  width: number;
  height: number;
  /** RG binary16, rows from the south: elevation (m), coverage. */
  data: Uint16Array;
  z: number;
  covered: number;
}

export interface TerrainStats {
  z: number | null;
  needed: number;
  loaded: number;
  missing: number;
  cached: number;
  covered: number;
  mosaics: number;
}

/** The geographic box a camera shows (continuous longitude), from its edges. */
export function viewGeoBox(geo: Lambert, camera: Camera): GeoBox | null {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  const steps = camera.surface ? 8 : geo.projection === 'equirectangular' ? 1 : 8;
  for (let k = 0; k <= steps; k += 1) {
    const t = (k / steps) * 2 - 1;
    for (const [cx, cy] of [[t, -1], [t, 1], [-1, t], [1, t]]) {
      const point = mapUnproject(geo, camera, cx, cy);
      if (!point) continue;
      west = Math.min(west, point.lon);
      east = Math.max(east, point.lon);
      south = Math.min(south, point.lat);
      north = Math.max(north, point.lat);
    }
  }
  if (!Number.isFinite(west) || !(east > west) || !(north > south)) return null;
  return { west, east, south: Math.max(-90, south), north: Math.min(90, north) };
}

export interface TerrainLayer {
  /** Call on every paint; it only messages the worker when the view outgrows the mosaic. Returns relief strength. */
  update(geo: Lambert, camera: Camera, cssWidth: number, dpr: number): number;
  /** East–west DEM through a point. Tile misses stay in the worker, off the page console. */
  sampleSection(lat: number, lon: number, signal?: AbortSignal): Promise<SectionSample[]>;
  stats(): TerrainStats;
  destroy(): void;
}

export function createTerrainLayer(onMosaic: (mosaic: TerrainMosaic) => void, options: { template?: string } = {}): TerrainLayer | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL('../../workers/terrain.worker.ts', import.meta.url));
  } catch {
    return null;
  }
  let id = 0;
  let sectionId = 0;
  let requested: TerrainPlan | null = null;
  const stats: TerrainStats = { z: null, needed: 0, loaded: 0, missing: 0, cached: 0, covered: 0, mosaics: 0 };
  const pending = new Map<number, (samples: SectionSample[]) => void>();
  worker.onmessage = (event: MessageEvent<TerrainMosaic & { type: string; id: number; tiles: { needed: number; loaded: number; missing: number; cached: number }; samples?: SectionSample[] }>) => {
    const message = event.data;
    if (message.type === 'section') {
      pending.get(message.id)?.(message.samples ?? []);
      pending.delete(message.id);
      return;
    }
    if (message.type !== 'mosaic' || message.id !== id) return;
    Object.assign(stats, message.tiles, { z: message.z, covered: message.covered, mosaics: stats.mosaics + 1 });
    onMosaic(message);
  };
  return {
    update(geo, camera, cssWidth, dpr) {
      const view = viewGeoBox(geo, camera);
      if (!view) return 0;
      const strength = reliefStrength(view.north - view.south);
      // Even without shaded relief, the world chart needs measured elevation
      // to de-emphasise sea-level reductions over mountains. Keep the existing
      // tile/texel budgets; clamp coverage to the DEM's Mercator extent.
      view.south = Math.max(-MERCATOR_LIMIT, view.south);
      view.north = Math.min(MERCATOR_LIMIT, view.north);
      if (!(view.north > view.south)) return strength;
      // About one texel per CSS pixel, a little finer on a dense display.
      const density = Math.min(1.5, Math.max(1, dpr));
      const pxPerDegree = (cssWidth * density) / (view.east - view.west);
      const phone = cssWidth < 700;
      const plan = planMosaic(view, pxPerDegree, phone ? 1_500_000 : 6_000_000);
      const stale = !requested
        || requested.z !== plan.z
        || !boxContains(requested.box, view)
        // Zoomed well out of the requested box: a coarser, wider mosaic.
        || (requested.box.east - requested.box.west) > 4 * (plan.box.east - plan.box.west);
      if (stale) {
        requested = plan;
        id += 1;
        // Stats describe the plan in flight: nothing settled yet.
        Object.assign(stats, { z: plan.z, needed: 0, loaded: 0, missing: 0, covered: 0, mosaics: 0 });
        worker.postMessage({ type: 'plan', id, plan, template: options.template });
      }
      return strength;
    },
    sampleSection(lat, lon, signal) {
      if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
      const requestId = ++sectionId;
      return new Promise((resolve, reject) => {
        const settle = (samples: SectionSample[]) => {
          pending.delete(requestId);
          signal?.removeEventListener('abort', onAbort);
          resolve(samples);
        };
        const onAbort = () => {
          pending.delete(requestId);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        pending.set(requestId, settle);
        signal?.addEventListener('abort', onAbort);
        worker.postMessage({ type: 'section', id: requestId, lat, lon });
      });
    },
    stats: () => ({ ...stats }),
    destroy() {
      for (const settle of pending.values()) settle([]);
      pending.clear();
      worker.terminate();
    },
  };
}
