import { describe, expect, it } from 'vitest';
import {
  drawAtmosphereFlow,
  buildAtmosphereTrajectory,
  syntheticAtmosphereProfile,
  syntheticAtmosphereVectors,
  syntheticAtmosphereWind,
} from '../../src/lib/atmosphere-flow';
import { globalEquirectangular } from '../../src/lib/lambert';

function derivative(value: (lat: number, lon: number, height: number) => number, lat: number, lon: number, height: number, dLat: number, dLon: number, dHeight: number) {
  return {
    lat: (value(lat + dLat, lon, height) - value(lat - dLat, lon, height)) / (2 * dLat * 111132),
    lon: (value(lat, lon + dLon, height) - value(lat, lon - dLon, height)) /
      (2 * dLon * 111320 * Math.max(.1, Math.cos(lat * Math.PI / 180))),
    height: (value(lat, lon, height + dHeight) - value(lat, lon, height - dHeight)) / (2 * dHeight),
  };
}

describe('idealised atmosphere pedagogy contract', () => {
  it('integrates short curved trajectories through the selected forecast field', () => {
    const vector = syntheticAtmosphereVectors(-31.94, 115.97, .5, 1.5, Date.UTC(2026, 9, 10))[0];
    expect(vector).toBeDefined();
    const path = buildAtmosphereTrajectory(vector, Date.UTC(2026, 9, 10), -90, 0, 7);
    const repeated = buildAtmosphereTrajectory(vector, Date.UTC(2026, 9, 10), -90, 0, 7);
    expect(path).toHaveLength(7);
    expect(repeated).toEqual(path);
    expect(path.every(point => Number.isFinite(point.lat) && Number.isFinite(point.lon) && Number.isFinite(point.heightM))).toBe(true);
    const start = path[0], end = path[path.length - 1], middle = path[Math.floor(path.length / 2)];
    const fraction = (middle.time - start.time) / (end.time - start.time);
    const straightLat = start.lat + (end.lat - start.lat) * fraction;
    const straightLon = start.lon + (end.lon - start.lon) * fraction;
    expect(Math.hypot(middle.lat - straightLat, middle.lon - straightLon)).toBeGreaterThan(1e-8);
  });

  it('keeps one analytic overturning cell locally continuous in metres and seconds', () => {
    const time = Date.UTC(2026, 9, 10);
    for (const [lat, lon] of [[-32.1, 116.3], [13.2, -42.8], [61.4, 8.7]]) {
      for (const height of [2500, 5000, 7500]) {
        const wind = (a: number, o: number, z: number) => syntheticAtmosphereWind(a, o, z, time);
        const du = derivative((a, o, z) => wind(a, o, z).u, lat, lon, height, .002, .002, 1);
        const dv = derivative((a, o, z) => wind(a, o, z).v, lat, lon, height, .002, .002, 1);
        const dw = derivative((a, o, z) => wind(a, o, z).w ?? 0, lat, lon, height, .002, .002, 1);
        expect(Math.abs(du.lon + dv.lat + dw.height)).toBeLessThan(2e-7);
      }
    }
  });

  it('closes the cell at both boundaries and reverses horizontal return flow', () => {
    const floor = syntheticAtmosphereWind(1 / 24, 1 / 24, 0, 0);
    const up = syntheticAtmosphereWind(1 / 24, 1 / 24, 2500, 0);
    const high = syntheticAtmosphereWind(1 / 24, 1 / 24, 7500, 0);
    const top = syntheticAtmosphereWind(1 / 24, 1 / 24, 10000, 0);
    const down = syntheticAtmosphereWind(1 / 24, 1 / 6 + 1 / 24, 5000, 0);
    const background = { u: 8 + 20 * .25, v: -5 + 16 * .25 };
    expect(floor.w).toBeCloseTo(0, 10); expect(top.w).toBeCloseTo(0, 10);
    expect(up.w).toBeGreaterThan(0); expect(down.w).toBeLessThan(0);
    expect(Math.abs(up.w ?? 0)).toBeLessThanOrEqual(2.5);
    expect(Math.abs(up.u - background.u) + Math.abs(up.v - background.v)).toBeGreaterThan(0.01);
    expect((up.u - background.u) * (high.u - (8 + 20 * .75))).toBeLessThan(0);
    expect((up.v - background.v) * (high.v - (-5 + 16 * .75))).toBeLessThan(0);
  });

  it('keeps generated levels and profiles above a supplied terrain surface', () => {
    const ground = (lon: number, lat: number) => 8200 + 100 * Math.sin(lon + lat);
    const vectors = syntheticAtmosphereVectors(27.99, 86.93, .5, 1.5, 0, undefined, ground);
    expect(vectors.length).toBeGreaterThan(0);
    expect(vectors.every(v => v.heightM >= (ground(v.lon, v.lat) ?? 0) + 50)).toBe(true);
    const profile = syntheticAtmosphereProfile(27.99, 86.93, 0, ground);
    expect(profile.elevationM).toBeCloseTo(ground(86.93, 27.99), 8);
    expect(profile.series.levels.every(level => level.z[0] >= (profile.elevationM ?? 0) + 50)).toBe(true);
    expect(new Set(vectors.map(v => v.pressure))).toEqual(new Set(profile.series.levels.map(level => level.hPa)));
  });

  it('retains regional trails whose individual curve segments are subpixel', () => {
    const context={save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},stroke(){}} as unknown as CanvasRenderingContext2D;
    const vector={lat:0,lon:0,heightM:9000,u:26,v:9,w:0,pressure:300,phase:.5};
    const camera={centerX:0,centerY:0,halfWidth:6,halfHeight:3,pitch:0,bearingRadians:0};
    expect(drawAtmosphereFlow(context,[vector],globalEquirectangular(),camera,800,400,0,false,()=>0,0).flows).toBe(1);
  });

  it('caps the complete projected tail at mountain zoom', () => {
    let x=0,y=0,total=0;
    const context={save(){},restore(){},beginPath(){},moveTo(a:number,b:number){x=a;y=b;},
      lineTo(a:number,b:number){total+=Math.hypot(a-x,b-y);x=a;y=b;},stroke(){}} as unknown as CanvasRenderingContext2D;
    const vector={lat:0,lon:0,heightM:9000,u:26,v:9,w:0,pressure:300,phase:.5};
    const camera={centerX:0,centerY:0,halfWidth:.006,halfHeight:.003,pitch:0,bearingRadians:0};
    const result=drawAtmosphereFlow(context,[vector],globalEquirectangular(),camera,800,400,0,false,()=>0,0);
    expect(result.flows).toBe(1);
    expect(total).toBeGreaterThan(40);expect(total).toBeLessThanOrEqual(54.01);
  });

  it('rejects an animated segment that would cross supplied terrain', () => {
    const context = {
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      set lineCap(_: CanvasLineCap) {}, set lineWidth(_: number) {}, set globalAlpha(_: number) {},
      set strokeStyle(_: string) {},
    } as unknown as CanvasRenderingContext2D;
    const camera = { centerX: 0, centerY: 0, halfWidth: 1, halfHeight: .5, pitch: 0, bearingRadians: 0 };
    const geo = globalEquirectangular();
    const vector = [{ lat: 0, lon: 0, heightM: 9000, u: 8, v: -5, w: 2.5, pressure: 925, phase: .5 }];
    expect(drawAtmosphereFlow(context, vector, geo, camera, 800, 400, 0, false, () => 0).flows).toBeGreaterThan(0);
    expect(drawAtmosphereFlow(context, vector, geo, camera, 800, 400, 0, false, () => 8900).flows).toBe(0);
  });
});
