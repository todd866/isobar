import {describe,it,expect} from 'vitest';
import {everestUtm,exactImageryUv,imageryMapping,mappedImageryUv,imageryEdgeWeight,validateImageryReceipt,type ImageryReceipt} from '../../src/lib/terrain/imagery-material';
const receipt:ImageryReceipt={asset:'modern.png',projection:'EPSG:32645',native_pixel_size_m:10,acquisition_datetime:'2026-10-03T05:00:49Z',pixel_window:{width:2048,height:2048},utm_bounds_m:{west:480000,south:3090000,east:500480,north:3110480},geographic_bounds_wgs84:{west:86.795,south:27.935,east:87.005,north:28.125},attribution:'Copernicus Sentinel data 2026',sha256:'a'.repeat(64)};
describe('bounded modern terrain photography',()=>{
 it('maps UTM central meridian and equator without changing hemisphere or axis',()=>{
  expect(everestUtm(87,0)).toEqual([500000,0]);
  const uv=exactImageryUv({...receipt,utm_bounds_m:{west:490000,south:0,east:510000,north:20000}},87,0);
  expect(uv).toEqual([.5,1]);
  expect(everestUtm(86.925,27.9881)[0]).toBeCloseTo(492632,-2);
 });
 it('keeps cheap shader mapping within a tenth of a source pixel across the bounded crop',()=>{
  const m=imageryMapping(receipt),g=receipt.geographic_bounds_wgs84;
  for(let y=0;y<=20;y++)for(let x=0;x<=20;x++){
   const lon=g.west+(g.east-g.west)*x/20,lat=g.south+(g.north-g.south)*y/20;
   const a=mappedImageryUv(m,lon,lat),b=exactImageryUv(receipt,lon,lat);
   expect(Math.max(Math.abs(a[0]-b[0]),Math.abs(a[1]-b[1]))*2048).toBeLessThan(.1);
  }
 });
 it('keeps float32 shader arithmetic within a quarter of a source pixel',()=>{
  const m=imageryMapping(receipt),f=Math.fround,g=receipt.geographic_bounds_wgs84;
  const dot=(a:number[],b:number[])=>f(f(f(a[0]*b[0])+f(a[1]*b[1]))+f(a[2]*b[2]));
  for(let y=0;y<=20;y++)for(let x=0;x<=20;x++){
   const lon=g.west+(g.east-g.west)*x/20,lat=g.south+(g.north-g.south)*y/20;
   const dx=f(f(lon)-f(m.origin[0])),dy=f(f(lat)-f(m.origin[1]));
   const shader=(c:number[])=>f(dot(c.slice(0,3).map(f),[1,dx,dy])+dot(c.slice(3).map(f),[f(dx*dx),f(dx*dy),f(dy*dy)]));
   const uv=exactImageryUv(receipt,lon,lat);
   expect(Math.max(Math.abs(shader(m.u)-uv[0]),Math.abs(shader(m.v)-uv[1]))*2048).toBeLessThan(.25);
  }
 });
 it('fades all four borders and contributes nothing outside the crop',()=>{
  const m=imageryMapping(receipt);
  for(const [u,v] of [[0,.5],[1,.5],[.5,0],[.5,1],[-.1,.5],[.5,1.1]])expect(imageryEdgeWeight(m,u,v)).toBe(0);
  expect(imageryEdgeWeight(m,.5,.5)).toBe(1);
  expect(imageryEdgeWeight(m,m.edgeUv[0]/2,.5)).toBeCloseTo(.5);
 });
 it('rejects mismatched grids, excessive extent and missing acquisition provenance',()=>{
  for(const r of [{...receipt,projection:'EPSG:4326'},{...receipt,utm_bounds_m:{...receipt.utm_bounds_m,west:580000,east:600480}},{...receipt,acquisition_datetime:''},{...receipt,pixel_window:{width:4096,height:2048}},{...receipt,utm_bounds_m:{...receipt.utm_bounds_m,east:500000}},{...receipt,geographic_bounds_wgs84:{...receipt.geographic_bounds_wgs84,east:88}}])expect(()=>validateImageryReceipt(r)).toThrow();
 });
});
