import katrina from '../../../tools/history/katrina-track.json';
import {describe,it,expect} from 'vitest';
import {cycloneAt,cycloneShape,cycloneWind,cycloneScalar,validateCyclone,type HistoricalCyclone} from '../../src/lib/historical-cyclone';
import {cycloneContours,clipCycloneLines} from '../../src/lib/cyclone-contours';
const data:HistoricalCyclone={method:'compact-vortex-v1',rmwKm:11,source:'https://www.bom.gov.au/cyclone/history/tracy.shtml',track:[{time:'1974-12-24T18:00Z',lat:-12.4,lon:130.9,windKt:95,pressureHpa:950},{time:'1974-12-25T06:00Z',lat:-12.8,lon:132,windKt:35,pressureHpa:994}]};
const s=cycloneAt(data,Date.parse(data.track[0].time))!;
describe('compact cyclone reconstruction',()=>{
 it('has a resolved eye and compact gale envelope without inflating global grids',()=>{
  expect(cycloneScalar(s,s.lon,s.lat,1000,'mslp')).toBe(950);
  expect(cycloneShape(s,s.lon,s.lat).speed).toBe(0);
  expect(cycloneShape(s,s.lon,s.lat+11/111.132).speed).toBeCloseTo(95,5);
  expect(cycloneShape(s,s.lon,s.lat+50/111.132).speed).toBeGreaterThan(33);
  expect(cycloneShape(s,s.lon,s.lat+50/111.132).speed).toBeLessThan(35);
  expect(cycloneScalar(s,s.lon,s.lat+121/111.132,1002,'mslp')).toBe(1002);
  expect(cycloneWind(s,s.lon,s.lat+121/111.132,{u:3,v:4})).toEqual({u:3,v:4});
 });
 it('turns clockwise in the southern hemisphere with inward surface flow',()=>{
  const north=cycloneWind(s,s.lon,s.lat+11/111.132,{u:3,v:4})!;
  expect(north.u).toBeGreaterThan(0);expect(north.v).toBeLessThan(0);
  expect(Math.hypot(north.u,north.v)).toBeCloseTo(cycloneScalar(s,s.lon,s.lat+11/111.132,5,'wind')!,8);
 });
 it('moves and decays continuously; does not hold outside dated coverage',()=>{
  const half=cycloneAt(data,Date.parse(data.track[0].time)+6*3600000)!;
  expect(half.windKt).toBe(65);expect(half.pressureHpa).toBe(972);expect(half.lon).toBeCloseTo(131.45);
  expect(cycloneAt(data,Date.parse('1974-12-26'))).toBeNull();
 });
 it('draws closed core isobars and a matching low centre',()=>{
  const result=cycloneContours({lines:[],centres:[]},s,()=>1002);
  expect(result.centres[0].hpa).toBe(950);
  expect(cycloneContours({lines:[],centres:[]},{...s,pressureHpa:949.812345},()=>1002).centres[0].hpa).toBe(950);
  expect(result.lines.filter(l=>l.closed&&l.level<=980).length).toBeGreaterThan(8);
 });
 it('clips coarse segments crossing the core even with both endpoints outside',()=>{
  const line={level:1000,closed:false,lon:Float32Array.from([s.lon-3,s.lon+3]),lat:Float32Array.from([s.lat,s.lat])};
  const outside=clipCycloneLines([line],s,false);
  expect(outside).toHaveLength(2);
  for(const piece of outside)for(let i=0;i<piece.lon.length;i++)expect(cycloneShape(s,piece.lon[i],piece.lat[i]).r).toBeGreaterThan(119.99);
 });
 it('rejects invalid track values and order',()=>{
  expect(()=>validateCyclone({...data,track:[...data.track].reverse()})).toThrow();
  expect(()=>validateCyclone({...data,rmwKm:0})).toThrow();
  expect(()=>validateCyclone({...data,rmwKm:55})).toThrow();
 });
});

describe('broad northern hurricane profile',()=>{
 const large:HistoricalCyclone={...data,rmwKm:55,profile:{exponent:1.75,blendStartKm:370,blendEndKm:600},track:data.track.map(f=>({...f,lat:29,lon:-89.5,windKt:110,pressureHpa:920}))};
 const state=cycloneAt(large,Date.parse(data.track[0].time))!;
 it('resolves the broader eye, northern rotation and finite blend boundary',()=>{
  expect(validateCyclone(large)).toBe(large);
  expect(cycloneShape(state,state.lon,state.lat+55/111.132).speed).toBeCloseTo(110,5);
  const north=cycloneWind(state,state.lon,state.lat+55/111.132,{u:0,v:0})!;
  expect(north.u).toBeLessThan(0);expect(north.v).toBeLessThan(0);
  expect(cycloneShape(state,state.lon,state.lat+150/111.132).weight).toBeGreaterThan(.5);
  expect(cycloneScalar(state,state.lon,state.lat+601/111.132,1002,'mslp')).toBe(1002);
  expect(cycloneScalar(state,state.lon,state.lat,1002,'mslp')).toBe(920);
 });
 it('clips contours at the selected storm radius rather than the Tracy radius',()=>{
  const line={level:1000,closed:false,lon:Float32Array.from([state.lon-9,state.lon+9]),lat:Float32Array.from([state.lat,state.lat])};
  const outside=clipCycloneLines([line],state,false);expect(outside).toHaveLength(2);
  for(const l of outside)for(let i=0;i<l.lon.length;i++)expect(cycloneShape(state,l.lon[i],l.lat[i]).r).toBeGreaterThan(599.99);
  expect(cycloneContours({lines:[],centres:[]},state,()=>1002).lines.some(l=>l.closed&&l.level===940)).toBe(true);
 });
 it('rejects nonphysical and unbounded profile inputs',()=>{
  for(const profile of [null,false,0,{exponent:NaN,blendStartKm:90,blendEndKm:320},{exponent:1.25,blendStartKm:30,blendEndKm:320},{exponent:1.25,blendStartKm:90,blendEndKm:90},{exponent:1.25,blendStartKm:90,blendEndKm:1001}])expect(()=>validateCyclone({...large,profile})).toThrow();
 });
});


it('honours the NHC peak and minute-specific landfall fixes through the last evening',()=>{
 const storm:HistoricalCyclone={method:'compact-vortex-v1',rmwKm:55,profile:{exponent:1.75,blendStartKm:370,blendEndKm:600},source:katrina.provenance.record_url,track:katrina.observations.map(f=>({time:f.time,lat:f.lat,lon:f.lon,windKt:f.wind_kt,pressureHpa:f.pressure_hpa}))};
 validateCyclone(storm);
 expect(cycloneAt(storm,Date.parse('2005-08-28T18:00Z'))).toMatchObject({windKt:150,pressureHpa:902});
 expect(cycloneAt(storm,Date.parse('2005-08-29T11:10Z'))).toMatchObject({lat:29.3,lon:-89.6,windKt:110,pressureHpa:920});
 expect(cycloneAt(storm,Date.parse('2005-08-29T14:45Z'))).toMatchObject({lat:30.2,windKt:105,pressureHpa:928});
 expect(cycloneAt(storm,Date.parse('2005-08-29T23:00Z'))).toMatchObject({windKt:55});
 const landfall=cycloneAt(storm,Date.parse('2005-08-29T11:10Z'))!;
 expect(cycloneShape(landfall,landfall.lon,landfall.lat+167/111.132).speed).toBeGreaterThan(60);
 expect(cycloneShape(landfall,landfall.lon,landfall.lat+370/111.132).speed).toBeGreaterThan(33);
 expect(cycloneShape(landfall,landfall.lon,landfall.lat+370/111.132).speed).toBeLessThan(35);
});
