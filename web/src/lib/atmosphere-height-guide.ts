import { mapProject, type Camera, type Lambert } from './lambert';
import type { TeachingAtmosphereContext } from './atmosphere-teaching';
import { slicePoint } from './atmosphere-slice';
import { SUMMITS } from './peaks';
import { atmosphereDisplayCamera } from './atmosphere-display';

export interface HeightGuidePoint { x: number; y: number; z: number; }
export interface HeightGuideLabelBox { x: number; y: number; w: number; h: number; text: string; point: HeightGuidePoint; }
export interface HeightGuideLayout { points: HeightGuidePoint[]; labels: HeightGuideLabelBox[]; }

const guideFields = new WeakMap<object, TeachingAtmosphereContext>();
/** Reproject the shared field against the current camera, never last frame's boxes. */
export function atmosphereHeightGuideBoxes(canvas: object | null, geo: Lambert, camera: Camera, width: number, height: number): HeightGuideLabelBox[] {
  const field = canvas && guideFields.get(canvas);
  return field && camera.halfHeight <= .35
    ? layoutAtmosphereHeightGuide(geo, atmosphereDisplayCamera(camera, field), width, height, field)?.labels ?? [] : [];
}

/** Compute the guide geometry without drawing, for collision avoidance and tests. */
export function layoutAtmosphereHeightGuide(
  geo: Lambert, camera: Camera, width: number, height: number, field: TeachingAtmosphereContext,
  summitPoints?: readonly { x: number; y: number }[],
): HeightGuideLayout | null {
  const anchor = camera.slice ? slicePoint(camera.slice, -camera.slice.halfWidthM * .8, 0) : { lat: field.lat, lon: field.lon };
  if (!anchor) return null;
  const levels = field.kind === 'sea-breeze' ? [0, 500, 1000, 1500, 2000, 2500]
    : field.kind === 'mountain-wave' ? [0, 2000, 4000, 6000, 8000, 10000, 12000] : [0, 2000, 4000, 6000, 8000, 10000];
  const points = levels.map(z => {
    const p = mapProject(geo, camera, anchor.lat, anchor.lon, field.groundM + z);
    return p ? { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2, z } : null;
  }).filter((p): p is NonNullable<typeof p> => p != null && p.x > 42 && p.x < width - 70 && p.y > 48 && p.y < height - 32);
  if (points.length < 2 || Math.hypot(points[0].x - points.at(-1)!.x, points[0].y - points.at(-1)!.y) < 70) return null;
  for (let i = 1; i < points.length; i += 1) if (Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) < 23) return null;
  const projectedSummits = summitPoints ?? SUMMITS.map(peak => mapProject(geo, camera, peak.lat, peak.lon, peak.elevationM))
    .filter((p): p is NonNullable<typeof p> => p != null).map(p => ({ x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 }));
  const labels: HeightGuideLabelBox[] = [];
  let previous = -Infinity;
  for (const p of points) {
    if (Math.abs(p.y - previous) < 23) continue;
    previous = p.y;
    const text = p.z === 0 && projectedSummits.every(s => Math.hypot(s.x - p.x, s.y - p.y) > 36)
      ? 'SFC' : p.z === 0 ? '' : `${Math.round((field.groundM + p.z) / .3048 / 100) / 10}k ft`;
    if (text) labels.push({ x: p.x + 5, y: p.y - 7, w: Math.max(18, text.length * 6.3) + 8, h: 14, text, point: p });
  }
  return { points, labels };
}

/** A geographic altitude ruler shares true heights with wind and clouds. */
export function drawAtmosphereHeightGuide(ctx: CanvasRenderingContext2D, geo: Lambert, camera: Camera, width: number, height: number, field: TeachingAtmosphereContext, dark: boolean) {
  guideFields.set(ctx.canvas, field);
  const layout = layoutAtmosphereHeightGuide(geo, camera, width, height, field);
  if (!layout) return;
  ctx.save(); ctx.strokeStyle = dark ? '#b7d3df' : '#426b80'; ctx.fillStyle = dark ? '#d9e9ef' : '#284f63'; ctx.globalAlpha = .55;
  ctx.lineWidth = 1; ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.moveTo(layout.points[0].x, layout.points[0].y);
  for (const p of layout.points.slice(1)) ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const label of layout.labels) {
    const p = label.point;
    ctx.globalAlpha = .9; ctx.beginPath(); ctx.moveTo(p.x - 3, p.y); ctx.lineTo(p.x + 5, p.y); ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = dark ? '#142735' : '#f1f6f8'; ctx.strokeText(label.text, label.x + 4, p.y);
    ctx.globalAlpha = .9; ctx.fillText(label.text, label.x + 4, p.y); ctx.strokeStyle = dark ? '#b7d3df' : '#426b80'; ctx.lineWidth = 1;
  }
  ctx.restore();
}
