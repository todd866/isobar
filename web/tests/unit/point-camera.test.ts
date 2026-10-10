import { describe, expect, it } from 'vitest';
import { cameraInside, frameData, type DataFrame } from '../../src/lib/camera';
import { australiaLambert, cameraProject, globalEquirectangular, type Camera } from '../../src/lib/lambert';
import { cameraDuringMove, exposedMap, pointCamera, projectPoint, reframeCamera } from '../../src/lib/point/camera';

const geo = globalEquirectangular();
const map = { left: 12, top: 200, width: 366, height: 500 };
const sheet = { left: 12, top: 430, width: 366, height: 270 };
const box = { west: -180, east: 180, south: -90, north: 90 };
const frame = frameData(geo, map.width, map.height, box, { lat: -31, lon: 130 });

describe('point inspection camera', () => {
  it('pans a covered point to the centre above the sheet without changing scale', () => {
    const point = { lat: -35.28, lon: 149.13 };
    const visible = exposedMap(map, sheet, false);
    const target = pointCamera(geo, frame.home, frame, point, map, visible);
    const p = projectPoint(geo, point, target)!;
    const clip = cameraProject(target, p.x, p.y);
    expect(map.left + (clip.x + 1) * map.width / 2).toBeCloseTo(195);
    expect(map.top + (1 - clip.y) * map.height / 2).toBeCloseTo(315);
    expect(target.halfWidth).toBe(frame.home.halfWidth);
    expect(target.halfHeight).toBe(frame.home.halfHeight);
  });

  it('keeps DOMRect fields, which are prototype getters and do not survive a spread', () => {
    // getBoundingClientRect() returns a DOMRect. Its geometry is not an own
    // property, so a spread copy is empty.
    const rect = (left: number, top: number, width: number, height: number) => Object.create({
      get left() { return left; }, get top() { return top; }, get width() { return width; }, get height() { return height; },
    }) as { left: number; top: number; width: number; height: number };
    const map = rect(12, 200, 366, 500);
    expect(exposedMap(map, rect(300, 200, 400, 500), true)).toEqual({ left: 12, top: 200, width: 288, height: 500 });
    expect(exposedMap(map, rect(12, 430, 366, 270), false)).toEqual({ left: 12, top: 200, width: 366, height: 230 });
  });

  it('uses the actual intersection when a side panel extends beyond the map stage', () => {
    const visible = exposedMap(map, { left: 300, top: 200, width: 400, height: 500 }, true);
    expect(visible).toEqual({ ...map, width: 288 });
    expect(exposedMap(map, { left: 500, top: 200, width: 400, height: 500 }, true)).toEqual(map);
    const target = pointCamera(geo, frame.home, frame, { lat: -31, lon: 130 }, map, visible);
    const p = projectPoint(geo, { lat: -31, lon: 130 }, target)!;
    const clip = cameraProject(target, p.x, p.y);
    expect(map.left + (clip.x + 1) * map.width / 2).toBeCloseTo(156);
    expect(clip.y).toBeCloseTo(0);
  });

  it('keeps edge selections exposed even where the ordinary minimum zoom cannot centre them', () => {
    const au = australiaLambert();
    const regionalBox = { west: 107, east: 166, south: -46, north: -2 };
    const regional = frameData(au, map.width, map.height, regionalBox);
    for (const point of [{ lat: -35.28, lon: 149.13 }, { lat: -45.99, lon: 149 }, { lat: -25, lon: 165.99 }]) {
      const visible = exposedMap(map, sheet, false);
      const target = pointCamera(au, regional.home, regional, point, map, visible);
      const p = projectPoint(au, point, target)!;
      const clip = cameraProject(target, p.x, p.y);
      expect((clip.x + 1) * map.width / 2).toBeCloseTo(visible.width / 2);
      expect((1 - clip.y) * map.height / 2).toBeCloseTo(visible.height / 2);
      expect(cameraInside(au, target, regionalBox)).toBe(true);
    }
  });

  it('selects the nearby world copy on either side of the dateline', () => {
    for (const [centerX, lon, projected] of [[181, -179, 181], [-181, 179, -181], [541, -179, 541]]) {
      const camera = { ...frame.home, centerX };
      expect(projectPoint(geo, { lat: 0, lon }, camera)?.x).toBe(projected);
      const target = pointCamera(geo, camera, frame, { lat: 0, lon }, map, exposedMap(map, sheet, false));
      expect(target.centerX).toBe(projected);
    }
  });

  it('has exact endpoints, a monotonic 250 ms pan, and an immediate reduced-motion endpoint', () => {
    const from = frame.home, to = { ...from, centerX: from.centerX + 17.3, centerY: from.centerY - 3.9 };
    const move = { from, to, start: 1000, duration: 250 };
    expect(cameraDuringMove(move, 1000)).toEqual(from);
    expect(cameraDuringMove(move, 1250)).toEqual(to);
    const samples = Array.from({ length: 16 }, (_, i) => cameraDuringMove(move, 1000 + i * 250 / 15).centerX);
    expect(samples).toEqual([...samples].sort((a, b) => a - b));
    expect(samples[1] - samples[0]).toBeLessThan((to.centerX - from.centerX) / 10);
    expect(cameraDuringMove({ ...move, duration: 0 }, 1000)).toEqual(to);
  });

  it('glides with a 240 ms cubic ease-out that starts faster than it finishes', () => {
    const from = frame.home, to = { ...from, centerX: from.centerX + 17.3 };
    const move = { from, to, start: 1000, duration: 240, ease: 'out' as const };
    expect(cameraDuringMove(move, 1000)).toEqual(from);
    expect(cameraDuringMove(move, 1240)).toEqual(to);
    const samples = Array.from({ length: 16 }, (_, i) => cameraDuringMove(move, 1000 + i * 240 / 15).centerX);
    expect(samples).toEqual([...samples].sort((a, b) => a - b));
    const step = (index: number) => samples[index + 1] - samples[index];
    expect(step(0)).toBeGreaterThan(step(14));
    expect(step(0)).toBeGreaterThan((to.centerX - from.centerX) / 10);
  });

  it('restores the saved camera exactly, or rebases it to a resized frame without mutating it', () => {
    const saved: Camera = { ...frame.home, halfWidth: frame.home.halfWidth / 2, halfHeight: frame.home.halfHeight / 2 };
    const copy = { ...saved };
    expect(reframeCamera(geo, saved, frame, frame)).toEqual(copy);
    const landscape: DataFrame = frameData(geo, 844, 200, box, { lat: -31, lon: 130 });
    const resized = reframeCamera(geo, saved, frame, landscape);
    expect(resized.halfWidth / landscape.home.halfWidth).toBeCloseTo(.5);
    expect(resized.halfWidth / resized.halfHeight).toBeCloseTo(844 / 200);
    expect(reframeCamera(geo, resized, landscape, frame)).toEqual(copy);
    expect(saved).toEqual(copy);
  });
});
