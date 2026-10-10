import {syntheticAtmosphereVectors} from '../../src/lib/atmosphere-flow';
import { describe, expect, it } from 'vitest';
import {
  atmosphereSliceWeight,
  offsetAtmosphereSlice,
  buildTerrainSliceMesh,
  sliceCoordinates,
  sliceSegmentRange,
  slicePoint,
  type AtmosphereSlice,
} from '../../src/lib/atmosphere-slice';

const slice: AtmosphereSlice = {
  lat: -32,
  lon: 179.9,
  bearingRadians: Math.PI / 4,
  halfWidthM: 1_000,
  halfDepthM: 2_000,
  baseM: 100,
};

describe('atmosphere slice plane', () => {
  it('round-trips across/depth coordinates at multiple bearings', () => {
    for (const bearingRadians of [0, Math.PI / 2, Math.PI, -Math.PI / 3]) {
      const current = { ...slice, bearingRadians, lon: 20 };
      const point = slicePoint(current, 350, -720);
      expect(point).not.toBeNull();
      const coordinates = sliceCoordinates(current, point!.lat, point!.lon);
      expect(coordinates.acrossM).toBeCloseTo(350, 3);
      expect(coordinates.depthM).toBeCloseTo(-720, 3);
    }
  });

  it('uses the short dateline path and wraps returned longitudes', () => {
    const coordinates = sliceCoordinates({ ...slice, bearingRadians: 0 }, -32, -179.9);
    expect(coordinates.depthM).toBeCloseTo(0, 5);
    expect(coordinates.acrossM).toBeCloseTo(18_881, 0);
    expect(slicePoint({ ...slice, bearingRadians: 0 }, 0, 0)!.lon).toBeCloseTo(179.9, 6);
    expect(slicePoint({ ...slice, bearingRadians: 0, lon: 1e308 }, 0, 0)!.lon).toBeGreaterThanOrEqual(-180);
  });

  it('fades through the outer quarter and excludes the footprint outside', () => {
    const northSlice = { ...slice, bearingRadians: 0 };
    expect(atmosphereSliceWeight(northSlice, slice.lat, slice.lon)).toBe(1);
    expect(atmosphereSliceWeight(northSlice, slice.lat, slice.lon + (slice.halfWidthM * 0.75) / (111_320 * Math.cos(slice.lat * Math.PI / 180)))).toBeCloseTo(1, 6);
    expect(atmosphereSliceWeight(northSlice, slice.lat, slice.lon + (slice.halfWidthM * 0.875) / (111_320 * Math.cos(slice.lat * Math.PI / 180)))).toBeGreaterThan(0);
    expect(atmosphereSliceWeight(northSlice, slice.lat, slice.lon + (slice.halfWidthM * 1.001) / (111_320 * Math.cos(slice.lat * Math.PI / 180)))).toBe(0);
    expect(atmosphereSliceWeight(undefined, Number.NaN, Number.NaN)).toBe(1);
  });
});

describe('terrain slice mesh', () => {
  it('has bounded indices and separate top, wall, and bottom flags', () => {
    const mesh = buildTerrainSliceMesh(slice, 4, 2);
    expect(mesh.vertices.length % 4).toBe(0);
    expect(mesh.indices.length % 3).toBe(0);
    expect(Math.max(...mesh.indices)).toBeLessThan(mesh.vertices.length / 4);
    const records = Array.from({ length: mesh.vertices.length / 4 }, (_, i) => mesh.vertices.slice(i * 4, i * 4 + 4));
    expect(records.some((v) => v[2] === 0 && v[3] === 0)).toBe(true);
    expect(records.some((v) => v[2] === 0 && v[3] === 1)).toBe(true);
    expect(records.some((v) => v[2] === 1 && v[3] === 1)).toBe(true);
  });

  it('keeps mesh longitudes continuous across the dateline', () => {
    const mesh = buildTerrainSliceMesh({ ...slice, bearingRadians: Math.PI / 2, halfDepthM: 40_000 }, 4, 1);
    const longitudes = Array.from({ length: mesh.vertices.length / 4 }, (_, i) => mesh.vertices[i * 4]);
    expect(Math.max(...longitudes) - Math.min(...longitudes)).toBeLessThan(1);
    expect(longitudes.some((lon) => lon > 180)).toBe(true);
  });

  it('rejects invalid or oversized dimensions without allocating', () => {
    expect(buildTerrainSliceMesh(slice, 257, 2).vertices.length).toBe(0);
    expect(buildTerrainSliceMesh(slice, 4.5, 2).indices.length).toBe(0);
    expect(buildTerrainSliceMesh({ ...slice, halfWidthM: Number.NaN }).indices.length).toBe(0);
  });
});

it('retains a segment crossing both edges without dropping the entire wind vector',()=>{
  const s={...slice,lon:0,bearingRadians:0,halfWidthM:1000,halfDepthM:100};
  const a=slicePoint(s,-2000,0)!,b=slicePoint(s,2000,0)!;
  const range=sliceSegmentRange(s,a,b)!;
  expect(range[0]).toBeCloseTo(.25);expect(range[1]).toBeCloseTo(.75);
  expect(sliceSegmentRange(s,slicePoint(s,-2000,200)!,slicePoint(s,2000,200)!)).toBeNull();
});

it('seeds all five wind levels even when the slab misses the ordinary geographic lattice',()=>{
 const s={...slice,lat:-31.9547,lon:115.8599,halfWidthM:10000,halfDepthM:1200};
 const vectors=syntheticAtmosphereVectors(s.lat,s.lon,.13,2,0,s);
 expect(new Set(vectors.map(v=>v.pressure))).toEqual(new Set([925,850,700,500,300]));
 expect(vectors.length).toBeLessThan(250);
 expect(vectors.every(v=>atmosphereSliceWeight(s,v.lat,v.lon)>0)).toBe(true);
});


it('sweeps normal to the chosen bearing from the same target without accumulating drift',()=>{
  for(const bearingRadians of [0,Math.PI/2,Math.PI,Math.PI*1.75]){
    const origin={...slice,bearingRadians};
    const moved=offsetAtmosphereSlice(origin,25000)!;
    const local=sliceCoordinates(origin,moved.lat,moved.lon);
    expect(local.acrossM).toBeCloseTo(0,5);expect(local.depthM).toBeCloseTo(25000,5);
    expect(moved.halfWidthM).toBe(origin.halfWidthM);expect(moved.bearingRadians).toBe(bearingRadians);
    const reset=offsetAtmosphereSlice(origin,0)!;
    expect(reset.lat).toBeCloseTo(origin.lat,9);expect(reset.lon).toBeCloseTo(origin.lon,9);
  }
  expect(offsetAtmosphereSlice(slice,NaN)).toBeNull();
});
