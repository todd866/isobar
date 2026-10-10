import { describe, expect, it } from 'vitest';
import {
  boxContains,
  compositeMosaic,
  decodeTerrarium,
  halfTableLookup,
  latToTileY,
  lonToTileX,
  MAX_VIEW_TILES,
  planMosaic,
  reliefStrength,
  terrainZoom,
  terrariumElevation,
  tileXToLon,
  tileYToLat,
  tilesForBox,
  TILE_SIZE,
  toHalf,
} from '../../src/lib/terrain/terrarium';
import { viewGeoBox } from '../../src/lib/terrain/terrain-layer';
import { globalEquirectangular } from '../../src/lib/lambert';

const half = halfTableLookup();

/** Terrarium RGB for an elevation (the inverse of the decode). */
function encode(metres: number): [number, number, number] {
  const v = metres + 32768;
  return [Math.floor(v / 256), Math.floor(v) % 256, Math.round((v - Math.floor(v)) * 256)];
}

describe('terrarium decode', () => {
  it('decodes the pixels sampled from Mapterhorn on 8 Oct 2026', () => {
    // Mt Rainier summit area z12 (surveyed 4392 m), Kosciuszko z12, Perth CBD, Puget Sound, Dead Sea.
    expect(terrariumElevation(145, 28, 0)).toBe(4380);
    expect(terrariumElevation(136, 176, 128)).toBe(2224.5);
    expect(terrariumElevation(128, 14, 0)).toBe(14);
    expect(terrariumElevation(127, 255, 128)).toBe(-0.5);
    expect(terrariumElevation(126, 80, 0)).toBe(-432);
  });

  it('round-trips RGBA through binary16 within half precision', () => {
    const metres = [0, -0.5, 14, 288, 2224.5, 4391.5, 8848, -432];
    const rgba = new Uint8Array(metres.length * 4);
    metres.forEach((m, i) => rgba.set([...encode(m), 255], i * 4));
    const out = decodeTerrarium(rgba);
    metres.forEach((m, i) => expect(Math.abs(half[out[i]] - m)).toBeLessThanOrEqual(Math.max(0.01, Math.abs(m) / 1024)));
  });

  it('converts to and from binary16', () => {
    for (const v of [0, 1, -1, 0.5, 65504, 1e-5, 4392]) expect(half[toHalf(v)]).toBeCloseTo(v, v > 1000 ? -1 : 4);
    expect(half[toHalf(1e6)]).toBe(Infinity);
  });
});

describe('tile ↔ lat/lon', () => {
  it('maps Mt Rainier to the tile the verification fetched', () => {
    expect(Math.floor(lonToTileX(-121.76, 12))).toBe(662);
    expect(Math.floor(latToTileY(46.853, 12))).toBe(1443);
    expect(Math.floor(lonToTileX(115.861, 8))).toBe(210);
    expect(Math.floor(latToTileY(-31.952, 8))).toBe(151);
  });

  it('inverts', () => {
    for (const [lat, lon] of [[46.853, -121.76], [-31.95, 116.1], [0, 0], [80, 179]]) {
      expect(tileYToLat(latToTileY(lat, 9), 9)).toBeCloseTo(lat, 9);
      expect(tileXToLon(lonToTileX(lon, 9), 9)).toBeCloseTo(lon, 9);
    }
  });

  it('lists tiles centre-out and wraps across the antimeridian', () => {
    const tiles = tilesForBox({ west: 170, east: 190, south: -20, north: -10 }, 4);
    expect(tiles.every((t) => t.x >= 0 && t.x < 16)).toBe(true);
    expect(new Set(tiles.map((t) => t.x))).toEqual(new Set([15, 0]));
    const seattle = tilesForBox({ west: -124, east: -120, south: 46, north: 49 }, 7);
    const centreX = lonToTileX(-122, 7);
    expect(Math.abs(seattle[0].x + 0.5 - centreX)).toBeLessThan(1);
  });

  it('chooses the zoom whose texels match the screen', () => {
    expect(terrainZoom(512 / 360)).toBe(0);
    expect(terrainZoom((512 * 2 ** 7) / 360)).toBe(7);
    expect(terrainZoom(1e9)).toBe(13);
  });

  it('plans a bounded mosaic', () => {
    const plan = planMosaic({ west: -128.6, east: -115.8, south: 43.7, north: 51.7 }, 225, 6_000_000);
    expect(plan.width * plan.height).toBeLessThanOrEqual(6_000_000 * 1.01);
    expect(tilesForBox(plan.box, plan.z).length).toBeLessThanOrEqual(MAX_VIEW_TILES);
    expect(boxContains(plan.box, { west: -128.6, east: -115.8, south: 43.7, north: 51.7 })).toBe(true);
    expect(boxContains(plan.box, { west: 231.4 - 360 + 360, east: 244.2, south: 44, north: 51 })).toBe(true);
  });

  it('fades relief in with zoom: none for the world, subtle synoptic, full regional', () => {
    expect(reliefStrength(180)).toBe(0);
    expect(reliefStrength(50)).toBeGreaterThan(0.2);
    expect(reliefStrength(50)).toBeLessThan(0.8);
    expect(reliefStrength(8)).toBe(1);
  });

  it('finds the geographic box an equirectangular camera shows', () => {
    const box = viewGeoBox(globalEquirectangular(), { centerX: -122, centerY: 47.7, halfWidth: 6.4, halfHeight: 4 });
    expect(box).toEqual({ west: -128.4, east: -115.6, south: 43.7, north: 51.7 });
  });
});

describe('mosaic', () => {
  /** A tile whose elevation is a ramp east (metres = column). */
  function ramp(): Uint16Array {
    const tile = new Uint16Array(TILE_SIZE * TILE_SIZE);
    for (let y = 0; y < TILE_SIZE; y += 1) for (let x = 0; x < TILE_SIZE; x += 1) tile[y * TILE_SIZE + x] = toHalf(x);
    return tile;
  }

  it('reprojects a tile into lat/lon with coverage, rows from the south', () => {
    const z = 2;
    const x = 1, y = 1;
    const box = { west: tileXToLon(x, z), east: tileXToLon(x + 1, z), south: tileYToLat(y + 1, z), north: tileYToLat(y, z) };
    const tile = ramp();
    const mosaic = compositeMosaic(box, 64, 32, z, (tz, tx, ty) => (tz === z && tx === x && ty === y ? tile : null));
    expect(mosaic.covered).toBe(64 * 32);
    const at = (i: number, j: number) => half[mosaic.data[(j * 64 + i) * 2]];
    expect(at(0, 0)).toBeLessThan(8);
    expect(at(63, 0)).toBeGreaterThan(500);
    expect(half[mosaic.data[1]]).toBe(1);
  });

  it('leaves missing tiles uncovered (flat tint, no invented relief)', () => {
    const mosaic = compositeMosaic({ west: -124, east: -120, south: 46, north: 49 }, 40, 30, 7, () => null);
    expect(mosaic.covered).toBe(0);
    expect(mosaic.data.every((v) => v === 0)).toBe(true);
  });

  it('uses measured parent relief when the fine tile is unavailable', () => {
    const parent = ramp();
    const mosaic = compositeMosaic({ west: -124, east: -120, south: 46, north: 49 }, 40, 30, 7, z => z === 5 ? parent : null);
    expect(mosaic.covered).toBe(40 * 30);
  });

  it('falls back to a loaded ancestor while the zoom tile is still arriving', () => {
    const parent = ramp();
    const mosaic = compositeMosaic({ west: -124, east: -120, south: 46, north: 49 }, 40, 30, 7, (z) => (z === 5 ? parent : undefined));
    expect(mosaic.covered).toBe(40 * 30);
  });
});
