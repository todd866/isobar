import { describe, expect, it } from 'vitest';
import { TRAFFIC_PALETTES, TRAFFIC_SHAPES, altitudeBand, aircraftClass, trafficAltitudeShade, vesselClass } from '../../src/lib/traffic-symbols';

describe('traffic variant D symbols', () => {
  it('keeps all twelve normalized sheet silhouettes', () => {
    expect(Object.keys(TRAFFIC_SHAPES)).toHaveLength(12);
    for (const points of Object.values(TRAFFIC_SHAPES)) for (const [x, y] of points) expect(Math.max(Math.abs(x), Math.abs(y))).toBeLessThanOrEqual(1);
  });
  it('uses exact ICAO designators and no prefix/callsign inference', () => {
    expect(aircraftClass('A388')).toBe('heavy'); expect(aircraftClass(' b38m ')).toBe('narrowbody'); expect(aircraftClass('AT72')).toBe('regional'); expect(aircraftClass('PC12')).toBe('regional'); expect(aircraftClass('PC24')).toBe('bizjet'); expect(aircraftClass('E190')).toBe('regional'); expect(aircraftClass('E75L')).toBe('regional'); expect(aircraftClass('BE30')).toBe('regional'); expect(aircraftClass('B752')).toBe('narrowbody');
    expect(aircraftClass('GLF6')).toBe('bizjet'); expect(aircraftClass('C172')).toBe('ga'); expect(aircraftClass('EC35')).toBe('helicopter');
    expect(aircraftClass('A32')).toBe('unknown'); expect(aircraftClass('QFA642')).toBe('unknown'); expect(aircraftClass('A300')).toBe('unknown'); expect(aircraftClass('E175')).toBe('unknown'); expect(aircraftClass('B350')).toBe('unknown'); expect(aircraftClass('PA28')).toBe('unknown'); expect(aircraftClass('H125')).toBe('unknown'); expect(aircraftClass('SR22T')).toBe('unknown');
  });
  it('keeps AIS vessel families separate from aircraft silhouettes', () => {
    expect(vesselClass(30)).toBe('fishing'); expect(vesselClass(36)).toBe('sail'); expect(vesselClass(37)).toBe('sail');
    expect(vesselClass(60)).toBe('passenger'); expect(vesselClass(79)).toBe('cargo'); expect(vesselClass(80)).toBe('tanker');
    expect(vesselClass(90)).toBe('tug'); expect(vesselClass(null)).toBe('tug');
  });
  it('uses 2000, 10000 and 30000 ft boundaries', () => {
    expect(altitudeBand(null)).toBeNull(); expect(altitudeBand(-1)).toBeNull(); expect(altitudeBand(Number.NaN)).toBeNull();
    expect(altitudeBand(1999)).toBe(0); expect(altitudeBand(2000)).toBe(1); expect(altitudeBand(9999)).toBe(1);
    expect(altitudeBand(10000)).toBe(2); expect(altitudeBand(29999)).toBe(2); expect(altitudeBand(30000)).toBe(3);
  });
  it('returns light/dark shade and air fallback for unknown altitude', () => {
    expect(trafficAltitudeShade(30000)).toBe(TRAFFIC_PALETTES.light.levels[3]); expect(trafficAltitudeShade(30000, true)).toBe(TRAFFIC_PALETTES.dark.levels[3]);
    expect(trafficAltitudeShade(undefined)).toBe(TRAFFIC_PALETTES.light.air); expect(trafficAltitudeShade(undefined, true)).toBe(TRAFFIC_PALETTES.dark.air);
  });
});
