import { describe, expect, it } from 'vitest';
import { createTiltCamera, forwardProject, inverseAtAltitude, inverseUnproject, EARTH_RADIUS_M, TILT_CAMERA_GLSL } from '../../src/lib/tilt-camera';

const closeLon = (a: number, b: number) => Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
const expectRoundTrip = (tiltRadians: number, halfHeightDeg = 45) => {
  const camera = createTiltCamera({ lat: -31.95, lon: 115.86, halfHeightDeg, aspect: 16 / 9, tiltRadians });
  for (const [lat, lon] of [[-31.95, 115.86], [-20, 120], [-40, 110], [10, -179.5], [10, 179.5]]) {
    const point = forwardProject(camera, lat, lon);
    if (!point?.visible || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const back = inverseUnproject(camera, point.x, point.y);
    expect(back?.lat).toBeCloseTo(lat, 5);
    expect(closeLon(back?.lon ?? NaN, lon)).toBeLessThan(1e-4);
  }
};

describe('tilt camera', () => {
  it('matches centered equirectangular coordinates exactly at zero tilt', () => {
    const camera = createTiltCamera({ lat: 0, lon: 0, halfHeightDeg: 90, aspect: 2, tiltRadians: 0 });
    expect(forwardProject(camera, 45, 90)).toMatchObject({ x: 0.5, y: 0.5, visible: true });
    expect(inverseUnproject(camera, 0.5, 0.5)).toMatchObject({ lat: 45, lon: 90 });
    const southern = createTiltCamera({ lat: -30, lon: 120, halfHeightDeg: 30, aspect: 2, tiltRadians: 0 });
    const flat = forwardProject(southern, -15, 150)!;
    expect(flat.x).toBeCloseTo(0.5, 8);
    expect(inverseUnproject(southern, flat.x, flat.y)?.lon).toBeCloseTo(150, 8);
  });

  it('round-trips regional and partial/full perspective views', () => {
    expectRoundTrip(0.01);
    expectRoundTrip(35 * Math.PI / 180, 30);
    expectRoundTrip(75 * Math.PI / 180, 65);
  });

  it('preserves focal location and central scale through tilt', () => {
    for (const tilt of [0, 0.01, 20 * Math.PI / 180, 75 * Math.PI / 180]) {
      const camera = createTiltCamera({ lat: -31.95, lon: 115.86, halfHeightDeg: 30, aspect: 1.5, tiltRadians: tilt });
      const focal = forwardProject(camera, camera.lat, camera.lon);
      expect(focal?.x).toBeCloseTo(0, 8);
      expect(focal?.y).toBeCloseTo(0, 8);
      expect(focal?.visible).toBe(true);
      expect(camera.geometry.physicalScaleMPerClip).toBeCloseTo(EARTH_RADIUS_M * 30 * Math.PI / 180, 4);
    }
  });

  it('changes Perth-scale world pixels continuously at a small nonzero tilt', () => {
    const flat = createTiltCamera({ lat: -31.95, lon: 115.86, halfHeightDeg: 8, aspect: 1.6, tiltRadians: 0 });
    const slight = createTiltCamera({ lat: -31.95, lon: 115.86, halfHeightDeg: 8, aspect: 1.6, tiltRadians: 2 * Math.PI / 180 });
    const a = forwardProject(flat, -31.5, 116.2)!;
    const b = forwardProject(slight, -31.5, 116.2)!;
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(0.01);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(0);
  });

  it('culls the backface and handles dateline continuity', () => {
    const camera = createTiltCamera({ lat: 0, lon: 179.8, halfHeightDeg: 70, aspect: 1, tiltRadians: 75 * Math.PI / 180 });
    expect(forwardProject(camera, 0, -179.8)?.visible).toBe(true);
    const back = forwardProject(camera, 0, 0);
    expect(back?.visible).toBe(false);
    const focal = inverseUnproject(camera, 0, 0);
    expect(focal?.lat).toBeCloseTo(0, 8);
    expect(closeLon(focal?.lon ?? NaN, 179.8)).toBeLessThan(1e-8);
  });

  it('supports inverse intersection at a true altitude', () => {
    const camera = createTiltCamera({ lat: -32, lon: 116, halfHeightDeg: 40, aspect: 1.6, tiltRadians: 55 * Math.PI / 180 });
    const p = forwardProject(camera, -31, 117, 3000);
    const back = p && inverseAtAltitude(camera, p.x, p.y, 3000);
    expect(back?.lat).toBeCloseTo(-31, 5);
    expect(back?.lon).toBeCloseTo(117, 5);
  });

  it('keeps a regional aircraft altitude physical below 10 km', () => {
    const camera = createTiltCamera({ lat: -31.95, lon: 115.86, halfHeightDeg: 5, aspect: 1.6, tiltRadians: 35 * Math.PI / 180 });
    const ground = forwardProject(camera, -31.8, 116.1, 0)!;
    const aircraft = forwardProject(camera, -31.8, 116.1, 8000)!;
    expect(Math.abs(aircraft.x - ground.x) + Math.abs(aircraft.y - ground.y)).toBeGreaterThan(0);
    const back = inverseAtAltitude(camera, aircraft.x, aircraft.y, 8000);
    expect(back?.lat).toBeCloseTo(-31.8, 4);
    expect(back?.lon).toBeCloseTo(116.1, 4);
  });

  it('shows an elevated object seen from below its shell, but not through Earth', () => {
    const camera = createTiltCamera({lat:0,lon:0,halfHeightDeg:.02,aspect:1.6,tiltRadians:1.2});
    const near = forwardProject(camera, .1, 0, 3000)!;
    expect(near.depth).toBeGreaterThan(0);
    expect(near.visible).toBe(true);
    expect(forwardProject(camera, 0, 180, 3000)?.visible).toBe(false);
  });

  it('exports shader math for the matching sphere ray', () => {
    expect(TILT_CAMERA_GLSL).toContain('variableGeo');
    expect(TILT_CAMERA_GLSL).toContain('6371000.0');
  });
});
