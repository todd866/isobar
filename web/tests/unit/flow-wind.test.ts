import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedChart } from '../../src/lib/chart-store';
import { FRAME_MISSING, FRAME_PENDING, FRAME_READY } from '../../src/lib/chart-store';
import * as flow from '../../src/lib/flow';
import { createWindSampler, flowWindLegend } from '../../src/lib/flow-wind';

const spec = (fill = 65535) => ({ file: null, frames: ['a', 'b', 'c'], encoding: 'raw' as const, units: 'm/s', scale: 1, offset: 0, fill });
function chart(options: { u?: boolean; v?: boolean; states?: number[]; values?: number[]; hours?: number[] } = {}): LoadedChart {
  const hours = options.hours ?? [0, 3, 9];
  const variables: Record<string, ReturnType<typeof spec>> = { mslp: spec() };
  if (options.u) variables.u10 = spec();
  if (options.v) variables.v10 = spec();
  const state: Record<string, Uint8Array> = {};
  const packed: Record<string, Uint16Array> = {};
  for (const name of Object.keys(variables)) {
    state[name] = new Uint8Array(options.states ?? [FRAME_READY, FRAME_READY, FRAME_READY]);
    packed[name] = new Uint16Array(hours.length * 4).fill(name === 'mslp' ? 1000 : 0);
  }
  if (options.values) {
    packed.u10 = new Uint16Array(options.values);
    packed.v10 = new Uint16Array(options.values.map((value) => value + 100));
  }
  return {
    manifest: { forecastHours: hours, nx: 2, ny: 2, west: 110, east: 112, south: -34, north: -32, wrapsLongitude: false, variables },
    packed, state, coast: { rings: [] }, coastLod: [], aviation: null, points: null,
    listeners: new Set(), complete: Promise.resolve(), want: async () => {},
  } as unknown as LoadedChart;
}

afterEach(() => vi.restoreAllMocks());

describe('wind source and sampler', () => {
  it('uses divergent model u/v rather than pressure fallback', () => {
    const spy = vi.spyOn(flow, 'surfaceWindFromPressure');
    const sampler = createWindSampler(chart({ u: true, v: true, values: [8, 8, 8, 8, 20, 20, 20, 20, 40, 40, 40, 40] }), 90);
    expect(sampler?.(111, -33)).toEqual({ u: 14, v: 114 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('interpolates an irregular ladder and includes the nonzero first hour', () => {
    const sampler = createWindSampler(chart({ u: true, v: true, values: [10, 10, 10, 10, 30, 30, 30, 30, 50, 50, 50, 50], hours: [6, 9, 15] }), 90);
    expect(sampler?.(111, -33)).toEqual({ u: 20, v: 120 });
  });

  it('estimates from ready pressure while model components are partial, pending or missing', () => {
    for (const c of [chart({ u: true }), chart({ v: true })]) {
      expect(createWindSampler(c, 90)?.source).toBe('estimate');
    }
    const missing = chart({ u: true, v: true });
    missing.state.v10[1] = FRAME_MISSING;
    expect(createWindSampler(missing, 90)?.source).toBe('estimate');
    const pending = chart({ u: true, v: true });
    pending.state.u10[1] = FRAME_PENDING;
    expect(createWindSampler(pending, 90)?.source).toBe('estimate');
    pending.state.mslp[1] = FRAME_PENDING;
    expect(createWindSampler(pending, 90)).toBeNull();
    expect(flowWindLegend('estimate')).toBe('Wind streaks: estimated from isobars');
    expect(flowWindLegend('model')).toBe('Wind streaks: model 10 m wind');
    expect(flowWindLegend('to-model')).toContain('isobar estimate → model');
    expect(flowWindLegend('to-estimate')).toContain('model wind → isobar estimate');
  });

  it('keeps missing cells missing within an otherwise ready model blend', () => {
    const spy = vi.spyOn(flow, 'surfaceWindFromPressure');
    const hole = chart({ u: true, v: true });
    hole.packed.u10[0] = 65535;
    expect(createWindSampler(hole, 0)?.(111, -33)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});


describe('forecast-clock continuity and model direction', () => {
  it('blends both components continuously through an irregular forecast boundary', () => {
    const c = chart({ u: true, v: true, hours: [6, 9, 15],
      values: [8, 8, 8, 8, 20, 20, 20, 20, 44, 44, 44, 44] });
    const left = createWindSampler(c, 180 - 0.001)!(111, -33)!;
    const at = createWindSampler(c, 180)!(111, -33)!;
    const right = createWindSampler(c, 180 + 0.001)!(111, -33)!;
    expect(at).toEqual({ u: 20, v: 120 });
    for (const component of ['u', 'v'] as const) {
      expect(at[component] - left[component]).toBeCloseTo(0.001 / 15, 8);
      expect(right[component] - at[component]).toBeCloseTo(0.001 / 15, 8);
    }
    expect(createWindSampler(c, 360)!(111, -33)).toEqual({ u: 32, v: 132 });
  });

  it('keeps the exact forecast instant visible when the following model frame is pending', () => {
    const c = chart({ u: true, v: true, states: [FRAME_READY, FRAME_READY, FRAME_PENDING] });
    expect(createWindSampler(c, 180)!(111, -33)).toEqual({ u: 0, v: 0 });
    expect(createWindSampler(c, 180.01)).toBeNull();
  });

  it('calls the pressure estimator on a legacy manifest without components', () => {
    const spy = vi.spyOn(flow, 'surfaceWindFromPressure');
    const c = chart();
    // The tiny pressure fixture has no gradient stencil beyond its edge.
    expect(createWindSampler(c, 90)!(111, -33)).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('preserves different supplied inward angles without applying land/sea rotations', () => {
    const c = chart({ u: true, v: true });
    c.manifest.variables.u10.offset = -80;
    c.manifest.variables.v10.offset = -80;
    // A synthetic westward pressure gradient, with distinct model crossing
    // angles at the west/east cells. These are input vectors, not meteorology.
    c.packed.mslp.set([1000, 1010, 1000, 1010]);
    c.packed.u10.set([78, 74, 78, 74]);
    c.packed.v10.set([68, 70, 68, 70]);
    const sample = createWindSampler(c, 0)!;
    expect(sample(110, -33)).toEqual({ u: -2, v: -12 });
    expect(sample(112, -33)).toEqual({ u: -6, v: -10 });
  });
});
