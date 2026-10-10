import {describe,it,expect} from 'vitest';
import {everestTeamPosition,buildEverestMinuteTrack,EVEREST_TRACK_START,EVEREST_TRACK_END,EVEREST_TRACK_ANCHORS,everestTeamWeather} from '../../src/lib/everest-timeline';
import {historicalToChart} from '../../src/lib/history-chart';
import type {HistoricalWeather} from '../../src/lib/history';
const local=(s:string)=>Date.parse(`${s}:00+05:30`);
describe('Everest minute reconstruction',()=>{
 it('covers every minute of both UTC days without gaps, invalid coordinates or teleportation',()=>{
  const records=buildEverestMinuteTrack();expect(records).toHaveLength(2880);
  records.forEach((p,i)=>{expect(p.timeMs).toBe(EVEREST_TRACK_START+i*60000);expect([p.lat,p.lon,p.heightM].every(Number.isFinite)).toBe(true);if(i){const a=records[i-1];expect(Math.hypot((p.lat-a.lat)*111132,(p.lon-a.lon)*98000)).toBeLessThan(100);}});
  expect(everestTeamPosition(EVEREST_TRACK_START-1)).toBeNull();expect(everestTeamPosition(EVEREST_TRACK_END+1)).toBeNull();
 });
 it('honours every timed route anchor',()=>{
  for(const a of EVEREST_TRACK_ANCHORS)expect(everestTeamPosition(a.timeMs)!.routeIndex).toBeCloseTo(a.routeIndex,8);
 });
 it('stops overnight and on the summit, then descends the same terrain route',()=>{
  const night=everestTeamPosition(local('1953-05-29T03:00'))!;
  expect(night.phase).toBe('stopped');expect(night.heightM).toBe(8504);
  const top=everestTeamPosition(local('1953-05-29T11:35'))!;
  expect(top.phase).toBe('stopped');expect(top.heightM).toBe(8849);
  expect(everestTeamPosition(local('1953-05-29T12:00'))!.phase).toBe('descending');
 });
 it('labels interpolation and the clock convention as assumptions',()=>{
  const p=everestTeamPosition(local('1953-05-29T08:00'))!;
  expect(p.provenance.kind).toBe('synthetic');expect(p.provenance.clock.kind).toBe('assumed-expedition-clock');
 });
 it('provides finite minute weather without downloaded DEM and holds only the final bounded hour',()=>{
  const times=['1953-05-28T00:00Z','1953-05-29T23:00Z'];
  const data:HistoricalWeather={schema_version:1,product:'isobar-historical-weather',grid:{nx:2,ny:2,latitudes:[29,27],longitudes:[86,88],step_degrees:2},times,units:{u:'knots',v:'knots',pressure_msl:'hPa'},frames:times.map((time,i)=>({time,pressure_msl:[1010,1010,1010,1010],u:Array(4).fill(10+i*10),v:[0,0,0,0]}))};
  const chart=historicalToChart(data,{rings:[]},'everest-1953');
  for(const p of buildEverestMinuteTrack()){const w=everestTeamWeather(chart,p,null)!;expect(w).not.toBeNull();expect([w.temperatureC,w.windKt,w.rhPct,w.pressureHPa].every(Number.isFinite)).toBe(true);}
  expect(everestTeamWeather(chart,everestTeamPosition(EVEREST_TRACK_END-60000)!,null)!.temporalBasis).toBe('endpoint-held-under-1h');
 });
});
