import { describe, expect, it } from 'vitest';
import { frameData, cameraInside, clampToData } from '../../src/lib/camera';
import { globalEquirectangular, project, unproject } from '../../src/lib/lambert';
import { readManifest } from '../../src/lib/manifest';

const GEO = globalEquirectangular();

describe('global map projection', () => {
  it('round-trips foreign places and the dateline without infinities', () => {
    for (const [lat, lon] of [[51.5, -0.1], [-33.9, 151.2], [64.1, 179.75], [64.1, -179.75], [89, 0]]) {
      const point = project(GEO, lat, lon);
      expect(point).not.toBeNull();
      const back = unproject(GEO, point!.x, point!.y);
      expect(back?.lat).toBeCloseTo(lat, 8);
      expect(Math.abs((back!.lon - lon + 180) % 360 - 180)).toBeLessThan(1e-8);
    }
  });

  it('frames the complete world and keeps the vertical poles finite', () => {
    const frame = frameData(GEO, 1280, 640, { west: -179.5, east: 179.5, south: -90, north: 90 });
    expect(frame.home.centerX).toBe(0);
    expect(frame.home.halfWidth).toBeCloseTo(180, 8);
    expect(frame.home.halfHeight).toBe(90);
    expect(cameraInside(GEO, frame.home, frame.box)).toBe(true);
    expect(clampToData(GEO, { ...frame.home, centerX: 200, halfWidth: 400, halfHeight: 200 }, frame).halfWidth).toBe(180);
  });

  it('accepts the prescribed global schema-2 grid without adding a duplicate longitude', () => {
    const hours = [...Array.from({ length: 49 }, (_, i) => i * 3), 150, 156, 162, 168];
    const variable = { frames: hours.map((hour) => `frames/mslp/f${String(hour).padStart(3, '0')}.u16z`), encoding: 'shuffle-gzip', units: 'hPa', scale: 0.1, offset: 850, fill: 65535 };
    const source = {
      schema: 2, contract: 'isobar-web', run: '2026-10-08T00:00:00Z', generated: '2026-10-08T01:00:00Z', forecast_hours: hours,
      grid: { west: -180, east: 179.5, north: 90, south: -90, step: 0.5, nx: 720, ny: 361, dtype: 'uint16', wraps_longitude: true },
      variables: { mslp: variable, rain24: variable, t2m: { ...variable, units: 'C' }, wind: { ...variable, units: 'kt' } },
      places: [{ id: 'sydney', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.9, lon: 151.2, icao: 'YSSY' }],
      aviation: 'aviation.json', points: null, attribution: [{ source: 'ECMWF', licence: 'CC BY 4.0' }],
    };
    const manifest = readManifest(source);
    expect(manifest.wrapsLongitude).toBe(true);
    expect(manifest.nx * manifest.step).toBe(360);
    expect(manifest.east).toBeLessThan(180);
    expect(() => readManifest({ ...source, grid: { ...source.grid, north: 80, south: -100 } })).toThrow('global grid geometry');
    expect(() => readManifest({ ...source, forecast_hours: [0, 3, 6] })).toThrow('all 53');
  });
});
