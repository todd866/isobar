/** ICAO standard atmosphere in the units the flight computer uses: feet, °C, knots.
 * Troposphere to 36 089 ft and the isothermal layer above it (to 65 617 ft).
 * Constants: ICAO Doc 7488. These are the exact answers the slide rule is checked against.
 */

export const T0 = 288.15;
/** K per ft (6.5 K/km). */
export const LAPSE = 0.0065 * 0.3048;
export const TROPOPAUSE_FT = 11000 / 0.3048;
export const T_TROP = 216.65;
/** g·M/(R·L), the troposphere pressure exponent. */
export const EXP = 5.255876;
/** Speed of sound at T0 in knots (340.294 m/s). */
export const A0_KT = 340.29399 / (1852 / 3600);
const DELTA_TROP = (T_TROP / T0) ** EXP;
/** Scale height of the isothermal layer, ft: R·T/g. */
const H_STRAT = (287.05287 * T_TROP) / 9.80665 / 0.3048;

export const kelvin = (celsius: number): number => celsius + 273.15;

/** ISA temperature at a pressure altitude, °C. */
export function isaTemp(pressureAltFt: number): number {
  const kelvins = pressureAltFt < TROPOPAUSE_FT ? T0 - LAPSE * pressureAltFt : T_TROP;
  return kelvins - 273.15;
}

/** Pressure ratio p/p0 at a pressure altitude. */
export function delta(pressureAltFt: number): number {
  if (pressureAltFt < TROPOPAUSE_FT) return (1 - (LAPSE / T0) * pressureAltFt) ** EXP;
  return DELTA_TROP * Math.exp(-(pressureAltFt - TROPOPAUSE_FT) / H_STRAT);
}

/** Density ratio from pressure altitude and outside air temperature. */
export function sigma(pressureAltFt: number, oatC: number): number {
  return delta(pressureAltFt) * T0 / kelvin(oatC);
}

/** The ISA density ratio at an altitude: σ of the standard day. */
export function isaSigma(altitudeFt: number): number {
  return delta(altitudeFt) * T0 / kelvin(isaTemp(altitudeFt));
}

/** Density altitude: the ISA altitude with this density ratio. */
export function densityAltitude(densityRatio: number): number {
  const sigmaTrop = DELTA_TROP * T0 / T_TROP;
  if (densityRatio >= sigmaTrop) return (T0 / LAPSE) * (1 - densityRatio ** (1 / (EXP - 1)));
  return TROPOPAUSE_FT - H_STRAT * Math.log(densityRatio / sigmaTrop);
}

/** TAS from CAS treating the air as incompressible (CAS taken as EAS):
 * TAS = CAS / √σ. This is the relation the E6-B airspeed window embodies. */
export function tasIncompressible(casKt: number, pressureAltFt: number, oatC: number): number {
  return casKt / Math.sqrt(sigma(pressureAltFt, oatC));
}

/** Exact subsonic TAS from CAS, with compressibility (St Venant): the answer an ADC gives. */
export function tasCompressible(casKt: number, pressureAltFt: number, oatC: number): number {
  const impact = (1 + 0.2 * (casKt / A0_KT) ** 2) ** 3.5 - 1; // qc / p0
  const mach = Math.sqrt(5 * ((impact / delta(pressureAltFt) + 1) ** (2 / 7) - 1));
  return mach * speedOfSound(oatC);
}

/** Local speed of sound in knots. */
export function speedOfSound(oatC: number): number {
  return A0_KT * Math.sqrt(kelvin(oatC) / T0);
}

/** True altitude above the station by the computer's method: the calibrated height
 * above the station scaled by actual over ISA temperature at the pressure altitude. */
export function trueHeightComputer(calHeightFt: number, pressureAltFt: number, oatC: number): number {
  return calHeightFt * kelvin(oatC) / kelvin(isaTemp(pressureAltFt));
}
