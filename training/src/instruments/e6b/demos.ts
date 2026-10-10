/** Guided demonstrations. Each is a sequence of disc settings, cursor positions,
 * highlighted marks and one-line instructions, built from the face geometry. The
 * final reading is taken off the simulated scales, as a person would read it,
 * and compared with the exact answer and the official manual's printed answer.
 *
 * Page numbers are those printed in ASA, "E6-B Flight Computer Instructions"
 * (ASA-E6B-BK, © 1992–2026), asa2fly.com/content/support-files/product-manuals/E6B_Manual.pdf.
 */
import { densityAltitude, sigma, speedOfSound, tasCompressible, tasIncompressible, trueHeightComputer } from './atmosphere.ts';
import { E6B, mark, scale, type Face } from './face.ts';
import { HIGH_SPEED_SLIDE, SLIDE, computeHeading, computeWind, solveHeading, solveWind, wrap360, type WindState } from './wind.ts';
import { angleOf, hmm, middleOpposite, norm, outerOpposite, placeDecade, readAsPerson, rotationFor, scaleTolerance, turn } from './slide.ts';

export type Highlight =
  | { kind: 'wind'; id: 'index' | 'grommet' | 'dot' }
  | { kind: 'arc'; value: number }
  | { kind: 'scale'; scale: string; value: number }
  | { kind: 'mark'; id: string }
  | { kind: 'index'; id: 'rate' | 'unit' | 'density' | 'mach' | 'seconds' };

export interface Step {
  say: string;
  /** Disc angle, degrees clockwise from 1:1. */
  theta: number;
  /** Cursor angle in the fixed frame, or null to leave it. */
  cursor: number | null;
  highlights: Highlight[];
  /** Wind-side setting: plate azimuth at the index, ground-speed arc at the grommet, pencil dot (plate frame). */
  wind?: WindState;
  /** The disc only has to be roughly right (an index brought into a window); the next step sets it exactly. */
  loose?: boolean;
}

export interface Result {
  label: string;
  /** What a careful reader takes off the scale. */
  read: number;
  /** The exact answer the scale is approximating. */
  exact: number;
  /** ± one graduation (plus window setting error where a window is used). */
  tolerance: number;
  unit: string;
  format: (value: number) => string;
  /** The manual's printed answer, where the demo is a manual example. */
  manual?: { value: number; page: string; note?: string };
  /** A further exact answer the instrument does not model (compressibility, trig). */
  physics?: { label: string; value: number };
}

export interface Demo {
  id: string;
  title: string;
  cite: string;
  steps: Step[];
  results: Result[];
}

const kt = (v: number) => `${Math.round(v)} kt`;
const round1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en-AU');
const ft = (v: number) => `${Math.round(v).toLocaleString('en-AU')} ft`;
const deg = (v: number) => `${round1(v)}°`;

/** Read the outer scale opposite a middle value, as a person would, in the decade of `estimate`. */
function readOuter(middleValue: number, theta: number, estimate: number): number {
  return readAsPerson(placeDecade(outerOpposite(middleValue, theta), estimate));
}

function readMiddle(outerValue: number, theta: number, estimate: number): number {
  return readAsPerson(placeDecade(middleOpposite(outerValue, theta), estimate));
}

/** Window settings carry a setting error of about 1 °C (0.2 %), so allow 0.3 % more. */
const windowTol = (value: number): number => scaleTolerance(value) + Math.abs(value) * 0.003;

// --- (a) time from groundspeed and distance -----------------------------------
export interface TsdParams { gs: number; dist: number }
export function tsdDemo(p: TsdParams, face: Face = E6B, manual?: Result['manual']): Demo {
  const theta = rotationFor(p.gs, 60);
  const exact = (p.dist / p.gs) * 60;
  const read = readMiddle(p.dist, theta, exact);
  return {
    id: 'tsd', title: 'Time en route', cite: manual ? `Manual p. ${manual.page}` : 'Same method as manual p. 8',
    steps: [
      { say: `Set the 60 RATE arrow under ${p.gs} kt on the outer scale.`, theta, cursor: null,
        highlights: [{ kind: 'index', id: 'rate' }, { kind: 'scale', scale: 'outer', value: p.gs }] },
      { say: `Find the distance, ${p.dist} NM, on the outer scale.`, theta, cursor: angleOf(p.dist),
        highlights: [{ kind: 'scale', scale: 'outer', value: p.dist }] },
      { say: `Read the time opposite it: ${Math.round(read)} min on the middle scale, ${hmm(read)} on the HOURS ring.`, theta, cursor: angleOf(p.dist),
        highlights: [{ kind: 'scale', scale: 'middle', value: read }, { kind: 'scale', scale: 'outer', value: p.dist }] },
    ],
    results: [{ label: 'Time', read, exact, tolerance: Math.max(scaleTolerance(exact), 1), unit: 'min', format: hmm, manual }],
  };
}

// --- (b) fuel used from flow and time ---------------------------------------------
export interface FuelParams { rate: number; minutes: number; unit: string }
export function fuelDemo(p: FuelParams, face: Face = E6B, manual?: Result['manual']): Demo {
  const theta = rotationFor(p.rate, 60);
  const exact = (p.rate * p.minutes) / 60;
  const read = readOuter(p.minutes, theta, exact);
  return {
    id: 'fuel', title: 'Fuel used', cite: manual ? `Manual p. ${manual.page}` : 'Same method as manual p. 11–12',
    steps: [
      { say: `Set the 60 RATE arrow under the flow, ${p.rate} ${p.unit}/h.`, theta, cursor: null,
        highlights: [{ kind: 'index', id: 'rate' }, { kind: 'scale', scale: 'outer', value: p.rate }] },
      { say: `Find the time, ${hmm(p.minutes)} (${p.minutes} min), on the middle scale.`, theta, cursor: norm(angleOf(p.minutes) + theta),
        highlights: [{ kind: 'scale', scale: 'middle', value: p.minutes }] },
      { say: `Read the fuel used above it on the outer scale: ${round1(read)} ${p.unit}.`, theta, cursor: norm(angleOf(p.minutes) + theta),
        highlights: [{ kind: 'scale', scale: 'outer', value: read }, { kind: 'scale', scale: 'middle', value: p.minutes }] },
    ],
    results: [{ label: 'Fuel', read, exact, tolerance: scaleTolerance(exact), unit: p.unit, format: (v) => `${round1(v)} ${p.unit}`, manual }],
  };
}

// --- (c) unit conversion ---------------------------------------------------------
export type ConversionKind = 'nm-sm' | 'sm-km' | 'kg-lb' | 'usgal-fuel' | 'usgal-imp' | 'm-ft' | 'l-usgal';
interface ConversionSpec { from: string; to: string; fromUnit: string; toUnit: string; factor: number; method: 'arrows' | 'align' }
export const CONVERSIONS: Record<ConversionKind, ConversionSpec> = {
  // Set the value under the `from` arrow on the outer scale; read under the `to` arrow (manual p. 13–14).
  'nm-sm': { from: 'naut', to: 'stat', fromUnit: 'NM', toUnit: 'SM', factor: 1.852 / 1.609344, method: 'arrows' },
  'sm-km': { from: 'stat', to: 'km', fromUnit: 'SM', toUnit: 'km', factor: 1.609344, method: 'arrows' },
  // Line a disc arrow up with an outer arrow; disc value → outer value (manual p. 15–17).
  'kg-lb': { from: 'kg', to: 'lbs', fromUnit: 'kg', toUnit: 'lb', factor: 1 / 0.45359237, method: 'align' },
  'usgal-fuel': { from: 'us-gal-mid', to: 'fuel-lbs', fromUnit: 'US gal', toUnit: 'lb', factor: 6, method: 'align' },
  'usgal-imp': { from: 'us-gal-mid', to: 'imp-gal', fromUnit: 'US gal', toUnit: 'imp gal', factor: 3.785411784 / 4.54609, method: 'align' },
  'm-ft': { from: 'meters', to: 'ft', fromUnit: 'm', toUnit: 'ft', factor: 1 / 0.3048, method: 'align' },
  'l-usgal': { from: 'liters-mid', to: 'us-gal', fromUnit: 'L', toUnit: 'US gal', factor: 1 / 3.785411784, method: 'align' },
};

export interface ConversionParams { kind: ConversionKind; value: number }
export function conversionSteps(p: ConversionParams, face: Face = E6B): { steps: Step[]; read: number; exact: number } {
  const spec = CONVERSIONS[p.kind];
  const from = mark(face, spec.from);
  const to = mark(face, spec.to);
  const exact = p.value * spec.factor;
  if (spec.method === 'arrows') {
    const theta = rotationFor(from.value, p.value);
    const read = readMiddle(to.value, theta, exact);
    return {
      exact, read,
      steps: [
        { say: `Set ${p.value} on the middle scale under the ${from.text} arrow.`, theta, cursor: angleOf(from.value),
          highlights: [{ kind: 'mark', id: from.id }, { kind: 'scale', scale: 'middle', value: p.value }] },
        { say: `Under the ${to.text} arrow read ${round1(read)} ${spec.toUnit}.`, theta, cursor: angleOf(to.value),
          highlights: [{ kind: 'mark', id: to.id }, { kind: 'scale', scale: 'middle', value: read }] },
      ],
    };
  }
  const theta = rotationFor(to.value, from.value);
  const read = readOuter(p.value, theta, exact);
  return {
    exact, read,
    steps: [
      { say: `Line up the ${from.text} arrow on the disc with ${to.text} on the outer scale.`, theta, cursor: angleOf(to.value),
        highlights: [{ kind: 'mark', id: from.id }, { kind: 'mark', id: to.id }] },
      { say: `Find ${p.value.toLocaleString('en-AU')} ${spec.fromUnit} on the middle scale.`, theta, cursor: norm(angleOf(p.value) + theta),
        highlights: [{ kind: 'scale', scale: 'middle', value: p.value }] },
      { say: `Read ${round1(read)} ${spec.toUnit} above it on the outer scale.`, theta, cursor: norm(angleOf(p.value) + theta),
        highlights: [{ kind: 'scale', scale: 'outer', value: read }, { kind: 'scale', scale: 'middle', value: p.value }] },
    ],
  };
}

export function conversionDemo(parts: (ConversionParams & { manual?: Result['manual'] })[], face: Face = E6B): Demo {
  const steps: Step[] = [];
  const results: Result[] = [];
  for (const part of parts) {
    const spec = CONVERSIONS[part.kind];
    const built = conversionSteps(part, face);
    steps.push(...built.steps);
    results.push({
      label: `${part.value.toLocaleString('en-AU')} ${spec.fromUnit} → ${spec.toUnit}`,
      read: built.read, exact: built.exact, tolerance: scaleTolerance(built.exact), unit: spec.toUnit,
      format: (v) => `${round1(v)} ${spec.toUnit}`, manual: part.manual,
    });
  }
  return { id: 'convert', title: 'Unit conversion', cite: 'Manual p. 13–17', steps, results };
}

// --- (d) TAS and density altitude from CAS, pressure altitude and OAT ---------------
export interface TasParams { pa: number; oat: number; cas: number }
export function tasTheta(p: { pa: number; oat: number }, face: Face = E6B): number {
  return norm(scale(face, 'pa-as').at(p.pa) - scale(face, 'temp-as').at(p.oat));
}

/** Density altitude read at the ▲ index for a disc angle. */
export function densityAtIndex(theta: number, face: Face = E6B): number {
  // Base DA mark at the index: densityAltAt(d) = index + θ. Solve on the ISA σ.
  return densityAltitude(10 ** (-turn(theta) / 180));
}

export function tasDemo(p: TasParams, face: Face = E6B, manual?: { tas: number; da: number; page: string; daNote?: string }): Demo {
  const theta = tasTheta(p, face);
  const exact = tasIncompressible(p.cas, p.pa, p.oat);
  const read = readOuter(p.cas, theta, exact);
  const da = densityAtIndex(theta, face);
  const daRead = Math.round(da / 500) * 500;
  const ka = p.pa / 1000;
  return {
    id: 'tas', title: 'TAS and density altitude', cite: manual ? `Manual p. ${manual.page}` : 'Same method as manual p. 18–19',
    steps: [
      { say: `In the airspeed window set pressure altitude ${ka} (thousands) opposite ${p.oat > 0 ? '+' : ''}${p.oat} °C.`, theta, cursor: null,
        highlights: [{ kind: 'scale', scale: 'pa-as', value: p.pa }, { kind: 'scale', scale: 'temp-as', value: p.oat }] },
      { say: `Find CAS ${p.cas} kt on the middle scale.`, theta, cursor: norm(angleOf(p.cas) + theta),
        highlights: [{ kind: 'scale', scale: 'middle', value: p.cas }] },
      { say: `Read TAS above it on the outer scale: ${Math.round(read)} kt.`, theta, cursor: norm(angleOf(p.cas) + theta),
        highlights: [{ kind: 'scale', scale: 'outer', value: read }, { kind: 'scale', scale: 'middle', value: p.cas }] },
      { say: `Read density altitude at the ▲ in the DENSITY ALTITUDE window: about ${daRead.toLocaleString('en-AU')} ft.`, theta, cursor: null,
        highlights: [{ kind: 'index', id: 'density' }, { kind: 'scale', scale: 'da', value: da }] },
    ],
    results: [
      { label: 'TAS', read, exact, tolerance: windowTol(exact), unit: 'kt', format: kt,
        manual: manual ? { value: manual.tas, page: manual.page } : undefined,
        physics: { label: 'with compressibility', value: tasCompressible(p.cas, p.pa, p.oat) } },
      { label: 'Density altitude', read: daRead, exact: densityAltitude(sigma(p.pa, p.oat)), tolerance: 500, unit: 'ft', format: ft,
        manual: manual ? { value: manual.da, page: manual.page, note: manual.daNote } : undefined },
    ],
  };
}

// --- (e) Mach number to TAS ----------------------------------------------------
export interface MachParams { oat: number; mach: number }
export function machTheta(oat: number, face: Face = E6B): number {
  return norm(face.index.mach - scale(face, 'temp-as').at(oat));
}

export function machDemo(p: MachParams, face: Face = E6B, manual?: Result['manual']): Demo {
  const theta = machTheta(p.oat, face);
  const exact = p.mach * speedOfSound(p.oat);
  const read = readOuter(p.mach * 10, theta, exact);
  return {
    id: 'mach', title: 'Mach number to TAS', cite: manual ? `Manual p. ${manual.page}` : 'Same method as manual p. 20',
    steps: [
      { say: 'Turn the disc until the MACH NO. INDEX shows in the airspeed window.', theta, cursor: null, loose: true,
        highlights: [{ kind: 'index', id: 'mach' }] },
      { say: `Set the outside air temperature, ${p.oat > 0 ? '+' : ''}${p.oat} °C, opposite the index.`, theta, cursor: null,
        highlights: [{ kind: 'index', id: 'mach' }, { kind: 'scale', scale: 'temp-as', value: p.oat }] },
      { say: `Find Mach ${p.mach.toFixed(2)} on the middle scale (${round1(p.mach * 10)} on the scale).`, theta, cursor: norm(angleOf(p.mach) + theta),
        highlights: [{ kind: 'scale', scale: 'middle', value: p.mach * 10 }] },
      { say: `Read TAS on the outer scale: ${Math.round(read)} kt.`, theta, cursor: norm(angleOf(p.mach) + theta),
        highlights: [{ kind: 'scale', scale: 'outer', value: read }] },
    ],
    results: [{ label: 'TAS', read, exact, tolerance: windowTol(exact), unit: 'kt', format: kt, manual }],
  };
}

// --- (f) 1-in-60 off-course correction ----------------------------------------------
export interface OffCourseParams { off: number; flown: number; remaining: number }
export function offCourseDemo(p: OffCourseParams, face: Face = E6B, manual?: { parallel: number; converge: number; total: number; page: string; note?: string }): Demo {
  const t1 = rotationFor(p.off, p.flown);
  const t2 = rotationFor(p.off, p.remaining);
  const exact1 = (60 * p.off) / p.flown;
  const exact2 = (60 * p.off) / p.remaining;
  const read1 = readOuter(60, t1, exact1);
  const read2 = readOuter(60, t2, exact2);
  const rate = (theta: number) => norm(angleOf(60) + theta);
  const trig = (Math.atan(p.off / p.flown) + Math.atan(p.off / p.remaining)) * 180 / Math.PI;
  return {
    id: 'offcourse', title: 'Off-course correction (1 in 60)', cite: manual ? `Manual p. ${manual.page}` : 'Same method as manual p. 24–26',
    steps: [
      { say: `Set the distance flown, ${p.flown}, on the middle scale opposite ${p.off} (off course) on the outer.`, theta: t1, cursor: angleOf(p.off),
        highlights: [{ kind: 'scale', scale: 'middle', value: p.flown }, { kind: 'scale', scale: 'outer', value: p.off }] },
      { say: `Read ${round1(read1)}° above the 60 RATE arrow: the turn to parallel the course.`, theta: t1, cursor: rate(t1),
        highlights: [{ kind: 'index', id: 'rate' }, { kind: 'scale', scale: 'outer', value: read1 }] },
      { say: `Set the distance to go, ${p.remaining}, opposite ${p.off}.`, theta: t2, cursor: angleOf(p.off),
        highlights: [{ kind: 'scale', scale: 'middle', value: p.remaining }, { kind: 'scale', scale: 'outer', value: p.off }] },
      { say: `Read ${round1(read2)}° above the rate arrow: the extra turn to converge.`, theta: t2, cursor: rate(t2),
        highlights: [{ kind: 'index', id: 'rate' }, { kind: 'scale', scale: 'outer', value: read2 }] },
      { say: `Turn ${round1(read1 + read2)}° toward the course: ${round1(read1)} + ${round1(read2)}.`, theta: t2, cursor: rate(t2),
        highlights: [{ kind: 'index', id: 'rate' }] },
    ],
    results: [
      { label: 'To parallel', read: read1, exact: exact1, tolerance: scaleTolerance(exact1), unit: '°', format: deg,
        manual: manual ? { value: manual.parallel, page: manual.page } : undefined },
      { label: 'To converge', read: read2, exact: exact2, tolerance: scaleTolerance(exact2), unit: '°', format: deg,
        manual: manual ? { value: manual.converge, page: manual.page, note: manual.note } : undefined },
      { label: 'Total turn', read: read1 + read2, exact: exact1 + exact2, tolerance: Math.max(0.2, scaleTolerance(exact1) + scaleTolerance(exact2)), unit: '°', format: deg,
        manual: manual ? { value: manual.total, page: manual.page } : undefined,
        physics: { label: 'by trigonometry', value: trig } },
    ],
  };
}

// --- (g) true altitude -----------------------------------------------------------
export interface TrueAltParams { pa: number; oat: number; indicated: number; station: number }
export function altTheta(p: { pa: number; oat: number }, face: Face = E6B): number {
  return norm(scale(face, 'temp-alt').at(p.oat) - scale(face, 'pa-alt').at(p.pa));
}

export function trueAltDemo(p: TrueAltParams, face: Face = E6B, manual?: Result['manual']): Demo {
  const theta = altTheta(p, face);
  const height = p.indicated - p.station;
  const exactHeight = trueHeightComputer(height, p.pa, p.oat);
  const readHeight = readOuter(height, theta, exactHeight);
  return {
    id: 'truealt', title: 'True altitude', cite: manual ? `Manual p. ${manual.page}` : 'Same method as manual p. 21–22',
    steps: [
      { say: `In the altitude correction window set pressure altitude ${p.pa / 1000} opposite ${p.oat > 0 ? '+' : ''}${p.oat} °C.`, theta, cursor: null,
        highlights: [{ kind: 'scale', scale: 'pa-alt', value: p.pa }, { kind: 'scale', scale: 'temp-alt', value: p.oat }] },
      { say: `Height above the station: ${p.indicated.toLocaleString('en-AU')} − ${p.station.toLocaleString('en-AU')} = ${height.toLocaleString('en-AU')} ft. Find it on the middle scale.`, theta, cursor: norm(angleOf(height) + theta),
        highlights: [{ kind: 'scale', scale: 'middle', value: height }] },
      { say: `Read ${Math.round(readHeight).toLocaleString('en-AU')} ft above it; add the station: ${Math.round(readHeight + p.station).toLocaleString('en-AU')} ft.`, theta, cursor: norm(angleOf(height) + theta),
        highlights: [{ kind: 'scale', scale: 'outer', value: readHeight }] },
    ],
    results: [{ label: 'True altitude', read: readHeight + p.station, exact: exactHeight + p.station,
      tolerance: windowTol(exactHeight), unit: 'ft', format: ft, manual }],
  };
}

// --- (h) wind side: heading and ground speed ------------------------------------------
export interface WindHeadingParams { windFrom: number; windKt: number; tc: number; tas: number }
const bearing = (v: number) => `${String(Math.round(wrap360(v)) || 360).padStart(3, '0')}°`;

export function windHeadingDemo(p: WindHeadingParams, manual?: { th: number; gs: number; page: string }): Demo {
  const slide = p.tas > SLIDE.maxKt ? HIGH_SPEED_SLIDE : SLIDE;
  const end = slide.id==='high'?{slide:'high' as const}:{};
  const solved = computeHeading(p.tc, p.tas, p.windFrom, p.windKt,slide);
  const exact = solveHeading(p.tc, p.tas, p.windFrom, p.windKt);
  const dot = solved.state.dot!;
  const gsRead = Math.round(solved.gs);
  const wcaRead = Math.round(solved.wca);
  const side = wcaRead >= 0 ? 'right' : 'left';
  const start = p.tas;
  return {
    id: 'windhdg', title: 'Heading and ground speed (wind side)', cite: manual ? `Manual p. ${manual.page}` : 'Same method as manual p. 28–30',
    steps: [
      { say: `Turn the plate to put the wind direction, ${bearing(p.windFrom)}, under the TRUE INDEX.`, theta: 0, cursor: null,
        highlights: [{ kind: 'wind', id: 'index' }], wind: { ...end, plate: p.windFrom, gs: start, dot: null } },
      { say: `Count ${p.windKt} kt up from the grommet and make a pencil dot.`, theta: 0, cursor: null,
        highlights: [{ kind: 'wind', id: 'dot' }], wind: { ...end, plate: p.windFrom, gs: start, dot } },
      { say: `Turn the plate to the true course, ${bearing(p.tc)}, under the index.`, theta: 0, cursor: null,
        highlights: [{ kind: 'wind', id: 'index' }], wind: { ...end, plate: p.tc, gs: start, dot } },
      { say: `Slide the grid until the dot sits on the ${p.tas}-kt TAS arc.`, theta: 0, cursor: null,
        highlights: [{ kind: 'wind', id: 'dot' }], wind: { ...end, plate: p.tc, gs: solved.gs, dot } },
      { say: `Read the ground speed under the grommet: ${gsRead} kt.`, theta: 0, cursor: null,
        highlights: [{ kind: 'wind', id: 'grommet' }], wind: { ...end, plate: p.tc, gs: solved.gs, dot } },
      { say: `The dot is ${Math.abs(wcaRead)}° ${side} of the centre line: true heading ${bearing(p.tc + wcaRead)}.`, theta: 0, cursor: null,
        highlights: [{ kind: 'wind', id: 'dot' }], wind: { ...end, plate: p.tc, gs: solved.gs, dot } },
    ],
    results: [
      { label: 'Ground speed', read: gsRead, exact: exact.gs, tolerance: slide.id==='high'?5:2, unit: 'kt', format: kt,
        manual: manual ? { value: manual.gs, page: manual.page } : undefined },
      { label: 'True heading', read: wrap360(p.tc + wcaRead), exact: exact.th, tolerance: 1, unit: '°T', format: bearing,
        manual: manual ? { value: manual.th, page: manual.page } : undefined },
    ],
  };
}

// --- (i) wind side: find the wind ----------------------------------------------------
export interface WindFindParams { th: number; tc: number; tas: number; gs: number }
export function windFindDemo(p: WindFindParams, manual?: { from: number; kt: number; page: string }): Demo {
  const solved = computeWind(p.th, p.tc, p.tas, p.gs);
  const exact = solveWind(p.th, p.tc, p.tas, p.gs);
  const wca = Math.round(((p.th - p.tc + 540) % 360) - 180);
  const side = wca >= 0 ? 'right' : 'left';
  const fromRead = Math.round(solved.from);
  const ktRead = Math.round(solved.kt);
  return {
    id: 'windfind', title: 'Find the wind (wind side)', cite: manual ? `Manual p. ${manual.page}` : 'Same method as manual p. 32–35',
    steps: [
      { say: `Put the true course, ${bearing(p.tc)}, under the TRUE INDEX.`, theta: 0, cursor: null,
        highlights: [{ kind: 'wind', id: 'index' }], wind: { plate: p.tc, gs: p.tas, dot: null } },
      { say: `Slide the grommet onto the ${p.gs}-kt ground-speed arc.`, theta: 0, cursor: null,
        highlights: [{ kind: 'wind', id: 'grommet' }], wind: { plate: p.tc, gs: p.gs, dot: null } },
      { say: `Heading ${bearing(p.th)} is ${Math.abs(wca)}° ${side} of course: mark where the ${Math.abs(wca)}° ${side} line meets the ${p.tas}-kt arc.`, theta: 0, cursor: null,
        highlights: [{ kind: 'wind', id: 'dot' }, { kind: 'arc', value: p.tas }], wind: { plate: p.tc, gs: p.gs, dot: solved.mark } },
      { say: 'Turn the plate until the mark is on the centre line above the grommet.', theta: 0, cursor: null,
        highlights: [{ kind: 'wind', id: 'dot' }], wind: { plate: solved.plate, gs: p.gs, dot: solved.mark } },
      { say: `Read the wind: ${bearing(fromRead)} under the index, ${ktRead} kt from the grommet to the mark.`, theta: 0, cursor: null,
        highlights: [{ kind: 'wind', id: 'index' }, { kind: 'wind', id: 'dot' }], wind: { plate: solved.plate, gs: p.gs, dot: solved.mark } },
    ],
    results: [
      { label: 'Wind direction', read: fromRead, exact: exact.from, tolerance: 2, unit: '°T', format: bearing,
        manual: manual ? { value: manual.from, page: manual.page } : undefined },
      { label: 'Wind speed', read: ktRead, exact: exact.kt, tolerance: 2, unit: 'kt', format: kt,
        manual: manual ? { value: manual.kt, page: manual.page } : undefined },
    ],
  };
}

/** The wind-side demos: the manual's worked examples (p. 30 and p. 32–35). */
export function windDemos(): Demo[] {
  return [
    windHeadingDemo({ windFrom: 230, windKt: 18, tc: 90, tas: 125 }, { th: 95, gs: 138, page: '30–32 (Figures 22–23)' }),
    windFindDemo({ th: 160, tc: 180, tas: 140, gs: 120 }, { from: 104, kt: 50, page: '32–35 (Figures 24–25)' }),
  ];
}

/** The guided demos, each reproducing the official manual's worked example. */
export function manualDemos(face: Face = E6B): Demo[] {
  return [
    tsdDemo({ gs: 150, dist: 245 }, face, { value: 98, page: '8 (Figure 3)' }),
    fuelDemo({ rate: 7.8, minutes: 200, unit: 'gal' }, face, { value: 26, page: '12, problem 1; answer p. 37' }),
    conversionDemo([
      { kind: 'nm-sm', value: 90, manual: { value: 103.5, page: '13 (Figure 8)' } },
      { kind: 'kg-lb', value: 160, manual: { value: 351, page: '17', note: 'The manual prints 351 lb; 160 kg is 352.7 lb. Its 2,000 lb → 901 kg is also 0.7 % low (907 kg).' } },
    ], face),
    tasDemo({ pa: 15000, oat: -15, cas: 145 }, face, { tas: 183, da: 15000, page: '18–19 (Figure 13)' }),
    machDemo({ oat: 15, mach: 1 }, face, { value: 661, page: '20 (Figure 14)' }),
    offCourseDemo({ off: 8, flown: 125, remaining: 235 }, face, {
      parallel: 3.8, converge: 2.4, total: 6, page: '24–25 (Figures 17–18)',
      note: 'The manual prints 2.4°; 60 × 8 ÷ 235 is 2.04°, which is what the scale shows. Its total, 6°, is right.',
    }),
    trueAltDemo({ pa: 10000, oat: -19, indicated: 12000, station: 5000 }, face, { value: 11600, page: '21–22 (Figure 15)' }),
  ];
}

/** Whether a result's read value agrees with the exact answer within tolerance. */
export const withinTolerance = (result: Result): boolean => Math.abs(difference(result, result.read)) <= result.tolerance;

/** Error of a value against a result's exact answer; bearings wrap at 360. */
export function difference(result: Result, value: number): number {
  const d = value - result.exact;
  return result.unit === '°T' ? ((d % 360) + 540) % 360 - 180 : d;
}

