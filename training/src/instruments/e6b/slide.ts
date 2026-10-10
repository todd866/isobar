/** Circular slide-rule arithmetic. One decade (10–100) fills 360°.
 * Angles are degrees clockwise from 12 o'clock. The disc angle θ is how far the
 * rotating disc has turned clockwise from the 1:1 setting; then
 *   outer = middle × 10^(θ/360)   (mantissas, decade free).
 */

export const DECADE = 360;

/** Normalise to [0, 360). */
export function norm(angle: number): number {
  const a = angle % 360;
  return a < 0 ? a + 360 : a;
}

/** Normalise to (−180, 180]: the shortest turn. */
export function turn(angle: number): number {
  const a = norm(angle);
  return a > 180 ? a - 360 : a;
}

/** Position of any positive number on a 10–100 scale. */
export function angleOf(value: number): number {
  return norm(DECADE * Math.log10(value));
}

/** The 10–100 mantissa printed at an angle. */
export function valueAt(angle: number): number {
  return 10 * 10 ** (norm(angle) / DECADE);
}

/** Mantissa of a positive number, in [10, 100). */
export function mantissa(value: number): number {
  return valueAt(angleOf(value));
}

/** Disc angle that puts `middle` on the disc opposite `outer` on the fixed scale. */
export function rotationFor(outer: number, middle: number): number {
  return norm(angleOf(outer) - angleOf(middle));
}

/** Outer-scale mantissa opposite a middle-scale value. */
export function outerOpposite(middle: number, theta: number): number {
  return valueAt(angleOf(middle) + theta);
}

/** Middle-scale mantissa opposite an outer-scale value. */
export function middleOpposite(outer: number, theta: number): number {
  return valueAt(angleOf(outer) - theta);
}

/** Put a 10–100 mantissa into the decade nearest an estimate: the step the
 * learner does in their head ("four hours at 125 kt is about 500"). */
export function placeDecade(m: number, estimate: number): number {
  const k = Math.round(Math.log10(estimate / m));
  return m * 10 ** k;
}

/** Graduation interval at a mantissa on the main scales (ASA E6-B manual p. 5–6:
 * 0.1 from 10, 0.2 from 15, 0.5 from 30, 1 from 60). */
export function graduation(m: number): number {
  if (m < 15) return 0.1;
  if (m < 30) return 0.2;
  if (m < 60) return 0.5;
  return 1;
}

/** One graduation, in the units of `value`: the reading tolerance of the scale. */
export function scaleTolerance(value: number): number {
  const m = mantissa(value);
  return graduation(m) * (value / m);
}

/** What a careful reader reads: the scale estimated to a fifth of a graduation. */
export function readAsPerson(value: number): number {
  const m = mantissa(value);
  const fifth = graduation(m) / 5;
  const read = Math.round(m / fifth) * fifth;
  return read * (value / m);
}

/** Minutes as h:mm. */
export function hmm(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** The middle-scale mantissa read as minutes the way the HOURS ring labels it:
 * 60–100 is 1:00–1:40 and 10–60 is 1:40–10:00. */
export function ringMinutes(m: number): number {
  return m >= 60 ? m : m * 10;
}
