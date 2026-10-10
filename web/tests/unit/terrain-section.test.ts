import { describe, expect, it } from 'vitest';
import { pressureAltitudeMetres } from '../../src/lib/units';
import { lonToTileX, latToTileY, terrariumElevation } from '../../src/lib/terrain/terrarium';
import {
  elevationsAlong, modelGroundFromPressure, modelGroundLabel, resolveModelGroundM,
  sampleTiles, sectionTrack, sectionX, type DecodedTile,
} from '../../src/lib/point/terrain-section';
import { FT_PER_M } from '../../src/lib/sky/physics';
import { heightFraction, plotY, surfaceLabel } from '../../src/lib/point/sounding';

function encode(metres: number): [number, number, number] {
  const scaled = Math.round((metres + 32768) * 256);
  return [(scaled >> 16) & 255, (scaled >> 8) & 255, scaled & 255];
}

describe('terrain cross-section', () => {
  it('samples an east–west line through the point, ±25 km, with the tap at the centre', () => {
    const track = sectionTrack(27.9881, 86.925);
    expect(track).toHaveLength(101);
    expect(track[50].distanceKm).toBeCloseTo(0, 6);
    expect(track[50].lat).toBeCloseTo(27.9881, 6);
    expect(track[50].lon).toBeCloseTo(86.925, 6);
    expect(track[0].distanceKm).toBeCloseTo(-25, 5);
    expect(track[100].distanceKm).toBeCloseTo(25, 5);
    const kmPerDeg = 111.195 * Math.cos((27.9881 * Math.PI) / 180);
    expect(track[100].lon - track[0].lon).toBeCloseTo(50 / kmPerDeg, 3);
    const equator = sectionTrack(0, 0);
    expect(Math.abs(equator[100].lon - equator[0].lon)).toBeLessThan(Math.abs(sectionTrack(60, 10)[100].lon - sectionTrack(60, 10)[0].lon));
    const wrapped = sectionTrack(0, 179.95);
    expect(wrapped[100].lon).toBeLessThan(0);
    expect(wrapped[100].lon).toBeGreaterThan(-180);
  });

  it('keeps a mountain peaked at the tapped point and maps that peak to the middle of the axis', () => {
    const lat = 27.9881;
    const lon = 86.925;
    const track = sectionTrack(lat, lon);
    const kmPerDeg = 111.195 * Math.cos((lat * Math.PI) / 180);
    const samples = elevationsAlong(track, (sampleLon) => {
      const km = (sampleLon - lon) * kmPerDeg;
      return 8849 * Math.exp(-(km * km) / (2 * 8 * 8));
    });
    expect(samples[50].metres).toBeCloseTo(8849, 0);
    expect(samples[0].metres).toBeLessThan(200);
    expect(samples[100].metres).toBeLessThan(200);
    expect(sectionX(0, 360)).toBeCloseTo(180, 0);
    expect(sectionX(-25, 360)).toBeCloseTo(8, 0);
    expect(sectionX(25, 360)).toBeCloseTo(352, 0);
    const crest = plotY(heightFraction(samples[50].metres! * FT_PER_M, 0), 420);
    const edge = plotY(heightFraction(samples[0].metres! * FT_PER_M, 0), 420);
    expect(crest).toBeLessThan(edge - 40);
    expect(surfaceLabel(8849)).toBe('SFC 8,849 m / 29,032 ft');
    expect(surfaceLabel(20)).toBe('SFC 20 m / 66 ft');
    expect(surfaceLabel(null)).toBe('SFC');
  });

  it('reads terrarium pixels on the tile the relief layer uses', () => {
    const z = 4;
    const lon = 86.925;
    const lat = 27.9881;
    const x = Math.floor(lonToTileX(lon, z));
    const y = Math.floor(latToTileY(lat, z));
    const width = 8;
    const rgba = new Uint8ClampedArray(width * width * 4);
    for (let row = 0; row < width; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const [r, g, b] = encode(col * 1000);
        const i = (row * width + col) * 4;
        rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
        expect(terrariumElevation(r, g, b)).toBe(col * 1000);
      }
    }
    const tile: DecodedTile = { z, x, y, width, rgba };
    const west = lonToTileX(lon, z) - x;
    expect(west).toBeGreaterThan(0);
    expect(west).toBeLessThan(1);
    const at = sampleTiles([tile], lon, lat);
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThan(0);
    expect(at!).toBeLessThan(8000);
    const eastLon = lon + 0.4;
    if (Math.floor(lonToTileX(eastLon, z)) === x) {
      expect(sampleTiles([tile], eastLon, lat)!).toBeGreaterThan(at!);
    }
    expect(sampleTiles([tile], lon + 40, lat)).toBeNull();
  });

  it('derives model ground from surface pressure against MSLP, and prefers export orography', () => {
    expect(modelGroundFromPressure(1013.25, 1013.25)).toBeCloseTo(0, 3);
    expect(modelGroundFromPressure(500, 1013.25)).toBeCloseTo(pressureAltitudeMetres(500), 1);
    expect(modelGroundFromPressure(511.22, 1012)).toBeCloseTo(5400, 0);
    expect(modelGroundFromPressure(null, 1012)).toBeNull();
    expect(modelGroundFromPressure(1012, null)).toBeNull();
    expect(modelGroundFromPressure(50, 1012)).toBeNull();
    expect(modelGroundFromPressure(1012, 50)).toBeNull();
    expect(resolveModelGroundM(5400, 100)).toBe(5400);
    expect(resolveModelGroundM(null, 5400)).toBe(5400);
    expect(resolveModelGroundM(null, null)).toBeNull();
    expect(modelGroundLabel(5400)).toBe('model ground 5,400 m');
  });
});
