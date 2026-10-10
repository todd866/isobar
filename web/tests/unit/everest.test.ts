import { describe,it,expect } from 'vitest';
import { everestAtmosphere } from '../../src/lib/everest';
import { historicalToChart } from '../../src/lib/history-chart';
import type { HistoricalWeather } from '../../src/lib/history';
const weather:HistoricalWeather={schema_version:1,product:'isobar-historical-weather',grid:{nx:2,ny:2,latitudes:[29,27],longitudes:[86,88],step_degrees:2},times:['1953-05-29T00:00Z','1953-05-29T01:00Z'],units:{u:'knots',v:'knots',pressure_msl:'hPa'},frames:[0,1].map(hour=>({time:`1953-05-29T0${hour}:00Z`,pressure_msl:[1010,1010,1010,1010],u:Array(4).fill(10+hour*10),v:[0,0,0,0]}))};
const chart=historicalToChart(weather,{rings:[]},'everest-1953');
const time=Date.parse(weather.times[0]);
describe('Everest reconstructed atmosphere',()=>{
 it('uses historical wind and changes with selected hour',()=>{
   const a=everestAtmosphere(chart,time,()=>5000).at(28,87,6000)!;
   const b=everestAtmosphere(chart,time+3600000,()=>5000).at(28,87,6000)!;
   expect(b.u).toBeGreaterThan(a.u*1.6); expect(a.w).toBe(0);
   expect(everestAtmosphere(chart,time,()=>5000).at(28,87,6000)!.u).toBe(a.u);
 });
 it('masks absent terrain and below-ground air',()=>{
   expect(everestAtmosphere(chart,time,null).profile(28,87)).toBeNull();
   expect(everestAtmosphere(chart,time,()=>8000).at(28,87,7000)).toBeNull();
   expect(everestAtmosphere(chart,time,()=>5000).profile(0,0)).toBeNull();
 });
 it('bounds terrain deflection and generates only above-ground profiles',()=>{
   const model=everestAtmosphere(chart,time,(lon)=>5000+(lon-87)*100000);
   expect(Math.abs(model.at(28,87,5200)!.w)).toBeLessThanOrEqual(3);
   const profile=model.profile(28,87)!;
   expect(profile.series.levels.every(l=>l.z[0]>5000)).toBe(true);
   expect(profile.provenance.model).toBe('everest-terrain-v2');
   expect(model.vectors(28,87,.03,2).length).toBeLessThanOrEqual(900);
 });
 it('keeps flat terrain symmetric and turns flow around a slope',()=>{
   const flat=everestAtmosphere(chart,time,()=>5000);
   const level=flat.at(28,87,6000)!;
   expect(level.w).toBe(0);
   const uphill=everestAtmosphere(chart,time,(lon)=>5000+(lon-87)*100000).at(28,87,6000)!;
   const downhill=everestAtmosphere(chart,time,(lon)=>5000-(lon-87)*100000).at(28,87,6000)!;
   expect(uphill.w).not.toBeCloseTo(level.w,5);
   expect(downhill.u).not.toBeCloseTo(uphill.u,5);
   for(const field of [uphill.u,uphill.v,uphill.w,downhill.u,downhill.v,downhill.w]) expect(Number.isFinite(field)).toBe(true);
 });
 it('has bounded multiscale gusts and coherent time evolution',()=>{
   const model=everestAtmosphere(chart,time,()=>5000);
   const now=model.at(28,87,6000)!;
   const later=everestAtmosphere(chart,time+1000,()=>5000).at(28,87,6000)!;
   const next=model.at(28,87,6000)!;
   expect(Math.abs(now.u-later.u)).toBeLessThan(.1); expect(now.u).toBe(next.u);
   expect(Math.hypot(now.u,now.v)).toBeLessThan(100);
   expect(Math.abs(now.w)).toBeLessThanOrEqual(3);
   expect(model.profile(28,87)!.series.levels.length).toBe(7);
 });
});
