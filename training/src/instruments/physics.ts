/** Pure, inspectable teaching calculations for the instrument lab.
 *
 * These are deliberately training approximations, not dispatch or flight
 * planning tools. Distances are nautical miles, heights feet, speeds knots,
 * temperatures °C and pressures hPa unless a name says otherwise.
 */
import {
  AIRCRAFT, BALANCE, climb, descent, densityAltitudeFt,
  isaTemperatureK, pressureAltitudeFt, percentMac, armFromIndex, indexUnits,
  fuelDistribution, cgLimits,
} from '../b727/model.ts';
import { greatCircleNm, initialTrackTrue, type LatLon } from '../b727/engine.ts';

export interface Vector { x: number; y: number }
/** Screen vector: north is negative y; bearings are clockwise from north. */
export function vector(bearing: number, length: number): Vector {
  const r = bearing * Math.PI / 180;
  const x = Math.sin(r) * length, y = -Math.cos(r) * length;
  return { x: Math.abs(x) < 1e-12 ? 0 : x, y: Math.abs(y) < 1e-12 ? 0 : y };
}

export interface WindTriangleResult {
  heading: number; drift: number; groundspeed: number;
  crosswind: number; headwind: number; feasible: boolean;
}
/** Wind direction is FROM (meteorological convention); track and heading are true. */
export function windTriangle(input: { tas: number; track: number; windFrom: number; windSpeed: number }): WindTriangleResult {
  const { tas, track, windFrom, windSpeed } = input;
  if (![tas, track, windFrom, windSpeed].every(Number.isFinite) || tas <= 0 || windSpeed < 0) {
    return { heading: NaN, drift: NaN, groundspeed: NaN, crosswind: NaN, headwind: NaN, feasible: false };
  }
  const t = vector(track, 1);
  const w = vector(windFrom + 180, windSpeed);
  const crosswind = w.x * t.y - w.y * t.x;
  const alongWind = w.x * t.x + w.y * t.y;
  if (Math.abs(crosswind) > tas) return { heading: NaN, drift: NaN, groundspeed: NaN, crosswind, headwind: -alongWind, feasible: false };
  const gs = alongWind + Math.sqrt(Math.max(0, tas * tas - crosswind * crosswind));
  const air = { x: gs * t.x - w.x, y: gs * t.y - w.y };
  const heading = (Math.atan2(air.x, -air.y) * 180 / Math.PI + 360) % 360;
  const signedDrift = heading - track;
  const drift = -(((signedDrift + 540) % 360) - 180);
  const headwind = -alongWind;
  return { heading, drift, groundspeed: gs, crosswind, headwind, feasible: gs > 1e-9 };
}

export interface AtmosphereResult {
  isa: number; isaDeviation: number; pressureAltitude: number; densityAltitude: number;
  trueAltitude: number; coldError: number; correction: number;
}
/**
 * `level` is indicated altitude AMSL. `setting` is the selected subscale used
 * to infer pressure altitude; `qnh` is the actual sea-level pressure used to
 * correct the pressure surface. True height uses a constant temperature
 * offset through the ISA column above the field. `coldError` isolates the
 * temperature part with matching QNH (indicated minus true, positive in cold).
 * `correction` is the combined true-minus-indicated altitude correction.
 */
export function atmosphere(input: { level: number; oat: number; qnh: number; setting?: number; fieldElevation?: number }): AtmosphereResult {
  const field = input.fieldElevation ?? 0;
  const setting = input.setting ?? input.qnh;
  if (![input.level,input.oat,input.qnh,setting,field].every(Number.isFinite) || input.oat <= -273.15 || input.qnh <= 0 || setting <= 0) return {isa:NaN,isaDeviation:NaN,pressureAltitude:NaN,densityAltitude:NaN,trueAltitude:NaN,coldError:NaN,correction:NaN};
  const pressureAltitude = pressureAltitudeFt(input.level, setting);
  const isa = isaTemperatureK(pressureAltitude) - 273.15;
  const isaDeviation = input.oat - isa;
  const densityAltitude = densityAltitudeFt(pressureAltitude, input.oat);
  const pressureHeight = input.level + (input.qnh - setting) * 27 - field;
  const fieldIsaK = isaTemperatureK(field);
  const trueAltitude = field + pressureHeight * ((fieldIsaK + isaDeviation) / fieldIsaK);
  // Isolate temperature error with QNH matched to the indication.
  const matchedHeight = input.level - field;
  const temperatureTrue = field + matchedHeight * ((fieldIsaK + isaDeviation) / fieldIsaK);
  const coldError = input.level - temperatureTrue;
  const correction = trueAltitude - input.level;
  return { isa, isaDeviation, pressureAltitude, densityAltitude, trueAltitude, coldError, correction };
}

export function interpolate(x: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x1 === x0) throw new RangeError('interpolation bounds must differ');
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

export function bilinear(weight: number, level: number, weights: [number, number], levels: [number, number], values: [[number, number], [number, number]]): number {
  const a = interpolate(weight, weights[0], weights[1], values[0][0], values[0][1]);
  const b = interpolate(weight, weights[0], weights[1], values[1][0], values[1][1]);
  return interpolate(level, levels[0], levels[1], a, b);
}

export interface BalanceResult { weight: number; zeroFuelWeight: number; moment: number; index: number; cg: number; forward: number; aft: number; status: 'within'|'forward'|'aft'|'overweight'|'capacity'; issues: string[] }
/** Passenger entries are counts in zones A–E; cargo and fuel are kilograms. */
export function balance(input: { passengers: number[]; cargo: number[]; fuel: number }): BalanceResult {
  const issues: string[] = [];
  const valid = Array.isArray(input.passengers) && Array.isArray(input.cargo) && [...input.passengers, ...input.cargo, input.fuel].every(Number.isFinite);
  if (!valid || input.passengers.some(x=>x<0||!Number.isInteger(x)) || input.cargo.some(x=>x<0) || input.fuel<0) return { weight: NaN, zeroFuelWeight: NaN, moment: NaN, index: NaN, cg: NaN, forward: NaN, aft: NaN, status: 'capacity', issues: ['load must be finite and non-negative; passengers must be whole people'] };
  const p = [...input.passengers, 0, 0, 0, 0, 0].slice(0, 5);
  const c = [...input.cargo, 0, 0, 0, 0].slice(0, 4);
  if (input.passengers.length > 5) issues.push('passenger zones exceed A–E');
  if (input.cargo.length > 4) issues.push('cargo compartments must be 1, 2, 4, 5');
  const zoneKeys = ['A', 'B', 'C', 'D', 'E'] as const;
  const holdKeys = [1, 2, 4, 5] as const;
  let payloadMoment = 0, payload = 0;
  p.forEach((count, i) => { if (count < 0 || count > BALANCE.zones[zoneKeys[i]].seats) issues.push(`zone ${zoneKeys[i]} exceeds ${BALANCE.zones[zoneKeys[i]].seats} seats`); const kg = count * BALANCE.standardWeights.adult; payload += kg; payloadMoment += kg * BALANCE.zones[zoneKeys[i]].armM; });
  c.forEach((kg, i) => { const h = BALANCE.compartments[holdKeys[i]]; if (kg < 0) issues.push(`compartment ${holdKeys[i]} is negative`); if (kg > h.maxKg) issues.push(`compartment ${holdKeys[i]} exceeds ${h.maxKg} kg`); payload += kg; payloadMoment += kg * h.armM; });
  if (input.fuel < 0 || input.fuel > AIRCRAFT.fuel.usableWithAuxKg) issues.push(`fuel exceeds ${AIRCRAFT.fuel.usableWithAuxKg} kg capacity`);
  const basic = AIRCRAFT.weights.basicWeightKg;
  const basicArm = armFromIndex(basic, BALANCE.typicalBasicIndex);
  const zeroFuelWeight = basic + payload;
  const fuel = input.fuel;
  const fd = fuelDistribution(fuel);
  const excessFuel = Math.max(0, fuel - AIRCRAFT.fuel.usableWithAuxKg);
  const knownMoment = basic * basicArm + payloadMoment + fd.wingKg * BALANCE.tanks.wing.armM + fd.centreKg * BALANCE.tanks.centre.armM + fd.aftAuxKg * BALANCE.tanks.aftAux.armM + fd.fwdAuxKg * BALANCE.tanks.fwdAux.armM;
  const moment = excessFuel > 0 ? NaN : knownMoment;
  const weight = zeroFuelWeight + fuel;
  const cg = percentMac(moment / weight);
  const lim = cgLimits(weight);
  if (zeroFuelWeight > AIRCRAFT.weights.maxZeroFuelKg) issues.push(`zero-fuel weight exceeds ${AIRCRAFT.weights.maxZeroFuelKg} kg`);
  if (weight > AIRCRAFT.weights.maxTakeoffKg) issues.push(`take-off weight exceeds ${AIRCRAFT.weights.maxTakeoffKg} kg`);
  const status = issues.some((x) => x.includes('zone') || x.includes('compartment') || (x.includes('fuel') && !x.includes('zero-fuel')) || x.includes('capacity')) ? 'capacity' : weight > AIRCRAFT.weights.maxTakeoffKg || zeroFuelWeight > AIRCRAFT.weights.maxZeroFuelKg ? 'overweight' : cg < lim.forwardMac ? 'forward' : cg > lim.aftMac ? 'aft' : Number.isFinite(cg) ? 'within' : 'capacity';
  return { weight, zeroFuelWeight, moment, index: BALANCE.indexOffset + indexUnits(weight, moment / weight), cg, forward: lim.forwardMac, aft: lim.aftMac, status, issues };
}

export type WindInput = number | { speedKt: number; direction?: 'tailwind'|'headwind' };
export interface ProfileResult { climbNm:number; descentNm:number; climbMinutes:number; descentMinutes:number; toc:number; tod:number; threeRuleNm:number; climbWindLevel:number; descentWindLevel:number; feasible:boolean }
/** `level` is FL; wind levels are feet. Winds are signed (tailwind positive). */
export function profile(input: { weight:number; level:number; isaDeviation:number; climbWind:WindInput; descentWind:WindInput; distance:number; arrivalAltitude?:number; landingWeight?:number }): ProfileResult {
  const signed = (w: WindInput) => typeof w === 'number' ? w : (w.direction === 'headwind' ? -w.speedKt : w.speedKt);
  const arrival = input.arrivalAltitude ?? 1500;
  const invalid = ![input.weight,input.level,input.isaDeviation,input.distance,arrival,input.landingWeight??input.weight,signed(input.climbWind),signed(input.descentWind)].every(Number.isFinite) || input.weight <= 0 || input.weight > AIRCRAFT.weights.maxTakeoffKg || input.level <= 15 || input.level > 420 || input.distance <= 0 || arrival < 0 || arrival >= input.level*100 || (input.landingWeight??input.weight) <= 0 || (input.landingWeight??input.weight) > input.weight || input.isaDeviation < -100 || input.isaDeviation > 100;
  if (invalid) return { climbNm: NaN, descentNm: NaN, climbMinutes: NaN, descentMinutes: NaN, toc: NaN, tod: NaN, threeRuleNm: NaN, climbWindLevel: NaN, descentWindLevel: NaN, feasible: false };
  const c = climb(input.weight, input.level, input.isaDeviation);
  const d = descent(input.landingWeight ?? input.weight - (c?.fuelKg ?? 0), input.level, input.isaDeviation, arrival);
  const cg = c ? c.distNm + signed(input.climbWind) * c.timeMin / 60 : Infinity;
  const dg = d.distNm + signed(input.descentWind) * d.timeMin / 60;
  const threeRuleNm = Math.max(0, (input.level * 100 - arrival) / 1000 * 3);
  const finite = Number.isFinite(input.distance) && input.distance > 0 && Number.isFinite(cg) && Number.isFinite(dg) && cg >= 0 && dg >= 0;
  return { climbNm: cg, descentNm: dg, climbMinutes: c?.timeMin ?? Infinity, descentMinutes: d.timeMin, toc: cg, tod: input.distance - dg, threeRuleNm, climbWindLevel: input.level * 100 * 2 / 3, descentWindLevel: (input.level * 100 + arrival) / 2, feasible: c !== null && finite && input.distance >= cg + dg };
}

export const ROUTES: Record<string, { from: string; to: string; fromLatLon: LatLon; toLatLon: LatLon; distanceNm: number; trackTrue: number }> = {};
const cities: Record<string, LatLon> = { YSSY: {lat:-33.9461,lon:151.1772}, YMML:{lat:-37.6733,lon:144.8433}, YBBN:{lat:-27.3842,lon:153.1175}, YPPH:{lat:-31.9403,lon:115.9669}, YPAD:{lat:-34.945,lon:138.5306}, YPDN:{lat:-12.4147,lon:130.8767} };
for (const [from, to] of [['YSSY','YPPH'], ['YSSY','YMML'], ['YSSY','YBBN'], ['YPPH','YPAD'], ['YPPH','YSSY'], ['YMML','YBBN'], ['YPAD','YSSY']] as const) ROUTES[`${from}-${to}`] = { from, to, fromLatLon: cities[from], toLatLon: cities[to], distanceNm: greatCircleNm(cities[from], cities[to]), trackTrue: initialTrackTrue(cities[from], cities[to]) };
