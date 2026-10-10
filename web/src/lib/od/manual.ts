/**
 * Fictional republic operations sheets.  Values are deliberately rounded,
 * invented teaching values; they are not performance data or an operating
 * manual.  They are useful for the decision exercises only.
 */

export const TEACHING_LABEL = 'teaching values — not for operational use';
export type AircraftId = 'trainer' | 'club-single' | 'piston-twin' | 'commuter' | 'a727';
export type RunwayState = 'dry' | 'wet' | 'contaminated';
export type FlightPhase = 'takeoff' | 'landing';

export type TripRow = { distanceNm: number; cruiseLevel: number; timeMinutes: number; fuelKg: number; teachingLabel: typeof TEACHING_LABEL };
export type AlternateRow = { distanceNm: number; timeMinutes: number; fuelKg: number; teachingLabel: typeof TEACHING_LABEL };
type RunwayRow = { weightKg: number; distanceM: number };
export type MelItem = {
  item: 'antiIce' | 'onePack' | 'autopilot' | 'apu';
  dispatchAllowed: boolean;
  conditions: readonly string[];
  constraints: Readonly<Record<string, number | boolean | string>>;
};
export type MelContext = { icingForecast?: boolean; flightLevel?: number; passengerCount?: number; ifr?: boolean; pilotCount?: number; externalPower?: boolean; externalAir?: boolean };
export type OperationsSheet = {
  id: AircraftId;
  name: string;
  teachingLabel: typeof TEACHING_LABEL;
  sourceNote: string;
  emptyKg: number;
  maxTakeoffKg: number;
  maxLandingKg: number;
  maxFuelKg: number;
  seats: number;
  cruiseLevels: readonly number[];
  flaps: { takeoff: readonly number[]; landing: readonly number[] };
  crosswindLimitsKt: Record<RunwayState, number>;
  mel: readonly MelItem[];
  tripRows: readonly TripRow[];
  alternateRows: readonly AlternateRow[];
  holdingFuelPer30MinKg: number;
  finalReserveBasis: { au: 'holding'; us: 'normal-cruise' };
  taxiFuelKg: number;
  tables: Readonly<Record<string, typeof TEACHING_LABEL>>;
  runway: { takeoff: RunwayRow[]; landing: RunwayRow[] };
};

const invented = 'All figures are original rounded teaching values; no manufacturer, CASA or Boeing performance table is reproduced.';
const row = (distanceNm: number, cruiseLevel: number, timeMinutes: number, fuelKg: number): TripRow => ({ distanceNm, cruiseLevel, timeMinutes, fuelKg, teachingLabel: TEACHING_LABEL });
const alternate = (distanceNm: number, timeMinutes: number, fuelKg: number): AlternateRow => ({ distanceNm, timeMinutes, fuelKg, teachingLabel: TEACHING_LABEL });
const commonTables = (taxiFuelKg: number, holdingFuelPer30MinKg: number) => ({ alternateRows: [] as AlternateRow[], holdingFuelPer30MinKg, finalReserveBasis: { au: 'holding', us: 'normal-cruise' } as const, taxiFuelKg, tables: { trip: TEACHING_LABEL, alternate: TEACHING_LABEL, holding: TEACHING_LABEL, taxi: TEACHING_LABEL, runway: TEACHING_LABEL, crosswind: TEACHING_LABEL, mel: TEACHING_LABEL, flaps: TEACHING_LABEL, contingency: TEACHING_LABEL, corrections: TEACHING_LABEL } as const });
const mel = (id: MelItem['item'], allowed: boolean, conditions: string[], constraints: MelItem['constraints'] = {}): MelItem => ({ item: id, dispatchAllowed: allowed, conditions, constraints });

const trainer: OperationsSheet = {
  id: 'trainer', name: 'R-1 Wagtail single-engine trainer', teachingLabel: TEACHING_LABEL, sourceNote: invented,
  emptyKg: 510, maxTakeoffKg: 750, maxLandingKg: 750, maxFuelKg: 120, seats: 2, cruiseLevels: [35, 55, 75],
  flaps: { takeoff: [10, 20], landing: [30, 40] }, crosswindLimitsKt: { dry: 15, wet: 12, contaminated: 8 },
  mel: [mel('antiIce', true, ['carburettor heat must be serviceable; no known icing'], { icingProhibited: true }), mel('onePack', false, ['not fitted; cabin ventilation must remain adequate'], { notFitted: true }), mel('autopilot', true, ['VFR only; placard control'], { vfrOnly: true }), mel('apu', false, ['not fitted; external start available'], { notFitted: true })],
  tripRows: [row(50, 35, 30, 18), row(100, 35, 56, 34), row(200, 35, 111, 66), row(50, 55, 27, 16), row(100, 55, 51, 30), row(200, 55, 101, 57), row(50, 75, 25, 15), row(100, 75, 48, 28), row(200, 75, 95, 52)],
  ...commonTables(10, 9),
  runway: { takeoff: [{ weightKg: 600, distanceM: 430 }, { weightKg: 750, distanceM: 620 }], landing: [{ weightKg: 600, distanceM: 360 }, { weightKg: 750, distanceM: 470 }] },
};
const clubSingle: OperationsSheet = {
  id: 'club-single', name: 'R-2 Kestrel aero-club single', teachingLabel: TEACHING_LABEL, sourceNote: invented,
  emptyKg: 710, maxTakeoffKg: 1100, maxLandingKg: 1050, maxFuelKg: 190, seats: 4, cruiseLevels: [45, 65, 85],
  flaps: { takeoff: [10, 20], landing: [30, 40] }, crosswindLimitsKt: { dry: 18, wet: 14, contaminated: 10 },
  mel: [mel('antiIce', true, ['flight prohibited in known icing'], { icingProhibited: true }), mel('onePack', false, ['not fitted; cabin ventilation must remain adequate'], { notFitted: true }), mel('autopilot', true, ['VFR only; placard'], { vfrOnly: true }), mel('apu', false, ['not fitted; external start available'], { notFitted: true })],
  tripRows: [row(100, 45, 43, 43), row(200, 45, 86, 84), row(400, 45, 172, 168), row(100, 65, 40, 39), row(200, 65, 80, 76), row(400, 65, 153, 145), row(100, 85, 38, 37), row(200, 85, 75, 72), row(400, 85, 145, 137)],
  ...commonTables(10, 18),
  runway: { takeoff: [{ weightKg: 850, distanceM: 620 }, { weightKg: 1100, distanceM: 900 }], landing: [{ weightKg: 850, distanceM: 510 }, { weightKg: 1050, distanceM: 680 }] },
};
const pistonTwin: OperationsSheet = {
  id: 'piston-twin', name: 'R-4 Osprey piston twin', teachingLabel: TEACHING_LABEL, sourceNote: invented,
  emptyKg: 1500, maxTakeoffKg: 2150, maxLandingKg: 2050, maxFuelKg: 430, seats: 6, cruiseLevels: [65, 85, 105],
  flaps: { takeoff: [10, 15], landing: [25, 40] }, crosswindLimitsKt: { dry: 22, wet: 18, contaminated: 12 },
  mel: [mel('antiIce', true, ['no known icing; approved alternate route'], { icingProhibited: true }), mel('onePack', false, ['not fitted; cabin ventilation must remain adequate'], { notFitted: true }), mel('autopilot', true, ['IFR allowed only with an approved second pilot'], { ifrPilotCount: 2 }), mel('apu', false, ['not fitted; external start procedure required'], { notFitted: true })],
  tripRows: [row(100, 65, 35, 92), row(300, 65, 104, 270), row(600, 65, 210, 535), row(100, 85, 33, 82), row(300, 85, 99, 238), row(600, 85, 199, 465), row(100, 105, 31, 76), row(300, 105, 94, 220), row(600, 105, 188, 430)],
  ...commonTables(20, 45),
  runway: { takeoff: [{ weightKg: 1700, distanceM: 920 }, { weightKg: 2150, distanceM: 1320 }], landing: [{ weightKg: 1700, distanceM: 740 }, { weightKg: 2050, distanceM: 980 }] },
};
const commuter: OperationsSheet = {
  id: 'commuter', name: 'R-8 Sunbird commuter turboprop', teachingLabel: TEACHING_LABEL, sourceNote: invented,
  emptyKg: 5800, maxTakeoffKg: 8700, maxLandingKg: 8200, maxFuelKg: 2200, seats: 19, cruiseLevels: [150, 170, 190],
  flaps: { takeoff: [5, 15], landing: [30, 40] }, crosswindLimitsKt: { dry: 28, wet: 22, contaminated: 15 },
  mel: [mel('antiIce', true, ['dispatch permitted only when icing is not forecast'], { icingProhibited: true }), mel('onePack', true, ['maximum altitude FL150; passenger count capped at 14'], { maxFlightLevel: 150, maxPassengerCount: 14 }), mel('autopilot', true, ['IFR requires two pilots; no single-pilot IMC dispatch'], { ifrPilotCount: 2 }), mel('apu', true, ['external power and engine start cart required'], { externalPowerAndAir: true })],
  tripRows: [row(100, 150, 25, 125), row(300, 150, 73, 360), row(600, 150, 145, 710), row(100, 170, 24, 115), row(300, 170, 69, 310), row(600, 170, 137, 600), row(100, 190, 23, 108), row(300, 190, 66, 290), row(600, 190, 132, 560)],
  ...commonTables(80, 120),
  runway: { takeoff: [{ weightKg: 7000, distanceM: 1150 }, { weightKg: 8700, distanceM: 1540 }], landing: [{ weightKg: 7000, distanceM: 900 }, { weightKg: 8200, distanceM: 1190 }] },
};
const a727: OperationsSheet = {
  id: 'a727', name: 'A727 trijet (727-200 class)', teachingLabel: TEACHING_LABEL, sourceNote: invented + ' Magnitude anchor: FAA ARAC Widespread Fatigue Damage report (29 June 1999), p. 144, ST00076SE lists a 161,000 lb landing-weight option for the 727-200 (about 73,000 kg). https://www.faa.gov/sites/faa.gov/files/aircraft/air_cert/design_approvals/transport/ARAC_WFDFinalReport399A.pdf . All other figures are invented; no performance table is copied.',
  emptyKg: 48000, maxTakeoffKg: 95000, maxLandingKg: 73000, maxFuelKg: 36500, seats: 155, cruiseLevels: [250, 290, 330, 350],
  flaps: { takeoff: [5, 15], landing: [30, 40] }, crosswindLimitsKt: { dry: 30, wet: 25, contaminated: 15 },
  mel: [mel('antiIce', true, ['no stipulated icing exposure with any anti-ice deferred; icing requires all three'], { icingRequiresAll: true }), mel('onePack', true, ['maximum FL250'], { maxFlightLevel: 250 }), mel('autopilot', true, ['IFR requires two pilots; no CAT II/III; second pilot monitors'], { ifrPilotCount: 2 }), mel('apu', true, ['external pneumatic/electrical power and approved dispatch procedure'], { externalPowerAndAir: true })],
  tripRows: [row(500, 250, 78, 5900), row(1000, 250, 154, 11000), row(2000, 250, 300, 20800), row(3000, 250, 445, 30500), row(500, 290, 76, 5750), row(1000, 290, 145, 10300), row(2000, 290, 282, 19500), row(3000, 290, 421, 28400), row(500, 330, 74, 5500), row(1000, 330, 141, 9900), row(2000, 330, 274, 18800), row(3000, 330, 410, 27400), row(500, 350, 73, 5350), row(1000, 350, 139, 9600), row(2000, 350, 270, 18200), row(3000, 350, 404, 26500)],
  ...commonTables(600, 1500),
  alternateRows: [alternate(100, 17, 1250), alternate(200, 32, 2300), alternate(300, 47, 3350), alternate(500, 76, 5750)],
  runway: { takeoff: [{ weightKg: 70000, distanceM: 1800 }, { weightKg: 95000, distanceM: 2850 }], landing: [{ weightKg: 60000, distanceM: 1550 }, { weightKg: 73000, distanceM: 2150 }] },
};

export const FLEET: Readonly<Record<AircraftId, OperationsSheet>> = { trainer, 'club-single': clubSingle, 'piston-twin': pistonTwin, commuter, a727 };
export const A727 = a727;

/** Evaluate the small, fictional dispatch conditions used by MEL exercises. */
export function canDispatchMel(id: AircraftId, item: MelItem['item'], context: MelContext = {}): boolean {
  const m = sheet(id).mel.find(entry => entry.item === item); if (!m || !m.dispatchAllowed) return false;
  if (m.constraints.vfrOnly && context.ifr !== false) return false;
  if ((m.constraints.icingProhibited || m.constraints.icingRequiresAll) && context.icingForecast !== false) return false;
  if (typeof m.constraints.maxFlightLevel === 'number' && (!Number.isFinite(context.flightLevel) || context.flightLevel! < 0 || context.flightLevel! > m.constraints.maxFlightLevel)) return false;
  if (typeof m.constraints.maxPassengerCount === 'number' && (!Number.isInteger(context.passengerCount) || context.passengerCount! < 0 || context.passengerCount! > m.constraints.maxPassengerCount)) return false;
  if (m.constraints.ifrPilotCount && typeof context.ifr !== 'boolean') return false;
  if (typeof m.constraints.ifrPilotCount === 'number' && context.ifr && (!Number.isInteger(context.pilotCount) || context.pilotCount! < m.constraints.ifrPilotCount)) return false;
  if (m.constraints.externalPowerAndAir && !(context.externalPower && context.externalAir)) return false;
  if (m.constraints.externalPowerOrCrossBleed && !context.externalPower) return false;
  return true;
}

function sheet(id: AircraftId): OperationsSheet { const s = FLEET[id]; if (!s) throw new RangeError(`unknown aircraft: ${id}`); return s; }
function finite(name: string, n: number): number { if (!Number.isFinite(n)) throw new RangeError(`${name} must be finite`); return n; }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function interpolate(rows: readonly { distanceNm: number; [key: string]: unknown }[], x: number, key: string): number {
  if (x < rows[0].distanceNm || x > rows[rows.length - 1].distanceNm) throw new RangeError('distance outside teaching table');
  for (let i = 1; i < rows.length; i++) if (x <= rows[i].distanceNm) { const a = rows[i - 1]; const b = rows[i]; return lerp(Number(a[key]), Number(b[key]), (x - a.distanceNm) / (b.distanceNm - a.distanceNm)); }
  return Number(rows[rows.length - 1][key]);
}

export function tripPlan(aircraftId: AircraftId, distanceNm: number, cruiseLevel: number, headwindKt = 0): { timeMinutes: number; fuelKg: number } {
  const s = sheet(aircraftId); finite('distanceNm', distanceNm); finite('cruiseLevel', cruiseLevel); finite('headwindKt', headwindKt);
  if (distanceNm <= 0 || headwindKt < -250) throw new RangeError('invalid distance or wind');
  if (!s.cruiseLevels.includes(cruiseLevel)) throw new RangeError('cruise level is not in teaching table');
  const levelRows = s.tripRows.filter(r => r.cruiseLevel === cruiseLevel);
  if (levelRows.length < 2) throw new RangeError('cruise level is not in teaching table');
  const fuel = interpolate(levelRows, distanceNm, 'fuelKg'); const stillTime = interpolate(levelRows, distanceNm, 'timeMinutes');
  const stillSpeed = distanceNm / (stillTime / 60); const groundSpeed = stillSpeed - headwindKt; if (groundSpeed <= 0) throw new RangeError('headwind exceeds groundspeed');
  return { timeMinutes: distanceNm / groundSpeed * 60, fuelKg: fuel * (stillSpeed / groundSpeed) };
}
export function holdingFuelKg(id: AircraftId, minutes: number): number { finite('minutes', minutes); if (minutes < 0) throw new RangeError('minutes must be non-negative'); return sheet(id).holdingFuelPer30MinKg * minutes / 30; }
export function alternatePlan(id: AircraftId, distanceNm: number, headwindKt = 0): { timeMinutes: number; fuelKg: number } {
  const s = sheet(id); finite('distanceNm', distanceNm); finite('headwindKt', headwindKt);
  if (distanceNm <= 0 || headwindKt < -250) throw new RangeError('invalid alternate input');
  const rows = s.alternateRows.length ? s.alternateRows : s.tripRows.filter(r => r.cruiseLevel === s.cruiseLevels[0]);
  const stillFuel = interpolate(rows, distanceNm, 'fuelKg'), stillTime = interpolate(rows, distanceNm, 'timeMinutes');
  const speed = distanceNm / (stillTime / 60), groundSpeed = speed - headwindKt;
  if (groundSpeed <= 0) throw new RangeError('headwind exceeds groundspeed');
  return { timeMinutes: stillTime * speed / groundSpeed, fuelKg: stillFuel * speed / groundSpeed };
}
export function alternateFuelKg(id: AircraftId, distanceNm: number, headwindKt = 0): number { return alternatePlan(id,distanceNm,headwindKt).fuelKg; }

export type FuelInput = { aircraft: AircraftId; distanceNm: number; cruiseLevel: number; headwindKt?: number; alternateDistanceNm: number | null; holdingMinutes: number; finalReserveMinutes: number; contingencyPercent?: number };
export type FuelBreakdown = { taxiKg: number; tripKg: number; contingencyKg: number; alternateKg: number; holdingKg: number; finalReserveKg: number; totalKg: number };
export function requiredFuelKg(input: FuelInput): FuelBreakdown {
  const headwind = input.headwindKt ?? 0; finite('contingencyPercent', input.contingencyPercent ?? 5); const trip = tripPlan(input.aircraft, input.distanceNm, input.cruiseLevel, headwind); const s = sheet(input.aircraft); const taxiKg = s.taxiFuelKg;
  const contingencyPercent = input.contingencyPercent ?? 5; if (contingencyPercent < 0 || contingencyPercent > 50) throw new RangeError('contingency percent outside 0–50');
  if (input.alternateDistanceNm !== null && input.alternateDistanceNm <= 0) throw new RangeError('alternate distance must be positive');
  if (input.finalReserveMinutes < 0 || input.holdingMinutes < 0) throw new RangeError('reserve times must be non-negative');
  const alternateKg = input.alternateDistanceNm === null ? 0 : alternateFuelKg(input.aircraft, input.alternateDistanceNm, headwind);
  const holdingKg = holdingFuelKg(input.aircraft, input.holdingMinutes); const finalReserveKg = holdingFuelKg(input.aircraft, input.finalReserveMinutes); const contingencyKg = trip.fuelKg * contingencyPercent / 100;
  return { taxiKg, tripKg: trip.fuelKg, contingencyKg, alternateKg, holdingKg, finalReserveKg, totalKg: taxiKg + trip.fuelKg + contingencyKg + alternateKg + holdingKg + finalReserveKg };
}
export function pressureAltitudeFt(elevationFt: number, qnhHpa: number): number { finite('elevationFt', elevationFt); finite('qnhHpa', qnhHpa); if (qnhHpa < 800 || qnhHpa > 1100) throw new RangeError('QNH outside teaching range'); return elevationFt + (1013.25 - qnhHpa) * 27; }
export function densityAltitudeFt(pressureAltitude: number, tempC: number): number { finite('pressureAltitudeFt', pressureAltitude); finite('tempC', tempC); return pressureAltitude + 120 * (tempC - (15 - pressureAltitude / 500)); }
export function runwayDistanceM(input: { aircraft: AircraftId; phase: FlightPhase; weightKg: number; flapDeg: number; runwayState: RunwayState; pressureAltitudeFt: number; temperatureC: number }): number {
  const s = sheet(input.aircraft); finite('weightKg', input.weightKg); finite('flapDeg', input.flapDeg); finite('pressureAltitudeFt', input.pressureAltitudeFt); finite('temperatureC', input.temperatureC); const rows = s.runway[input.phase]; if (!rows || !['dry', 'wet', 'contaminated'].includes(input.runwayState) || !s.flaps[input.phase].includes(input.flapDeg)) throw new RangeError('unsupported runway state or flap');
  const maxWeight = input.phase === 'landing' ? s.maxLandingKg : s.maxTakeoffKg; if (input.weightKg < rows[0].weightKg || input.weightKg > maxWeight || input.pressureAltitudeFt < -1000 || input.pressureAltitudeFt > 10000 || input.temperatureC < -40 || input.temperatureC > 55) throw new RangeError('runway input outside teaching table');
  const base = input.weightKg === rows[0].weightKg ? rows[0].distanceM : lerp(rows[0].distanceM, rows[1].distanceM, (input.weightKg - rows[0].weightKg) / (rows[1].weightKg - rows[0].weightKg)); const flapFactor = input.flapDeg === s.flaps[input.phase][0] ? 1.08 : 1; const stateFactor = { dry: 1, wet: 1.15, contaminated: 1.45 }[input.runwayState]; const altitudeFactor = 1 + input.pressureAltitudeFt / 10000; const tempFactor = 1 + Math.max(0, input.temperatureC - 15) / 100; return Math.round(base * flapFactor * stateFactor * altitudeFactor * tempFactor);
}
export function crosswindKt(runwayHeadingTrueDeg: number, windFromTrueDeg: number, speedKt: number): number { [runwayHeadingTrueDeg, windFromTrueDeg, speedKt].forEach((n, i) => finite(['runwayHeadingTrueDeg', 'windFromTrueDeg', 'speedKt'][i], n)); if (speedKt < 0) throw new RangeError('speed must be non-negative'); const d = (windFromTrueDeg - runwayHeadingTrueDeg) * Math.PI / 180; return Math.abs(speedKt * Math.sin(d)); }
