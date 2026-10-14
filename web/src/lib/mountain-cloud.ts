/**
 * Small parcel model for cloud from a supplied displacement (the mountain-wave
 * solver's η). Not a forecast or CFD solver. Saturation is calculated over liquid water;
 * below-freezing ice/mixed-phase effects are outside this bounded model.
 */
export interface MountainCloudInput {
  temperatureC: number;
  rhPct: number;
  pressureHPa: number;
  liftM: number;
  stabilityN2: number;
  heightAboveGroundM: number;
  windSpeedMs: number;
}

export interface MountainCloudResult {
  condensateGKg: number;
  density: number;
  kind: "clear" | "orographic" | "wave" | "convective";
  saturated: boolean;
  lclM: number;
  liftedTemperatureC: number;
  mixingRatioGKg: number;
}

const GRAVITY = 9.80665;
const CP = 1004;
const RD = 287.05;
const RV = 461.5;
const LATENT_HEAT = 2.5e6;
const EPSILON = RD / RV;
const MAX_CONDENSATE = 8;
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));
const finite = (value: number) => Number.isFinite(value);

export function saturationVapourHPa(temperatureC: number): number {
  return 6.112 * Math.exp((17.67 * temperatureC) / (temperatureC + 243.5));
}
function dewpointC(temperatureC: number, rhPct: number): number {
  const rh = clamp(rhPct, 0.1, 100) / 100;
  const gamma = Math.log(rh) + (17.67 * temperatureC) / (temperatureC + 243.5);
  return (243.5 * gamma) / (17.67 - gamma);
}
function mixingRatioGKg(
  temperatureC: number,
  pressureHPa: number,
  rhPct: number,
): number {
  const vapour =
    saturationVapourHPa(temperatureC) * (clamp(rhPct, 0, 100) / 100);
  return (1000 * 0.622 * vapour) / Math.max(1, pressureHPa - vapour);
}

export function sampleMountainCloud(
  input: MountainCloudInput,
): MountainCloudResult {
  if (
    !Object.values(input).every(finite) ||
    input.temperatureC < -100 ||
    input.temperatureC > 60 ||
    input.pressureHPa < 50 ||
    input.pressureHPa > 1100 ||
    input.windSpeedMs < 0
  )
    throw new Error(
      "mountain cloud inputs must be finite and physically bounded",
    );
  const rh = clamp(input.rhPct, 0, 100);
  const initialMix = mixingRatioGKg(input.temperatureC, input.pressureHPa, rh);
  const dewpoint = dewpointC(input.temperatureC, Math.max(0.1, rh));
  const lclM = Math.max(0, 125 * (input.temperatureC - dewpoint));
  const liftM = clamp(input.liftM, 0, 5000);
  const dryLift =
    Math.min(liftM, lclM) + Math.max(-5000, Math.min(0, input.liftM));
  const moistLift = Math.max(0, liftM - lclM);
  let liftedTemperatureC = input.temperatureC - dryLift * 0.0098;
  let liftedPressure = input.pressureHPa * Math.exp(-dryLift / 8000);
  // Integrate in <=100m steps. Cold saturated air approaches the dry lapse
  // rate; warm saturated air releases more latent heat.
  const steps = Math.max(1, Math.ceil(moistLift / 100)),
    dz = moistLift / steps;
  for (let i = 0; i < steps; i++) {
    const kelvin = liftedTemperatureC + 273.15;
    const q = mixingRatioGKg(liftedTemperatureC, liftedPressure, 100) / 1000;
    const latent = 2.5e6;
    const lapse =
      (9.80665 * (1 + (latent * q) / (287.05 * kelvin))) /
      (1004 + (latent * latent * q * 0.622) / (287.05 * kelvin * kelvin));
    liftedTemperatureC -= lapse * dz;
    liftedPressure *= Math.exp((-9.80665 * dz) / (287.05 * kelvin));
  }
  const saturatedMix = mixingRatioGKg(liftedTemperatureC, liftedPressure, 100);
  const condensateGKg = clamp(initialMix - saturatedMix, 0, MAX_CONDENSATE);
  const saturated = condensateGKg > 0.02 && liftM >= lclM;
  const stable = input.stabilityN2 > 1e-5;
  const kind = !saturated
    ? "clear"
    : stable && input.windSpeedMs >= 8 && input.heightAboveGroundM > 100
      ? "wave"
      : input.stabilityN2 <= 0 && liftM > 300
        ? "convective"
        : "orographic";
  return {
    condensateGKg,
    // Optical density is a rendering hint: 0.15 g/kg is already a visible cloud.
    density: saturated ? clamp(1 - Math.exp(-condensateGKg / 0.15), 0, 1) : 0,
    kind,
    saturated,
    lclM,
    liftedTemperatureC,
    mixingRatioGKg: initialMix,
  };
}
