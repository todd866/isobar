import { FRAME_FAILED, FRAME_MISSING, FRAME_READY } from './chart-store';
import { FIELD_STOPS, type ColouredField, type FieldId, type FieldStop } from './field-color';
import type { FrameBlend } from './interpolate';

export type LegendState = 'ready' | 'loading' | 'missing' | 'error';

export const FIELD_VARIABLE: Record<Exclude<FieldId, 'none'>, string> = {
  rain: 'rain24',
  temp: 't2m',
  wind: 'wind',
};

export const FIELD_LABEL: Record<Exclude<FieldId, 'none'>, string> = {
  rain: '24 h rain',
  temp: 'Temperature',
  wind: 'Wind',
};

export interface LegendScale {
  stops: readonly FieldStop[];
  min: number;
  max: number;
  unit: 'mm' | '°C' | 'kt';
}

/** Palette metadata for a faithful legend gradient and its endpoint labels. */
export function legendScale(field: ColouredField): LegendScale {
  const stops = FIELD_STOPS[field];
  return {
    stops,
    min: stops[0].value,
    max: stops[stops.length - 1].value,
    unit: field === 'rain' ? 'mm' : field === 'temp' ? '°C' : 'kt',
  };
}

/**
 * What the legend under the map says for the field at this blend.
 * "Unavailable" only when a frame the blend needs is really missing from the
 * export; a frame still downloading is "loading", never "unavailable".
 */
export function legendState(state: ArrayLike<number> | undefined, blend: FrameBlend | null): LegendState {
  if (!state || !blend) return 'missing';
  const a = state[blend.i0];
  const b = state[blend.i1];
  if (a === FRAME_MISSING || b === FRAME_MISSING || a === undefined || b === undefined) return 'missing';
  if (a === FRAME_FAILED || b === FRAME_FAILED) return 'error';
  if (a !== FRAME_READY || b !== FRAME_READY) return 'loading';
  return 'ready';
}
