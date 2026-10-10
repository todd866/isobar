/**
 * Small, deterministic atmosphere models for teaching and visual exploration.
 * These are synthetic fields, not a forecast or a CFD solution.  Coordinates
 * are local metres from context.lat/context.lon (u=east, v=north, w=up), and
 * heightM is metres above mean sea level while groundM is the local floor.
 */
import { sampleMountainCloud, saturationVapourHPa } from './mountain-cloud';

export type TeachingScenario = 'circulation' | 'sea-breeze' | 'thunderstorm' | 'mountain-wave';

export interface TeachingAtmosphereContext {
  kind: TeachingScenario;
  lat: number;
  lon: number;
  groundM: number;
  timeMs: number;
}

export interface TeachingAtmosphereSample {
  u: number;
  v: number;
  w: number;
  temperatureC: number;
  rhPct: number;
  pressureHPa: number;
  stabilityN2: number;
  cloudPct: number;
  density: number;
  cloudBaseM: number;
}

const PI = Math.PI;
const DEG = PI / 180;
const EARTH_M = 111_320;
const G = 9.80665;
const RD = 287.05;
const MAX_Z = 12_000;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const finite = (x: number) => Number.isFinite(x);

function localMetres(context: TeachingAtmosphereContext, lat: number, lon: number) {
  const cosLat = Math.max(0.2, Math.cos(context.lat * DEG));
  const shortestLon = ((lon - context.lon + 540) % 360) - 180;
  return {
    x: shortestLon * EARTH_M * cosLat,
    y: (lat - context.lat) * EARTH_M,
  };
}

function baseProfile(z: number, ground: number, warm = 0, rhOffset = 0) {
  const lapse = 0.0065;
  const amsl = ground + z;
  const t = clamp(24 + warm - lapse * amsl,-90,50);
  const pressure = clamp(1013.25 * Math.exp(-G * amsl / (RD * (t + 273.15))),50,1100);
  const rh = clamp(78 + rhOffset - 0.0018 * z, 28, 96);
  const density = (pressure * 100) / (RD * (t + 273.15));
  return { temperatureC: t, pressureHPa: pressure, rhPct: rh, density, ground };
}

function cloudFromParcel(
  profile: ReturnType<typeof baseProfile>,
  z: number,
  stabilityN2: number,
  liftM: number,
  windSpeedMs: number,
) {
  const parcel = sampleMountainCloud({
    temperatureC: profile.temperatureC,
    rhPct: profile.rhPct,
    pressureHPa: profile.pressureHPa,
    liftM: clamp(liftM, -5000, 5000),
    stabilityN2,
    heightAboveGroundM: z,
    windSpeedMs: Math.max(0, windSpeedMs),
  });
  return {
    cloudPct: parcel.saturated ? 100 * parcel.density : 0,
    density: parcel.saturated ? parcel.density : 0,
    // Keep the public field finite even for a clear parcel; callers can use
    // cloudPct===0 to distinguish this diagnostic height from a cloud base.
    cloudBaseM: parcel.lclM,
    temperatureC: parcel.liftedTemperatureC,
    mixingRatioGKg: parcel.mixingRatioGKg,
    saturated: parcel.saturated,
  };
}

/** Sample one bounded pedagogical atmosphere. All outputs are finite. */
export function sampleTeachingAtmosphere(
  context: TeachingAtmosphereContext,
  lat: number,
  lon: number,
  heightM: number,
): TeachingAtmosphereSample {
  const safeContext = {
    ...context,
    lat: finite(context.lat) ? context.lat : 0,
    lon: finite(context.lon) ? context.lon : 0,
    groundM: finite(context.groundM) ? context.groundM : 0,
    timeMs: finite(context.timeMs) ? context.timeMs : 0,
  };
  const ground = safeContext.groundM;
  const z = clamp((finite(heightM) ? heightM : ground) - ground, 0, MAX_Z);
  const { x, y } = localMetres(safeContext, finite(lat) ? lat : safeContext.lat, finite(lon) ? lon : safeContext.lon);
  // One smooth diurnal factor gives sea-breeze teaching a visible daily cue;
  // it is anchored to the supplied time, so replaying the same time is stable.
  const localSolarMs = safeContext.timeMs + safeContext.lon * 240_000;
  const dayPhase = 2 * PI * ((localSolarMs / 86_400_000) - 0.25);
  const daylight = 0.5 + 0.5 * Math.sin(dayPhase);
  let u = 0;
  let v = 0;
  let w = 0;
  let stabilityN2 = 0.00008;
  let liftM = 0;
  let windSpeed = 5;
  const H = 2500;
  let lid = H;

  if (safeContext.kind === 'sea-breeze') {
    // Ocean is west (x<0), land east (x>0). A streamfunction S(x)sin²(pi z/H)
    // closes both at floor and lid: u=∂ψ/∂z, w=-∂ψ/∂x. It therefore gives
    // onshore lower flow, offshore return flow, land-side rise and ocean-side
    // descent without injecting mass through either boundary.
    const L = 6_000;
    const S = Math.exp(-(x * x) / (L * L));
    const dSdx = (-2 * x / (L * L)) * S;
    const vertical = Math.sin(PI * z / H) ** 2;
    const amplitude = 8 * (0.65 + 0.35 * daylight);
    u = amplitude * S * Math.sin(2 * PI * z / H);
    w = -(amplitude * H / PI) * dSdx * vertical;
    stabilityN2 = 0.00006;
    windSpeed = Math.abs(u) + 1;
    liftM = 700 * S * vertical;
  } else if (safeContext.kind === 'thunderstorm') {
    // A closed axisymmetric convective cell centred at the anchor, roughly
    // 10 km high. This streamfunction pair is analytically divergence-free:
    // w=A f(r)sin(pi z/H), vr=-A*pi/H*cos(pi z/H)*(r/2)e^-r²/L²,
    // where f(r)=(1-r²/L²)e^-r²/L². Convergence below mid-level and
    // divergence above it are the two signs of the same radial velocity.
    const top = 10_000;
    lid = top;
    const q = clamp(z / top, 0, 1);
    const L = 5000;
    const r2 = x * x + y * y;
    const radialGaussian = Math.exp(-r2 / (L * L));
    const f = (1 - r2 / (L * L)) * radialGaussian;
    const vertical = Math.sin(PI * q);
    const radial = -9 * PI / top * Math.cos(PI * q) * 0.5 * Math.sqrt(r2) * radialGaussian;
    w = 9 * f * vertical;
    u = r2 > 0 ? radial * x / Math.sqrt(r2) : 0;
    v = r2 > 0 ? radial * y / Math.sqrt(r2) : 0;
    stabilityN2 = q < 0.65 ? -0.00008 : 0.00012;
    windSpeed = Math.hypot(u, v) + 4;
    // Prescribed stationary displacement, not advected storm microphysics.
    // Condensate depends on displacement and source moisture, not the sign of w.
    // A prescribed moist plume spreads in the upper divergent branch. This
    // stationary anvil envelope is illustrative, not resolved ice microphysics.
    const outflow = clamp((z-6500)/3000,0,1);
    const plumeRadius=2500*(1+2.2*outflow*outflow*(3-2*outflow));
    liftM = Math.min(z,3000)*Math.exp(-r2/(plumeRadius*plumeRadius));
  } else if (safeContext.kind === 'mountain-wave') {
    // Idealised ridge runs north/south at x=0; a stable westerly crosses it.
    // Phase is stationary and tied to the ridge, while the weak time term only
    // represents a deterministic, slowly varying background wind.
    const wavelength = 12_000;
    lid = MAX_Z;
    const phase = (2 * PI * x) / wavelength + (z / 7000) * PI;
    const verticalTaper = Math.sin(PI * z / MAX_Z) ** 2;
    const horizontalDecay = Math.exp(-(x * x) / (130_000 * 130_000));
    const k = 2 * PI / wavelength;
    const m = PI / 7000;
    const displacement = 900 * Math.cos(phase) * verticalTaper * horizontalDecay;
    const dEtaDx = 900 * verticalTaper * horizontalDecay *
      (-k * Math.sin(phase) - 2 * x * Math.cos(phase) / (130_000 * 130_000));
    const taperDerivative = (PI / MAX_Z) * Math.sin(2 * PI * z / MAX_Z);
    const dEtaDz = 900 * horizontalDecay *
      (-m * Math.sin(phase) * verticalTaper + Math.cos(phase) * taperDerivative);
    const meanU = 16 + 1.2 * Math.sin(dayPhase);
    u = meanU - meanU * dEtaDz;
    w = meanU * dEtaDx;
    v = 0.4 * Math.sin(phase + PI / 2) * verticalTaper * horizontalDecay;
    stabilityN2 = 0.00035;
    windSpeed = Math.max(1, Math.abs(u));
    liftM = displacement;
  } else {
    // Generic local circulation uses the same divergence-free axisymmetric
    // cell as the storm, with a wider, weaker envelope and no cloud sheet.
    const L = 6_000;
    const cellH = 10_000;
    lid = cellH;
    const r2 = x * x + y * y;
    const gaussian = Math.exp(-r2 / (L * L));
    const f = (1 - r2 / (L * L)) * gaussian;
    const q = z / cellH;
    const radial = -3 * PI / cellH * Math.cos(PI * q) * 0.5 * Math.sqrt(r2) * gaussian;
    u = r2 > 0 ? radial * x / Math.sqrt(r2) : 0;
    v = r2 > 0 ? radial * y / Math.sqrt(r2) : 0;
    w = 3 * f * Math.sin(PI * q);
    stabilityN2 = 0.0001;
    windSpeed = Math.hypot(u, v) + 1;
    liftM = 600 * f * (1 - Math.cos(PI * q)) / 2;
  }

  const profile = baseProfile(
    z,
    ground,
    safeContext.kind === 'thunderstorm' ? 1 : 0,
    safeContext.kind === 'thunderstorm' ? 12 : safeContext.kind === 'mountain-wave' ? 8 : 0,
  );
  // Clouding is evaluated from a parcel origin below/above the destination,
  // then lifted by the explicit synthetic displacement field.
  const originZ = clamp(z - liftM, 0, MAX_Z);
  const originProfile = baseProfile(
    originZ,
    ground,
    safeContext.kind === 'thunderstorm' ? 1 : 0,
    safeContext.kind === 'thunderstorm' ? 12 : safeContext.kind === 'mountain-wave' ? 8 : 0,
  );
  const cloud = cloudFromParcel(originProfile, z, stabilityN2, liftM, windSpeed);
  const lidFade=1-clamp((z-(lid-500))/500,0,1);
  const belowGround = finite(heightM) && heightM < ground;
  const aboveLid = z >= lid;
  return {
    u: belowGround || aboveLid ? 0 : u,
    v: belowGround || aboveLid ? 0 : v,
    w: belowGround || aboveLid ? 0 : w,
    temperatureC: cloud.temperatureC,
    rhPct: cloud.saturated ? 100 : clamp(100 * (cloud.mixingRatioGKg * profile.pressureHPa / (622 + cloud.mixingRatioGKg)) / saturationVapourHPa(cloud.temperatureC),0,100),
    pressureHPa: profile.pressureHPa,
    stabilityN2,
    cloudPct: belowGround || aboveLid ? 0 : cloud.cloudPct*lidFade,
    density: belowGround || aboveLid ? 0 : cloud.density*lidFade,
    cloudBaseM: belowGround ? ground : ground + originZ + cloud.cloudBaseM,
  };
}
