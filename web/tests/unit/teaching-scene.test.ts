import { describe, expect, it } from 'vitest';
import {
  buildAtmosphereTrajectory,
  syntheticAtmosphereProfile,
  syntheticAtmosphereVectors,
} from '../../src/lib/atmosphere-flow';
import { buildCloudDensityTexture } from '../../src/lib/cloud-density';
import { sampleTeachingAtmosphere, type TeachingAtmosphereContext } from '../../src/lib/atmosphere-teaching';
import type { AtmosphereSlice } from '../../src/lib/atmosphere-slice';

const time = Date.UTC(2026, 0, 15, 6);
const teaching: TeachingAtmosphereContext = {
  kind: 'thunderstorm', lat: -31.95, lon: 115.86, groundM: 20, timeMs: time,
};
const seaBreeze: TeachingAtmosphereContext = { ...teaching, kind: 'sea-breeze' };

describe('integrated teaching atmosphere scene', () => {
  it('keeps profile thermodynamics, wind, and cloud values on the shared field', () => {
    const profile = syntheticAtmosphereProfile(teaching.lat, teaching.lon, time, undefined, teaching);
    expect(profile.series.levels.length).toBeGreaterThan(4);
    for (const level of profile.series.levels) {
      const sampled = sampleTeachingAtmosphere(teaching, teaching.lat, teaching.lon, level.z[0]);
      expect(level.ws[0]).toBeCloseTo(Math.hypot(sampled.u, sampled.v) / 0.514444, 8);
      expect(level.w[0]).toBeCloseTo(sampled.w, 8);
      expect(level.t[0]).toBeCloseTo(sampled.temperatureC, 8);
      expect(level.rh[0]).toBeCloseTo(sampled.rhPct, 8);
      expect(level.cc[0]).toBeCloseTo(sampled.cloudPct, 8);
    }
  });

  it('carries the teaching field and cloud percentage through generated vectors', () => {
    const vectors = syntheticAtmosphereVectors(teaching.lat, teaching.lon, .3, 1.4, time, undefined, undefined, teaching);
    expect(vectors.length).toBeGreaterThan(4);
    const vector = vectors.find((candidate) => candidate.heightM === teaching.groundM + 1800);
    expect(vector?.teaching).toEqual(teaching);
    expect(vector?.cloudPct).toBe(sampleTeachingAtmosphere(teaching, vector!.lat, vector!.lon, vector!.heightM).cloudPct);
    expect(vectors.every((candidate) => candidate.heightM >= teaching.groundM)).toBe(true);
  });

  it('isolates trajectory cache entries by teaching context and time', () => {
    const first = { lat: seaBreeze.lat, lon: seaBreeze.lon, heightM: seaBreeze.groundM + 450, u: 0, v: 0, w: 0, pressure: 950, phase: 0, teaching: seaBreeze };
    const repeated = buildAtmosphereTrajectory(first, time, -90, 0, 7);
    expect(buildAtmosphereTrajectory(first, time, -90, 0, 7)).toEqual(repeated);
    const laterContext = { ...seaBreeze, timeMs: time + 12 * 60 * 60 * 1000 };
    const later = { ...first, teaching: laterContext };
    expect(buildAtmosphereTrajectory(later, time, -90, 0, 7)).not.toEqual(repeated);
  });

  it('keeps a slice lattice tied to the slice rather than camera dimensions', () => {
    const slice: AtmosphereSlice = { lat: seaBreeze.lat, lon: seaBreeze.lon, bearingRadians: .4, halfWidthM: 12_000, halfDepthM: 2_000, baseM: 0 };
    const narrow = syntheticAtmosphereVectors(slice.lat, slice.lon, .1, .8, time, slice, undefined, seaBreeze);
    const wide = syntheticAtmosphereVectors(slice.lat, slice.lon, 2.5, 3, time, slice, undefined, seaBreeze);
    expect(wide).toEqual(narrow);
    expect(narrow.length).toBeGreaterThan(10);
  });

  it('omits vector and profile levels below supplied terrain', () => {
    const terrain = () => 1000;
    const vectors = syntheticAtmosphereVectors(seaBreeze.lat, seaBreeze.lon, .4, 1.2, time, undefined, terrain, seaBreeze);
    expect(vectors.length).toBeGreaterThan(0);
    expect(vectors.every((vector) => vector.heightM >= 1050)).toBe(true);
    const profile = syntheticAtmosphereProfile(seaBreeze.lat, seaBreeze.lon, time, terrain, seaBreeze);
    expect(profile.series.levels.every((level) => level.z[0] >= 1050)).toBe(true);
  });

  it('builds shared flow cloud density for a moist storm and clears outside it', () => {
    const sample = (lat: number, lon: number, height: number) => {
      const field = sampleTeachingAtmosphere(teaching, lat, lon, height);
      return { density: field.density, u: field.u, v: field.v };
    };
    const wetBounds = { west: teaching.lon - .04, east: teaching.lon + .04, south: teaching.lat - .04, north: teaching.lat + .04, minHeight: 0, maxHeight: 10_000 };
    const wet = buildCloudDensityTexture([], { bounds: wetBounds, width: 10, height: 10, depth: 12, terrain: () => teaching.groundM, flowSample: sample });
    expect(wet.density.some((value) => value > 0)).toBe(true);
    const outsideBounds = { ...wetBounds, west: teaching.lon + .2, east: teaching.lon + .28, south: teaching.lat + .2, north: teaching.lat + .28 };
    const clear = buildCloudDensityTexture([], { bounds: outsideBounds, width: 8, height: 8, depth: 8, terrain: () => teaching.groundM, flowSample: sample });
    expect(clear.density.every((value) => value === 0)).toBe(true);
  });
});

import {frameAtmosphere,withTilt,MAX_TILT} from '../../src/lib/tilt-navigation';
import {mapProject,globalEquirectangular} from '../../src/lib/lambert';
import {cameraDuringMove} from '../../src/lib/point/camera';

describe('framing the actual atmospheric column',()=>{
  it('keeps floor and lid in view for phone, laptop, near-vertical and maximum tilt',()=>{
    const geo=globalEquirectangular();
    for(const aspect of [.5,1,1.8])for(const pitch of [.2,.8,MAX_TILT])for(const bearingRadians of [0,1.4,-2.8])for(const top of [2700,11000]){
      const before={centerX:115.86,centerY:-31.95,halfWidth:.04*aspect,halfHeight:.04,bearingRadians};
      const fitted=frameAtmosphere(geo,before,pitch,top,()=>20);
      const view=withTilt(geo,fitted,pitch,()=>20,true);
      for(const h of [20,20+top]){
        const p=mapProject(geo,view,-31.95,115.86,h);
        expect(p).not.toBeNull();expect(Math.abs(p!.y)).toBeLessThan(.72);
      }
      expect(fitted.centerX).toBe(before.centerX);expect(fitted.centerY).toBe(before.centerY);
      expect(fitted.bearingRadians).toBe(before.bearingRadians);
      const mid=cameraDuringMove({from:before,to:fitted,start:0,duration:1000},500);
      expect(mid.focusHeightM).toBeCloseTo(fitted.focusHeightM!*.5,6);
    }
  });
});
