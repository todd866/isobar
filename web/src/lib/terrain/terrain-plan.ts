import {
  MERCATOR_LIMIT,
  planMosaic,
  terrainZoom,
  tileCountForBox,
  TILE_SIZE,
  type GeoBox,
  type TerrainPlan,
} from './terrarium';

export type TerrainMosaicPlan = TerrainPlan & { far?: TerrainPlan };

const FAR_MAX_TEXELS = 512_000;
const NEAR_MAX_TILES = 40;
const FAR_MAX_TILES = 16;

function expandedBox(view: GeoBox, margin: number): GeoBox {
  const lon = Math.max(0.001, view.east - view.west);
  const lat = Math.max(0.001, view.north - view.south);
  return {
    west: view.west - lon * margin,
    east: view.east + lon * margin,
    south: Math.max(-MERCATOR_LIMIT, view.south - lat * margin),
    north: Math.min(MERCATOR_LIMIT, view.north + lat * margin),
  };
}

function boundedPlan(
  view: GeoBox,
  pxPerDegree: number,
  maxTexels: number,
  margin: number,
  maxTiles: number,
  nativeDensityOnly: boolean,
  maxZoom = 13,
): TerrainPlan {
  const box = expandedBox(view, margin);
  let z = Math.min(maxZoom, terrainZoom(pxPerDegree));
  while (z > 0 && tileCountForBox(box, z) > maxTiles) z -= 1;

  const nativeDensity = (TILE_SIZE * 2 ** z) / 360;
  const density = Math.min(pxPerDegree > 0 ? pxPerDegree : nativeDensity, nativeDensity * (nativeDensityOnly ? 1 : 1.25));
  const spanLon = Math.max(0.001, box.east - box.west);
  const spanLat = Math.max(0.001, box.north - box.south);
  const budget = Math.max(4, maxTexels);
  const scale = Math.min(1, Math.sqrt(budget / (spanLon * spanLat * density * density)));
  let width = Math.max(2, Math.min(4096,Math.round(spanLon * density * scale)));
  let height = Math.max(2, Math.min(4096,Math.round(spanLat * density * scale)));
  // Rounding must not push a phone or far-field plan over its hard budget.
  while (width * height > budget && (width > 2 || height > 2)) {
    if (width >= height && width > 2) width -= 1;
    else if (height > 2) height -= 1;
    else break;
  }
  return { z, box, width, height };
}

/**
 * Plan the close terrain footprint and a coarse backdrop for a tilted camera.
 * The close box is independent of the far view, so a narrow mountain focus can
 * retain detail while the backdrop still reaches the visible horizon.
 */
export function planTerrainMosaics(
  view: GeoBox,
  nearView: GeoBox | null,
  pxPerDegree: number,
  maxTexels: number,
): TerrainMosaicPlan {
  if (!nearView) return planMosaic(view, pxPerDegree, maxTexels);

  const farBudget = Math.min(FAR_MAX_TEXELS, Math.max(0, maxTexels - 4));
  const nearBudget = Math.max(4, maxTexels - farBudget);
  const near = boundedPlan(nearView, pxPerDegree, nearBudget, 0.1, NEAR_MAX_TILES, false);
  const farZoom = Math.max(0, near.z - 3);
  const far = boundedPlan(view, pxPerDegree, Math.min(FAR_MAX_TEXELS, Math.max(4, farBudget)), 0.1, FAR_MAX_TILES, true, farZoom);
  return { ...near, far };
}

