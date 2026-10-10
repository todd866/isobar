import { describe, expect, it } from 'vitest';
import { projectEverestSectionRoute } from '../../src/lib/point/section-route';
import type { AtmosphereSlice } from '../../src/lib/atmosphere-slice';

const everestSlice: AtmosphereSlice = {
  lat: 27.9881, lon: 86.925, bearingRadians: 0,
  halfWidthM: 25_000, halfDepthM: 25_000, baseM: 0,
};

describe('Everest section route projection', () => {
  it('projects only the bounded route inside the slab and exposes the timeline marker', () => {
    const projection = projectEverestSectionRoute(everestSlice, Date.parse('1953-05-29T06:00:00Z'));
    const points = projection.runs.flat();
    expect(points.length).toBeGreaterThan(0);
    expect(points.length).toBeLessThanOrEqual(204);
    expect(points.every((point) => Math.abs(point.acrossM) <= everestSlice.halfWidthM)).toBe(true);
    expect(projection.marker).not.toBeNull();
  });

  it('does not leak the Everest route into unrelated geography or disabled sections', () => {
    const elsewhere = { ...everestSlice, lat: -32, lon: 115.86 };
    expect(projectEverestSectionRoute(elsewhere, Date.now()).runs).toEqual([]);
    expect(projectEverestSectionRoute(everestSlice, Date.now(), false)).toEqual({ runs: [], marker: null });
  });

  it('clips route points to both across and depth extents', () => {
    const narrow = { ...everestSlice, halfWidthM: 100, halfDepthM: 100 };
    const projection = projectEverestSectionRoute(narrow, Date.parse('1953-05-29T06:00:00Z'));
    expect(projection.runs.flat().every((point) => Math.abs(point.acrossM) <= 100)).toBe(true);
    expect(projection.runs.flat().every((point) => Math.abs(point.lat - narrow.lat) < 0.002)).toBe(true);
  });
});


it('keeps the local approximate ascent in a thin cut and rotates its projection',()=>{
 const thin={...everestSlice,halfWidthM:8000,halfDepthM:1};
 const time=Date.parse('1953-05-29T06:00:00Z');
 const first=projectEverestSectionRoute(thin,time),turned=projectEverestSectionRoute({...thin,bearingRadians:Math.PI/2},time);
 expect(first.runs.flat().length).toBeGreaterThan(10);
 expect(turned.runs.flat().length).toBeGreaterThan(10);
 expect(turned.runs.flat()[0].acrossM).not.toBeCloseTo(first.runs.flat()[0].acrossM,0);
});
