/** Display orientation is independent of the computer's scale settings.
 * Angles are clockwise in the SVG's y-down coordinates. Never add the view
 * angle to a scale reading: undo it at the input boundary instead. */
export interface Point { x: number; y: number }

export function rotatePoint(p: Point, degrees: number): Point {
  const a = degrees * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

export function viewToFace(p: Point, degrees: number): Point {
  return rotatePoint(p, -degrees);
}

/** Safari reports cumulative rotation and scale, not incremental deltas.
 * Some releases omit coordinates; the caller supplies the instrument centre. */
export function gestureNumbers(event: Event): { scale: number; rotation: number; x: number | null; y: number | null; alt: boolean } {
  const e = event as Event & { scale?: number; rotation?: number; clientX?: number; clientY?: number; altKey?: boolean };
  return {
    scale: Number.isFinite(e.scale) && e.scale! > 0 ? e.scale! : 1,
    rotation: Number.isFinite(e.rotation) ? e.rotation! : 0,
    x: Number.isFinite(e.clientX) ? e.clientX! : null,
    y: Number.isFinite(e.clientY) ? e.clientY! : null,
    alt: e.altKey === true,
  };
}
