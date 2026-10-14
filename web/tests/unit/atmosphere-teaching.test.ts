import { describe, expect, it } from 'vitest';
import {
  RIDGE_A,
  RIDGE_H,
  sampleTeachingAtmosphere,
  type TeachingAtmosphereContext,
  type TeachingScenario,
} from '../../src/lib/atmosphere-teaching';

const anchor = { lat: -31.95, lon: 115.86 };
const context = (kind: TeachingScenario, timeMs = Date.UTC(2026, 0, 15, 6)): TeachingAtmosphereContext => ({
  ...anchor,
  kind,
  groundM: 20,
  timeMs,
});
const point = (xM: number, yM = 0, zM = 500) => ({
  lat: anchor.lat + yM / 111_320,
  lon: anchor.lon + xM / (111_320 * Math.cos(anchor.lat * Math.PI / 180)),
  heightM: 20 + zM,
});
function sampleLocal(c: TeachingAtmosphereContext, x: number, y: number, z: number) {
  return sampleTeachingAtmosphere(c, c.lat + y / 111_320, c.lon + x / (111_320 * Math.cos(c.lat * Math.PI / 180)), c.groundM + z);
}
function divergence(c: TeachingAtmosphereContext, x: number, y: number, z: number) {
  const h = 10;
  const xp = sampleLocal(c, x + h, y, z), xm = sampleLocal(c, x - h, y, z);
  const yp = sampleLocal(c, x, y + h, z), ym = sampleLocal(c, x, y - h, z);
  const zp = sampleLocal(c, x, y, z + h), zm = sampleLocal(c, x, y, z - h);
  return (xp.u - xm.u + yp.v - ym.v) / (2 * h) + (zp.w - zm.w) / (2 * h);
}

describe('synthetic teaching atmosphere', () => {
  it('keeps every public quantity finite and closes the sea-breeze floor/lid', () => {
    const c = context('sea-breeze');
    for (const heightM of [20, 500, 2500, -10]) {
      const s = sampleTeachingAtmosphere(c, anchor.lat, anchor.lon, heightM);
      for (const value of Object.values(s)) expect(Number.isFinite(value)).toBe(true);
      if (heightM <= 20) expect([s.u, s.v, s.w, s.cloudPct]).toEqual([0, 0, 0, 0]);
    }
    const lid = sampleTeachingAtmosphere(c, anchor.lat, anchor.lon, 2520);
    expect(Math.hypot(lid.u, lid.v, lid.w)).toBeLessThan(1e-8);
  });

  it('gives the Perth sea breeze its four directional branches', () => {
    const c = context('sea-breeze');
    const ocean = sampleTeachingAtmosphere(c, point(-35_000).lat, point(-35_000).lon, 20 + 450);
    const land = sampleTeachingAtmosphere(c, point(35_000).lat, point(35_000).lon, 20 + 450);
    const returnFlow = sampleTeachingAtmosphere(c, anchor.lat, anchor.lon, 20 + 1850);
    expect(ocean.u).toBeGreaterThan(0); // lower onshore flow, west -> east
    expect(land.w).toBeGreaterThan(0); // rising on land side
    expect(ocean.w).toBeLessThan(0); // sinking over ocean side
    expect(returnFlow.u).toBeLessThan(0); // upper offshore return
  });

  it('has a convergent low-level and divergent upper thunderstorm cell', () => {
    const c = context('thunderstorm');
    const centreLow = sampleTeachingAtmosphere(c, anchor.lat, anchor.lon, 20 + 1200);
    const cloudLayer = sampleTeachingAtmosphere(c, anchor.lat, anchor.lon, 20 + 3000);
    const centreUpper = sampleTeachingAtmosphere(c, anchor.lat, anchor.lon, 20 + 7500);
    const lowEast = sampleTeachingAtmosphere(c, point(15_000).lat, point(15_000).lon, 20 + 1200);
    const upperEast = sampleTeachingAtmosphere(c, point(15_000).lat, point(15_000).lon, 20 + 7500);
    expect(centreLow.w).toBeGreaterThan(0);
    expect(lowEast.u).toBeLessThan(0); // low-level air converges toward centre
    expect(upperEast.u).toBeGreaterThan(0); // upper-level air diverges outward
    expect(centreUpper.w).toBeGreaterThan(0);
    expect(cloudLayer.cloudPct).toBeGreaterThan(0); // cloud follows parcel displacement
  });

  it('gives the idealised ridge linear-wave physics: kinematic ground, lee waves, cap cloud', () => {
    const c=context('mountain-wave');
    const U=16+1.2*Math.sin(2*Math.PI*((c.timeMs+c.lon*240_000)/86_400_000-.25));
    const h=(x:number)=>RIDGE_H*RIDGE_A**2/(x*x+RIDGE_A**2);
    for(const x of [-2400,-1200,1200,2400]){
      const expected=U*(h(x+1)-h(x-1))/2, s=sampleLocal(c,x,0,0);
      expect(Math.abs(s.w-expected)/Math.abs(expected)).toBeLessThan(.12);
    }
    let up=0,down=0;
    for(let x=2000;x<=40_000;x+=500)for(const z of [1500,3000,4500]){up+=Math.abs(sampleLocal(c,-x,0,z).w);down+=Math.abs(sampleLocal(c,x,0,z).w);}
    expect(down/up).toBeGreaterThan(2.5);
    // Cloud only where the moist low layer is lifted over the crest.
    expect(sampleLocal(c,0,0,0).cloudPct).toBeGreaterThan(0);
    expect(sampleLocal(c,1200,0,0).cloudPct).toBe(0);
    expect(sampleLocal(c,-3000,0,0).cloudPct).toBe(0);
  });

  it('keeps analytic cells nearly divergence-free and masks every scenario lid', () => {
    for (const kind of ['circulation', 'sea-breeze', 'thunderstorm', 'mountain-wave'] as TeachingScenario[]) {
      const c = context(kind);
      const z = kind === 'thunderstorm' ? 4200 : kind === 'mountain-wave' ? 4200 : 1200;
      expect(Math.abs(divergence(c, kind === 'mountain-wave' ? 3000 : 6000, 1800, z))).toBeLessThan(2e-5);
      const lid = kind === 'thunderstorm' || kind === 'circulation' ? 10_000 : kind === 'mountain-wave' ? 12_000 : 2500;
      const above = sampleLocal(c, 6000, 1800, lid + 100);
      expect(Math.hypot(above.u, above.v, above.w)).toBe(0);
      expect(above.cloudPct).toBe(0);
    }
  });

  it('is deterministic for fixed anchors and changes only with explicit time', () => {
    const c = context('sea-breeze', Date.UTC(2026, 0, 15, 9));
    const p = point(12_000, 4000, 800);
    const first = sampleTeachingAtmosphere(c, p.lat, p.lon, p.heightM);
    const second = sampleTeachingAtmosphere(c, p.lat, p.lon, p.heightM);
    expect(second).toEqual(first);
    const later = sampleTeachingAtmosphere(context('sea-breeze', c.timeMs + 12 * 60 * 60 * 1000), p.lat, p.lon, p.heightM);
    expect(later.u).not.toBe(first.u);
  });
});
