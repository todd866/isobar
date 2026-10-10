// Isobar B727 worked examples: five complete flight plans and ten
// APLA-style take-off, landing and weight-and-balance problems.
//
// Every number here is computed from the Isobar tables through engine.ts, so
// the examples stay consistent with the data and can be round-tripped by the
// tests. Aerodrome coordinates, elevations and runway lengths are public
// (AIP ERSA); forecasts are invented and labelled as such.

import * as e from './engine.ts';

export interface Aerodrome {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  elevFt: number;
  /** magnetic variation, east positive */
  variation: number;
  runway: { designator: string; toraM: number; ldaM: number; slopePercent: number };
}

export const AERODROMES: Record<string, Aerodrome> = {
  YPPH: { icao: 'YPPH', name: 'Perth', lat: -31.940, lon: 115.967, elevFt: 67, variation: -1.7, runway: { designator: '03/21', toraM: 3444, ldaM: 3444, slopePercent: 0.0 } },
  YSSY: { icao: 'YSSY', name: 'Sydney', lat: -33.946, lon: 151.177, elevFt: 21, variation: 12.5, runway: { designator: '16R/34L', toraM: 3962, ldaM: 3962, slopePercent: 0.0 } },
  YMML: { icao: 'YMML', name: 'Melbourne', lat: -37.673, lon: 144.843, elevFt: 434, variation: 11.6, runway: { designator: '16/34', toraM: 3657, ldaM: 3657, slopePercent: 0.1 } },
  YBBN: { icao: 'YBBN', name: 'Brisbane', lat: -27.384, lon: 153.117, elevFt: 13, variation: 11.0, runway: { designator: '01R/19L', toraM: 3560, ldaM: 3560, slopePercent: 0.0 } },
  YBCS: { icao: 'YBCS', name: 'Cairns', lat: -16.886, lon: 145.755, elevFt: 10, variation: 7.0, runway: { designator: '15/33', toraM: 3196, ldaM: 3196, slopePercent: 0.0 } },
  YPAD: { icao: 'YPAD', name: 'Adelaide', lat: -34.945, lon: 138.531, elevFt: 20, variation: 8.0, runway: { designator: '05/23', toraM: 3100, ldaM: 3100, slopePercent: 0.0 } },
  YSCB: { icao: 'YSCB', name: 'Canberra', lat: -35.307, lon: 149.195, elevFt: 1886, variation: 12.3, runway: { designator: '17/35', toraM: 3283, ldaM: 3283, slopePercent: 0.3 } },
  YBCG: { icao: 'YBCG', name: 'Gold Coast', lat: -28.164, lon: 153.505, elevFt: 21, variation: 11.0, runway: { designator: '14/32', toraM: 2492, ldaM: 2042, slopePercent: 0.0 } },
  YPKG: { icao: 'YPKG', name: 'Kalgoorlie-Boulder', lat: -30.790, lon: 121.462, elevFt: 1203, variation: 0.5, runway: { designator: '11/29', toraM: 2000, ldaM: 2000, slopePercent: 0.0 } },
  YBTL: { icao: 'YBTL', name: 'Townsville', lat: -19.253, lon: 146.766, elevFt: 18, variation: 7.0, runway: { designator: '01/19', toraM: 2438, ldaM: 2438, slopePercent: 0.0 } },
  YMIA: { icao: 'YMIA', name: 'Mildura', lat: -34.229, lon: 142.086, elevFt: 167, variation: 9.6, runway: { designator: '09/27', toraM: 1830, ldaM: 1830, slopePercent: 0.0 } },
  YBAS: { icao: 'YBAS', name: 'Alice Springs', lat: -23.807, lon: 133.902, elevFt: 1789, variation: 4.5, runway: { designator: '12/30', toraM: 2438, ldaM: 2438, slopePercent: 0.0 } },
};

/** Named en-route positions (approximate, for training). */
export const WAYPOINTS: Record<string, e.LatLon> = {
  FORREST: { lat: -30.838, lon: 128.115 },
  CEDUNA: { lat: -32.131, lon: 133.710 },
  MILDURA: { lat: -34.229, lon: 142.086 },
  NHILL: { lat: -36.333, lon: 141.650 },
  KALGOORLIE: { lat: -30.790, lon: 121.462 },
  WILLIAMTOWN: { lat: -32.795, lon: 151.834 },
  'COFFS HARBOUR': { lat: -30.321, lon: 153.116 },
  ROCKHAMPTON: { lat: -23.382, lon: 150.475 },
  MACKAY: { lat: -21.172, lon: 149.180 },
  TOWNSVILLE: { lat: -19.253, lon: 146.766 },
};

const fmt = (n: number, d = 0): string => n.toLocaleString('en-AU', { minimumFractionDigits: d, maximumFractionDigits: d });

function position(name: string): e.LatLon {
  const ad = AERODROMES[name];
  if (ad) return { lat: ad.lat, lon: ad.lon };
  const wp = WAYPOINTS[name];
  if (!wp) throw new Error(`unknown position ${name}`);
  return wp;
}

/** Variation interpolated linearly in longitude between the two aerodromes. */
function variationAt(lon: number, a: Aerodrome, b: Aerodrome): number {
  if (a.lon === b.lon) return a.variation;
  const f = (lon - a.lon) / (b.lon - a.lon);
  return a.variation + f * (b.variation - a.variation);
}

export interface RouteLegSpec {
  to: string;
  metColumn: number;
}

/** Build engine legs from named positions: great-circle distance (rounded to
 * the nautical mile) and the initial true track converted to magnetic using
 * the variation at the leg's mid-longitude. */
export function buildLegs(from: string, to: string, via: RouteLegSpec[]): e.Leg[] {
  const dep = AERODROMES[from], dest = AERODROMES[to];
  let prev = position(from);
  const legs: e.Leg[] = [];
  for (const spec of via) {
    const next = position(spec.to);
    const dist = Math.round(e.greatCircleNm(prev, next));
    const trueTrack = e.initialTrackTrue(prev, next);
    const variation = Math.round(variationAt((prev.lon + next.lon) / 2, dep, dest) * 2) / 2;
    const trackM = Math.round((((trueTrack - variation) % 360) + 360) % 360);
    legs.push({ to: spec.to, distNm: dist, trackM, variation, metColumn: spec.metColumn });
    prev = next;
  }
  return legs;
}

/** A compact RSWT-style column: wind (true) and temperature deviation at the
 * six standard levels. */
export function metColumn(name: string, rows: [level: number, dirT: number, kt: number, isaDev: number][]): e.MetColumn {
  const wind: Record<number, { dirT: number; kt: number }> = {};
  const isaDev: Record<number, number> = {};
  for (const [level, dirT, kt, dev] of rows) {
    wind[level] = { dirT, kt };
    isaDev[level] = dev;
  }
  return { name, wind, isaDev };
}

export interface FlightSpec {
  id: string;
  title: string;
  from: string;
  to: string;
  alternate: string;
  via: RouteLegSpec[];
  grid: e.MetGrid;
  technique: e.Technique;
  /** level cap (ATC or turbulence), default FL390 */
  maxFl?: number;
  /** planned payload */
  payloadKg: number;
  basicWeightKg: number;
  /** destination weather holding, minutes (0 = none) */
  holdingMin: number;
  /** departure conditions for the take-off check */
  departure: { oatC: number; qnhHpa: number; windKt: number; flap: 5 | 15 | 25 };
  /** destination conditions for the landing check */
  arrival: { oatC: number; qnhHpa: number; windKt: number; flap: 30 | 40; wet: boolean };
  /** alternate burn (missed approach to 1,500 ft at the alternate), kg; from the alternate leg plan */
  alternateDistNm: number;
  alternateTrackM: number;
  notes?: string[];
}

export interface EtpResult {
  label: string;
  distNm: number;
  fl: number;
  tasKt: number;
  gsOnKt: number;
  gsBackKt: number;
  timeFromDepartureMin: number;
}

export interface FlightExample {
  spec: FlightSpec;
  legs: e.Leg[];
  cruiseFl: number;
  zeroFuelKg: number;
  brakeReleaseKg: number;
  plan: e.Plan;
  fuel: e.FuelPlan;
  alternateBurnKg: number;
  takeoff: e.TakeoffLimit;
  landing: e.LandingLimit;
  etps: EtpResult[];
  pnr: { distNm: number; zone: number; limited: boolean; fuelAvailableKg: number; timeToPnrMin: number };
  ruleOfThumb: ReturnType<typeof e.ruleOfThumb>;
  checks: string[];
}

const LANDING_ALLOWANCE = 350;

/** Fuel from the missed approach to 1,500 ft at the alternate (the descent
 * table ends at 1,500 ft): climb to a sensible level, cruise LRC, descend. The alternate leg is planned at the
 * highest usable level at or below FL250 for short legs. */
export function alternateBurn(lwKg: number, distNm: number, trackM: number, grid: e.MetGrid, column: number): { burnKg: number; fl: number; timeMin: number } {
  const levels = e.ifrLevels(trackM, 150, 290).filter((fl) => e.TABLES.climb.fl.includes(fl));
  // choose level by distance: 150–250 nm → FL250/270; shorter → lower
  const target = distNm < 80 ? 150 : distNm < 150 ? 210 : distNm < 250 ? 250 : 290;
  const fl = levels.filter((l) => l <= target).pop() ?? levels[0];
  const single: e.MetGrid = { levels: grid.levels, columns: [grid.columns[column]] };
  const plan = e.planFlight({
    from: 'MAP', to: 'ALT', legs: [{ to: 'ALT', distNm, trackM, variation: 0, metColumn: 0 }],
    cruiseFl: fl, technique: 'LRC', brakeReleaseKg: lwKg, grid: single,
  });
  return { burnKg: plan.burnKg, fl, timeMin: plan.totalTimeMin };
}

function isaDevAtLevel(spec: FlightSpec, column: number): (fl: number) => number {
  return (fl) => e.sampleMet(spec.grid.columns[column], e.metLevelFor(spec.grid, fl)).isaDev;
}

/** Plan a flight from a specification: iterate fuel ↔ brake-release weight,
 * pick the highest IFR level the aircraft can hold at TOC, then compute the
 * fuel plan, ETPs, PNR and the departure/arrival performance checks. */
export function planExample(spec: FlightSpec): FlightExample {
  const legs = buildLegs(spec.from, spec.to, spec.via);
  const zfw = spec.basicWeightKg + spec.payloadKg;
  const dep = AERODROMES[spec.from], dest = AERODROMES[spec.to];
  let brw = zfw + 12000;
  let plan!: e.Plan;
  let fuel!: e.FuelPlan;
  let cruiseFl = 0;
  let altBurn = 0;
  for (let pass = 0; pass < 8; pass++) {
    // the level is chosen on the weight at TOC, estimated from the climb to the previous level
    const probe = e.highestLevel(spec.technique === '280KIAS' ? 'LRC' : spec.technique, legs[0].trackM, brw - 2500, isaDevAtLevel(spec, legs[0].metColumn), spec.maxFl ?? 390);
    if (!probe) throw new Error(`${spec.id}: no cruise level`);
    cruiseFl = probe;
    plan = e.planFlight({ from: spec.from, to: spec.to, legs, cruiseFl, technique: spec.technique, brakeReleaseKg: brw, grid: spec.grid });
    const lastColumn = legs[legs.length - 1].metColumn;
    altBurn = alternateBurn(plan.landingKg, spec.alternateDistNm, spec.alternateTrackM, spec.grid, lastColumn).burnKg;
    fuel = e.fuelPlan({
      tripKg: plan.burnKg + LANDING_ALLOWANCE,
      landingKg: plan.landingKg,
      alternateBurnKg: altBurn,
      holdingMin: spec.holdingMin,
      isaDevAtDestination: e.sampleMet(spec.grid.columns[lastColumn], 185).isaDev,
    });
    const next = Math.round((zfw + fuel.takeoffFuelKg) / 10) * 10;
    if (Math.abs(next - brw) < 10) { brw = next; break; }
    brw = next;
  }
  // final plan at the settled weight
  plan = e.planFlight({ from: spec.from, to: spec.to, legs, cruiseFl, technique: spec.technique, brakeReleaseKg: brw, grid: spec.grid });

  const takeoff = e.takeoffLimit({ flap: spec.departure.flap, toraM: dep.runway.toraM, slopePercent: dep.runway.slopePercent, windKt: spec.departure.windKt, elevationFt: dep.elevFt, qnhHpa: spec.departure.qnhHpa, oatC: spec.departure.oatC });
  const landing = e.landingLimit({ flap: spec.arrival.flap, ldaM: dest.runway.ldaM, slopePercent: dest.runway.slopePercent, windKt: spec.arrival.windKt, elevationFt: dest.elevFt, qnhHpa: spec.arrival.qnhHpa, oatC: spec.arrival.oatC, wet: spec.arrival.wet });

  // ETPs: normal at cruise level; 1-INOP at the engine-out ceiling; depressurised at FL100.
  const cruiseRows = plan.rows.filter((r) => typeof r.fl === 'number');
  const midWeight = e.weightEntry((plan.tocKg + plan.todKg) / 2);
  const etps: EtpResult[] = [];
  const etpFor = (label: string, fl: number, perf: (isaDev: number) => { tasKt: number } | null): void => {
    const zones = legs.map((leg) => {
      const met = e.sampleMet(spec.grid.columns[leg.metColumn], e.metLevelFor(spec.grid, fl));
      const p = perf(met.isaDev);
      if (!p) throw new Error(`${spec.id}: no ${label} performance at FL${fl}`);
      const trackT = e.trueFromMagnetic(leg.trackM, leg.variation);
      const on = e.groundSpeed(p.tasKt, trackT, met.windDirT, met.windKt).gsKt;
      const back = e.groundSpeed(p.tasKt, (trackT + 180) % 360, met.windDirT, met.windKt).gsKt;
      return { distNm: leg.distNm, gsOnKt: on, gsBackKt: back, tasKt: p.tasKt };
    });
    const r = e.etpMultiZone(zones);
    etps.push({ label, distNm: r.distNm, fl, tasKt: zones[r.zone].tasKt, gsOnKt: zones[r.zone].gsOnKt, gsBackKt: zones[r.zone].gsBackKt, timeFromDepartureMin: timeToDistance(plan, r.distNm) });
  };
  etpFor('Normal (all engines)', cruiseFl, (dev) => e.cruiseLookup(spec.technique, cruiseFl, midWeight, dev));
  // 1-INOP level: the highest tabulated level the mid-flight weight can hold in every zone's temperature
  const inopLevels = [...e.TABLES.abnormal.oneInop.lrc.fl].sort((a, b) => b - a);
  const inopFl = inopLevels.find((fl) => legs.every((leg) => {
    const dev = e.sampleMet(spec.grid.columns[leg.metColumn], e.metLevelFor(spec.grid, fl)).isaDev;
    return e.oneInopCruiseLookup(fl, midWeight, dev) !== null;
  })) ?? 100;
  etpFor('One engine inoperative', inopFl, (dev) => e.oneInopCruiseLookup(inopFl, midWeight, dev));
  etpFor('Depressurised (FL100)', 100, (dev) => e.depressurisedCruiseLookup(100, midWeight, dev));

  // PNR: fuel available = take-off fuel − reserves kept at the return (alternate, holding, final, landing allowance) − climb fuel is in the first zone
  // fixed reserves are held at the return; the 5% variable reserve applies to the flight fuel out and back
  const reserveKg = fuel.alternateKg + fuel.holdingKg + fuel.finalReserveKg + LANDING_ALLOWANCE;
  const pnrFuel = (fuel.takeoffFuelKg - reserveKg) / 1.05;
  const pnrZones = cruiseRows.map((row) => {
    const leg = legs.find((l) => row.segment.endsWith(l.to)) ?? legs[legs.length - 1];
    const met = e.sampleMet(spec.grid.columns[leg.metColumn], e.metLevelFor(spec.grid, cruiseFl));
    const trackT = e.trueFromMagnetic(leg.trackM, leg.variation);
    const back = e.groundSpeed(row.tasKt, (trackT + 180) % 360, met.windDirT, met.windKt).gsKt;
    return { distNm: row.distNm, sgrOutKgPerNm: row.fuelFlowKgPerHour! / row.gsKt, sgrBackKgPerNm: row.fuelFlowKgPerHour! / back };
  });
  const climbRow = plan.rows[0];
  const descentRow = plan.rows[plan.rows.length - 1];
  // climb and descent are treated as fixed allowances: subtract them from the fuel, add the climb ground distance
  const pnrCore = e.pnrDistanceNm(pnrFuel - climbRow.zoneFuelKg - descentRow.zoneFuelKg, pnrZones);
  const pnrDist = climbRow.distNm + pnrCore.distNm;
  const pnr = { distNm: pnrDist, zone: pnrCore.zone, limited: pnrCore.limited, fuelAvailableKg: pnrFuel, timeToPnrMin: timeToDistance(plan, pnrDist) };

  const ruleOfThumb = e.ruleOfThumb(plan);
  const checks: string[] = [];
  checks.push(`ZFW ${fmt(zfw)} kg ${zfw <= e.TABLES.limitations.weights.maxZeroFuelKg ? '≤' : '>'} MZFW ${fmt(e.TABLES.limitations.weights.maxZeroFuelKg)} kg`);
  checks.push(`BRW ${fmt(brw)} kg ${brw <= takeoff.performanceLimitKg ? '≤' : '>'} take-off limit ${fmt(Math.floor(takeoff.performanceLimitKg))} kg (${takeoff.limitedBy})`);
  checks.push(`LW ${fmt(Math.round(plan.landingKg))} kg ${plan.landingKg <= landing.performanceLimitKg ? '≤' : '>'} landing limit ${fmt(Math.floor(landing.performanceLimitKg))} kg (${landing.limitedBy})`);
  const cap = e.altitudeCapabilityKg(spec.technique === '280KIAS' ? 'LRC' : spec.technique, cruiseFl, isaDevAtLevel(spec, legs[0].metColumn)(cruiseFl));
  checks.push(`TOC ${fmt(Math.round(plan.tocKg))} kg ${cap !== null && plan.tocKg <= cap ? '≤' : '>'} FL${cruiseFl} capability ${cap === null ? '—' : fmt(cap)} kg`);
  return { spec, legs, cruiseFl, zeroFuelKg: zfw, brakeReleaseKg: brw, plan, fuel, alternateBurnKg: altBurn, takeoff, landing, etps, pnr, ruleOfThumb, checks };
}

/** Elapsed time from brake release to a ground distance along the plan. */
export function timeToDistance(plan: e.Plan, distNm: number): number {
  let d = 0, t = 0;
  for (const row of plan.rows) {
    if (distNm <= d + row.distNm) return t + ((distNm - d) / row.distNm) * row.etiMin;
    d += row.distNm;
    t += row.etiMin;
  }
  return t;
}

// ---------------------------------------------------------------------------
// The five flights. Forecasts are invented RSWT-style columns.

export const FLIGHTS: FlightSpec[] = [
  {
    id: 'F1', title: 'Perth to Sydney (YPPH–YSSY)', from: 'YPPH', to: 'YSSY', alternate: 'YSCB',
    via: [{ to: 'FORREST', metColumn: 0 }, { to: 'CEDUNA', metColumn: 1 }, { to: 'MILDURA', metColumn: 1 }, { to: 'YSSY', metColumn: 2 }],
    grid: { levels: e.RSWT_LEVELS, columns: [
      metColumn('Perth–Forrest', [[185, 250, 25, 2], [235, 255, 40, 0], [300, 260, 60, -2], [340, 265, 70, -3], [385, 265, 65, -1], [445, 260, 55, 0]]),
      metColumn('Forrest–Mildura', [[185, 270, 30, 4], [235, 275, 45, 2], [300, 280, 75, 0], [340, 280, 90, -1], [385, 275, 80, 1], [445, 270, 65, 2]]),
      metColumn('Mildura–Sydney', [[185, 290, 30, 5], [235, 290, 50, 3], [300, 290, 80, 1], [340, 290, 95, 0], [385, 285, 85, 2], [445, 280, 70, 3]]),
    ] },
    technique: 'M0.80', payloadKg: 15400, basicWeightKg: 46400, holdingMin: 0,
    departure: { oatC: 29, qnhHpa: 1012, windKt: 8, flap: 15 },
    arrival: { oatC: 19, qnhHpa: 1018, windKt: 10, flap: 30, wet: false },
    alternateDistNm: 128, alternateTrackM: 229,
  },
  {
    id: 'F2', title: 'Sydney to Brisbane (YSSY–YBBN)', from: 'YSSY', to: 'YBBN', alternate: 'YBCG',
    via: [{ to: 'WILLIAMTOWN', metColumn: 0 }, { to: 'COFFS HARBOUR', metColumn: 0 }, { to: 'YBBN', metColumn: 1 }],
    grid: { levels: e.RSWT_LEVELS, columns: [
      metColumn('Sydney–Coffs', [[185, 230, 20, 3], [235, 240, 30, 1], [300, 250, 45, 0], [340, 250, 50, -1], [385, 250, 45, 0], [445, 245, 40, 1]]),
      metColumn('Coffs–Brisbane', [[185, 200, 15, 4], [235, 220, 25, 2], [300, 240, 35, 1], [340, 245, 40, 0], [385, 245, 35, 1], [445, 240, 30, 2]]),
    ] },
    technique: 'M0.80', payloadKg: 17000, basicWeightKg: 46400, holdingMin: 30,
    departure: { oatC: 24, qnhHpa: 1016, windKt: 12, flap: 15 },
    arrival: { oatC: 27, qnhHpa: 1010, windKt: 6, flap: 30, wet: true },
    alternateDistNm: 50, alternateTrackM: 145,
  },
  {
    id: 'F3', title: 'Melbourne to Perth (YMML–YPPH)', from: 'YMML', to: 'YPPH', alternate: 'YPKG',
    via: [{ to: 'NHILL', metColumn: 0 }, { to: 'CEDUNA', metColumn: 0 }, { to: 'FORREST', metColumn: 1 }, { to: 'YPPH', metColumn: 2 }],
    grid: { levels: e.RSWT_LEVELS, columns: [
      metColumn('Melbourne–Ceduna', [[185, 280, 35, 1], [235, 285, 55, -1], [300, 290, 85, -3], [340, 290, 100, -4], [385, 285, 90, -2], [445, 280, 75, -1]]),
      metColumn('Ceduna–Forrest', [[185, 270, 30, 2], [235, 275, 45, 0], [300, 275, 70, -2], [340, 275, 80, -3], [385, 270, 70, -1], [445, 265, 60, 0]]),
      metColumn('Forrest–Perth', [[185, 240, 20, 4], [235, 250, 30, 2], [300, 255, 50, 0], [340, 260, 55, -1], [385, 260, 50, 1], [445, 255, 45, 2]]),
    ] },
    technique: 'LRC', payloadKg: 13200, basicWeightKg: 46400, holdingMin: 0,
    departure: { oatC: 14, qnhHpa: 1021, windKt: 15, flap: 15 },
    arrival: { oatC: 22, qnhHpa: 1014, windKt: 10, flap: 30, wet: false },
    alternateDistNm: 290, alternateTrackM: 76,
    notes: ['Headwind sector: long-range cruise is planned and the level is fuel-limited, not capability-limited.'],
  },
  {
    id: 'F4', title: 'Brisbane to Cairns (YBBN–YBCS)', from: 'YBBN', to: 'YBCS', alternate: 'YBTL',
    via: [{ to: 'ROCKHAMPTON', metColumn: 0 }, { to: 'MACKAY', metColumn: 0 }, { to: 'TOWNSVILLE', metColumn: 1 }, { to: 'YBCS', metColumn: 1 }],
    grid: { levels: e.RSWT_LEVELS, columns: [
      metColumn('Brisbane–Mackay', [[185, 120, 15, 6], [235, 110, 20, 4], [300, 100, 25, 3], [340, 90, 30, 2], [385, 80, 25, 3], [445, 70, 20, 4]]),
      metColumn('Mackay–Cairns', [[185, 130, 20, 7], [235, 120, 25, 5], [300, 110, 30, 4], [340, 100, 30, 3], [385, 90, 25, 4], [445, 80, 20, 5]]),
    ] },
    technique: 'M0.80', payloadKg: 15600, basicWeightKg: 46400, holdingMin: 30,
    departure: { oatC: 31, qnhHpa: 1009, windKt: 5, flap: 15 },
    arrival: { oatC: 32, qnhHpa: 1007, windKt: 8, flap: 30, wet: true },
    alternateDistNm: 158, alternateTrackM: 143,
    notes: ['Tropical, warm sector: ISA+5 to +7 at the cruise level trims the altitude capability.'],
  },
  {
    id: 'F5', title: 'Perth to Adelaide (YPPH–YPAD)', from: 'YPPH', to: 'YPAD', alternate: 'YMIA',
    via: [{ to: 'KALGOORLIE', metColumn: 0 }, { to: 'FORREST', metColumn: 0 }, { to: 'CEDUNA', metColumn: 1 }, { to: 'YPAD', metColumn: 1 }],
    grid: { levels: e.RSWT_LEVELS, columns: [
      metColumn('Perth–Forrest', [[185, 320, 15, 0], [235, 310, 25, -2], [300, 300, 40, -4], [340, 295, 45, -5], [385, 290, 40, -3], [445, 285, 35, -2]]),
      metColumn('Forrest–Adelaide', [[185, 300, 20, 1], [235, 300, 35, -1], [300, 295, 55, -3], [340, 290, 60, -4], [385, 290, 55, -2], [445, 285, 45, -1]]),
    ] },
    technique: 'LRC', maxFl: 250, payloadKg: 13400, basicWeightKg: 46400, holdingMin: 0,
    departure: { oatC: 18, qnhHpa: 1024, windKt: 10, flap: 5 },
    arrival: { oatC: 15, qnhHpa: 1020, windKt: 12, flap: 40, wet: false },
    alternateDistNm: 170, alternateTrackM: 88,
    notes: ['Level capped at FL250 (forecast severe turbulence above): long-range cruise at a low level. Compare the specific range with F3.'],
  },
];

export function planAll(): FlightExample[] {
  return FLIGHTS.map(planExample);
}

// ---------------------------------------------------------------------------
// APLA-style problems

export interface Problem {
  id: string;
  topic: 'take-off' | 'landing' | 'weight and balance';
  question: string;
  working: string[];
  answer: string;
  /** machine-checkable values used by the tests */
  values: Record<string, number>;
}

/** a weight limit, or 'above the table' when it falls off the top */
const lim = (n: number): string => (n >= e.TABLE_CEILING_KG ? 'above the table' : `${fmt(n)} kg`);

export function problems(): Problem[] {
  const out: Problem[] = [];
  const L = e.TABLES.limitations;

  // P1 – Perth, hot afternoon, tailwind
  {
    const ad = AERODROMES.YPPH;
    const r = e.takeoffLimit({ flap: 15, toraM: ad.runway.toraM, slopePercent: 0, windKt: -5, elevationFt: ad.elevFt, qnhHpa: 1008, oatC: 38 });
    out.push({
      id: 'P1', topic: 'take-off',
      question: `${ad.name} RWY 03, TORA ${fmt(ad.runway.toraM)} m, level, elevation ${ad.elevFt} ft, QNH 1008, OAT +38 °C, 5 kt tailwind, flaps 15, anti-ice off. Find the performance-limited take-off weight and the limiting factor.`,
      working: [
        `Pressure altitude = ${ad.elevFt} + (1013 − 1008) × 30 = ${fmt(r.pressureAltFt)} ft; interpolate between the sea-level and 1,000 ft tables.`,
        `Corrected length = ${fmt(ad.runway.toraM)} − 50 (line-up) + 5 × (−35) tailwind = ${fmt(r.correctedLengthM)} m.`,
        `Field-limit table, flaps 15, interpolating between the 30 and 40 °C columns at ${fmt(r.correctedLengthM)} m → ${lim(r.fieldLimitKg)}.`,
        `Climb-limit table, flaps 15, PA/OAT, less ${e.TABLES.takeoff.climbLimit.tailwindKgPerKt} kg/kt of tailwind → ${fmt(r.climbLimitKg)} kg.`,
        `Structural limit ${fmt(r.structuralKg)} kg.`,
      ],
      answer: `${fmt(r.performanceLimitKg)} kg, ${r.limitedBy} limited. V1 ${r.speeds!.v1}, VR ${r.speeds!.vr}, V2 ${r.speeds!.v2} kt.`,
      values: { performanceLimitKg: r.performanceLimitKg, fieldLimitKg: r.fieldLimitKg, climbLimitKg: r.climbLimitKg, v2: r.speeds!.v2 },
    });
  }
  // P2 – Cairns, flaps 25, headwind
  {
    const ad = AERODROMES.YBCS;
    const r = e.takeoffLimit({ flap: 25, toraM: ad.runway.toraM, slopePercent: 0, windKt: 10, elevationFt: ad.elevFt, qnhHpa: 1010, oatC: 33 });
    out.push({
      id: 'P2', topic: 'take-off',
      question: `${ad.name} RWY 15, TORA ${fmt(ad.runway.toraM)} m, level, elevation ${ad.elevFt} ft, QNH 1010, OAT +33 °C, 10 kt headwind, flaps 25. Find the maximum take-off weight and the limiting factor.`,
      working: [
        `PA = ${ad.elevFt} + 3 × 30 = ${fmt(r.pressureAltFt)} ft.`,
        `Corrected length = ${fmt(ad.runway.toraM)} − 50 + 10 × 10 = ${fmt(r.correctedLengthM)} m.`,
        `Field limit (flaps 25, interpolated 30–40 °C) ${lim(r.fieldLimitKg)}; climb limit ${lim(r.climbLimitKg)}; structural ${fmt(r.structuralKg)} kg.`,
      ],
      answer: `${fmt(r.performanceLimitKg)} kg, ${r.limitedBy} limited.`,
      values: { performanceLimitKg: r.performanceLimitKg, fieldLimitKg: r.fieldLimitKg, climbLimitKg: r.climbLimitKg },
    });
  }
  // P3 – Alice Springs, hot and high, flaps 5 on a short runway
  {
    const ad = AERODROMES.YBAS;
    const r5 = e.takeoffLimit({ flap: 5, toraM: ad.runway.toraM, slopePercent: 0, windKt: 0, elevationFt: ad.elevFt, qnhHpa: 1005, oatC: 42 });
    const r15 = e.takeoffLimit({ flap: 15, toraM: ad.runway.toraM, slopePercent: 0, windKt: 0, elevationFt: ad.elevFt, qnhHpa: 1005, oatC: 42 });
    const r25 = e.takeoffLimit({ flap: 25, toraM: ad.runway.toraM, slopePercent: 0, windKt: 0, elevationFt: ad.elevFt, qnhHpa: 1005, oatC: 42 });
    const best = [r5, r15, r25].reduce((a, b) => (b.performanceLimitKg > a.performanceLimitKg ? b : a));
    const bestFlap = best === r5 ? 5 : best === r15 ? 15 : 25;
    out.push({
      id: 'P3', topic: 'take-off',
      question: `${ad.name} RWY 12, TORA ${fmt(ad.runway.toraM)} m, level, elevation ${fmt(ad.elevFt)} ft, QNH 1005, OAT +42 °C, nil wind. Compare flaps 5, 15 and 25 and state the best take-off weight.`,
      working: [
        `PA = ${fmt(ad.elevFt)} + 8 × 30 = ${fmt(r5.pressureAltFt)} ft (interpolate 2,000–3,000 ft); corrected length ${fmt(r5.correctedLengthM)} m.`,
        `Flaps 5: field ${lim(r5.fieldLimitKg)}, climb ${lim(r5.climbLimitKg)} → ${fmt(r5.performanceLimitKg)} kg (${r5.limitedBy}).`,
        `Flaps 15: field ${lim(r15.fieldLimitKg)}, climb ${lim(r15.climbLimitKg)} → ${fmt(r15.performanceLimitKg)} kg (${r15.limitedBy}).`,
        `Flaps 25: field ${lim(r25.fieldLimitKg)}, climb ${lim(r25.climbLimitKg)} → ${fmt(r25.performanceLimitKg)} kg (${r25.limitedBy}).`,
        'A short runway favours more flap for the field limit; the climb limit favours less flap. Take the flap setting with the higher of the two minima.',
      ],
      answer: `Flaps ${bestFlap}: ${fmt(best.performanceLimitKg)} kg (${best.limitedBy} limited).`,
      values: { bestFlap, performanceLimitKg: best.performanceLimitKg, f5: r5.performanceLimitKg, f15: r15.performanceLimitKg, f25: r25.performanceLimitKg },
    });
  }
  // P4 – Canberra uphill, cold morning, engine anti-ice on
  {
    const ad = AERODROMES.YSCB;
    const r = e.takeoffLimit({ flap: 15, toraM: ad.runway.toraM, slopePercent: 0.3, windKt: 6, elevationFt: ad.elevFt, qnhHpa: 1030, oatC: 2, engineAntiIce: true });
    out.push({
      id: 'P4', topic: 'take-off',
      question: `${ad.name} RWY 35, TORA ${fmt(ad.runway.toraM)} m, 0.3% upslope, elevation ${fmt(ad.elevFt)} ft, QNH 1030, OAT +2 °C, 6 kt headwind, flaps 15, engine anti-ice on. Find the maximum take-off weight.`,
      working: [
        `PA = ${fmt(ad.elevFt)} − 17 × 30 = ${fmt(r.pressureAltFt)} ft.`,
        `Corrected length = ${fmt(ad.runway.toraM)} − 50 + 6 × 10 − 0.3 × 0.06 × ${fmt(ad.runway.toraM)} = ${fmt(r.correctedLengthM)} m.`,
        `Field limit ${lim(r.fieldLimitKg)} (interpolated 0–10 °C); climb limit ${lim(r.climbLimitKg)} after the ${fmt(e.TABLES.takeoff.climbLimit.engineAntiIceKg)} kg engine anti-ice decrement; structural ${fmt(r.structuralKg)} kg.`,
      ],
      answer: `${fmt(r.performanceLimitKg)} kg, ${r.limitedBy} limited.`,
      values: { performanceLimitKg: r.performanceLimitKg, climbLimitKg: r.climbLimitKg },
    });
  }
  // P5 – Gold Coast, wet, flaps 30
  {
    const ad = AERODROMES.YBCG;
    const r = e.landingLimit({ flap: 30, ldaM: ad.runway.ldaM, slopePercent: 0, windKt: 8, elevationFt: ad.elevFt, qnhHpa: 1004, oatC: 30, wet: true });
    out.push({
      id: 'P5', topic: 'landing',
      question: `${ad.name} RWY 14, LDA ${fmt(ad.runway.ldaM)} m, level, elevation ${ad.elevFt} ft, QNH 1004, OAT +30 °C, 8 kt headwind, runway wet, flaps 30. Find the maximum landing weight and VREF.`,
      working: [
        `PA = ${ad.elevFt} + 9 × 30 = ${fmt(r.pressureAltFt)} ft.`,
        `Corrected LDA = ${fmt(ad.runway.ldaM)} + 8 × 8 = ${fmt(r.correctedLengthM)} m.`,
        `Wet field limit (flaps 30) ${lim(r.fieldLimitKg)}; approach-climb limit ${lim(r.approachClimbLimitKg)}; structural ${fmt(r.structuralKg)} kg.`,
      ],
      answer: `${fmt(r.performanceLimitKg)} kg, ${r.limitedBy} limited; VREF ${r.vrefKt} kt at that weight.`,
      values: { performanceLimitKg: r.performanceLimitKg, fieldLimitKg: r.fieldLimitKg, vrefKt: r.vrefKt ?? NaN },
    });
  }
  // P6 – Kalgoorlie, hot, flaps 40 dry
  {
    const ad = AERODROMES.YPKG;
    const r30 = e.landingLimit({ flap: 30, ldaM: ad.runway.ldaM, slopePercent: 0, windKt: 0, elevationFt: ad.elevFt, qnhHpa: 1012, oatC: 40, wet: false });
    const r40 = e.landingLimit({ flap: 40, ldaM: ad.runway.ldaM, slopePercent: 0, windKt: 0, elevationFt: ad.elevFt, qnhHpa: 1012, oatC: 40, wet: false });
    out.push({
      id: 'P6', topic: 'landing',
      question: `${ad.name} RWY 11, LDA ${fmt(ad.runway.ldaM)} m, elevation ${fmt(ad.elevFt)} ft, QNH 1012, OAT +40 °C, nil wind, dry. Compare the flaps 30 and flaps 40 landing weight limits.`,
      working: [
        `PA = ${fmt(ad.elevFt)} + 1 × 30 = ${fmt(r30.pressureAltFt)} ft. Corrected LDA ${fmt(r30.correctedLengthM)} m.`,
        `Flaps 30: field ${lim(r30.fieldLimitKg)}, approach climb ${lim(r30.approachClimbLimitKg)}, structural ${fmt(r30.structuralKg)} kg → ${fmt(r30.performanceLimitKg)} kg (${r30.limitedBy}).`,
        `Flaps 40: field ${lim(r40.fieldLimitKg)}, approach climb ${lim(r40.approachClimbLimitKg)}, structural ${fmt(r40.structuralKg)} kg → ${fmt(r40.performanceLimitKg)} kg (${r40.limitedBy}).`,
      ],
      answer: `Flaps 30 ${fmt(r30.performanceLimitKg)} kg; flaps 40 ${fmt(r40.performanceLimitKg)} kg (flaps 40 structural limit ${fmt(L.weights.maxLandingFlaps40Kg)} kg).`,
      values: { f30: r30.performanceLimitKg, f40: r40.performanceLimitKg },
    });
  }
  // P7 – Mildura: given LW, minimum LDA
  {
    const lw = 62000;
    const T = e.TABLES.landing;
    const row = T.fieldLimit.weightKg[T.flaps.indexOf(30)][T.surfaces.indexOf('dry')][T.pressureAltFt.indexOf(0)];
    const lens = T.fieldLengthM;
    const idx = row.findIndex((w) => w !== null && w >= lw);
    const minLen = lens[idx];
    const r = e.landingLimit({ flap: 30, ldaM: minLen + 40 * 10, slopePercent: 0, windKt: -10, elevationFt: 0, qnhHpa: 1013, oatC: 15, wet: false });
    out.push({
      id: 'P7', topic: 'landing',
      question: `Planned landing weight ${fmt(lw)} kg, flaps 30, dry, sea level ISA, 10 kt tailwind. What is the shortest landing distance available that satisfies the field limit?`,
      working: [
        `Sea-level dry table, flaps 30: the shortest tabulated corrected length whose weight is at least ${fmt(lw)} kg is ${fmt(minLen)} m (${fmt(row[idx]!)} kg).`,
        `Tailwind correction: the table length is the corrected length, so the LDA must be longer by 10 kt × 40 m/kt = 400 m.`,
        `Check: LDA ${fmt(minLen + 400)} m with 10 kt tailwind → corrected ${fmt(r.correctedLengthM)} m → ${fmt(r.fieldLimitKg)} kg ≥ ${fmt(lw)} kg.`,
      ],
      answer: `${fmt(minLen + 400)} m.`,
      values: { minLdaM: minLen + 400, fieldLimitKg: r.fieldLimitKg },
    });
  }
  // P8 – Full load sheet
  {
    const input: e.LoadInput = {
      basicWeightKg: 46400, basicIndex: e.TABLES.balance.typicalBasicIndex,
      zones: { A: { adult: 30, child: 2 }, B: { adult: 34 }, C: { adult: 28 }, D: { adult: 26, infant: 1 }, E: { adult: 22 } },
      freightKg: { 1: 1400, 2: 900, 4: 1200, 5: 800 },
      fuelKg: 17500, taxiKg: 200, tripBurnKg: 10800,
    };
    const s = e.loadSheet(input);
    out.push({
      id: 'P8', topic: 'weight and balance',
      question: `Basic weight ${fmt(input.basicWeightKg)} kg, basic index ${input.basicIndex}. Passengers: zone A 30 adults and 2 children, B 34 adults, C 28 adults, D 26 adults and 1 infant, E 22 adults. Freight: compartment 1 ${fmt(1400)} kg, 2 ${fmt(900)} kg, 4 ${fmt(1200)} kg, 5 ${fmt(800)} kg. Ramp fuel ${fmt(17500)} kg, taxi 200 kg, trip burn ${fmt(10800)} kg. Find ZFW, BRW and LW with CG in % MAC and the stabiliser trim for flaps 15.`,
      working: [
        ...s.items.map((it) => `${it.name}: ${fmt(it.kg)} kg, ${it.iu >= 0 ? '+' : ''}${fmt(it.iu, 1)} IU`),
        `ZFW ${fmt(s.zeroFuelKg)} kg, index ${fmt(s.zeroFuelIndex, 1)} → ${fmt(s.zeroFuelMac, 1)}% MAC.`,
        `Take-off fuel ${fmt(input.fuelKg - 200)} kg: fuel index from the loading table, BRW ${fmt(s.brakeReleaseKg)} kg, index ${fmt(s.brakeReleaseIndex, 1)} → ${fmt(s.brakeReleaseMac, 1)}% MAC.`,
        `LW ${fmt(s.landingKg!)} kg → ${fmt(s.landingMac!, 1)}% MAC.`,
        `Stabiliser trim (flaps 15) ${fmt(s.stabTrim.flaps15, 1)} units.`,
      ],
      answer: `ZFW ${fmt(s.zeroFuelKg)} kg at ${fmt(s.zeroFuelMac, 1)}% MAC; BRW ${fmt(s.brakeReleaseKg)} kg at ${fmt(s.brakeReleaseMac, 1)}% MAC; LW ${fmt(s.landingKg!)} kg at ${fmt(s.landingMac!, 1)}% MAC; trim ${fmt(s.stabTrim.flaps15, 1)} units.${s.violations.length ? ' Violations: ' + s.violations.join('; ') : ' All within limits.'}`,
      values: { zeroFuelKg: s.zeroFuelKg, zeroFuelMac: s.zeroFuelMac, brakeReleaseKg: s.brakeReleaseKg, brakeReleaseMac: s.brakeReleaseMac, landingMac: s.landingMac!, stabTrim15: s.stabTrim.flaps15 },
    });
  }
  // P9 – Maximum payload
  {
    const bw = 46400, fuelTo = 21400, burn = 15200, taxi = 200;
    const mtow = L.weights.maxTakeoffKg, mlw = L.weights.maxLandingKg, mzfw = L.weights.maxZeroFuelKg;
    const perfTow = 84100;
    const towLimit = Math.min(mtow, perfTow);
    const byTow = towLimit - fuelTo - bw;
    const byLw = mlw + burn - fuelTo - bw;
    const byZfw = mzfw - bw;
    const payload = Math.min(byTow, byLw, byZfw);
    const limiter = payload === byZfw ? 'MZFW' : payload === byLw ? 'MLW' : 'take-off weight';
    out.push({
      id: 'P9', topic: 'weight and balance',
      question: `Basic weight ${fmt(bw)} kg. Take-off fuel ${fmt(fuelTo)} kg (taxi ${taxi} kg extra), trip burn ${fmt(burn)} kg. Performance-limited take-off weight ${fmt(perfTow)} kg. Find the maximum payload and the limiting weight.`,
      working: [
        `Take-off limit: min(MTOW ${fmt(mtow)}, performance ${fmt(perfTow)}) = ${fmt(towLimit)} kg → payload ${fmt(towLimit)} − ${fmt(fuelTo)} − ${fmt(bw)} = ${fmt(byTow)} kg.`,
        `Landing limit: MLW ${fmt(mlw)} + burn ${fmt(burn)} − fuel ${fmt(fuelTo)} − BW ${fmt(bw)} = ${fmt(byLw)} kg.`,
        `Zero-fuel limit: MZFW ${fmt(mzfw)} − BW ${fmt(bw)} = ${fmt(byZfw)} kg.`,
      ],
      answer: `${fmt(payload)} kg, limited by ${limiter}.`,
      values: { payloadKg: payload, byTow, byLw, byZfw },
    });
  }
  // P10 – Freight shift to restore the CG
  {
    const base: e.LoadInput = {
      basicWeightKg: 46400, basicIndex: e.TABLES.balance.typicalBasicIndex,
      zones: { A: { adult: 30 }, B: { adult: 32 }, C: { adult: 24 }, D: { adult: 14 } },
      freightKg: { 1: 1800, 2: 1000 },
      fuelKg: 9000, taxiKg: 200, tripBurnKg: 4000,
    };
    const s = e.loadSheet(base);
    const arms = e.TABLES.balance.compartments;
    const B = e.TABLES.balance;
    const dArm = arms['5'].armM - arms['1'].armM;
    const targetMac = e.cgLimitsAt(s.zeroFuelKg).forwardMac + 1;
    const targetIndex = B.indexUnit.offset + (s.zeroFuelKg * ((B.mac.lemacM + (targetMac / 100) * B.mac.macM) - B.indexUnit.referenceArmM)) / B.indexUnit.divisor;
    const neededIu = targetIndex - s.zeroFuelIndex;
    const moveKg = Math.ceil((neededIu * B.indexUnit.divisor) / dArm / 10) * 10;
    const after = e.loadSheet({ ...base, freightKg: { 1: 1800 - moveKg, 2: 1000, 5: moveKg } });
    out.push({
      id: 'P10', topic: 'weight and balance',
      question: `Basic weight ${fmt(base.basicWeightKg)} kg, index ${base.basicIndex}. Passengers: zone A 30, B 32, C 24, D 14 adults, E empty. Freight ${fmt(1800)} kg in compartment 1 and ${fmt(1000)} kg in compartment 2. Fuel ${fmt(9000)} kg. The ZFW CG is forward of the limit. How much freight must move from compartment 1 to compartment 5 to put the ZFW CG 1% MAC inside the forward limit?`,
      working: [
        `As loaded: ZFW ${fmt(s.zeroFuelKg)} kg, index ${fmt(s.zeroFuelIndex, 1)}, ${fmt(s.zeroFuelMac, 1)}% MAC; forward limit ${fmt(e.cgLimitsAt(s.zeroFuelKg).forwardMac, 1)}% MAC.`,
        `Target ${fmt(targetMac, 1)}% MAC = index ${fmt(targetIndex, 1)}; change needed ${fmt(neededIu, 1)} IU.`,
        `Moving m kg from arm ${arms['1'].armM} m to ${arms['5'].armM} m changes the index by m × ${dArm.toFixed(1)} ÷ ${B.indexUnit.divisor} IU → m = ${fmt(neededIu, 1)} × ${B.indexUnit.divisor} ÷ ${dArm.toFixed(1)} = ${fmt((neededIu * B.indexUnit.divisor) / dArm)} kg, round up to ${fmt(moveKg)} kg.`,
        `Check: ZFW CG after the move ${fmt(after.zeroFuelMac, 1)}% MAC; BRW CG ${fmt(after.brakeReleaseMac, 1)}% MAC; compartment 5 limit ${fmt(arms['5'].maxKg)} kg.`,
      ],
      answer: `Move ${fmt(moveKg)} kg aft. ZFW CG becomes ${fmt(after.zeroFuelMac, 1)}% MAC.`,
      values: { moveKg, beforeMac: s.zeroFuelMac, afterMac: after.zeroFuelMac },
    });
  }
  return out;
}
