import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compassFrom, dedupeNames, readingText, drawPlaces, regionalPlaces, DAY_PLACES, type PlaceRow } from '../../src/lib/places';

import { globalEquirectangular } from '../../src/lib/lambert';
import { withTilt } from '../../src/lib/tilt-navigation';

describe('town names', () => {
  it('keeps the larger of two same-name places and qualifies the smaller', () => {
    const out = dedupeNames([
      { name: 'Vancouver', region: 'BC' },
      { name: 'Seattle', region: 'WA' },
      { name: 'Vancouver', region: 'WA' },
    ]);
    expect(out.map((p) => p.label)).toEqual(['Vancouver', 'Seattle', 'Vancouver WA']);
  });

  it('drops a same-name place its region cannot tell apart', () => {
    const out = dedupeNames([
      { name: 'Springfield', region: 'IL' },
      { name: 'Springfield', region: 'IL' },
      { name: 'Springfield', region: '' },
      { name: 'Springfield', region: 'MO' },
    ]);
    expect(out.map((p) => p.label)).toEqual(['Springfield', 'Springfield MO']);
  });

  it('ships both Vancouvers, the Canadian one ranked first, with region codes', () => {
    const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '../../public/places/world-places.json'), 'utf8')) as PlaceRow[];
    const vancouvers = rows.filter((row) => row[0] === 'Vancouver');
    expect(vancouvers.map((row) => row[4])).toEqual(['BC', 'WA']);
    expect(rows.find((row) => row[0] === 'Perth' && row[4] === 'WA')).toBeTruthy();
    for (let i = 1; i < rows.length; i += 1) expect(rows[i][3]).toBeGreaterThanOrEqual(rows[i - 1][3]);
  });

  it('reads out the active lens like the Mac', () => {
    expect(readingText('temp', 16.4)).toBe('16°');
    expect(readingText('rain', 0.1)).toBeNull();
    expect(readingText('rain', 0.4)).toBe('1 mm');
    expect(readingText('rain', 3.2)).toBe('3 mm');
    expect(readingText('wind', 12.2, 'SW')).toBe('SW 12 kt');
    expect(readingText('wind', 12.2, null)).toBe('12 kt');
  });

  it('bounds label work and tests lake coverage only for on-screen candidates', () => {
    const ctx = { save() {}, restore() {}, measureText: () => ({ width: 24 }) } as unknown as CanvasRenderingContext2D;
    const rows: PlaceRow[] = [
      ...Array.from({ length: 1000 }, (_, i): PlaceRow => [`Distant ${i}`, 40, 120, 0, '']),
      ['West', 0, -6, 0, ''], ['Centre', 0, 0, 0, ''], ['East', 0, 6, 0, ''],
    ];
    const onWater = vi.fn(() => false), reading = vi.fn(() => '20°');
    const result = drawPlaces(ctx, rows, globalEquirectangular(), { centerX: 0, centerY: 0, halfWidth: 10, halfHeight: 5 },
      1000, 500, [], DAY_PLACES, reading, 1, true, onWater);
    expect(result.names).toEqual(['West  20°']);
    expect(reading).toHaveBeenCalledTimes(1);
    expect(onWater).toHaveBeenCalledTimes(3);
  });

  it('names where the wind blows from', () => {
    // u, v are the components the air moves toward: blowing toward the NE means from the SW.
    expect(compassFrom(5, 5)).toBe('SW');
    expect(compassFrom(0, -5)).toBe('N');
    expect(compassFrom(-5, 0)).toBe('E');
  });
});


describe('regional place selection', () => {
  it('does not project distant towns in a tilted close view', () => {
    const geo=globalEquirectangular();
    const camera=withTilt(geo,{centerX:116.1,centerY:-31.9,halfWidth:1,halfHeight:.6},.9);
    const project=vi.spyOn(camera.surface!, 'project');
    const ctx={save(){},restore(){},measureText:()=>({width:30})} as unknown as CanvasRenderingContext2D;
    drawPlaces(ctx,[['Perth',-31.9,116.1,1,''],['London',51.5,-.1,1,'']],geo,camera,1280,720,[],DAY_PLACES,null,40,true);
    expect(project).toHaveBeenCalledWith(-31.9,116.1,undefined);
    expect(project.mock.calls.some(([lat])=>lat===51.5)).toBe(false);
  });
  it('preserves rank, reuses nearby candidates, and refreshes when panned away', () => {
    const rows: PlaceRow[] = [['A', 1, 2, 1, ''], ['B', 1, 3, 2, ''], ['C', 1, 90, 3, '']];
    const a = regionalPlaces(rows, 0, 5, -2, 2);
    expect(a.map(r => r[0])).toEqual(['A', 'B']);
    expect(regionalPlaces(rows, 1, 6, -2, 2)).toBe(a);
    expect(regionalPlaces(rows, 88, 92, -2, 2).map(r => r[0])).toEqual(['C']);
  });
  it('retains seam towns across world copies, while excluding distant latitudes', () => {
    const rows: PlaceRow[] = [['A', 1, 179, 1, ''], ['B', 1, -179, 2, ''], ['C', 85, 179, 3, '']];
    expect(regionalPlaces(rows, 175, 185, -2, 2).map(r => r[0])).toEqual(['A', 'B']);
    expect(regionalPlaces(rows, 895, 905, -2, 2).map(r => r[0])).toEqual(['A', 'B']);
  });
});
