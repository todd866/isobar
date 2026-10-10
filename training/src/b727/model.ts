/** Isobar B727 model: an original, physically consistent performance model of a
 * Boeing 727-200 Advanced with three JT8D-15 engines, in kilograms.
 *
 * Nothing here is copied from any operator's handbook. Structural weights and
 * fuel capacity are Boeing's published airport-planning figures (D6-58324,
 * 2023 release). Aerodynamics and engine behaviour are a textbook drag polar
 * and a flat-rated low-bypass turbofan, with the free constants calibrated to
 * the Boeing field-length and payload-range charts and to the Dittmar (2011)
 * speed tables. The calibration points and tolerances are in
 * `test/b727-model.test.ts`.
 *
 * Units inside this file: SI (m, kg, N, s, K, Pa) unless a name says otherwise
 * (`ft`, `kt`, `kias`, `kgPerHour`, `nm`). Tables published to `data/*.json`
 * use the handbook units: kg, FL, knots, nautical miles, minutes, kg/h.
 *
 * For training, not for operational use.
 */

export const G = 9.80665;
export const FT = 0.3048;
export const KT = 0.514444;
export const NM = 1852;
const R_AIR = 287.05287;
const GAMMA = 1.4;
const P0 = 101325;
const T0 = 288.15;
const RHO0 = 1.225;
const A0 = Math.sqrt(GAMMA * R_AIR * T0);

/** The aeroplane. One variant, stated once. */
export const AIRCRAFT = {
  type: 'Boeing 727-200 Advanced',
  engines: '3 × Pratt & Whitney JT8D-15',
  /** Boeing D6-58324, General characteristics, model 727-200 Advanced,
   * 190,500 lb option; usable fuel 8,090 US gal basic, 10,570 US gal with
   * forward and aft auxiliary tanks. */
  weights: {
    maxTaxiKg: 86700,
    maxTakeoffKg: 86500,
    maxLandingKg: 70100,
    /** Isobar model limit: the flaps 40 landing weight is held below the
     * structural landing weight so that the flap choice matters in problems. */
    maxLandingFlaps40Kg: 66000,
    maxZeroFuelKg: 63600,
    basicWeightKg: 46400,
  },
  fuel: {
    /** kg at 0.80 kg/L */
    tank1Kg: 5500,
    tank2Kg: 13600,
    tank3Kg: 5500,
    aftAuxKg: 3650,
    fwdAuxKg: 3890,
    usableBasicKg: 24600,
    usableWithAuxKg: 32140,
    densityKgPerL: 0.8,
  },
  wing: {
    areaM2: 157.9,
    spanM: 32.92,
    /** 180.9 in */
    macM: 4.595,
    /** Isobar model datum: nose. Main gear at about 22.9 m (wheelbase 19.3 m). */
    lemacM: 20.75,
  },
  limits: {
    vmoKias: 350,
    mmo: 0.88,
    /** Flap placard speeds, KIAS. Isobar model values. */
    vfeKias: { 2: 238, 5: 225, 15: 215, 20: 205, 25: 195, 30: 185, 40: 170 } as Record<number, number>,
    gearExtendedKias: 270,
    gearOperatingKias: 235,
    maxTyreSpeedKt: 195,
    maxOperatingAltitudeFt: 42000,
  },
} as const;

/** Drag polar: CD = CD0 + ΔCD(config) + k·CL² + ΔCD(compressibility). */
const AERO = {
  cd0: 0.0185,
  oswald: 0.78,
  /** Added profile drag and 1-g CLmax by flap setting. CLmax calibrated to the
   * Dittmar stall-speed table at 170,000 lb (within 3 kt). */
  flaps: {
    0: { dcd: 0, clmax: 1.21 },
    5: { dcd: 0.01, clmax: 1.75 },
    15: { dcd: 0.02, clmax: 2.02 },
    20: { dcd: 0.027, clmax: 2.22 },
    25: { dcd: 0.035, clmax: 2.41 },
    30: { dcd: 0.048, clmax: 2.59 },
    40: { dcd: 0.07, clmax: 2.75 },
  } as Record<number, { dcd: number; clmax: number }>,
  gearDcd: 0.02,
  /** Windmilling engine plus asymmetric trim. */
  oneInopDcd: 0.006,
  /** Drag rise: ΔCD = K · ((M − M_onset) / 0.1)², M_onset = 0.78 − 0.2 (CL − 0.3).
   * Puts the optimum cruise CL near 0.45 at M 0.78, about 2,000 ft above the
   * Dittmar optimum-altitude line. */
  compressibilityOnset: 0.80,
  compressibilityOnsetSlope: 0.5,
  compressibilityK: 0.012,
  /** 1-g lift coefficient that keeps 1.3 g to initial buffet. */
  buffetCl: 0.48,
};

const aspectRatio = (AIRCRAFT.wing.spanM * AIRCRAFT.wing.spanM) / AIRCRAFT.wing.areaM2;
const K_INDUCED = 1 / (Math.PI * aspectRatio * AERO.oswald);

/** JT8D-15, installed, per engine. */
const ENGINE = {
  count: 3,
  /** Sea-level static take-off thrust, N (15,500 lbf). */
  takeoffStaticN: 68900,
  /** Flat rated to ISA + 14 °C at the field pressure altitude. */
  flatRatingIsaDevC: 14,
  /** Thrust loss above the flat-rating temperature, fraction per °C. */
  hotLapsePerC: 0.0055,
  /** Take-off thrust below the flat-rating temperature varies as δ^0.85. */
  takeoffDeltaExp: 0.85,
  /** Max climb thrust at 1,500 ft and 250 KIAS, N, then × σ^0.68. */
  maxClimbRefN: 50000,
  maxClimbSigmaExp: 0.68,
  /** Extra turbine-temperature loss in climb and cruise above ISA. */
  warmLapsePerC: 0.004,
  maxCruiseFraction: 0.88,
  /** TSFC = c0 · (1 + 0.70 M) · √θ, kg per kN per hour. 0.62 lb/lbf/h. */
  tsfcC0: 62.0,
  tsfcMachK: 0.7,
  /** Idle: thrust N × δ, fuel flow kg/h per engine = a + b·δ. */
  idleThrustN: 6000,
  idleFuelA: 450,
  idleFuelB: 500,
  apuKgPerHour: 100,
};

// ---------------------------------------------------------------------------
// Atmosphere

export interface Air {
  /** Pressure altitude, m. */
  hM: number;
  /** Static pressure, Pa. */
  p: number;
  /** ISA temperature, K. */
  tIsa: number;
  /** Actual temperature, K. */
  t: number;
  rho: number;
  /** Speed of sound, m/s. */
  a: number;
  /** Pressure ratio. */
  delta: number;
  /** Density ratio (actual). */
  sigma: number;
  /** Temperature ratio (actual). */
  theta: number;
}

export function isaTemperatureK(hFt: number): number {
  const hM = hFt * FT;
  return hM < 11000 ? T0 - 0.0065 * hM : 216.65;
}

export function isaPressurePa(hFt: number): number {
  const hM = hFt * FT;
  if (hM < 11000) return P0 * Math.pow((T0 - 0.0065 * hM) / T0, 5.2559);
  return 22632.06 * Math.exp(-(hM - 11000) / 6341.62);
}

export function air(hFt: number, isaDevC = 0): Air {
  const p = isaPressurePa(hFt);
  const tIsa = isaTemperatureK(hFt);
  const t = tIsa + isaDevC;
  const rho = p / (R_AIR * t);
  return {
    hM: hFt * FT,
    p,
    tIsa,
    t,
    rho,
    a: Math.sqrt(GAMMA * R_AIR * t),
    delta: p / P0,
    sigma: rho / RHO0,
    theta: t / T0,
  };
}

/** Pressure altitude from field elevation and QNH, ft. 27 ft per hPa near sea level. */
export function pressureAltitudeFt(elevationFt: number, qnhHpa: number): number {
  return elevationFt + (1013.25 - qnhHpa) * 27;
}

/** Density altitude, ft, from pressure altitude and OAT. */
export function densityAltitudeFt(pressureAltFt: number, oatC: number): number {
  const a = air(pressureAltFt, oatC + 273.15 - isaTemperatureK(pressureAltFt));
  // invert σ = (1 - 6.875e-6 h)^4.2559
  return (1 - Math.pow(a.sigma, 1 / 4.2559)) / 6.8756e-6;
}

// ---------------------------------------------------------------------------
// Speeds

/** Mach from calibrated airspeed, m/s, at static pressure p. */
export function machFromCas(casMs: number, p: number): number {
  const qc = P0 * (Math.pow(1 + 0.2 * (casMs / A0) ** 2, 3.5) - 1);
  return Math.sqrt(5 * (Math.pow(qc / p + 1, 2 / 7) - 1));
}

/** Calibrated airspeed, m/s, from Mach at static pressure p. */
export function casFromMach(mach: number, p: number): number {
  const qc = p * (Math.pow(1 + 0.2 * mach * mach, 3.5) - 1);
  return A0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}

export function tasFromKias(kias: number, a: Air): number {
  return machFromCas(kias * KT, a.p) * a.a;
}

export function tasKtFromMach(mach: number, a: Air): number {
  return (mach * a.a) / KT;
}

export function kiasFromMach(mach: number, a: Air): number {
  return casFromMach(mach, a.p) / KT;
}

/** 1-g stall speed, KIAS, at sea level density (IAS is altitude-invariant for a CL). */
export function stallKias(weightKg: number, flap: number): number {
  const clmax = AERO.flaps[flap].clmax;
  return Math.sqrt((2 * weightKg * G) / (RHO0 * AIRCRAFT.wing.areaM2 * clmax)) / KT;
}

// ---------------------------------------------------------------------------
// Aerodynamics

export interface Config {
  flap: number;
  gear: boolean;
  oneInop: boolean;
}

export const CLEAN: Config = { flap: 0, gear: false, oneInop: false };
export const CLEAN_1INOP: Config = { flap: 0, gear: false, oneInop: true };

function compressibilityDcd(mach: number, cl: number): number {
  const onset = AERO.compressibilityOnset - AERO.compressibilityOnsetSlope * Math.max(0, cl - 0.3);
  if (mach <= onset) return 0;
  const x = (mach - onset) / 0.1;
  return AERO.compressibilityK * x * x;
}

export function dragCoefficient(cl: number, mach: number, config: Config): number {
  let cd = AERO.cd0 + AERO.flaps[config.flap].dcd + K_INDUCED * cl * cl + compressibilityDcd(mach, cl);
  if (config.gear) cd += AERO.gearDcd;
  if (config.oneInop) cd += AERO.oneInopDcd;
  return cd;
}

/** Drag, N, in level flight at the given Mach. */
export function dragN(weightKg: number, mach: number, a: Air, config: Config = CLEAN): number {
  const v = mach * a.a;
  const q = 0.5 * a.rho * v * v;
  const cl = (weightKg * G) / (q * AIRCRAFT.wing.areaM2);
  return dragCoefficient(cl, mach, config) * q * AIRCRAFT.wing.areaM2;
}

export function liftCoefficient(weightKg: number, mach: number, a: Air): number {
  const v = mach * a.a;
  return (weightKg * G) / (0.5 * a.rho * v * v * AIRCRAFT.wing.areaM2);
}

// ---------------------------------------------------------------------------
// Engine

/** Take-off thrust per engine, N, at the given field conditions and Mach. */
export function takeoffThrustN(a: Air, mach: number): number {
  const isaDev = a.t - a.tIsa;
  const hot = Math.max(0, isaDev - ENGINE.flatRatingIsaDevC);
  const lapse = Math.max(0.5, 1 - ENGINE.hotLapsePerC * hot);
  const speed = 1 - 0.45 * mach + 0.3 * mach * mach;
  return ENGINE.takeoffStaticN * Math.pow(a.delta, ENGINE.takeoffDeltaExp) * lapse * speed;
}

/** Max climb (max continuous) thrust per engine, N. */
export function maxClimbThrustN(a: Air): number {
  const isaDev = a.t - a.tIsa;
  const warm = Math.max(0, isaDev);
  return (
    ENGINE.maxClimbRefN *
    Math.pow(a.sigma, ENGINE.maxClimbSigmaExp) *
    (1 - ENGINE.warmLapsePerC * warm)
  );
}

export function maxCruiseThrustN(a: Air): number {
  return ENGINE.maxCruiseFraction * maxClimbThrustN(a);
}

export function idleThrustN(a: Air): number {
  return ENGINE.idleThrustN * a.delta;
}

/** Thrust-specific fuel consumption, kg per N per hour. */
export function tsfcKgPerNHour(mach: number, a: Air): number {
  return (ENGINE.tsfcC0 / 1000) * (1 + ENGINE.tsfcMachK * mach) * Math.sqrt(a.theta);
}

/** Total fuel flow, kg/h, for a total thrust (all operating engines). */
export function fuelFlowKgPerHour(thrustN: number, mach: number, a: Air): number {
  return thrustN * tsfcKgPerNHour(mach, a);
}

export function idleFuelFlowKgPerHour(a: Air, engines = ENGINE.count): number {
  return engines * (ENGINE.idleFuelA + ENGINE.idleFuelB * a.delta);
}

export const ENGINE_COUNT = ENGINE.count;
export const APU_KG_PER_HOUR = ENGINE.apuKgPerHour;

// ---------------------------------------------------------------------------
// Cruise

export interface CruisePoint {
  mach: number;
  tasKt: number;
  kias: number;
  fuelFlowKgPerHour: number;
  /** Specific air range, nam per kg. */
  narPerKg: number;
  cl: number;
  dragN: number;
}

export function cruise(weightKg: number, mach: number, a: Air, config: Config = CLEAN): CruisePoint {
  const d = dragN(weightKg, mach, a, config);
  const ff = fuelFlowKgPerHour(d, mach, a);
  const tasKt = tasKtFromMach(mach, a);
  return {
    mach,
    tasKt,
    kias: kiasFromMach(mach, a),
    fuelFlowKgPerHour: ff,
    narPerKg: tasKt / ff,
    cl: liftCoefficient(weightKg, mach, a),
    dragN: d,
  };
}

/** Long-range cruise: the Mach above the maximum-range Mach at which the
 * specific range has fallen to 99% of its maximum, capped by MMO − 0.04 and
 * by VMO − 10 KIAS. */
export function longRangeCruise(weightKg: number, a: Air, config: Config = CLEAN): CruisePoint {
  let best: CruisePoint | null = null;
  const maxMach = Math.min(AIRCRAFT.limits.mmo - 0.04, machFromCas((AIRCRAFT.limits.vmoKias - 10) * KT, a.p));
  for (let m = 0.3; m <= maxMach + 1e-9; m += 0.0025) {
    const pt = cruise(weightKg, m, a, config);
    if (!best || pt.narPerKg > best.narPerKg) best = pt;
  }
  if (!best) throw new Error('no cruise solution');
  const target = 0.99 * best.narPerKg;
  let m = best.mach;
  let pt = best;
  while (m + 0.0025 <= maxMach + 1e-9) {
    const next = cruise(weightKg, m + 0.0025, a, config);
    if (next.narPerKg < target) break;
    m += 0.0025;
    pt = next;
  }
  return pt;
}

/** Residual rate of climb, ft/min, at max cruise thrust and the given Mach. */
export function residualClimbFpm(weightKg: number, mach: number, a: Air, thrustN: number, config: Config = CLEAN): number {
  const d = dragN(weightKg, mach, a, config);
  const v = mach * a.a;
  return (((thrustN - d) * v) / (weightKg * G) / FT) * 60;
}

/** Highest weight, kg, that can cruise at `mach` at this level with
 * `residualFpm` of climb in hand at max cruise thrust and inside the buffet
 * margin. Null if even 40,000 kg cannot. */
export function thrustLimitedWeightKg(mach: number, a: Air, residualFpm = 300, config: Config = CLEAN): number | null {
  const thrust = (config.oneInop ? 2 : ENGINE.count) * maxCruiseThrustN(a);
  let lo = 40000;
  let hi = 120000;
  if (residualClimbFpm(lo, mach, a, thrust, config) < residualFpm) return null;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (residualClimbFpm(mid, mach, a, thrust, config) >= residualFpm) lo = mid;
    else hi = mid;
  }
  const v = mach * a.a;
  const buffetWeight = (AERO.buffetCl * 0.5 * a.rho * v * v * AIRCRAFT.wing.areaM2) / G;
  return Math.min(lo, buffetWeight);
}

// ---------------------------------------------------------------------------
// Climb

export interface Leg {
  timeMin: number;
  fuelKg: number;
  distNm: number;
}

export const CLIMB_SCHEDULE = { lowKias: 250, highKias: 300, mach: 0.78, transitionFt: 10000 };
export const DESCENT_SCHEDULE = { mach: 0.8, highKias: 280, lowKias: 250, transitionFt: 10000 };

/** Brake release to 1,500 ft at 250 KIAS: take-off roll, lift-off and the
 * initial climb. A fixed allowance in the Isobar model. */
export const TAKEOFF_ALLOWANCE: Leg = { timeMin: 1.3, fuelKg: 250, distNm: 4 };

/** Climb target speed, TAS m/s, at an altitude for the climb schedule. */
function climbTas(hFt: number, a: Air): number {
  if (hFt < CLIMB_SCHEDULE.transitionFt) return tasFromKias(CLIMB_SCHEDULE.lowKias, a);
  const machAt300 = machFromCas(CLIMB_SCHEDULE.highKias * KT, a.p);
  return Math.min(machAt300, CLIMB_SCHEDULE.mach) * a.a;
}

/** Climb from brake release to a flight level. Null when the aeroplane cannot
 * hold 300 ft/min before reaching the level. Weight is brake-release weight. */
export function climb(brakeReleaseKg: number, toFl: number, isaDevC: number, config: Config = CLEAN): Leg | null {
  const topFt = toFl * 100;
  const startFt = 1500;
  if (topFt <= startFt) return { ...TAKEOFF_ALLOWANCE };
  let w = brakeReleaseKg - TAKEOFF_ALLOWANCE.fuelKg;
  let t = TAKEOFF_ALLOWANCE.timeMin * 60;
  let fuel = TAKEOFF_ALLOWANCE.fuelKg;
  let dist = TAKEOFF_ALLOWANCE.distNm * NM;
  const engines = config.oneInop ? 2 : ENGINE.count;
  const step = 500;
  for (let h = startFt; h < topFt; h += step) {
    const h1 = Math.min(h + step, topFt);
    const hm = 0.5 * (h + h1);
    const a = air(hm, isaDevC);
    const v = climbTas(hm, a);
    const mach = v / a.a;
    const thrust = engines * maxClimbThrustN(a);
    const d = dragN(w, mach, a, config);
    const dvdh = (climbTas(h1, air(h1, isaDevC)) - climbTas(h, air(h, isaDevC))) / ((h1 - h) * FT);
    const accel = 1 + (v / G) * dvdh;
    const roc = ((thrust - d) * v) / (w * G) / accel;
    if (roc < 300 * FT / 60) return null;
    const dt = ((h1 - h) * FT) / roc;
    const ff = fuelFlowKgPerHour(thrust, mach, a) / 3600;
    t += dt;
    dist += v * dt;
    fuel += ff * dt;
    w -= ff * dt;
    // level acceleration at the transition altitude
    if (h < CLIMB_SCHEDULE.transitionFt && h1 >= CLIMB_SCHEDULE.transitionFt) {
      const at = air(CLIMB_SCHEDULE.transitionFt, isaDevC);
      const v1 = tasFromKias(CLIMB_SCHEDULE.lowKias, at);
      const v2 = climbTas(CLIMB_SCHEDULE.transitionFt, at);
      const vm = 0.5 * (v1 + v2);
      const thr = engines * maxClimbThrustN(at);
      const dm = dragN(w, vm / at.a, at, config);
      const dta = ((v2 - v1) * w) / (thr - dm);
      const ffa = fuelFlowKgPerHour(thr, vm / at.a, at) / 3600;
      t += dta;
      dist += vm * dta;
      fuel += ffa * dta;
      w -= ffa * dta;
    }
  }
  return { timeMin: t / 60, fuelKg: fuel, distNm: dist / NM };
}

// ---------------------------------------------------------------------------
// Descent

/** Descent target speed, TAS m/s, for the 0.80 / 280 / 250 profile. */
function descentTas(hFt: number, a: Air): number {
  if (hFt < DESCENT_SCHEDULE.transitionFt) return tasFromKias(DESCENT_SCHEDULE.lowKias, a);
  const machAt280 = machFromCas(DESCENT_SCHEDULE.highKias * KT, a.p);
  return Math.min(machAt280, DESCENT_SCHEDULE.mach) * a.a;
}

/** Idle descent from a flight level to `toFt` (default 1,500 ft) at the
 * standard profile, at a fixed landing weight. */
export function descent(landingKg: number, fromFl: number, isaDevC: number, toFt = 1500): Leg {
  const topFt = fromFl * 100;
  let t = 0;
  let fuel = 0;
  let dist = 0;
  const step = 500;
  const w = landingKg;
  for (let h = topFt; h > toFt; h -= step) {
    const h1 = Math.max(h - step, toFt);
    const hm = 0.5 * (h + h1);
    const a = air(hm, isaDevC);
    const v = descentTas(hm, a);
    const mach = v / a.a;
    const thrust = ENGINE.count * idleThrustN(a);
    const d = dragN(w, mach, a);
    const dvdh = (descentTas(h, air(h, isaDevC)) - descentTas(h1, air(h1, isaDevC))) / ((h - h1) * FT);
    const accel = 1 + (v / G) * dvdh;
    const rod = ((d - thrust) * v) / (w * G) / accel;
    const dt = ((h - h1) * FT) / rod;
    t += dt;
    dist += v * dt;
    fuel += (idleFuelFlowKgPerHour(a) / 3600) * dt;
    if (h > DESCENT_SCHEDULE.transitionFt && h1 <= DESCENT_SCHEDULE.transitionFt) {
      // level deceleration 280 → 250 KIAS at 10,000 ft
      const at = air(DESCENT_SCHEDULE.transitionFt, isaDevC);
      const v1 = descentTas(DESCENT_SCHEDULE.transitionFt + 1, at);
      const v2 = tasFromKias(DESCENT_SCHEDULE.lowKias, at);
      const vm = 0.5 * (v1 + v2);
      const dm = dragN(w, vm / at.a, at);
      const dtd = ((v1 - v2) * w) / (dm - ENGINE.count * idleThrustN(at));
      t += dtd;
      dist += vm * dtd;
      fuel += (idleFuelFlowKgPerHour(at) / 3600) * dtd;
    }
  }
  return { timeMin: t / 60, fuelKg: fuel, distNm: dist / NM };
}

// ---------------------------------------------------------------------------
// Holding

/** Holding speed: 1.12 × minimum-drag speed, clean, never below 210 KIAS. */
export function holding(weightKg: number, a: Air, config: Config = CLEAN): CruisePoint {
  const clMd = Math.sqrt((AERO.cd0 + AERO.flaps[config.flap].dcd + (config.oneInop ? AERO.oneInopDcd : 0)) / K_INDUCED);
  const vMd = Math.sqrt((2 * weightKg * G) / (a.rho * AIRCRAFT.wing.areaM2 * clMd));
  const casMin = 210 * KT;
  const v = Math.max(1.12 * vMd, machFromCas(casMin, a.p) * a.a);
  const mach = v / a.a;
  return cruise(weightKg, mach, a, config);
}

// ---------------------------------------------------------------------------
// One engine inoperative

/** Drift-down speed: 1.05 × minimum-drag speed with the windmilling engine. */
function driftdownTas(weightKg: number, a: Air): number {
  const clMd = Math.sqrt((AERO.cd0 + AERO.oneInopDcd) / K_INDUCED);
  return 1.05 * Math.sqrt((2 * weightKg * G) / (a.rho * AIRCRAFT.wing.areaM2 * clMd));
}

/** One-engine-inoperative ceiling, ft, where two engines at max continuous
 * thrust give 100 ft/min at drift-down speed. Rounded down to 100 ft. */
export function oneInopCeilingFt(weightKg: number, isaDevC: number): number {
  let lo = 0;
  let hi = 40000;
  const ok = (hFt: number) => {
    const a = air(hFt, isaDevC);
    const v = driftdownTas(weightKg, a);
    const thrust = 2 * maxClimbThrustN(a);
    return residualClimbFpm(weightKg, v / a.a, a, thrust, CLEAN_1INOP) >= 100;
  };
  if (!ok(lo)) return 0;
  for (let i = 0; i < 30; i++) {
    const mid = 0.5 * (lo + hi);
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo / 100) * 100;
}

/** Drift-down from a cruise level at max continuous thrust on two engines to
 * the level-off height, 2,000 ft below the one-engine-inoperative ceiling.
 * Weight at failure. */
export function driftdown(weightKg: number, fromFl: number, isaDevC: number): Leg & { ceilingFt: number; levelOffFt: number } {
  const ceiling = oneInopCeilingFt(weightKg, isaDevC);
  const levelOff = Math.max(0, ceiling - 2000);
  let w = weightKg;
  let t = 0;
  let fuel = 0;
  let dist = 0;
  const step = 500;
  for (let h = fromFl * 100; h > levelOff; h -= step) {
    const h1 = Math.max(h - step, levelOff);
    const hm = 0.5 * (h + h1);
    const a = air(hm, isaDevC);
    const v = driftdownTas(w, a);
    const mach = v / a.a;
    const thrust = 2 * maxClimbThrustN(a);
    const d = dragN(w, mach, a, CLEAN_1INOP);
    const rod = Math.max(((d - thrust) * v) / (w * G), 1.5);
    const dt = ((h - h1) * FT) / rod;
    const ff = fuelFlowKgPerHour(thrust, mach, a) / 3600;
    t += dt;
    dist += v * dt;
    fuel += ff * dt;
    w -= ff * dt;
  }
  return { timeMin: t / 60, fuelKg: fuel, distNm: dist / NM, ceilingFt: ceiling, levelOffFt: levelOff };
}

// ---------------------------------------------------------------------------
// Take-off and landing

/** Second-segment lift-to-drag ratio by take-off flap, gear up, V2. Isobar model. */
const SECOND_SEGMENT_LD: Record<number, number> = { 5: 9.6, 15: 8.8, 20: 8.4, 25: 7.9 };
/** Approach-climb L/D (go-around flap for each landing flap). */
const APPROACH_CLIMB_LD: Record<number, number> = { 30: 8.8, 40: 7.9 };

export const TAKEOFF_FLAPS = [5, 15, 25] as const;
export const LANDING_FLAPS = [30, 40] as const;

/** Take-off speeds, KIAS. V2 = 1.23 Vs, VR = V2 − 12, V1 = VR (balanced). */
export function takeoffSpeeds(weightKg: number, flap: number): { v1: number; vr: number; v2: number } {
  const v2 = 1.23 * stallKias(weightKg, flap);
  const vr = v2 - 12;
  return { v1: Math.round(vr), vr: Math.round(vr), v2: Math.round(v2) };
}

export function vrefKias(weightKg: number, flap: number): number {
  return 1.3 * stallKias(weightKg, flap);
}

/** Balanced (CAR) take-off field length, m, zero wind, zero slope.
 * BFL = C0 + C1 · X, X = [W / (ρ S CL_lof)] / [T/W − 0.02 − ¼ CD_lof/CL_lof],
 * T = all-engine thrust at 0.7 V_lof. Calibrated by least squares to the
 * Boeing D6-58324 pages 45–46 chart readings (JT8D-15, standard day and
 * ISA + 13.9 °C) listed in `test/b727-model.test.ts`. */
export function takeoffFieldLengthM(weightKg: number, flap: number, pressureAltFt: number, oatC: number): number {
  const x = takeoffFieldParameter(weightKg, flap, pressureAltFt, oatC);
  return x === null ? Infinity : TAKEOFF_C0 + TAKEOFF_C1 * x;
}

export function takeoffFieldParameter(weightKg: number, flap: number, pressureAltFt: number, oatC: number): number | null {
  const a = air(pressureAltFt, oatC + 273.15 - isaTemperatureK(pressureAltFt));
  const clmax = AERO.flaps[flap].clmax;
  const clLof = clmax / 1.21;
  const vLof = Math.sqrt((2 * weightKg * G) / (a.rho * AIRCRAFT.wing.areaM2 * clLof));
  const mach = (0.7 * vLof) / a.a;
  const thrust = ENGINE.count * takeoffThrustN(a, mach);
  const cdLof = AERO.cd0 + AERO.flaps[flap].dcd + AERO.gearDcd + K_INDUCED * clLof * clLof;
  const accel = thrust / (weightKg * G) - 0.02 - 0.25 * (cdLof / clLof);
  if (accel <= 0.02) return null;
  const x = (weightKg * G) / (a.rho * AIRCRAFT.wing.areaM2 * clLof);
  return x / accel;
}
const TAKEOFF_C0 = 503;
const TAKEOFF_C1 = 0.1483;

/** Field-length-limited take-off weight, kg, for a corrected field length. */
export function fieldLimitedWeightKg(fieldLengthM: number, flap: number, pressureAltFt: number, oatC: number): number {
  let lo = 30000;
  let hi = 120000;
  if (takeoffFieldLengthM(lo, flap, pressureAltFt, oatC) > fieldLengthM) return 0;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (takeoffFieldLengthM(mid, flap, pressureAltFt, oatC) <= fieldLengthM) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Second-segment climb-limited take-off weight, kg: 2.7% gross gradient
 * (three-engine aeroplane, Part 121 MOS 9.05) with one engine inoperative at V2. */
export function climbLimitedWeightKg(flap: number, pressureAltFt: number, oatC: number): number {
  const a = air(pressureAltFt, oatC + 273.15 - isaTemperatureK(pressureAltFt));
  const thrust = (ENGINE.count - 1) * takeoffThrustN(a, 0.23);
  return thrust / (0.027 + 1 / SECOND_SEGMENT_LD[flap]) / G;
}

/** Approach-climb-limited landing weight, kg: 2.4% gradient, one engine
 * inoperative, go-around flap, gear up (Part 121 MOS approach climb for a
 * three-engine aeroplane). */
export function approachClimbLimitedWeightKg(landingFlap: number, pressureAltFt: number, oatC: number): number {
  const a = air(pressureAltFt, oatC + 273.15 - isaTemperatureK(pressureAltFt));
  const thrust = (ENGINE.count - 1) * takeoffThrustN(a, 0.22);
  return thrust / (0.024 + 1 / APPROACH_CLIMB_LD[landingFlap]) / G;
}

/** Factored (CAR, ÷0.6) landing field length, m, dry, zero wind, zero slope.
 * LFL = C0 + C1 · W / (ρ S CL_ref), CL_ref = CLmax / 1.69. Calibrated to
 * Boeing D6-58324 page 53 (flaps 30 and 40, sea level and 8,000 ft). */
export function landingFieldLengthM(weightKg: number, flap: number, pressureAltFt: number, wet = false): number {
  const a = air(pressureAltFt, 0);
  const clRef = AERO.flaps[flap].clmax / 1.69;
  const x = (weightKg * G) / (a.rho * AIRCRAFT.wing.areaM2 * clRef);
  const dry = LANDING_C0 + LANDING_C1 * x;
  return wet ? dry * 1.15 : dry;
}
const LANDING_C0 = 400;
const LANDING_C1 = 0.468;

export function landingFieldLimitedWeightKg(fieldLengthM: number, flap: number, pressureAltFt: number, wet = false): number {
  const a = air(pressureAltFt, 0);
  const clRef = AERO.flaps[flap].clmax / 1.69;
  const dry = wet ? fieldLengthM / 1.15 : fieldLengthM;
  const x = (dry - LANDING_C0) / LANDING_C1;
  return Math.max(0, (x * a.rho * AIRCRAFT.wing.areaM2 * clRef) / G);
}

/** Wind and slope corrections applied to the runway length before entering
 * the field-limit tables. Headwind credit 50%, tailwind penalty 150%.
 * Isobar model. */
export const RUNWAY_CORRECTIONS = {
  takeoff: {
    /** metres of equivalent length per knot of reported headwind */
    headwindMPerKt: 10,
    tailwindMPerKt: -35,
    /** fraction of length per 1% slope, uphill negative */
    slopePerPercent: -0.06,
    lineUpM: 50,
  },
  landing: {
    headwindMPerKt: 8,
    tailwindMPerKt: -40,
    slopePerPercent: 0.04,
  },
};

export function correctedTakeoffLengthM(toraM: number, slopePercent: number, windKt: number): number {
  const c = RUNWAY_CORRECTIONS.takeoff;
  const wind = windKt >= 0 ? windKt * c.headwindMPerKt : -windKt * c.tailwindMPerKt;
  return (toraM - c.lineUpM) * (1 + c.slopePerPercent * slopePercent) + wind;
}

export function correctedLandingLengthM(ldaM: number, slopePercent: number, windKt: number): number {
  const c = RUNWAY_CORRECTIONS.landing;
  const wind = windKt >= 0 ? windKt * c.headwindMPerKt : -windKt * c.tailwindMPerKt;
  return ldaM * (1 + c.slopePerPercent * slopePercent) + wind;
}

// ---------------------------------------------------------------------------
// Weight and balance

/** Arms are metres aft of the Isobar model datum (the nose). Index units:
 * IU = 100 + W·(arm − 21.90) / 500, with W in kg; 21.90 m is 25% MAC. */
export const BALANCE = {
  referenceArmM: 20.75 + 0.25 * 4.595,
  indexOffset: 100,
  indexDivisor: 500,
  zones: {
    A: { rows: '1–6', seats: 36, armM: 10.2 },
    B: { rows: '7–12', seats: 36, armM: 15.3 },
    C: { rows: '13–17', seats: 30, armM: 20.1 },
    D: { rows: '18–22', seats: 30, armM: 24.4 },
    E: { rows: '23–27', seats: 30, armM: 28.7 },
  } as Record<string, { rows: string; seats: number; armM: number }>,
  compartments: {
    1: { hold: 'forward', armM: 12.0, maxKg: 2300, volumeM3: 7.8 },
    2: { hold: 'forward', armM: 16.5, maxKg: 1800, volumeM3: 6.9 },
    4: { hold: 'aft', armM: 27.0, maxKg: 1850, volumeM3: 8.0 },
    5: { hold: 'aft', armM: 30.5, maxKg: 1800, volumeM3: 7.3 },
  } as Record<number, { hold: string; armM: number; maxKg: number; volumeM3: number }>,
  holdFloorKgPerM2: 732,
  tanks: {
    wing: { armM: 22.6 },
    centre: { armM: 21.3 },
    aftAux: { armM: 24.5 },
    fwdAux: { armM: 18.0 },
  },
  crewSeatArmM: 5.5,
  extraCrewKg: 85,
  /** Typical basic weight and index: 46,400 kg at 31% MAC. The rear-engined
   * 727 is tail-heavy empty; passengers and forward freight bring the CG forward. */
  typicalBasicIndex: 125.5,
  /** Isobar company standard weights, kg, including cabin baggage. */
  standardWeights: { adult: 82, adolescent: 60, child: 40, infant: 10, checkedBagKg: 15 },
  /** CG envelope: forward and aft limits, % MAC, by weight. One envelope for
   * take-off, flight and landing. Isobar model. */
  envelope: {
    forward: [
      { kg: 40000, mac: 12 },
      { kg: 70000, mac: 12 },
      { kg: 86700, mac: 16 },
    ],
    aft: [
      { kg: 40000, mac: 36 },
      { kg: 63600, mac: 36 },
      { kg: 86700, mac: 32 },
    ],
  },
};

export function indexUnits(weightKg: number, armM: number): number {
  return (weightKg * (armM - BALANCE.referenceArmM)) / BALANCE.indexDivisor;
}

export function armFromIndex(weightKg: number, totalIndex: number): number {
  return BALANCE.referenceArmM + ((totalIndex - BALANCE.indexOffset) * BALANCE.indexDivisor) / weightKg;
}

export function percentMac(armM: number): number {
  return ((armM - AIRCRAFT.wing.lemacM) / AIRCRAFT.wing.macM) * 100;
}

export function armFromPercentMac(mac: number): number {
  return AIRCRAFT.wing.lemacM + (mac / 100) * AIRCRAFT.wing.macM;
}

/** Fuel distribution by total fuel on board, following the loading order:
 * tanks 1, 2 and 3 equally until 1 and 3 are full, then tank 2, then the aft
 * auxiliary, then the forward auxiliary. */
export function fuelDistribution(totalKg: number): { wingKg: number; centreKg: number; aftAuxKg: number; fwdAuxKg: number } {
  const f = AIRCRAFT.fuel;
  let remaining = Math.max(0, totalKg);
  const equal = Math.min(remaining, 3 * f.tank1Kg);
  let wing = (2 * equal) / 3;
  let centre = equal / 3;
  remaining -= equal;
  const c2 = Math.min(remaining, f.tank2Kg - centre);
  centre += c2;
  remaining -= c2;
  const aft = Math.min(remaining, f.aftAuxKg);
  remaining -= aft;
  const fwd = Math.min(remaining, f.fwdAuxKg);
  return { wingKg: wing, centreKg: centre, aftAuxKg: aft, fwdAuxKg: fwd };
}

/** Index change for a fuel load. */
export function fuelIndex(totalKg: number): number {
  const d = fuelDistribution(totalKg);
  const t = BALANCE.tanks;
  return (
    indexUnits(d.wingKg, t.wing.armM) +
    indexUnits(d.centreKg, t.centre.armM) +
    indexUnits(d.aftAuxKg, t.aftAux.armM) +
    indexUnits(d.fwdAuxKg, t.fwdAux.armM)
  );
}

function limitAt(points: { kg: number; mac: number }[], kg: number): number {
  if (kg <= points[0].kg) return points[0].mac;
  for (let i = 1; i < points.length; i++) {
    if (kg <= points[i].kg) {
      const f = (kg - points[i - 1].kg) / (points[i].kg - points[i - 1].kg);
      return points[i - 1].mac + f * (points[i].mac - points[i - 1].mac);
    }
  }
  return points[points.length - 1].mac;
}

export function cgLimits(weightKg: number): { forwardMac: number; aftMac: number } {
  return {
    forwardMac: limitAt(BALANCE.envelope.forward, weightKg),
    aftMac: limitAt(BALANCE.envelope.aft, weightKg),
  };
}

/** Stabiliser trim, units nose up, by CG and take-off flap. Isobar model. */
export function stabTrimUnits(mac: number, flap: number): number {
  const base = flap === 5 ? 7.6 : flap === 25 ? 8.0 : 7.8;
  return Math.round((base - 0.16 * (mac - 10)) * 4) / 4;
}

export const PARAMETERS = { AERO, ENGINE, K_INDUCED, aspectRatio, TAKEOFF_C0, TAKEOFF_C1, LANDING_C0, LANDING_C1 };
