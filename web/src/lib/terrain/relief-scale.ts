/**
 * One vertical scale for the tilted 3D scene. At close range terrain is shown
 * at its physical height; at regional range real relief is a few thousandths
 * of the view and reads as flat, so heights are exaggerated (owner, 14 Oct:
 * artistic licence to look real). Every height placed in the scene uses the
 * same factor: terrain mesh, draped plate, lines, labels, occlusion, wind
 * trails, clouds and the altitude ruler. Readouts stay physical.
 *
 * Above MESH_FADE_START the scale eases to zero, so the mesh flattens into the
 * plate by MESH_MAX_HALF_HEIGHT_DEG instead of switching off with a pop.
 */
export const RELIEF_CLOSE_HALF_HEIGHT_DEG = .2;
export const RELIEF_REGIONAL_HALF_HEIGHT_DEG = 3;
export const RELIEF_MAX_EXAGGERATION = 4;
export const MESH_FADE_START_HALF_HEIGHT_DEG = 5;
export const MESH_MAX_HALF_HEIGHT_DEG = 8;

const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

/** The exaggeration a viewer is told about (1 at close range). */
export function reliefExaggeration(halfHeightDeg: number): number {
  if (!(halfHeightDeg > RELIEF_CLOSE_HALF_HEIGHT_DEG)) return 1;
  const t = Math.log(halfHeightDeg / RELIEF_CLOSE_HALF_HEIGHT_DEG) / Math.log(RELIEF_REGIONAL_HALF_HEIGHT_DEG / RELIEF_CLOSE_HALF_HEIGHT_DEG);
  return 1 + (RELIEF_MAX_EXAGGERATION - 1) * smooth(t);
}

/** The factor applied to every height in the scene: exaggeration, faded to
 * flat across the band where the terrain mesh hands over to the plate. */
export function terrainReliefScale(halfHeightDeg: number): number {
  if (!Number.isFinite(halfHeightDeg) || halfHeightDeg <= 0) return 1;
  const fade = 1 - smooth((halfHeightDeg - MESH_FADE_START_HALF_HEIGHT_DEG) / (MESH_MAX_HALF_HEIGHT_DEG - MESH_FADE_START_HALF_HEIGHT_DEG));
  return reliefExaggeration(halfHeightDeg) * fade;
}

/** Compact scale-bar note while heights are exaggerated; null at physical
 * scale and while the mesh flattens into the plate (heights below physical). */
export function reliefLabel(scale: number): string | null {
  if (!Number.isFinite(scale) || scale < 1.05) return null;
  return `relief ×${scale >= 2 ? Math.round(scale * 2) / 2 : Math.round(scale * 10) / 10}`;
}
