import { describe, expect, it } from 'vitest';
import { globalEquirectangular } from '../../src/lib/lambert';
import {
  createAnimatedPressureLabelState,
  pressureCentrePoint,
  updateAnimatedPressureLabels,
  type AnimatedPressureLabelCandidate,
} from '../../src/lib/animated-pressure-labels';

const geo = globalEquirectangular(0, 0);
const camera = { centerX: 0, centerY: 0, halfWidth: 20, halfHeight: 10 };
const options = { geo, camera, width: 800, height: 400 };
const label = (lon: number, lat: number, extra: Partial<AnimatedPressureLabelCandidate> = {}): AnimatedPressureLabelCandidate => ({
  key: 'isobar:1000', kind: 'isobar', level: 1000, lon, lat, x: 0, y: 0, w: 44, h: 16, text: '1000', ...extra,
});

describe('animated pressure labels', () => {
  it('moves labels with the line while clamping ordinary frame motion', () => {
    const first = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [label(0, 0)], options);
    const second = updateAnimatedPressureLabels(first.state, [label(0.1, 0)], options);
    const a = first.labels[0], b = second.labels[0];
    expect(Math.hypot((b.x + b.w / 2) - (a.x + a.w / 2), (b.y + b.h / 2) - (a.y + a.h / 2))).toBeLessThanOrEqual(3.001);
  });

  it('fades at the old position before a discontinuous re-placement', () => {
    let frame = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [label(0, 0)], options);
    const oldCenter = frame.labels[0].x + frame.labels[0].w / 2;
    frame = updateAnimatedPressureLabels(frame.state, [label(10, 0)], options);
    const fading = frame.state.labels.get('isobar:1000')!;
    expect(fading.x + fading.w / 2).toBe(oldCenter);
    expect(fading.alpha).toBeLessThan(1);
    for (let i = 0; i < 5; i += 1) frame = updateAnimatedPressureLabels(frame.state, [label(10, 0)], options);
    const replaced = frame.state.labels.get('isobar:1000')!;
    expect(replaced.x + replaced.w / 2).not.toBe(oldCenter);
  });

  it('reattaches an isobar to the current pressure sample', () => {
    const pressureSample = (lon: number, lat: number) => 1000 + lon;
    const first = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [label(0, 0)], { ...options, pressureSample });
    const second = updateAnimatedPressureLabels(first.state, [label(0, 0)], { ...options, pressureSample });
    expect(second.labels[0].lon).toBeCloseTo(0, 5);
    expect(second.labels[0].lat).toBeCloseTo(0, 5);
  });

  it('refines centre labels to the live pressure extremum', () => {
    const point = pressureCentrePoint(1, 1, (lon, lat) => 1000 + (lon - 2) ** 2 + 2 * (lat + 3) ** 2);
    expect(point).not.toBeNull();
    expect(point!.lon).toBeCloseTo(2, 2);
    expect(point!.lat).toBeCloseTo(-3, 2);
  });

  it('leaves a fully transparent discontinuity frame before reappearing', () => {
    let frame = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [label(0, 0)], options);
    frame = updateAnimatedPressureLabels(frame.state, [label(10, 0)], options);
    expect(frame.state.labels.get('isobar:1000')!.alpha).toBe(0);
    expect(frame.labels).toHaveLength(0);
    frame = updateAnimatedPressureLabels(frame.state, [label(10, 0)], options);
    expect(frame.labels[0].alpha).toBeGreaterThan(0);
  });
  it('follows every interpolated frame and ignores a new placement on the same line', () => {
    let frame = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [label(0, 0)], {...options, pressureSample:lon=>1000+lon});
    for (let i=1;i<=30;i++) {
      frame = updateAnimatedPressureLabels(frame.state, [label(0, 5)], {...options, pressureSample:lon=>1000+lon-i*.01});
      expect(frame.labels[0].lon).toBeCloseTo(i*.01,5);
      expect(frame.labels[0].lat).toBeCloseTo(0,5);
    }
  });
  it('fades an invalid anchor instead of painting an off-line number', () => {
    let frame = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [label(0,0)], {...options, pressureSample:lon=>1000+lon});
    for(let i=0;i<12;i++) frame=updateAnimatedPressureLabels(frame.state,[label(0,0)],{...options,pressureSample:()=>null});
    expect(frame.labels).toHaveLength(0);
  });

  it('rejects a centre whose worker type is opposite the live extremum', () => {
    const centre: AnimatedPressureLabelCandidate = {
      key: 'centre:1000', kind: 'centre', lon: 0, lat: 0,
      x: 0, y: 0, w: 52, h: 32, text: 'H 1000',
    };
    const pressureSample = (lon: number, lat: number) => 1000 + lon ** 2 + lat ** 2;
    const frame = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [centre], {
      ...options, pressureSample, fadePerFrame: 0.2,
    });
    expect(frame.labels).toHaveLength(0);
  });

  it('rejects a low whose worker type is opposite the live extremum', () => {
    const centre: AnimatedPressureLabelCandidate = {
      key: 'centre:1000', kind: 'centre', lon: 0, lat: 0,
      x: 0, y: 0, w: 52, h: 32, text: 'L 1000',
    };
    const pressureSample = (lon: number, lat: number) => 1000 - lon ** 2 - lat ** 2;
    const frame = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [centre], {
      ...options, pressureSample, fadePerFrame: 0.2,
    });
    expect(frame.labels).toHaveLength(0);
  });

  it('accepts both live extremum types and formats their live value', () => {
    const candidate = (text: string): AnimatedPressureLabelCandidate => ({
      key: `centre:${text}`, kind: 'centre', lon: 0, lat: 0,
      x: 0, y: 0, w: 52, h: 32, text,
    });
    const high = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [candidate('H 1000')], {
      ...options,
      pressureSample: (lon, lat) => 1000 - lon ** 2 - lat ** 2,
      formatPressure: (value) => value.toFixed(1),
    });
    expect(high.labels[0].text).toBe('H 1000.0');
    const low = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [candidate('L 1000')], {
      ...options,
      pressureSample: (lon, lat) => 1000 + lon ** 2 + lat ** 2,
      formatPressure: (value) => value.toFixed(1),
    });
    expect(low.labels[0].text).toBe('L 1000.0');
  });

  it('fades a previously valid centre when its live type changes', () => {
    const centre: AnimatedPressureLabelCandidate = {
      key: 'centre:1000', kind: 'centre', lon: 0, lat: 0,
      x: 0, y: 0, w: 52, h: 32, text: 'H 1000',
    };
    const high = (lon: number, lat: number) => 1000 - lon ** 2 - lat ** 2;
    const low = (lon: number, lat: number) => 1000 + lon ** 2 + lat ** 2;
    const first = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [centre], {
      ...options, pressureSample: high, fadePerFrame: 0.2,
    });
    const second = updateAnimatedPressureLabels(first.state, [centre], {
      ...options, pressureSample: low, fadePerFrame: 0.1,
    });
    expect(second.labels[0].alpha).toBeLessThan(first.labels[0].alpha);
  });

  it('rejects a centre when a neighboring pressure sample is missing', () => {
    const centre: AnimatedPressureLabelCandidate = {
      key: 'centre:1000', kind: 'centre', lon: 0, lat: 0,
      x: 0, y: 0, w: 52, h: 32, text: 'H 1000',
    };
    const high = (lon: number, lat: number) => 1000 - lon ** 2 - lat ** 2;
    const missingNeighbor = (lon: number, lat: number) => (
      Math.abs(lon) === 0.5 && lat === 0 ? null : high(lon, lat)
    );
    let frame = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [centre], {
      ...options, pressureSample: high, fadePerFrame: 0.2,
    });
    frame = updateAnimatedPressureLabels(frame.state, [centre], {
      ...options, pressureSample: missingNeighbor, fadePerFrame: 0.2,
    });
    expect(frame.labels).toHaveLength(0);
  });

  it('fades an invalid centre completely over repeated frames', () => {
    const centre: AnimatedPressureLabelCandidate = {
      key: 'centre:1000', kind: 'centre', lon: 0, lat: 0,
      x: 0, y: 0, w: 52, h: 32, text: 'H 1000',
    };
    const high = (lon: number, lat: number) => 1000 - lon ** 2 - lat ** 2;
    let frame = updateAnimatedPressureLabels(createAnimatedPressureLabelState(), [centre], {
      ...options, pressureSample: high, fadePerFrame: 0.2,
    });
    for (let i = 0; i < 6; i += 1) {
      frame = updateAnimatedPressureLabels(frame.state, [centre], {
        ...options, pressureSample: () => null, fadePerFrame: 0.2,
      });
    }
    expect(frame.labels).toHaveLength(0);
    expect(frame.state.labels.size).toBe(0);
  });

});
