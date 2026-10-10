import { describe, expect, it } from 'vitest';
import { frameData, type Camera } from '../../src/lib/camera';
import { globalEquirectangular, mapUnproject } from '../../src/lib/lambert';
import { anchorTilt, MAX_TILT, withTilt, zoomTilt } from '../../src/lib/tilt-navigation';

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
