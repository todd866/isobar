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
 });
});
