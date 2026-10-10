import { describe, expect, it } from 'vitest';
import { australiaAspects, cameraInside, clampToData, fitAustralia, frameData, insetBox, panBy, showsAustralia, zoomAbout, zoomWithinData, ZOOM_IN_LIMIT } from '../../src/lib/camera';
import { australiaLambert, globalEquirectangular, unproject } from '../../src/lib/lambert';

const GEO = australiaLambert();
const GRID = { west: 95, east: 170, south: -50, north: 0 };
const BOX = insetBox(GRID, 0.75);

describe('camera framing inside the data grid', () => {
  it('focuses global home on the selected place while retaining world extent', () => {
    const geo = globalEquirectangular();
    const box = { west: -180, east: 179.5, south: -90, north: 90 };
    const sydney = frameData(geo, 1000, 600, box, { lat: -33.9, lon: 151.2 });
    const perth = frameData(geo, 1000, 600, box, { lat: -31.95, lon: 115.86 });
    expect(sydney.home.centerX).not.toBeCloseTo(perth.home.centerX, 3);
    expect(sydney.home.centerY).toBeCloseTo(-33.9, 6);
    expect(sydney.widest).toEqual(perth.widest);
    expect(frameData(geo, 1000, 600, box, { lat: -100, lon: 151.2 }).home.centerY).toBeGreaterThan(-90);
  });
  for (const [width, height] of [[1320, 645], [920, 520], [361, 470], [393, 300], [1600, 400], [300, 900]]) {
    it(`keeps every edge inside the data at ${width}x${height}`, () => {
      const frame = frameData(GEO, width, height, BOX);
      expect(cameraInside(GEO, frame.home, BOX)).toBe(true);
      expect(cameraInside(GEO, frame.widest, BOX)).toBe(true);
      expect(frame.home.halfWidth / frame.home.halfHeight).toBeCloseTo(width / height, 5);
      expect(frame.home.halfWidth).toBeLessThanOrEqual(fitAustralia(width, height).halfWidth + 1e-9);
      const corner = unproject(GEO, frame.home.centerX - frame.home.halfWidth, frame.home.centerY - frame.home.halfHeight);
      expect(corner && corner.lat >= BOX.south && corner.lon >= BOX.west).toBe(true);
    });
  }

  it('frames all of Australia across the panel aspects the map allows', () => {
    const { min, max } = australiaAspects(GEO, BOX);
    expect(min).toBeLessThan(0.95);
    expect(max).toBeGreaterThan(1.35);
    for (const aspect of [min, (min + max) / 2, 1, max]) {
      const frame = frameData(GEO, 800 * aspect, 800, BOX);
      expect(showsAustralia(GEO, frame.home)).toBe(true);
      expect(cameraInside(GEO, frame.home, BOX)).toBe(true);
    }
    expect(showsAustralia(GEO, frameData(GEO, 1600, 800, BOX).home)).toBe(false);
  });

  it('clamps pans and zoom-outs back inside', () => {
    const frame = frameData(GEO, 1320, 645, BOX);
    let camera = frame.home;
    for (let k = 0; k < 30; k += 1) camera = clampToData(GEO, panBy(camera, 0.3, 0.2), frame);
    expect(cameraInside(GEO, camera, BOX)).toBe(true);
    camera = clampToData(GEO, zoomAbout(GEO, camera, 0.5, 0.5, 4), frame);
    expect(cameraInside(GEO, camera, BOX)).toBe(true);
    expect(camera.halfWidth).toBeLessThanOrEqual(frame.widest.halfWidth + 1e-9);
  });

  it('keeps the pinch point fixed at the zoom-in limit and respects coverage when zooming out', () => {
    const frame = frameData(GEO, 1000, 700, BOX);
    const camera = zoomWithinData(GEO, frame.home, 0, 0, 1 / ZOOM_IN_LIMIT, frame);
    const point = unproject(GEO, camera.centerX + .6 * camera.halfWidth, camera.centerY - .3 * camera.halfHeight);
    const next = zoomWithinData(GEO, camera, .6, -.3, .5, frame);
    expect(next.halfWidth).toBeCloseTo(camera.halfWidth, 9);
    const anchored = unproject(GEO, next.centerX + .6 * next.halfWidth, next.centerY - .3 * next.halfHeight);
    expect(anchored?.lat).toBeCloseTo(point!.lat, 10);
    expect(anchored?.lon).toBeCloseTo(point!.lon, 10);
    const wide = zoomWithinData(GEO, next, .9, .9, 100, frame);
    expect(cameraInside(GEO, wide, BOX)).toBe(true);
    expect(wide.halfWidth).toBeCloseTo(frame.widest.halfWidth, 9);
    expect(zoomWithinData(GEO, wide, 0, 0, NaN, frame)).toBe(wide);
  });
});
