import type { Snapshot } from '../../src/snapshot.ts';

/** Fixed place/clock, with a dry TAF and independently replaceable METAR cloud. */
export function learnSnapshot(cloud = 'FEW006 BKN012 OVC040', wind = '24015G25KT'): Snapshot {
  return {
    now: '2026-10-09T06:17:00Z',
    runTime: '2026-10-09T00:00:00Z', runError: null, gridSource: 'published',
    sampleTime: '2026-10-09T06:00:00Z', chartPng: null,
    gradient: null, sigmets: [], notamCount: null, points: [],
    airports: [{
      icao: 'YPPH', name: 'Perth', zone: 'Australia/Perth', lat: -31.9, lon: 115.9,
      metar: {
        raw: `METAR YPPH 090530Z ${wind} 9999 ${cloud} 18/12 Q1012`, time: '2026-10-09T05:30:00Z',
        cloud, vis: '', wind, clock: '', age: '', aged: false, tip: '',
      },
      taf: { raw: 'TAF YPPH 090400Z 0906/1012 24015KT CAVOK', issue: '2026-10-09T04:00:00Z', from: '2026-10-09T06:00:00Z', to: '2026-10-10T12:00:00Z', header: '', headerUtc: '', lines: [] },
      sample: null,
    }],
  };
}
