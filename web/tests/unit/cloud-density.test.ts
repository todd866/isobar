import { describe, expect, it } from "vitest";
import {
  buildCloudDensityTexture,
  cloudDensityLimits,
} from "../../src/lib/cloud-density";
import { buildMountainWave } from "../../src/lib/mountain-wave";
import { createMountainWindField, layerBackground } from "../../src/lib/mountain-wind";

const bounds = {
  west: 86.75,
  east: 87.05,
  south: 27.85,
  north: 28.15,
  minHeight: 4000,
  maxHeight: 9000,
};
const vector = { lat: 28, lon: 86.9, heightM: 6500, u: 4, v: 1, cloudPct: 80 };

describe("cloud density texture", () => {
  it("is repeatable and bounded", () => {
    const a = buildCloudDensityTexture([vector], { bounds });
    const b = buildCloudDensityTexture([vector], { bounds });
    expect(a.density).toEqual(b.density);
    expect(a.terrain.length).toBe(64 * 64);
    expect(a.density.byteLength + a.terrain.byteLength).toBeLessThanOrEqual(
      cloudDensityLimits.maxBytes,
    );
  });
  it("masks density below sampled terrain and stores terrain texture", () => {
    const result = buildCloudDensityTexture([vector], {
      bounds,
      terrain: (lat) => (lat > 28 ? 7000 : 4500),
    });
    expect(result.terrain.some((height) => height === 7000)).toBe(true);
    expect(result.density.some((value) => value > 0)).toBe(true);
    expect(
      result.density.some((value, index) => {
        const z = Math.floor(index / (result.width * result.height));
        const y = Math.floor(
          (index % (result.width * result.height)) / result.width,
        );
        const lat =
          bounds.south +
          ((y + 0.5) / result.height) * (bounds.north - bounds.south);
        const altitude =
          bounds.minHeight +
          ((z + 0.5) / result.depth) * (bounds.maxHeight - bounds.minHeight);
        return lat > 28 && altitude <= 7000 && value > 0;
      }),
    ).toBe(false);
  });
  it("produces nonuniform 3D lobes and ignores nonfinite observations", () => {
    const result = buildCloudDensityTexture(
      [
        vector,
        { ...vector, lat: Number.NaN },
        { ...vector, cloudPct: Number.POSITIVE_INFINITY },
      ],
      { bounds },
    );
    const values = Array.from(result.density);
    expect(new Set(values).size).toBeGreaterThan(3);
    expect(values.some((value) => value > 0)).toBe(true);
    expect(values.every(Number.isFinite)).toBe(true);
  });
  it("advects the same seeded volume with weather time", () => {
    const first=buildCloudDensityTexture([vector],{bounds,timeSeconds:0});
    const later=buildCloudDensityTexture([vector],{bounds,timeSeconds:120});
    expect(later.density).not.toEqual(first.density);
    expect(later.terrain).toEqual(first.terrain);
    expect(buildCloudDensityTexture([{...vector,u:0,v:0}],{bounds,timeSeconds:120}).density)
      .toEqual(buildCloudDensityTexture([{...vector,u:0,v:0}],{bounds,timeSeconds:0}).density);
  });
  it("rejects oversized regions and dimensions", () => {
    expect(() =>
      buildCloudDensityTexture([vector], { bounds: { ...bounds, east: 88 } }),
    ).toThrow(/0.5/);
    expect(() =>
      buildCloudDensityTexture([vector], {
        bounds,
        width: 256,
        height: 256,
        depth: 256,
      }),
    ).toThrow(/250/);
  });
});

describe('terrain-driven condensation',()=>{
  const region={west:86.85,east:86.95,south:27.95,north:28.05,minHeight:5000,maxHeight:10000};
  const terrain=(lat:number,lon:number)=>5000+2200*Math.exp(-(((lon-86.9)/.014)**2));
  const makeVectors=(rhPct:number)=>Array.from({length:7},(_,i)=>({lat:28,lon:86.9,heightM:5500+i*600,u:14,v:0,cloudPct:0,temperatureC:-8-i*3.6,rhPct,pressureHPa:520*Math.exp(-i*600/8000),stabilityN2:.00015}));
  it('forms cloud over a moist ridge only through the supplied wave field',()=>{
    // The ridge lifts air only via the mountain-wave solver's displacement.
    const nx=64,ny=64,heights=new Float32Array(nx*ny);
    for(let j=0;j<ny;j++)for(let i=0;i<nx;i++)heights[j*nx+i]=terrain(0,region.west+(region.east-region.west)*i/(nx-1));
    const field=(rh:number)=>{
      const bg=layerBackground(makeVectors(rh).map(v=>({hPa:v.pressureHPa,zM:v.heightM,tC:v.temperatureC,rh:v.rhPct,windKt:v.u/.514444,windFrom:270})),5000,9400)!;
      const wave=buildMountainWave({heights,nx,ny,bounds:region,U:bg.U,V:bg.V,N:bg.N,clipGround:false})!;
      return createMountainWindField(wave,bg,(lon,lat)=>terrain(lat,lon));
    };
    const options={bounds:region,terrain,width:24,height:16,depth:16};
    const wet=buildCloudDensityTexture([],{...options,flowSample:field(92)});
    const dry=buildCloudDensityTexture([],{...options,flowSample:field(8)});
    expect(wet.density.some(v=>v>40)).toBe(true);
    expect(dry.density.every(v=>v===0)).toBe(true);
    // Without a flow field the same moist column is not lifted by invented terrain heuristics.
    const still=buildCloudDensityTexture(makeVectors(92).map(v=>({...v,rhPct:80})),options);
    expect(still.density.every(v=>v===0)).toBe(true);
  });
  it('does not invent terrain lift over a flat plateau',()=>{
    const data=buildCloudDensityTexture(makeVectors(92),{bounds:region,terrain:()=>5000,width:16,height:12,depth:12});
    expect(data.density.every(v=>v===0)).toBe(true);
  });
});

it('uses the shared flow condensation rather than cloud-percentage decoration',()=>{
 const bounds={west:86.8,east:86.9,south:28,north:28.1,minHeight:5000,maxHeight:10000};
 const clear=buildCloudDensityTexture([],{bounds,width:8,height:8,depth:8,flowSample:()=>({density:0,u:10,v:0})});
 const wet=buildCloudDensityTexture([],{bounds,width:8,height:8,depth:8,flowSample:()=>({density:.8,u:10,v:0})});
 expect(clear.density.every(d=>d===0)).toBe(true);
 expect(wet.density.some(d=>d>0)).toBe(true);
});
