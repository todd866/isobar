import { describe, expect, it } from 'vitest';
import { FIELD_BASE, FIELD_STOPS, fieldBase, fieldColor, fieldStopsToGlsl } from '../../src/lib/field-color';
import { legendScale } from '../../src/lib/legend';

describe('weather field palette', () => {
  it('covers the extended temperature range and keeps endpoint alpha', () => {
    expect(FIELD_STOPS.temp[0].value).toBe(-40);
    expect(FIELD_STOPS.temp.at(-1)?.value).toBe(50);
    expect(fieldColor('temp', -50)).toEqual(FIELD_STOPS.temp[0].color);
    expect(fieldColor('temp', 60)).toEqual(FIELD_STOPS.temp.at(-1)?.color);
    expect(fieldColor('temp', -30).a).toBeGreaterThan(0);
    expect(fieldColor('temp', 45).a).toBeGreaterThan(0);
  });

  it('uses the same stop values and opacity in generated GLSL', () => {
    for (const field of ['rain', 'temp', 'wind'] as const) {
      const glsl = fieldStopsToGlsl(field, field === 'rain' ? 1 : field === 'temp' ? 2 : 3);
      expect(glsl).toContain(`value <= ${FIELD_STOPS[field][0].value.toFixed(1)}`);
      for (const stop of FIELD_STOPS[field].slice(1)) {
        expect(glsl).toContain(`value < ${stop.value.toFixed(1)}`);
        expect(glsl).toContain(stop.color.a.toFixed(8));
      }
    }
  });

  it('uses neutral field bases while leaving wind on the existing plate', () => {
    expect(fieldBase('rain', false, false)).toBe(FIELD_BASE.day.sea);
    expect(fieldBase('temp', true, true)).toBe(FIELD_BASE.night.land);
    expect(fieldBase('wind', false, false)).toBeNull();
    expect(fieldBase('none', false, false)).toBeNull();
  });

  it('keeps Kite wind colouring ahead of the normal wind palette', () => {
    expect(fieldColor('wind', 0.01).r).toBeLessThan(0.01);
    expect(fieldColor('wind', 20)).not.toEqual(fieldColor('wind', 20, { min: 15, max: 25 }));
    expect(fieldColor('wind', 0, { min: 15, max: 25 }).a).toBe(0.4);
    expect(fieldColor('wind', -1, { min: 15, max: 25 }).a).toBe(0);
  });

  it('distinguishes subzero temperatures and leaves missing values untinted', () => {
    expect(fieldColor('temp', -20)).not.toEqual(fieldColor('temp', 0));
    expect(fieldColor('temp', -10)).not.toEqual(fieldColor('temp', -20));
    for (const field of ['rain', 'temp', 'wind'] as const) expect(fieldColor(field, NaN).a).toBe(0);
  });

  it('exposes the exact palette endpoints to legends', () => {
    expect(legendScale('temp')).toMatchObject({ min: -40, max: 50, unit: '°C' });
    expect(legendScale('rain').stops).toBe(FIELD_STOPS.rain);
  });
});
