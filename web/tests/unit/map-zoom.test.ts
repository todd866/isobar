import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adminRankLimit, parseBorders } from '../../src/lib/borders';
import { fairChain } from '../../src/lib/overlay';
import { graticuleStep, graticuleText, readGraticule, writeGraticule } from '../../src/lib/graticule';
import { globalEquirectangular } from '../../src/lib/lambert';
import { placeRankLimit, type PlaceRow } from '../../src/lib/places';
import { centreWidthMetres, nice125, scaleBar, scaleUnit } from '../../src/lib/scale-bar';

describe('scale bar', () => {
  it('rounds to the nearest 1, 2 or 5 × 10^n', () => {
    expect(nice125(1)).toBe(1);
    expect(nice125(1.4)).toBe(1);
    expect(nice125(3)).toBe(2);
    expect(nice125(4)).toBe(5);
    expect(nice125(7)).toBe(5);
    expect(nice125(10)).toBe(10);
    expect(nice125(23)).toBe(20);
    expect(nice125(50)).toBe(50);
    expect(nice125(80)).toBe(100);
    expect(nice125(100)).toBe(100);
    expect(nice125(0.04)).toBeCloseTo(0.05);
  });

  it('picks a bar near the target and states nautical miles', () => {
    const metric = scaleBar(1_000_000, 1000, 'km', 100);
    expect(metric).toMatchObject({ primary: '100 km', nautical: '54 nm' });
    expect(metric!.px).toBeCloseTo(100, 0);
    const statute = scaleBar(1_000_000, 1000, 'mi', 100);
    expect(statute).toMatchObject({ primary: '50 mi', nautical: '43 nm' });
  });

  it('shrinks a degree of longitude toward the poles', () => {
    const geo = globalEquirectangular();
    const equator = centreWidthMetres(geo, { centerX: 0, centerY: 0, halfWidth: 1, halfHeight: 1 });
    const sixty = centreWidthMetres(geo, { centerX: 0, centerY: 60, halfWidth: 1, halfHeight: 1 });
    expect(equator).toBeGreaterThan(200_000);
    expect(sixty! / equator!).toBeCloseTo(0.5, 1);
  });

  it('uses kilometres for AUS and miles for US and statute-mile LOCAL', () => {
    expect(scaleUnit({ mode: 'aus', visibility: 'km' })).toBe('km');
    expect(scaleUnit({ mode: 'us', visibility: 'sm' })).toBe('mi');
    expect(scaleUnit({ mode: 'local', visibility: 'sm' })).toBe('mi');
    expect(scaleUnit({ mode: 'local', visibility: 'km' })).toBe('km');
  });
});

describe('graticule', () => {
  it('chooses 10, 5, 1 or 0.5 degrees from the shorter span', () => {
    expect(graticuleStep(80)).toBe(10);
    expect(graticuleStep(36)).toBe(10);
    expect(graticuleStep(35.9)).toBe(5);
    expect(graticuleStep(12)).toBe(5);
    expect(graticuleStep(11.9)).toBe(1);
    expect(graticuleStep(3)).toBe(1);
    expect(graticuleStep(2.9)).toBe(0.5);
    expect(graticuleStep(0.8)).toBe(0.5);
  });

  it('labels the edge with hemisphere, and leaves 0° and 180° unsigned', () => {
    expect(graticuleText(50, 'lat')).toBe('50°N');
    expect(graticuleText(-0.5, 'lat')).toBe('0.5°S');
    expect(graticuleText(0.5, 'lat')).toBe('0.5°N');
    expect(graticuleText(-120, 'lon')).toBe('120°W');
    expect(graticuleText(146.5, 'lon')).toBe('146.5°E');
    expect(graticuleText(0, 'lat')).toBe('0°');
    expect(graticuleText(180, 'lon')).toBe('180°');
    expect(graticuleText(-180, 'lon')).toBe('180°');
  });

  it('stays off until this browser turns it on', () => {
    const bag = new Map<string, string>();
    const storage = { getItem: (key: string) => bag.get(key) ?? null, setItem: (key: string, value: string) => { bag.set(key, value); } };
    expect(readGraticule(storage)).toBe(false);
    writeGraticule(storage, true);
    expect(readGraticule(storage)).toBe(true);
    writeGraticule(storage, false);
    expect(readGraticule(storage)).toBe(false);
  });
});

describe('place density', () => {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '../../public/places/world-places.json'), 'utf8')) as PlaceRow[];
  const kelowna = rows.find((row) => row[0] === 'Kelowna' && row[4] === 'BC');

  it('includes Kelowna on a 700 km desktop view', () => {
    expect(kelowna).toBeTruthy();
    const span = 700 / (6371 * Math.cos(48.2 * Math.PI / 180) * Math.PI / 180);
    expect(span).toBeGreaterThan(9);
    expect(span).toBeLessThan(10);
    expect(placeRankLimit(span, 1280)).toBeGreaterThanOrEqual(kelowna![3]);
    expect(placeRankLimit(16, 1200)).toBeGreaterThanOrEqual(kelowna![3]);
    expect(placeRankLimit(2, 1280)).toBeGreaterThan(placeRankLimit(40, 800));
  });
});

describe('isobar fairing', () => {
  it('keeps a straight run straight and rounds a long corner', () => {
    const straight = fairChain([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 140, y: 0 }], false);
    expect(straight[0]).toEqual({ x: 0, y: 0 });
    expect(straight.at(-1)).toEqual({ x: 140, y: 0 });
    for (const point of straight) if (point) expect(Math.abs(point.y)).toBeLessThan(0.01);
    const corner = fairChain([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], false).filter((point): point is { x: number; y: number } => !!point);
    expect(corner.some((point) => point.y > 12 && point.y < 40 && point.x < 99 && point.x > 70)).toBe(true);
    for (const point of corner) {
      expect(point.x).toBeGreaterThanOrEqual(-0.01);
      expect(point.x).toBeLessThanOrEqual(100.01);
      expect(point.y).toBeGreaterThanOrEqual(-0.01);
      expect(point.y).toBeLessThanOrEqual(100.01);
    }
    let longest = 0;
    for (let i = 1; i < corner.length; i += 1) {
      longest = Math.max(longest, Math.hypot(corner[i].x - corner[i - 1].x, corner[i].y - corner[i - 1].y));
    }
    expect(longest).toBeLessThan(30);
  });

  it('does not bridge a break', () => {
    const broken = fairChain([{ x: 0, y: 0 }, { x: 40, y: 0 }, null, { x: 80, y: 10 }, { x: 120, y: 10 }], false);
    expect(broken).toContain(null);
  });
});

describe('political borders', () => {
  const regional = parseBorders(new Uint8Array(fs.readFileSync(path.join(__dirname, '../../public/borders/regional.bin'))));
  const close = parseBorders(new Uint8Array(fs.readFileSync(path.join(__dirname, '../../public/borders/close.bin'))));
  const names = JSON.parse(fs.readFileSync(path.join(__dirname, '../../public/borders/names.json'), 'utf8')) as { name: string; lat: number; lon: number; rank: number }[];

  it('packs country, state and disputed lines, with British Columbia named', () => {
    expect(regional && regional.country.length).toBeGreaterThan(20);
    expect(regional && regional.state.length).toBeGreaterThan(20);
    expect(regional && regional.disputed.length).toBeGreaterThan(5);
    expect(close && close.country.length).toBeGreaterThan(regional!.country.length);
    const parallel = regional!.country.some((ring) => {
      for (let i = 0; i < ring.lon.length; i += 1) {
        if (Math.abs(ring.lat[i] - 49) < 0.2 && ring.lon[i] < -95 && ring.lon[i] > -123) return true;
      }
      return false;
    });
    expect(parallel).toBe(true);
    const bc = names.find((item) => item.name === 'British Columbia');
    expect(names.some((item) => item.name === 'Québec')).toBe(true);
    expect(bc?.rank).toBeLessThanOrEqual(3);
    expect(bc && bc.lat).toBeGreaterThan(48);
    expect(bc && bc.lon).toBeLessThan(-114);
    expect(parseBorders(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('hides state names until the view is close enough', () => {
    expect(adminRankLimit(40)).toBe(-1);
    expect(adminRankLimit(12)).toBe(3);
    expect(adminRankLimit(6)).toBe(6);
    expect(adminRankLimit(2)).toBe(10);
  });
});
