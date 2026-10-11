import {describe,it,expect} from 'vitest';
import {KATRINA_MARINE,marineObservation,satelliteForDate} from '../../src/lib/historical-marine';
describe('historical marine observations',()=>{
 it('does not place a drifting buoy at its old mooring',()=>{
  const s=KATRINA_MARINE.stations.find(s=>s.id==='42007')!;
  expect(marineObservation(s,Date.parse('2005-08-29T05:00Z'))).toBeNull();
  expect(marineObservation(s,Date.parse('2005-08-29T04:00Z'))).not.toBeNull();
 });
 it('does not carry observations across gaps',()=>{
  const s=KATRINA_MARINE.stations[0];
  expect(marineObservation(s,Date.parse('2005-09-01'))).toBeNull();
  expect(marineObservation(s,NaN)).toBeNull();
 });
 it('uses imagery only on its actual UTC day',()=>{
  expect(satelliteForDate(KATRINA_MARINE,Date.parse('2005-08-28T23:59Z'))?.date).toBe('2005-08-28');
  expect(satelliteForDate(KATRINA_MARINE,Date.parse('2005-08-29'))?.date).toBe('2005-08-29');
  expect(satelliteForDate(KATRINA_MARINE,Date.parse('2005-08-30'))).toBeNull();
 });
});
