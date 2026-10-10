import { describe, it, expect } from 'vitest';
import { orbitFrame, orbitRecord, parseOrbitSource, REFERENCE_ORBIT, sceneVector, MAX_ORBIT_AGE_MS, type OrbitSource } from '../../src/lib/earth-orbit';

describe('Earth orbit contract', () => {
  it('parses numeric OMM fields at UTC and agrees with the equivalent reference TLE', () => {
    // The published 2019 TLE expressed as OMM, not a fresh observation.
    const omm = {OBJECT_NAME:'ISS',OBJECT_ID:'1998-067A',NORAD_CAT_ID:25544,ELEMENT_SET_NO:999,
      EPOCH:'2019-06-05T12:12:57.999',MEAN_MOTION:15.51174618,ECCENTRICITY:.0008217,
      INCLINATION:51.6433,RA_OF_ASC_NODE:59.2583,ARG_OF_PERICENTER:16.4489,MEAN_ANOMALY:347.6017,
      BSTAR:.00059442,MEAN_MOTION_DOT:.00003075,MEAN_MOTION_DDOT:0};
    const raw = {kind:'elements',retrievedAt:'2019-06-05T12:13:00Z',omm};
    const source = parseOrbitSource(raw), utc = Date.parse(REFERENCE_ORBIT.epoch);
    expect(source.epoch).toBe('2019-06-05T12:12:57.999Z');
    const actual=orbitFrame(source,orbitRecord(source),utc), expected=orbitFrame(REFERENCE_ORBIT,orbitRecord(REFERENCE_ORBIT),utc);
    expect(Math.hypot(...actual.position.map((v,i)=>v-expected.position[i]))).toBeLessThan(.02);
    for (const patch of [{EPOCH:'broken'},{ECCENTRICITY:1},{MEAN_MOTION:NaN},{TIME_SYSTEM:'TAI'},{REF_FRAME:'GCRF'}]) {
      expect(()=>parseOrbitSource({...raw,omm:{...omm,...patch}})).toThrow();
    }
  });
  it('matches the published Vallado 00005 TEME verification case after the scene transform', () => {
    // AIAA 2006-6753: t=0 position [7022.46529266,-1400.08296755,0.03995155] km.
    // GMST at JD 2451723.28495062: 3.4691723423794 rad.
    const source: OrbitSource = { kind: 'reference', epoch: '2000-06-27T18:50:19.733Z', retrievedAt: null, tle: [
      '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753',
      '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667',
    ] };
    const frame = orbitFrame(source, orbitRecord(source), Date.parse(source.epoch));
    const g = 3.4691723423794, x = 7022.46529266, y = -1400.08296755;
    const expected = [x*Math.cos(g)+y*Math.sin(g), .03995155, x*Math.sin(g)-y*Math.cos(g)];
    expect(Math.hypot(...frame.position.map((v, i) => v - expected[i]))).toBeLessThan(.01);
  });
  it('uses a right-handed orbital frame and a bounded ISS altitude', () => {
    const frame = orbitFrame(REFERENCE_ORBIT, orbitRecord(REFERENCE_ORBIT), Date.parse(REFERENCE_ORBIT.epoch));
    for (const vector of [frame.radial, frame.along, frame.normal, frame.sun]) expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
    expect(frame.radial.reduce((sum, x, i) => sum+x*frame.along[i], 0)).toBeCloseTo(0, 10);
    expect(frame.altitude).toBeGreaterThan(350);
    expect(frame.altitude).toBeLessThan(450);
    expect(sceneVector({x:0,y:1,z:0})).toEqual([0,0,-1]);
  });
  it('never advances a historical orbit to today or propagates missing time', () => {
    const record = orbitRecord(REFERENCE_ORBIT);
    expect(() => orbitFrame(REFERENCE_ORBIT, record, Date.parse(REFERENCE_ORBIT.epoch)+MAX_ORBIT_AGE_MS+1)).toThrow();
    expect(() => orbitFrame(REFERENCE_ORBIT, record, NaN)).toThrow();
  });
  it('rejects other spacecraft, corrupt epochs, non-finite or implausible elements', () => {
    for (const raw of [null, {}, {kind:'elements',omm:{}}, {kind:'elements',omm:{NORAD_CAT_ID:42}},
      {kind:'elements',omm:{NORAD_CAT_ID:25544,MEAN_MOTION:'15.5'}}]) expect(() => parseOrbitSource(raw)).toThrow();
  });
  it('anchors a reference fallback to its published epoch regardless of supplied dates', () => {
    expect(parseOrbitSource({kind:'reference',epoch:'2026-10-09'})).toEqual(REFERENCE_ORBIT);
  });
});
