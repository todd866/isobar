import { describe, expect, it } from 'vitest';
import { australiaLambert, globalEquirectangular, project } from '../../src/lib/lambert';
import { distanceNm, layoutTraffic, trafficDestination, trafficLabel, type TrafficAircraft, type TrafficVessel } from '../../src/lib/traffic';
const NOW = 1_790_500_000_000;
const plane: TrafficAircraft = { hex: 'abc123', callsign: 'QFA642', registration: '', type: 'B738', latitude: -31.95, longitude: 115.9, pressureAltitudeFt: 37000, distanceNm: 0, positionTimeMs: NOW, groundSpeedKt: 450, trackDegrees: 90 };
const ship: TrafficVessel = { id: '123456789', name: 'PACIFIC STAR', shipType: 70, latitude: -32.05, longitude: 115.7, positionTimeMs: NOW, groundSpeedKt: 16, trackDegrees: 180 };
const geo = globalEquirectangular(115.9, -31.95);
const camera = { centerX: 0, centerY: -31.95, halfWidth: 1, halfHeight: 1 };
const base = { aircraft: [plane], vessels: [ship], trails: new Map(), nowMs: NOW, geo, camera, width: 900, height: 600 };

describe('variant D layout', () => {
  it('preserves physical two-minute air / thirty-minute sea distances through projection', () => {
    const marks = layoutTraffic(base);
    for (const mark of marks) {
      const contact = mark.aircraft ?? mark.vessel!;
      expect(mark.vector).not.toBeNull();
      const lon = geo.lon0 + ((mark.vector!.x / base.width * 2 - 1) * camera.halfWidth + camera.centerX) / geo.F;
      const lat = (1 - mark.vector!.y / base.height * 2) * camera.halfHeight + camera.centerY;
      expect(distanceNm(contact.latitude, contact.longitude, lat, lon)).toBeCloseTo(contact.groundSpeedKt! * (mark.vessel ? 30 : 2) / 60, 7);
    }
    expect(marks.find((g) => g.aircraft)?.label).toBe('QFA642 370 450');
    expect(marks.find((g) => g.vessel)?.label).toBe('PACIFIC STAR 16kt');
  });
  it('keeps type and size independent of altitude, speed and selection', () => {
    for (const altitude of [1000, 5000, 20000, 37000]) for (const speed of [1, 450, 900]) {
      const [mark] = layoutTraffic({ ...base, vessels: [], aircraft: [{ ...plane, pressureAltitudeFt: altitude, groundSpeedKt: speed }], selectedColors: new Map([[plane.hex, '#007e75']]) });
      expect(mark.symbolClass).toBe('narrowbody'); expect(mark.size).toBe(9);
      expect(mark.altitudeBand).toBe([1000, 5000, 20000, 37000].indexOf(altitude));
      expect(mark.color).toBe('#007e75'); expect(mark.selected).toBe(true);
    }
  });
  it('uses projected heading on Lambert, local dateline distance, and no vector minimum', () => {
    const lambert = australiaLambert(), centre = project(lambert, plane.latitude, plane.longitude)!;
    const [mark] = layoutTraffic({ ...base, vessels: [], geo: lambert, camera: { centerX: centre.x, centerY: centre.y, halfWidth: .1, halfHeight: .1 } });
    expect(mark.trackDeg).not.toBeCloseTo(90, 0);
    expect(mark.trackDeg).toBeCloseTo((Math.atan2(mark.vector!.x - mark.x, mark.y - mark.vector!.y) * 180 / Math.PI + 360) % 360, 0);
    const dateline = { ...plane, longitude: 179.999, latitude: 0, groundSpeedKt: 450 };
    const [wrap] = layoutTraffic({ ...base, vessels: [], aircraft: [dateline], geo: globalEquirectangular(), camera: { centerX: 179.9, centerY: 0, halfWidth: 1, halfHeight: 1 } });
    expect(wrap.vector!.x - wrap.x).toBeGreaterThan(100); expect(wrap.vector!.x - wrap.x).toBeLessThan(120);
    const [tiny] = layoutTraffic({ ...base, vessels: [], aircraft: [{ ...plane, groundSpeedKt: .1 }] });
    expect(Math.hypot(tiny.vector!.x - tiny.x, tiny.vector!.y - tiny.y)).toBeLessThan(.1);
  });
  it('does not invent speed, altitude, heading or aircraft class for unknowns', () => {
    const [missing] = layoutTraffic({ ...base, vessels: [], aircraft: [{ ...plane, pressureAltitudeFt: NaN, type: 'ZZZZ', groundSpeedKt: undefined, trackDegrees: undefined }] });
    expect(missing.symbolClass).toBe('unknown'); expect(missing.altitudeBand).toBeNull(); expect(missing.vector).toBeNull(); expect(missing.trackDeg).toBeNull();
    expect(missing.label).toBe('QFA642 — —');
    for (const bad of [0, -1, NaN, Infinity]) expect(layoutTraffic({ ...base, vessels: [], aircraft: [{ ...plane, groundSpeedKt: bad }] })[0].vector).toBeNull();
    expect(layoutTraffic({ ...base, vessels: [{ ...ship, groundSpeedKt: 101 }] }).find((mark) => mark.vessel)?.vector).not.toBeNull();
    expect(layoutTraffic({ ...base, vessels: [], aircraft: [{ ...plane, groundSpeedKt: 1501 }] })[0].vector).not.toBeNull();
    expect(trafficDestination(0, 0, 90, 60).longitude).toBeCloseTo(.9993, 3);
    expect(trafficLabel({ ...plane, groundSpeedKt: 90, pressureAltitudeFt: 1500 })).toBe('QFA642 015 090');
  });
  it('keeps selected labels at wide zooms and separate aircraft/ship density bins', () => {
    const coLocated = { ...ship, latitude: plane.latitude, longitude: plane.longitude };
    const selectedColors = new Map([[plane.hex, '#007e75'], [`ship:${ship.id}`, '#926100']]);
    const world = layoutTraffic({ ...base, vessels: [coLocated], geo: globalEquirectangular(), camera: { centerX: 0, centerY: 0, halfWidth: 180, halfHeight: 90 }, selectedColors });
    expect(world).toHaveLength(2); expect(world.every((g) => g.densityDot && !g.vector)).toBe(true);
    expect(world.every((g) => g.selected && g.label)).toBe(true);
    const regional = layoutTraffic({ ...base, camera: { ...camera, halfHeight: 15, halfWidth: 20 }, selectedColors });
    expect(regional.every((g) => g.size === 6 && !g.densityDot && g.label)).toBe(true);
    expect(layoutTraffic({ ...base, camera: { ...camera, halfHeight: 15, halfWidth: 20 } }).every((g) => !g.label)).toBe(true);
  });
  it('fits data blocks inside viewport and avoids controls', () => {
    const [mark] = layoutTraffic({ ...base, vessels: [], avoid: [{ x: 450, y: 260, w: 260, h: 70 }] });
    expect(mark.labelOrigin!.x).toBeLessThan(mark.x); expect(mark.labelOrigin!.x).toBeGreaterThan(0);
    const covered = layoutTraffic({ ...base, avoid: [{ x: 0, y: 0, w: 900, h: 600 }] });
    expect(covered.every((g) => !g.label)).toBe(true);
  });
});
