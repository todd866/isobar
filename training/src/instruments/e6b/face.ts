/** The computer side of the ASA E6-B flight computer, as data.
 *
 * Everything the renderer draws and everything the demos set comes from here,
 * so a second face (the Pooleys CRP-5) can be added as another `Face` without
 * touching the controller. Sources and measurements: SOURCES.md.
 *
 * Geometry is in face units: the fixed outer scale and the rotating middle
 * scale meet at r = 1095. Radii were measured from the 1:1 photograph of the
 * face in the ASA manual (Figure 1, p. 4) so the proportions match the real
 * instrument. Angles are degrees clockwise from 12 o'clock with the disc at 1:1.
 */
import { delta, isaSigma, isaTemp, kelvin, A0_KT, T0 } from './atmosphere.ts';
import { angleOf, graduation } from './slide.ts';

export type Layer = 'base' | 'disc';

export interface Tick { angle: number; length: number }
export interface Label { angle: number; text: string; size: number; weight?: number; boxed?: boolean }

/** A graduated arc. Ticks start at `r` and run outward (`dir` 1) or inward (−1). */
export interface Scale {
  id: string;
  layer: Layer;
  r: number;
  dir: 1 | -1;
  /** Radius of the label baseline centre. */
  labelR: number;
  ticks: Tick[];
  labels: Label[];
  /** Angle of a value on this scale, in its layer's frame. */
  at: (value: number) => number;
  /** Optional readable range for the readout and the tests. */
  range: [number, number];
  unit: string;
}

/** A labelled conversion arrow pointing at a scale. */
export interface Mark {
  id: string;
  layer: Layer;
  /** Position on the 10–100 scale. */
  value: number;
  /** What the value is derived from, for the tests and SOURCES.md. */
  derivation: string;
  /** Angle measured on ASA Figure 1 (p. 4), for the tests. */
  measured: number | null;
  text: string;
  /** Text offset along the arc, degrees (the face prints some labels beside the arrow). */
  textShift: number;
}

/** A cut-out in the disc through which a base scale shows. Disc frame. */
export interface Window { id: string; from: number; to: number; r0: number; r1: number }

/** Free text on a layer, set along an arc (`arc`) or straight (`x`,`y`). */
export interface Text {
  layer: Layer;
  text: string;
  size: number;
  weight?: number;
  arc?: { angle: number; r: number };
  at?: { x: number; y: number };
  anchor?: 'start' | 'middle' | 'end';
  rule?: boolean;
}

export interface Face {
  id: string;
  name: string;
  /** Radii of the visible rings. */
  radius: { base: number; disc: number; hub: number };
  scales: Scale[];
  marks: Mark[];
  windows: Window[];
  texts: Text[];
  /** Fixed indices on the disc used by the procedures. */
  index: { rate: number; unit: number; seconds: number; density: number; mach: number };
  /** Angles the window scales are pinned to (disc at 1:1), measured on Figure 1. */
  anchors: { airspeed: number; altitude: number; density: number; celsius0: number; celsiusPerDeg: number };
}

// --- Measured anchors (ASA Figure 1, disc at 1:1; SOURCES.md) ----------------
/** Airspeed window: disc +15 °C mark = base pressure-altitude 0 mark. */
const AIRSPEED = 37.5;
/** Altitude-correction window: base +15 °C mark = disc pressure-altitude 0 mark. */
const ALTITUDE = -28.0;
/** Density-altitude index (the ▲ between DENSITY and ALTITUDE) on the disc. */
const DENSITY = 47.3;
/** Temperature conversion arc: 0 °C at the bottom, measured 0.742° per °C. */
const CELSIUS0 = 180.0;
const PER_DEG = 0.742;

// --- Window scale laws -------------------------------------------------------
// Airspeed: TAS/CAS = 1/√σ = √(T/T0 / δ). Half-decade (180°) per decade of T and δ.
export const airspeedTempAt = (celsius: number): number => AIRSPEED - 180 * Math.log10(kelvin(celsius) / T0);
export const airspeedAltAt = (pressureAltFt: number): number => AIRSPEED - 180 * Math.log10(delta(pressureAltFt));
// Density altitude: the disc turns −180·log σ; the base DA scale follows the ISA σ.
export const densityAltAt = (densityAltFt: number): number => DENSITY - 180 * Math.log10(isaSigma(densityAltFt));
// Mach index: θ = 360·log a0 + 180·log(T/T0), so the index is fixed on the base.
export const MACH_INDEX = AIRSPEED + 360 * Math.log10(A0_KT);
// Altitude correction: true/calibrated = T / T_ISA(PA). Full decade per decade of T.
export const altitudeTempAt = (celsius: number): number => ALTITUDE + 360 * Math.log10(kelvin(celsius) / T0);
export const altitudeAltAt = (pressureAltFt: number): number => ALTITUDE + 360 * Math.log10(kelvin(isaTemp(pressureAltFt)) / T0);
export const celsiusAt = (celsius: number): number => CELSIUS0 - PER_DEG * celsius;
export const fahrenheitAt = (fahrenheit: number): number => celsiusAt((fahrenheit - 32) / 1.8);

// --- Main log scales ---------------------------------------------------------
/** Tick lengths: [shortest, medium, long]. */
function mainTicks(len: [number, number, number]): Tick[] {
  const ticks: Tick[] = [];
  const push = (value: number, kind: 0 | 1 | 2) => ticks.push({ angle: angleOf(value), length: len[kind] });
  for (let i = 0; i < 1000; i++) {
    const v = Math.round((10 + i * 0.1) * 10) / 10;
    if (v >= 100) break;
    const step = graduation(v);
    const k = Math.round(v / step);
    if (Math.abs(k * step - v) > 1e-6) continue;
    const integer = Math.abs(v - Math.round(v)) < 1e-6;
    let kind: 0 | 1 | 2 = 0;
    if (v < 30) kind = integer ? 2 : (v < 15 && Math.abs(v * 2 - Math.round(v * 2)) < 1e-6 ? 1 : 0);
    else if (v < 60) kind = Math.round(v) % 5 === 0 && integer ? 2 : integer ? 1 : 0;
    else kind = Math.round(v) % 10 === 0 ? 2 : Math.round(v) % 5 === 0 ? 1 : 0;
    push(v, kind);
  }
  return ticks;
}

/** Numerals printed on both main scales: 10–25 every unit, then 30–60 by fives, then 70, 80, 90. */
const NUMERALS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90];

function mainLabels(size: number, skip: number[] = []): Label[] {
  return NUMERALS.filter((value) => !skip.includes(value)).map((value) => ({
    angle: angleOf(value),
    text: String(value),
    size,
    weight: 700,
    boxed: value === 10,
  }));
}

/** HOURS ring under the middle scale: h:mm labels and 5/10-minute ticks. */
const HOURS: [number, string][] = [
  [70, '1:10'], [80, '1:20'], [90, '1:30'], [100, '1:40'], [110, '1:50'], [120, '2:00'],
  [150, '2:30'], [180, '3:00'], [210, '3:30'], [240, '4:00'], [270, '4:30'], [300, '5:00'],
  [360, '6:00'], [420, '7:00'], [480, '8:00'], [540, '9:00'],
];

function hourTicks(): Tick[] {
  const ticks: Tick[] = [];
  for (let minutes = 60; minutes < 600; minutes += minutes < 120 ? 5 : 10) {
    const labelled = HOURS.some(([m]) => m === minutes) || minutes === 60;
    ticks.push({ angle: angleOf(minutes), length: labelled ? 34 : 20 });
  }
  return ticks;
}

function linearTicks(from: number, to: number, step: number, at: (v: number) => number, length: (v: number) => number): Tick[] {
  const ticks: Tick[] = [];
  for (let v = from; v <= to + 1e-9; v += step) ticks.push({ angle: at(v), length: length(v) });
  return ticks;
}

const signed = (v: number): string => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0');

function scales(): Scale[] {
  const outer: Scale = {
    id: 'outer', layer: 'base', r: 1095, dir: 1, labelR: 1186,
    ticks: mainTicks([34, 46, 62]), labels: mainLabels(58), at: angleOf, range: [10, 100], unit: '',
  };
  const middle: Scale = {
    id: 'middle', layer: 'disc', r: 1095, dir: -1, labelR: 1004,
    ticks: mainTicks([34, 46, 62]), labels: mainLabels(58, [60]), at: angleOf, range: [10, 100], unit: '',
  };
  const hours: Scale = {
    id: 'hours', layer: 'disc', r: 952, dir: -1, labelR: 880,
    ticks: hourTicks(),
    labels: HOURS.map(([m, text]) => ({ angle: angleOf(m), text, size: 52, weight: 700 })),
    at: angleOf, range: [60, 600], unit: 'min',
  };
  const tempAirspeed: Scale = {
    id: 'temp-as', layer: 'disc', r: 652, dir: 1, labelR: 722,
    ticks: linearTicks(-60, 50, 5, airspeedTempAt, (v) => (v % 50 === 0 ? 40 : v % 10 === 0 ? 30 : 18)),
    labels: [50, 0, -50].map((v) => ({ angle: airspeedTempAt(v), text: signed(v), size: 40 })),
    at: airspeedTempAt, range: [-60, 50], unit: '°C',
  };
  const altAirspeed: Scale = {
    id: 'pa-as', layer: 'base', r: 650, dir: -1, labelR: 560,
    ticks: linearTicks(0, 40000, 1000, airspeedAltAt, (v) => (v % 5000 === 0 ? 46 : 26)),
    labels: [0, 5, 10, 15, 20, 25, 30, 35, 40].map((k) => ({ angle: airspeedAltAt(k * 1000), text: String(k), size: 46 })),
    at: airspeedAltAt, range: [0, 40000], unit: 'ft',
  };
  const density: Scale = {
    id: 'da', layer: 'base', r: 828, dir: 1, labelR: 878,
    ticks: linearTicks(-5000, 35000, 1000, densityAltAt, (v) => (v % 5000 === 0 ? 28 : 18)),
    labels: [-5, 0, 5, 10, 15, 20, 25, 30, 35].map((k) => ({ angle: densityAltAt(k * 1000), text: k < 0 ? `−${-k}` : String(k), size: 38 })),
    at: densityAltAt, range: [-5000, 35000], unit: 'ft',
  };
  const tempAltitude: Scale = {
    id: 'temp-alt', layer: 'base', r: 706, dir: 1, labelR: 764,
    ticks: linearTicks(-60, 40, 5, altitudeTempAt, (v) => (v % 10 === 0 ? 34 : 22)),
    labels: [-40, -20, 0, 20, 40].map((v) => ({ angle: altitudeTempAt(v), text: signed(v), size: 44 })),
    at: altitudeTempAt, range: [-60, 40], unit: '°C',
  };
  const altAltitude: Scale = {
    id: 'pa-alt', layer: 'disc', r: 704, dir: -1, labelR: 624,
    ticks: linearTicks(0, 30000, 1000, altitudeAltAt, (v) => (v % 10000 === 0 ? 46 : v % 5000 === 0 ? 34 : 22)),
    labels: [0, 10, 20, 30].map((k) => ({ angle: altitudeAltAt(k * 1000), text: String(k), size: 44 })),
    at: altitudeAltAt, range: [0, 30000], unit: 'ft',
  };
  const celsius: Scale = {
    id: 'celsius', layer: 'base', r: 1365, dir: -1, labelR: 1308,
    ticks: linearTicks(-50, 50, 1, celsiusAt, (v) => (v % 10 === 0 ? 30 : v % 5 === 0 ? 22 : 14)),
    labels: [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50].map((v) => ({ angle: celsiusAt(v), text: v === 0 ? '0°C' : signed(v), size: 34 })),
    at: celsiusAt, range: [-50, 50], unit: '°C',
  };
  const fahrenheit: Scale = {
    id: 'fahrenheit', layer: 'base', r: 1365, dir: 1, labelR: 1424,
    ticks: linearTicks(-58, 122, 2, fahrenheitAt, (v) => (v % 20 === 0 ? 30 : v % 10 === 0 ? 22 : 14)).filter((t) => t.angle <= celsiusAt(-50) + 1e-9 && t.angle >= celsiusAt(50) - 1e-9),
    labels: [-60, -40, -20, 0, 20, 40, 60, 80, 100, 120].filter((v) => v >= -58).map((v) => ({ angle: fahrenheitAt(v), text: v === 0 ? '0°F' : signed(v), size: 34 })),
    at: fahrenheitAt, range: [-58, 122], unit: '°F',
  };
  return [outer, middle, hours, tempAirspeed, altAirspeed, density, tempAltitude, altAltitude, celsius, fahrenheit];
}

// --- Conversion arrows -------------------------------------------------------
// Each family's relative positions follow exact unit definitions. One anchor per
// family was fitted to Figure 1 (SOURCES.md): NAUT at 66, US GAL at 12.8
// (128 US fl oz), KG at 16.65, FT at 14.33.
const NM_KM = 1.852;
const SM_KM = 1.609344;
const LB_KG = 0.45359237;
const USGAL_L = 3.785411784;
const IMPGAL_L = 4.54609;
const FT_M = 0.3048;

const NAUT = 66;
const STAT = NAUT * NM_KM / SM_KM;
const KM = NAUT * NM_KM / 10;
const USGAL = 12.8;
const IMPGAL = USGAL * USGAL_L / IMPGAL_L;
const LITERS = USGAL * USGAL_L;
/** Avgas 6 lb per US gallon and oil 7.5 lb per US gallon (manual p. 16). */
const FUEL_LBS = USGAL * 6;
const OIL_LBS = USGAL * 7.5;
const KG = 16.65;
const LBS = KG / LB_KG;
const FT = 14.33;
const METERS = FT * FT_M * 10;

function marks(): Mark[] {
  const m = (id: string, layer: Layer, value: number, derivation: string, measured: number | null, text: string, textShift = 0): Mark =>
    ({ id, layer, value, derivation, measured, text, textShift });
  return [
    m('naut', 'base', NAUT, 'anchor 66', 295.06, 'NAUT'),
    m('stat', 'base', STAT, 'NAUT × 1.852 / 1.609344', 317.04, 'STAT', -2.2),
    m('km', 'base', KM, 'NAUT × 1.852', 31.72, 'KM'),
    m('imp-gal', 'base', IMPGAL, 'US GAL × 3.785411784 / 4.54609', 10.18, 'IMP. GAL.'),
    m('us-gal', 'base', USGAL, 'anchor 12.8 (128 US fl oz)', 38.88, 'U.S. GAL.'),
    m('liters', 'base', LITERS, 'US GAL × 3.785411784', 246.96, 'LITERS'),
    m('fuel-lbs', 'base', FUEL_LBS, 'US GAL × 6 lb (avgas)', 318.86, 'FUEL LBS.', 3.6),
    m('oil-lbs', 'base', OIL_LBS, 'US GAL × 7.5 lb (oil)', 353.74, 'OIL LBS.'),
    m('lbs', 'base', LBS, 'KG / 0.45359237', 203.58, 'LBS.'),
    m('ft', 'base', FT, 'anchor 14.33', 56.16, 'FT'),
    m('statute', 'disc', STAT, 'NAUT × 1.852 / 1.609344', 317.04, 'STATUTE', -4.2),
    m('km-mid', 'disc', KM, 'NAUT × 1.852', 31.48, 'KM', 3.6),
    m('imp-gal-mid', 'disc', IMPGAL, 'US GAL × 3.785411784 / 4.54609', 10.0, 'IMP. GAL.', -1.6),
    m('us-gal-mid', 'disc', USGAL, 'anchor 12.8', 38.88, 'U.S. GAL', 6.2),
    m('liters-mid', 'disc', LITERS, 'US GAL × 3.785411784', 246.84, 'LITERS', -1.8),
    m('kg', 'disc', KG, 'anchor 16.65', 79.44, 'KG', -1.6),
    m('meters', 'disc', METERS, 'FT × 0.3048', 230.16, 'METERS', -2.6),
    m('seconds', 'disc', 36, '3 600 s per hour', 200.88, 'SECONDS', 4.4),
  ];
}

function texts(): Text[] {
  const arc = (layer: Layer, text: string, angle: number, r: number, size: number, weight = 500): Text =>
    ({ layer, text, size, weight, arc: { angle, r } });
  return [
    arc('base', 'E6-B  FLIGHT  COMPUTER', 0, 1330, 82, 800),
    arc('base', 'TEMPERATURE CONVERSION SCALE', 180, 1262, 30, 600),
    arc('base', 'DISTANCE', 286, 1250, 30), arc('base', 'FUEL', 271.5, 1250, 30),
    arc('base', 'TRUE ALT', 259.5, 1250, 30), arc('base', 'TAS', 154.5, 1250, 30),
    arc('disc', 'TIME', 286, 1004, 30), arc('disc', 'CAL ALT', 258.5, 1004, 30), arc('disc', 'CAS', 154.5, 1004, 30),
    arc('disc', 'HOURS', angleOf(33), 880, 34, 600),
    arc('disc', '◂  AIR TEMPERATURE °C  ▸', 2, 722, 32),
    arc('disc', '◂  PRESSURE ALTITUDE  ▸', 1, 640, 32),
    arc('disc', 'THOUSANDS OF FEET', 1, 596, 32),
    { layer: 'disc', text: 'ALTITUDE CORRECTION', size: 36, weight: 800, at: { x: -400, y: 64 }, anchor: 'middle' },
    { layer: 'disc', text: 'Set PRESS. ALT. opposite °C', size: 30, at: { x: -400, y: 118 }, anchor: 'middle' },
    { layer: 'disc', text: 'in window. Opposite CAL. ALT.', size: 30, at: { x: -400, y: 156 }, anchor: 'middle' },
    { layer: 'disc', text: 'on inner circle read TRUE ALT.', size: 30, at: { x: -400, y: 194 }, anchor: 'middle' },
    { layer: 'disc', text: 'on outer scale.', size: 30, at: { x: -400, y: 232 }, anchor: 'middle' },
    { layer: 'disc', text: 'AIRSPEED CORRECTION', size: 36, weight: 800, at: { x: 400, y: 64 }, anchor: 'middle' },
    { layer: 'disc', text: 'Set PRESS. ALT. opposite °C in', size: 30, at: { x: 400, y: 118 }, anchor: 'middle' },
    { layer: 'disc', text: 'window. Opposite CAS on inner', size: 30, at: { x: 400, y: 156 }, anchor: 'middle' },
    { layer: 'disc', text: 'scale read TAS on outer scale.', size: 30, at: { x: 400, y: 194 }, anchor: 'middle' },
    { layer: 'disc', text: 'Read DENSITY ALT. center ▲', size: 30, at: { x: 400, y: 232 }, anchor: 'middle' },
    { layer: 'disc', text: 'SET MPH (KTS) = DIST. (OUTER)', size: 32, at: { x: 0, y: 380 }, anchor: 'middle' },
    { layer: 'disc', text: '▲              TIME (INNER)', size: 32, at: { x: 40, y: 424 }, anchor: 'middle', rule: true },
    { layer: 'disc', text: 'SET GAL./HR. = TOTAL GAL. (OUTER)', size: 32, at: { x: 0, y: 500 }, anchor: 'middle' },
    { layer: 'disc', text: '▲              TIME (INNER)', size: 32, at: { x: 40, y: 544 }, anchor: 'middle', rule: true },
  ];
}

export const E6B: Face = {
  id: 'e6b',
  name: 'E6-B flight computer, computer side (after the ASA E6-B)',
  radius: { base: 1480, disc: 1095, hub: 70 },
  scales: scales(),
  marks: marks(),
  windows: [
    { id: 'airspeed', from: 23, to: 71, r0: 516, r1: 652 },
    { id: 'density', from: 34.5, to: 57.5, r0: 826, r1: 912 },
    { id: 'altitude', from: -66, to: -23, r0: 706, r1: 814 },
  ],
  texts: texts(),
  index: { rate: 60, unit: 10, seconds: 36, density: DENSITY, mach: MACH_INDEX },
  anchors: { airspeed: AIRSPEED, altitude: ALTITUDE, density: DENSITY, celsius0: CELSIUS0, celsiusPerDeg: PER_DEG },
};

export const UNITS = { NM_KM, SM_KM, LB_KG, USGAL_L, IMPGAL_L, FT_M };

export function scale(face: Face, id: string): Scale {
  const found = face.scales.find((item) => item.id === id);
  if (!found) throw new Error(`no scale ${id}`);
  return found;
}

export function mark(face: Face, id: string): Mark {
  const found = face.marks.find((item) => item.id === id);
  if (!found) throw new Error(`no mark ${id}`);
  return found;
}
