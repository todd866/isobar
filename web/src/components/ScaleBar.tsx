'use client';

import { centreWidthMetres, scaleBar, scaleUnit } from '@/lib/scale-bar';
import type { Camera, Lambert } from '@/lib/lambert';
import type { DisplayUnits } from '@/lib/units';
import type { TiltedCamera } from '@/lib/tilt-navigation';
import { reliefLabel } from '@/lib/terrain/relief-scale';

/** One row beside the pressure chip: a bar, the primary distance, and nautical miles. */
export function ScaleBar({ geo, camera, width, units }: {
  geo: Lambert;
  camera: Camera | null;
  width: number;
  units: DisplayUnits;
}) {
  if (!camera || width < 80) return null;
  const metres = centreWidthMetres(geo, camera);
  if (!metres) return null;
  const bar = scaleBar(metres, width, scaleUnit(units), width < 700 ? 72 : 104);
  if (!bar || bar.px < 28 || bar.px > width * 0.55) return null;
  // The 3D scene's vertical scale, only when it is not physical.
  const tilt = (camera as TiltedCamera).tiltCamera;
  const relief = tilt && tilt.geometry.curvature > .05 ? reliefLabel(tilt.reliefScale ?? 1) : null;
  return (
    <span className="map-scale" data-scale-bar data-scale-primary={bar.primary} data-scale-nm={bar.nautical} data-relief={relief ?? undefined}
      aria-label={relief ? `${bar.label}; terrain heights ${relief.replace('relief ', '')} exaggerated` : bar.label}
      title={relief ? 'Terrain heights exaggerated for legibility; readouts stay physical' : undefined}>
      <span className="map-scale-rule" style={{ width: Math.round(bar.px) }} aria-hidden="true" />
      <span aria-hidden="true">{bar.primary}</span>
      <span aria-hidden="true">{bar.nautical}</span>
      {relief ? <span aria-hidden="true" className="map-scale-relief">{relief}</span> : null}
    </span>
  );
}
