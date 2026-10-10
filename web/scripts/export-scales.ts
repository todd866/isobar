import { UINT16_FILL, type QuantScale } from '../src/lib/quantise.ts';

export const SCALES: Record<string, QuantScale> = {
  // Global fields need the full pressure and temperature ranges; the former
  // Australian offsets silently clipped polar values when reused worldwide.
  mslp: { scale: 0.1, offset: 500, fill: UINT16_FILL },
  rain24: { scale: 0.1, offset: 0, fill: UINT16_FILL },
  t2m: { scale: 0.1, offset: -100, fill: UINT16_FILL },
  wind: { scale: 0.1, offset: 0, fill: UINT16_FILL },
  // Components retain their sign so the client can draw barbs/streamlines.
  // The range comfortably covers the ECMWF 10 m field over Australia.
  u10: { scale: 0.1, offset: -150, fill: UINT16_FILL },
  v10: { scale: 0.1, offset: -150, fill: UINT16_FILL },
  // Total cloud cover, percent. Shown only as model cloud, never as a satellite picture.
  tcc: { scale: 0.1, offset: 0, fill: UINT16_FILL },
};
