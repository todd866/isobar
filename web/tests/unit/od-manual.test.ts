import { describe, expect, it } from 'vitest';
import {
  A727, FLEET, TEACHING_LABEL, alternateFuelKg, crosswindKt, densityAltitudeFt,
  holdingFuelKg, pressureAltitudeFt, requiredFuelKg, runwayDistanceM, tripPlan, canDispatchMel,
} from '../../src/lib/od/manual';

describe('fleet teaching operations sheets', () => {
  it('publishes all five sheets with the required teaching warning and four MEL items', () => {
    expect(Object.keys(FLEET)).toEqual(['trainer', 'club-single', 'piston-twin', 'commuter', 'a727']);
    for (const s of Object.values(FLEET)) {
      expect(s.teachingLabel).toBe(TEACHING_LABEL);
      expect(s.mel.map(m => m.item)).toEqual(['antiIce', 'onePack', 'autopilot', 'apu']);
      expect(s.maxTakeoffKg).toBeGreaterThanOrEqual(s.maxLandingKg);
      expect(s.maxFuelKg).toBeGreaterThan(0);
    }
    expect(A727.id).toBe('a727');
  });

  it('does a hand-checkable wind correction and fuel calculation', () => {
    const still = tripPlan('a727', 1000, 290, 0);
    const headwind = tripPlan('a727', 1000, 290, 50);
    expect(still).toEqual({ timeMinutes: 145, fuelKg: 10300 });
    expect(headwind.timeMinutes).toBeCloseTo(145 * (1000 / (145 / 60)) / (1000 / (145 / 60) - 50), 8);
    expect(headwind.fuelKg).toBeCloseTo(10300 * (1000 / (145 / 60)) / (1000 / (145 / 60) - 50), 8);
    expect(alternateFuelKg('a727', 500)).toBe(5750);
    expect(holdingFuelKg('a727', 30)).toBe(1500);
  });

  it('adds each required fuel component without hidden rounding', () => {
    const b = requiredFuelKg({ aircraft: 'a727', distanceNm: 1000, cruiseLevel: 290, headwindKt: 0, alternateDistanceNm: 500, holdingMinutes: 30, finalReserveMinutes: 45, contingencyPercent: 5 });
    expect(b.taxiKg).toBe(600); expect(b.tripKg).toBe(10300); expect(b.contingencyKg).toBe(515);
    expect(b.alternateKg).toBe(5750);
    expect(b.holdingKg).toBe(1500); expect(b.finalReserveKg).toBe(2250);
    expect(b.totalKg).toBe(20915);
  });

  it('converts pressure and density altitude', () => {
    expect(pressureAltitudeFt(500, 1000)).toBeCloseTo(857.75, 8);
    expect(densityAltitudeFt(1000, 30)).toBeCloseTo(3040, 8);
  });

  it('applies weight, flap, runway, altitude and temperature corrections', () => {
    const dry = runwayDistanceM({ aircraft: 'a727', phase: 'takeoff', weightKg: 82500, flapDeg: 5, runwayState: 'dry', pressureAltitudeFt: 0, temperatureC: 15 });
    const wet = runwayDistanceM({ aircraft: 'a727', phase: 'takeoff', weightKg: 82500, flapDeg: 15, runwayState: 'wet', pressureAltitudeFt: 5000, temperatureC: 35 });
    expect(dry).toBe(2511); // midpoint 2325 m, reduced takeoff flap +8%
    expect(wet).toBe(4813);
    expect(runwayDistanceM({ aircraft: 'trainer', phase: 'landing', weightKg: 750, flapDeg: 40, runwayState: 'contaminated', pressureAltitudeFt: 0, temperatureC: 15 })).toBe(682);
  });

  it('computes absolute crosswind and rejects unsupported inputs', () => {
    expect(crosswindKt(90, 0, 20)).toBeCloseTo(20, 8);
    expect(crosswindKt(0, 180, 20)).toBeCloseTo(0, 8);
    expect(() => tripPlan('a727', 1000, 999)).toThrow(RangeError);
    expect(() => tripPlan('a727', 1000, 290, 500)).toThrow(RangeError);
    expect(() => runwayDistanceM({ aircraft: 'a727', phase: 'takeoff', weightKg: 96000, flapDeg: 5, runwayState: 'dry', pressureAltitudeFt: 0, temperatureC: 15 })).toThrow(RangeError);
    expect(() => requiredFuelKg({ aircraft: 'a727', distanceNm: 1000, cruiseLevel: 290, alternateDistanceNm: null, holdingMinutes: 0, finalReserveMinutes: 0, contingencyPercent: 51 })).toThrow(RangeError);
    expect(() => runwayDistanceM({ aircraft: 'a727', phase: 'takeoff', weightKg: Number.NaN, flapDeg: 5, runwayState: 'dry', pressureAltitudeFt: 0, temperatureC: 15 })).toThrow(RangeError);
    expect(() => runwayDistanceM({ aircraft: 'a727', phase: 'takeoff', weightKg: 70000, flapDeg: 5, runwayState: 'dry', pressureAltitudeFt: 0, temperatureC: Number.NaN })).toThrow(RangeError);
    expect(() => requiredFuelKg({ aircraft: 'a727', distanceNm: 1000, cruiseLevel: 290, alternateDistanceNm: null, holdingMinutes: 0, finalReserveMinutes: 0, contingencyPercent: Number.NaN })).toThrow(RangeError);
  });

  it('exposes MEL conditions as executable predicates', () => {
    expect(canDispatchMel('a727', 'onePack', { flightLevel: 240, passengerCount: 150 })).toBe(true);
    expect(canDispatchMel('a727', 'onePack', { flightLevel: 260 })).toBe(false);
    expect(canDispatchMel('commuter', 'onePack', { flightLevel: 140, passengerCount: 14 })).toBe(true);
    expect(canDispatchMel('commuter', 'onePack', { flightLevel: 160, passengerCount: 14 })).toBe(false);
    expect(canDispatchMel('commuter', 'onePack', {})).toBe(false);
    expect(canDispatchMel('piston-twin', 'autopilot', { ifr: true, pilotCount: 1 })).toBe(false);
    expect(canDispatchMel('piston-twin', 'autopilot', { ifr: true, pilotCount: 2 })).toBe(true);
    expect(canDispatchMel('piston-twin', 'autopilot', { ifr: true, pilotCount: Number.NaN })).toBe(false);
    expect(canDispatchMel('a727', 'antiIce', { icingForecast: true })).toBe(false);
    expect(canDispatchMel('a727', 'apu', { externalPower: true, externalAir: true })).toBe(true);
    expect(canDispatchMel('a727', 'apu', { externalPower: true })).toBe(false);
    expect(canDispatchMel('piston-twin', 'onePack')).toBe(false);
    expect(canDispatchMel('piston-twin', 'apu')).toBe(false);
  });
});
