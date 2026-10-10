import { kiteBandColor, kiteBandState, type KiteBand } from './coastal';

/** Single-hue and muted ramps. No rainbow. Alpha 0 means do not tint. */
export type FieldId = 'none' | 'rain' | 'temp' | 'wind';
export type ColouredField = Exclude<FieldId, 'none'>;

export interface Rgba { r: number; g: number; b: number; a: number; }
export interface FieldStop { value: number; color: Rgba; }

export interface FieldBase {
  sea: Rgba;
  land: Rgba;
}

/** Low-chroma plate colours used while Rain or Temperature is selected. */
export const FIELD_BASE: Readonly<{ day: FieldBase; night: FieldBase }> = {
  day: {
    sea: { r: 0.84, g: 0.90, b: 0.93, a: 1 },
    land: { r: 0.94, g: 0.945, b: 0.92, a: 1 },
  },
  night: {
    sea: { r: 0.075, g: 0.14, b: 0.19, a: 1 },
    land: { r: 0.15, g: 0.22, b: 0.26, a: 1 },
  },
};

export function fieldBase(field: FieldId, dark: boolean, land: boolean): Rgba | null {
  if (field !== 'rain' && field !== 'temp') return null;
  const base = dark ? FIELD_BASE.night : FIELD_BASE.day;
  return land ? base.land : base.sea;
}

/** One palette consumed by Canvas2D, the legend, and generated WebGL GLSL. */
export const FIELD_STOPS: Readonly<Record<ColouredField, readonly FieldStop[]>> = {
  rain: [
    { value: 0, color: { r: 0, g: 0, b: 0, a: 0 } },
    { value: 0.2, color: { r: 0.51, g: 0.73, b: 0.82, a: 0 } },
    { value: 1, color: { r: 0.51, g: 0.73, b: 0.82, a: 0.38 } },
    { value: 5, color: { r: 0.24, g: 0.60, b: 0.77, a: 0.64 } },
    { value: 15, color: { r: 0.14, g: 0.42, b: 0.65, a: 0.72 } },
    { value: 40, color: { r: 0.11, g: 0.22, b: 0.43, a: 0.8 } },
  ],
  // Extend over a meaningful Australian and continental temperature range.
  temp: [
    { value: -40, color: { r: 0.1, g: 0.2, b: 0.42, a: 0.52 } },
    { value: -20, color: { r: 0.14, g: 0.35, b: 0.62, a: 0.46 } },
    { value: 0, color: { r: 0.28, g: 0.56, b: 0.76, a: 0.4 } },
    { value: 10, color: { r: 0.40, g: 0.67, b: 0.75, a: 0.42 } },
    { value: 20, color: { r: 0.89, g: 0.87, b: 0.75, a: 0.36 } },
    { value: 25, color: { r: 0.92, g: 0.75, b: 0.44, a: 0.44 } },
    { value: 30, color: { r: 0.88, g: 0.48, b: 0.25, a: 0.5 } },
    { value: 40, color: { r: 0.72, g: 0.2, b: 0.2, a: 0.54 } },
    { value: 50, color: { r: 0.43, g: 0.08, b: 0.14, a: 0.6 } },
  ],
  // A light speed tint under the flow streaks. Calm stays clear.
  wind: [
    { value: 0, color: { r: 0, g: 0, b: 0, a: 0 } },
    { value: 8, color: { r: 0.55, g: 0.66, b: 0.72, a: 0.07 } },
    { value: 20, color: { r: 0.42, g: 0.55, b: 0.64, a: 0.11 } },
    { value: 35, color: { r: 0.28, g: 0.4, b: 0.48, a: 0.14 } },
    { value: 55, color: { r: 0.18, g: 0.26, b: 0.32, a: 0.16 } },
  ],
};

function glslColour(color: Rgba): string {
  return `vec4(${color.r.toFixed(8)}, ${color.g.toFixed(8)}, ${color.b.toFixed(8)}, ${color.a.toFixed(8)})`;
}

function glslNumber(value: number): string {
  const text = String(value);
  return text.includes('.') ? text : `${text}.0`;
}

export function fieldBaseToGlsl(): string {
  const day = FIELD_BASE.day;
  const night = FIELD_BASE.night;
  const vec3 = (c: Rgba) => `vec3(${c.r.toFixed(8)}, ${c.g.toFixed(8)}, ${c.b.toFixed(8)})`;
  return [
    `const vec3 FIELD_SEA_DAY = ${vec3(day.sea)};`,
    `const vec3 FIELD_LAND_DAY = ${vec3(day.land)};`,
    `const vec3 FIELD_SEA_NIGHT = ${vec3(night.sea)};`,
    `const vec3 FIELD_LAND_NIGHT = ${vec3(night.land)};`,
  ].join('\n');
}

/** Generate a GLSL branch from FIELD_STOPS; exported for CPU/GPU parity tests. */
export function fieldStopsToGlsl(field: ColouredField, fieldNumber: number): string {
  const stops = FIELD_STOPS[field];
  const lines = [`  if (field == ${fieldNumber}) {`, `    if (value <= ${glslNumber(stops[0].value)}) return ${glslColour(stops[0].color)};`];
  for (let i = 1; i < stops.length; i += 1) {
    const previous = stops[i - 1];
    const current = stops[i];
    const fraction = `(value - ${glslNumber(previous.value)}) / ${glslNumber(current.value - previous.value)}`;
    lines.push(`    if (value < ${glslNumber(current.value)}) return mix(${glslColour(previous.color)}, ${glslColour(current.color)}, ${fraction});`);
  }
  lines.push(`    return ${glslColour(stops[stops.length - 1].color)};`, '  }');
  return lines.join('\n');
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const u = Math.min(1, Math.max(0, t));
  return { r: a.r + (b.r - a.r) * u, g: a.g + (b.g - a.g) * u, b: a.b + (b.b - a.b) * u, a: a.a + (b.a - a.a) * u };
}

function ramp(stops: readonly FieldStop[], value: number): Rgba {
  if (!Number.isFinite(value)) return { r: 0, g: 0, b: 0, a: 0 };
  if (value <= stops[0].value) return stops[0].color;
  const last = stops[stops.length - 1];
  if (value >= last.value) return last.color;
  for (let i = 1; i < stops.length; i += 1) {
    if (value <= stops[i].value) {
      const span = stops[i].value - stops[i - 1].value;
      return mix(stops[i - 1].color, stops[i].color, span === 0 ? 0 : (value - stops[i - 1].value) / span);
    }
  }
  return last.color;
}

export function fieldColor(field: FieldId, value: number, kiteBand?: KiteBand | null): Rgba {
  if (field === 'none' || !Number.isFinite(value)) return { r: 0, g: 0, b: 0, a: 0 };
  if (field === 'wind' && kiteBand) {
    const rgb = kiteBandColor(kiteBandState(value, kiteBand));
    return rgb ? { r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255, a: 0.4 } : { r: 0, g: 0, b: 0, a: 0 };
  }
  return ramp(FIELD_STOPS[field], value);
}

export const SEA = { r: 0.835, g: 0.89, b: 0.933 };
export const LAND = { r: 0.957, g: 0.937, b: 0.722 };
export const INK = '#1b2830';
export const HEADER = '#1a6ea8';
