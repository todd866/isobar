import { describe, expect, it } from "vitest";
import { createMountainFlowField } from "../../src/lib/mountain-flow-field";
const terrain = (lon: number, lat: number) =>
  5000 + Math.max(0, 1 - Math.abs(lon - 86.88) / 0.01) * 1800;
const wet = {
  lat: 28,
  lon: 86.9,
  heightM: 7000,
  u: 18,
  v: 0,
  w: 0,
  temperatureC: 4,
  rhPct: 94,
  pressureHPa: 650,
  stabilityN2: 0.0004,
};
const dry = { ...wet, rhPct: 20 };
describe("mountain flow field", () => {
  it("flows over an upwind ridge and condenses wet air", () => {
    const field = createMountainFlowField(
      [wet, { ...wet, heightM: 6000 }],
      terrain,
    );
    const sample = field(28, 86.885, 7000);
    expect(sample).not.toBeNull();
    expect(sample!.liftM).toBeGreaterThan(0);
    expect(sample!.condensateGKg).toBeGreaterThan(0);
  });
  it("shares the same terrain wave while dry air stays clear", () => {
    const field = createMountainFlowField(
      [dry, { ...dry, heightM: 6000 }],
      terrain,
    );
    const sample = field(28, 86.885, 7000);
    expect(sample).not.toBeNull();
    expect(sample!.liftM).toBeGreaterThan(0);
    expect(sample!.condensateGKg).toBe(0);
    expect(Number.isFinite(sample!.w)).toBe(true);
  });
  it("interpolates vertical levels and rejects missing physical columns", () => {
    const low = { ...wet, heightM: 6000, temperatureC: 8 },
      high = { ...wet, heightM: 7000, temperatureC: -2 };
    const field = createMountainFlowField([low, high], () => 5000);
    expect(field(28, 86.9, 6500)!.temperatureC).toBeCloseTo(3);
    expect(
      createMountainFlowField(
        [{ ...wet, temperatureC: undefined }],
        () => 5000,
      )(28, 86.9, 6000),
    ).toBeNull();
  });
  it("returns null below terrain and outside bounded column coverage", () => {
    const field = createMountainFlowField([wet], () => 7000);
    expect(field(28, 86.9, 7040)).toBeNull();
    expect(field(28.1, 87.1, 6000)).toBeNull();
  });
});

describe("mountain flow cache and wave phase", () => {
  it("preserves a downstream wave phase in vertical wind", () => {
    const field = createMountainFlowField(
      [{ ...wet, heightM: 6000 }, wet],
      terrain,
    );
    const sample = field(28, 86.885, 7000);
    expect(sample).not.toBeNull();
    expect(Number.isFinite(sample!.w)).toBe(true);
    expect(sample!.w).not.toBe(0);
  });
  it("rejects a column with a missing vertical wind component", () => {
    const field = createMountainFlowField([{ ...wet, w: null }], terrain);
    expect(field(28, 86.9, 6000)).toBeNull();
  });
});

it('keeps identical wind paths when moisture changes, but changes condensation',()=>{
 const columns=[{...wet,heightM:6000},wet,{...wet,heightM:8500}];
 const moist=createMountainFlowField(columns,terrain);
 const arid=createMountainFlowField(columns.map(v=>({...v,rhPct:10})),terrain);
 let condensed=0;
 for(let lon=86.88;lon<86.91;lon+=.002){
  const a=moist(28,lon,7200),b=arid(28,lon,7200);
  if(!a||!b)continue;
  expect(a.w).toBeCloseTo(b.w,10);expect(a.u).toBe(b.u);
  expect(b.density).toBe(0);if(a.density>0)condensed++;
 }
 expect(condensed).toBeGreaterThan(0);
});
it('does not manufacture mountains from missing terrain',()=>{
 const field=createMountainFlowField([wet],()=>null);
 expect(field(28,86.9,7000)).toBeNull();
});
