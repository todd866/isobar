/** The wind side of the E6-B: a transparent azimuth plate turning over a sliding
 * card of speed arcs and drift lines (ASA manual p. 28–35, Figures 21–25).
 *
 * The slide is a polar grid centred on a point O below the grommet: the arc for a
 * speed s has radius s·U and the drift lines are rays from O. With the true course
 * at the TRUE INDEX and the grommet on the ground-speed arc, the pencil dot (the
 * wind, drawn upwind of the grommet) lies at the tip of the air vector, so the arc
 * through it is the TAS and the ray through it is the wind correction angle. The
 * geometry is the exact wind triangle; the only error is reading.
 *
 * Screen frame: grommet at (0, 0), y down, angles clockwise from the TRUE INDEX.
 */

/** Face units per knot: one 2-kt arc spacing measured on Figure 21. */
export const U = 17;
export const PLATE_R = 1000;
/** The standard ASA slide.  Keep these measured proportions as the default. */
export const SLIDE = { id: 'low' as const, minKt: 30, maxKt: 260, halfWidth: 970, arcStepKt: 2, driftStepDeg: 1 };
export const LOW_SPEED_SLIDE = SLIDE;

/**
 * The removable high-speed slide described by ASA (manual p. 28): its printed
 * wind marks are read in 10-knot units.  ASA's booklet names the accessory and
 * its 1/10-knot convention, but does not publish the end marks or a dimensioned
 * drawing.  The 100–1000 teaching range is therefore an explicit product
 * assumption, kept here so it can be replaced when the accessory scan is
 * available.  The B727 exercises use 400–500 kt inside this range.
 */
export const HIGH_SPEED_SLIDE = {
  id: 'high' as const,
  minKt: 100,
  maxKt: 1000,
  halfWidth: 970,
  arcStepKt: 10,
  driftStepDeg: 1,
  // Normalized schematic scale: keeps a 100 kt wind on the plate while the
  // slide itself carries the 400–1000 kt jet arcs. The accessory drawing is not
  // present in the local ASA booklet, so this is deliberately not called U.
  unitsPerKt: 3.4,
};
export type WindSlide = typeof SLIDE | typeof HIGH_SPEED_SLIDE;
export type WindSlideId = WindSlide['id'];
const slideUnits = (slide: WindSlide): number => 'unitsPerKt' in slide ? slide.unitsPerKt : U;

const rad = (deg: number): number => (deg * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;
export const wrap360 = (a: number): number => ((a % 360) + 360) % 360;
const signed180 = (a: number): number => { const w = wrap360(a); return w > 180 ? w - 360 : w; };

export interface WindState {
  /** Azimuth on the plate under the TRUE INDEX. */
  plate: number;
  /** Ground-speed arc under the grommet. */
  gs: number;
  /** The pencil dot in plate coordinates (face units), or null. */
  dot: [number, number] | null;
  /** The physical insert in use; omitted means the measured low-speed slide. */
  slide?: WindSlideId;
}

/** Plate coordinates of a point at screen position (x, y) with `plate` under the index. */
export function toPlate(x: number, y: number, plate: number): [number, number] {
  const t = rad(plate);
  return [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
}

/** Screen position of a plate point. */
export function toScreen(p: [number, number], plate: number): [number, number] {
  const t = rad(-plate);
  return [p[0] * Math.cos(t) - p[1] * Math.sin(t), p[0] * Math.sin(t) + p[1] * Math.cos(t)];
}

/** The dot for a wind, drawn up from the grommet with the wind direction at the index. */
export function windDot(direction: number, speed: number, slide: WindSlide = SLIDE): [number, number] {
  return toPlate(0, -speed * slideUnits(slide), direction);
}

/** Speed arc and drift angle under a screen point, for a slide at `gs`. */
export function slideAt(x: number, y: number, gs: number, _slide: WindSlide = SLIDE): { speed: number; drift: number } {
  const units = slideUnits(_slide);
  const dy = gs * units - y;
  return { speed: Math.hypot(x, dy) / units, drift: deg(Math.atan2(x, dy)) };
}

/** Ground speed that puts a screen point on the `tas` arc. */
export function gsForArc(x: number, y: number, tas: number, _slide: WindSlide = SLIDE): number {
  const units = slideUnits(_slide);
  const t = tas * units;
  return (y + Math.sqrt(Math.max(0, t * t - x * x))) / units;
}

/** Read the dot: TAS arc and wind correction angle (right positive). */
export function readDot(state: WindState, slide: WindSlide = SLIDE): { tas: number; wca: number } | null {
  if (!state.dot) return null;
  if (state.slide) slide = state.slide === 'high' ? HIGH_SPEED_SLIDE : SLIDE;
  const [x, y] = toScreen(state.dot, state.plate);
  const at = slideAt(x, y, state.gs, slide);
  return { tas: at.speed, wca: at.drift };
}

/** Exact wind triangle: heading and ground speed from course, TAS and wind. */
export function solveHeading(tc: number, tas: number, windFrom: number, windKt: number): { wca: number; th: number; gs: number } {
  const angle = rad(windFrom - tc);
  const cross = windKt * Math.sin(angle);
  const wca = deg(Math.asin(cross / tas));
  const gs = tas * Math.cos(rad(wca)) - windKt * Math.cos(angle);
  return { wca, th: wrap360(tc + wca), gs };
}

/** Exact wind from heading, course, TAS and ground speed. */
export function solveWind(th: number, tc: number, tas: number, gs: number): { from: number; kt: number } {
  const gx = gs * Math.sin(rad(tc));
  const gy = gs * Math.cos(rad(tc));
  const ax = tas * Math.sin(rad(th));
  const ay = tas * Math.cos(rad(th));
  const wx = gx - ax; // wind blowing to
  const wy = gy - ay;
  return { from: wrap360(deg(Math.atan2(-wx, -wy))), kt: Math.hypot(wx, wy) };
}

/** The computer's answer to the heading problem: set the instrument as the manual says and read it. */
export function computeHeading(tc: number, tas: number, windFrom: number, windKt: number, slide: WindSlide = SLIDE): { state: WindState; gs: number; wca: number } {
  const dot = windDot(windFrom, windKt, slide);
  const [x, y] = toScreen(dot, tc);
  const gs = gsForArc(x, y, tas, slide);
  const state = { plate: tc, gs, dot, slide: slide.id };
  return { state, gs, wca: readDot(state, slide)!.wca };
}

/** The computer's answer to the find-wind problem: mark TAS on the WCA line, turn it to the centre line, read. */
export function computeWind(th: number, tc: number, tas: number, gs: number, slide: WindSlide = SLIDE): { mark: [number, number]; plate: number; from: number; kt: number } {
  const wca = rad(signed180(th - tc));
  const units = slideUnits(slide);
  const x = tas * units * Math.sin(wca);
  const y = gs * units - tas * units * Math.cos(wca);
  const mark = toPlate(x, y, tc);
  const plate = wrap360(deg(Math.atan2(mark[0], -mark[1])));
  return { mark, plate, from: plate, kt: Math.hypot(mark[0], mark[1]) / units };
}

export { signed180 };
