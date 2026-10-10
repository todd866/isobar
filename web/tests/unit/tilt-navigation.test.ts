import { describe, expect, it } from 'vitest';
import { frameData, type Camera } from '../../src/lib/camera';
import { globalEquirectangular, mapUnproject, mapProject } from '../../src/lib/lambert';
import { TiltFraming, panTilt, liftCamera, terrainEye, anchorTilt, MAX_TILT, withTilt, zoomTilt } from '../../src/lib/tilt-navigation';

const GEO = globalEquirectangular();
const BOX = { west: -180, east: 180, south: -90, north: 90 };
const FRAME = frameData(GEO, 1200, 600, BOX, { lat: -31.95, lon: 115.86 });
const pitch = 45 * Math.PI / 180;
const closeLon = (a: number, b: number) => Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);

function point(camera: Camera, pitchRadians = pitch, x = 0, y = 0) {
  return mapUnproject(GEO, withTilt(GEO, camera, pitchRadians), x, y);
}

describe('tilt navigation', () => {
  it('adds and removes the pure tilted surface at the endpoints', () => {
    expect(withTilt(GEO, FRAME.home, 0)).toBe(FRAME.home);
    const tilted = withTilt(GEO, FRAME.home, MAX_TILT);
    expect(tilted.pitch).toBe(MAX_TILT);
    expect(tilted.tiltCamera).toBeDefined();
    const focal = tilted.surface?.unproject(0, 0)!;
    expect(focal.lat).toBeCloseTo(FRAME.home.centerY, 8);
    expect(focal.lon).toBeCloseTo(FRAME.home.centerX, 8);
    expect(withTilt(GEO, FRAME.home, 0).surface).toBeUndefined();
  });

  it('keeps an off-centre pinch geographic anchor while changing zoom', () => {
    const x = 0.42, y = -0.27;
    const before = point(FRAME.home, pitch, x, y)!;
    const next = zoomTilt(GEO, FRAME.home, pitch, x, y, 0.6, FRAME);
    const after = point(next, pitch, x, y)!;
    expect(after.lat).toBeCloseTo(before.lat, 4);
    expect(closeLon(after.lon, before.lon)).toBeLessThan(1e-4);
    expect(next.halfWidth).toBeLessThan(FRAME.home.halfWidth);
  });

  it('holds scale at the global zoom limit and preserves the current focus', () => {
    let camera = FRAME.home;
    for (let i = 0; i < 8; i += 1) camera = zoomTilt(GEO, camera, pitch, 0.31, -0.18, 0.05, FRAME);
    const focus = point(camera, pitch, 0.31, -0.18)!;
    const held = zoomTilt(GEO, camera, pitch, 0.31, -0.18, 0.05, FRAME);
    const heldFocus = point(held, pitch, 0.31, -0.18)!;
    expect(held.halfWidth).toBeCloseTo(camera.halfWidth, 12);
    expect(heldFocus.lat).toBeCloseTo(focus.lat, 5);
    expect(closeLon(heldFocus.lon, focus.lon)).toBeLessThan(1e-4);
  });

  it('anchors a dateline point without taking the long longitude path', () => {
    const camera: Camera = { centerX: 179, centerY: 0, halfWidth: 20, halfHeight: 10 };
    const target = { lat: 4, lon: -179.5 };
    const next = anchorTilt(GEO, camera, pitch, target, 0.2, -0.1, FRAME);
    const hit = point(next, pitch, 0.2, -0.1)!;
    expect(hit.lat).toBeCloseTo(target.lat, 4);
    expect(closeLon(hit.lon, target.lon)).toBeLessThan(1e-4);
    expect(Math.abs(next.centerX - camera.centerX)).toBeLessThan(10);
  });

  it('keeps a close Perth pan stable through tilted and flat views', () => {
    const perth: Camera = { centerX: 115.86, centerY: -31.95, halfWidth: 2, halfHeight: 1 };
    const tilted = anchorTilt(GEO, perth, 35 * Math.PI / 180, { lat: -31.8, lon: 116.05 }, -0.22, 0.16, FRAME);
    const tiltedHit = point(tilted, 35 * Math.PI / 180, -0.22, 0.16)!;
    expect(tiltedHit.lat).toBeCloseTo(-31.8, 4);
    expect(closeLon(tiltedHit.lon, 116.05)).toBeLessThan(1e-4);
    const flatHit = point(tilted, 0, -0.22, 0.16)!;
    expect(flatHit.lat).toBeCloseTo(tilted.centerY + 0.16 * tilted.halfHeight, 6);
    expect(flatHit.lon).toBeCloseTo(tilted.centerX - 0.22 * tilted.halfWidth, 6);
  });
});


it('rises vertically rather than dollying along the view, and cannot descend through the focus',()=>{
  const camera={centerX:86.925,centerY:27.9881,halfHeight:.04,halfWidth:.064,bearingRadians:1.1};
  const before=withTilt(GEO,camera,1,null,true).tiltCamera!;
  const raised=liftCamera(camera,1,250);
  const after=withTilt(GEO,raised.camera,raised.pitch,null,true).tiltCamera!;
  expect(after.geometry.cameraPositionM[0]).toBeCloseTo(before.geometry.cameraPositionM[0],6);
  expect(after.geometry.cameraPositionM[1]).toBeCloseTo(before.geometry.cameraPositionM[1],6);
  expect(after.geometry.cameraPositionM[2]-before.geometry.cameraPositionM[2]).toBeCloseTo(250,6);
  const lowered=liftCamera(camera,1,-1e6);
  expect(lowered.pitch).toBeLessThanOrEqual(MAX_TILT);
  expect(terrainEye(withTilt(GEO,lowered.camera,lowered.pitch).tiltCamera!).heightM).toBeGreaterThan(0);
});

it('retains heading through terrain sampling, pinching and pan picking',()=>{
  const camera={centerX:86.925,centerY:27.9881,halfHeight:.04,halfWidth:.064,bearingRadians:1.1};
  const p=point(camera,1,.2,-.2)!;
  const next=zoomTilt(GEO,camera,1,.2,-.2,.75,FRAME);
  const q=point(next,1,.2,-.2)!;
  expect(q.lat).toBeCloseTo(p.lat,4);expect(q.lon).toBeCloseTo(p.lon,4);
  expect(next.bearingRadians).toBe(camera.bearingRadians);
  const eye=terrainEye(withTilt(GEO,camera,1).tiltCamera!);
  expect(eye.lon).toBeLessThan(camera.centerX);
});


it('does not jump when a look follows vertical eye movement',()=>{
  const framing=new TiltFraming();
  const base={centerX:0,centerY:0,halfHeight:1,halfWidth:1.6};
  const tilted=framing.apply(base,0,.8);
  const lifted=liftCamera(tilted,.8,1000);
  framing.synchronize(lifted.camera,lifted.pitch);
  expect(framing.apply(lifted.camera,lifted.pitch,lifted.pitch).halfHeight).toBeCloseTo(lifted.camera.halfHeight,10);
  const changed=framing.apply(lifted.camera,lifted.pitch,lifted.pitch+.001);
  expect(Math.abs(changed.halfHeight-lifted.camera.halfHeight)).toBeLessThan(.001);
});

describe('maximum-tilt drag navigation', () => {
  for (const bearingRadians of [0, Math.PI / 2, -2.4]) {
    it(`bounds each step and reverses without drift at bearing ${bearingRadians}`, () => {
      const start = { centerX: 86.925, centerY: 27.9881, halfHeight: .02, halfWidth: .04, bearingRadians };
      let last = start;
      // This trajectory crosses the visible horizon and returns through the
      // original click-slop area. It must not switch roots, stall or zoom.
      for (const dy of [...Array.from({length:81},(_,i)=>i*.02), ...Array.from({length:81},(_,i)=>(80-i)*.02)]) {
        const next = panTilt(GEO, start, MAX_TILT, 0, dy, FRAME);
        expect(Math.hypot((next.centerX-last.centerX)*Math.cos(start.centerY*Math.PI/180),next.centerY-last.centerY)).toBeLessThanOrEqual(start.halfHeight*.02/Math.cos(MAX_TILT)+1e-10);
        expect(next.halfHeight).toBe(start.halfHeight);
        expect(next.bearingRadians).toBe(bearingRadians);
        last=next;
      }
      expect(last.centerX).toBeCloseTo(start.centerX, 10);
      expect(last.centerY).toBeCloseTo(start.centerY, 10);
      expect(panTilt(GEO,start,MAX_TILT,0,.01,FRAME)).not.toEqual(start);
    });
  }
});

it('screen directions remain consistent through quarter and half turns',()=>{
  for(const bearingRadians of [0,Math.PI/2,Math.PI]){
    const start={centerX:86.925,centerY:27.9881,halfHeight:.02,halfWidth:.04,bearingRadians};
    const moved=panTilt(GEO,start,MAX_TILT,.001,.001,FRAME);
    const projected=mapProject(GEO,withTilt(GEO,moved,MAX_TILT),start.centerY,start.centerX)!;
    expect(projected.x).toBeGreaterThan(0);expect(projected.y).toBeGreaterThan(0);
    expect(projected.x).toBeCloseTo(.001,4);expect(projected.y).toBeCloseTo(.001,4);
  }
});
it('polar and dateline edge motion stays bounded and reversing the same drag recovers its start',()=>{
  for(const centerY of [-89,89]){
    const start={centerX:179.9,centerY,halfHeight:.2,halfWidth:.4,bearingRadians:.7};
    const moved=panTilt(GEO,start,MAX_TILT,2,2,FRAME);
    expect(Number.isFinite(moved.centerX)).toBe(true);expect(Math.abs(moved.centerY)).toBeLessThanOrEqual(90);
    const returned=panTilt(GEO,start,MAX_TILT,0,0,FRAME);
    expect(returned.centerY).toBe(start.centerY);expect(returned.centerX).toBeCloseTo(start.centerX,8);
  }
});
