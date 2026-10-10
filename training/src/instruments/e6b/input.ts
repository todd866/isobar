/** Input mapping for trackpad, mouse and touch. Pure, so the gesture maths is tested.
 *
 * macOS trackpad (primary): a two-finger swipe spins the whole computer,
 * following the fingers round the centre as if they rested on it; macOS supplies
 * the momentum, so no inertia is added on top. Option turns the disc; Shift (or
 * the pointer on the hairline handle) moves the hairline. Pinch arrives as ctrl+wheel in
 * Chrome and Edge and as gesture events in Safari, whose two-finger rotation
 * turns the disc one to one.
 */

/** Wheel deltas in pixels, whatever unit the browser reported. */
export function wheelPixels(dx: number, dy: number, mode: number): [number, number] {
  const k = mode === 1 ? 16 : mode === 2 ? 400 : 1;
  return [dx * k, dy * k];
}

/** Degrees clockwise for a scroll of (dx, dy) px with the pointer at (ox, oy) px
 * from the centre (y down). Scroll deltas run opposite to the fingers (natural
 * scrolling), so the finger motion is −(dx, dy); its component along the circle
 * through the pointer, divided by the radius, is the turn: a fingertip on the
 * rim drags the rim with it. Near the centre, where the circle is too tight to
 * steer by, a plain sideways or vertical swipe turns it at 0.2° per px. */
export function wheelTurn(dx: number, dy: number, ox: number, oy: number): number {
  const r = Math.hypot(ox, oy);
  if (r < 40) return -(dx + dy) * 0.2;
  const along = (dx * oy - dy * ox) / r;
  return (along / Math.max(r, 120)) * (180 / Math.PI);
}

/** Degrees clockwise to turn the whole computer for a plain scroll of (dx, dy) px.
 * Both axes turn it, in the scroll direction as the OS delivers it: a scroll
 * "down" or "right" (positive delta, whatever the natural-scrolling setting)
 * turns it clockwise, 0.25° per px, so a full trackpad swipe is about a
 * quarter turn and macOS momentum carries on as delivered. Position-independent:
 * a swipe anywhere over the dial turns it the same way. */
export function wheelSpin(dx: number, dy: number): number {
  return (dx + dy) * 0.25;
}

/** Zoom factor for a pinch delivered as ctrl+wheel (Chrome, Edge). */
export function pinchFactor(dy: number): number {
  return Math.exp(dy * 0.01);
}

/** Safari gesture events: scale and rotation (degrees clockwise) since gesturestart. */
export function gestureApply(start: { theta: number; w: number }, scale: number, rotation: number, minW: number, maxW: number): { theta: number; w: number } {
  const theta = (((start.theta + rotation) % 360) + 360) % 360;
  const w = Math.min(maxW, Math.max(minW, start.w / (scale > 0 ? scale : 1)));
  return { theta, w };
}

/** The input map, one line per input, for the "How it works" overlay. */
export const INPUT_MAP: [string, string][] = [
  ['Scroll or two-finger swipe', 'turn the whole computer; down or right is clockwise'],
  ['⌥ + two-finger swipe', 'turn the blue disc'],
  ['⇧ + two-finger swipe', 'move the red hairline (or swipe on its handle)'],
  ['Pinch', 'zoom; double-click or 0 to centre'],
  ['Two-finger rotate (Safari)', 'turn the disc; outside the disc or with ⌥, turn the whole view'],
  ['Drag the black ring', 'turn it against the disc'],
  ['Upright', 'return the whole view to zero; double-click empty space also resets'],
  ['Drag the disc', 'turn it; let go with a flick and it coasts'],
  ['Drag the red handle or hairline', 'move the hairline; ⌥ for free movement'],
  ['Click a graduation', 'bring the hairline to it'],
  ['← → ↑ ↓', 'turn the disc; ⇧ coarse, ⌥ moves the hairline'],
  ['Ctrl + arrows (wind)', 'move the pencil dot one knot; Shift makes ten; Backspace erases'],
  ['Shift + [ / ]', 'turn the whole view one degree'],
  ['Touch', 'one finger turns the disc, two twist and pinch'],
];

/** The same map for a touch screen: no keys, no scroll wheel, no Option. */
export const TOUCH_INPUT_MAP: [string, string][] = [
  ['Drag the disc', 'turn it with one finger; let go with a flick and it coasts'],
  ['Drag the red handle', 'move the hairline; it settles on the nearest graduation'],
  ['Tap a graduation', 'bring the hairline to it'],
  ['Two-finger twist', 'turn the whole computer; the settings stay as they are'],
  ['Pinch', 'zoom; Centre returns to the whole face'],
  ['View handle', 'drag it round to turn the whole computer'],
  ['Upright', 'return the whole view to zero'],
];

/** True when the primary pointer is a finger (phones, tablets without a trackpad). */
export function touchPrimary(): boolean {
  return typeof matchMedia === 'function' && !matchMedia('(pointer: fine)').matches && matchMedia('(pointer: coarse)').matches;
}

/** Desktop-only instructions and their touch equivalents. Coach text, the
 * first-contact tour and Guided corrections pass through `forInput`, so a phone
 * never tells the learner to Option-scroll. */
const TOUCH_WORDING: [string, string][] = [
  ['Turn the whole computer with View or a two-finger swipe', 'Twist two fingers, or drag View, to turn the whole computer'],
  ['Drag the blue disc.', 'Drag the blue disc with one finger.'],
  ['Drag the red teaching hairline, or Shift-scroll.', 'Drag the red handle to move the teaching hairline.'],
  ['Drag the red hairline or use Shift-scroll.', 'Drag the red handle.'],
  ['Swipe with two fingers, or use [ / ];', 'Twist two fingers or drag View;'],
];

export function forInput(text: string, touch: boolean): string {
  if (!touch) return text;
  let out = text;
  for (const [desk, finger] of TOUCH_WORDING) out = out.split(desk).join(finger);
  return out;
}
