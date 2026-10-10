import { describe, expect, it } from 'vitest';
import type { ChartManifest } from '../../src/lib/manifest';
import { answerFocus, anchorsFromTools } from '../../src/lib/chat/links';
import { runTool, sampleRegion, type PublishedChart } from '../../src/lib/chat/tools';
import type { ChatAnchors } from '../../src/lib/chat/types';

const manifest: ChartManifest = {
  schema: 2, contract: 'isobar-web', run: '2026-10-08T00:00:00Z', generated: '',
  forecastHours: [0], uniformStepHours: null, nx: 5, ny: 5,
  west: 110, east: 114, north: -32, south: -36, step: 1, wrapsLongitude: false, dtype: 'uint16',
  variables: { rain24: { file: null, frames: ['frame'], encoding: 'raw', units: 'mm', scale: 1, offset: 0, fill: 65535 } },
  places: [], aviation: 'aviation.json', points: null, attribution: [],
};
const chart: PublishedChart = {
  manifest,
  frame: () => new Float32Array(25).fill(4.5),
  points: null, aviation: null, sky: null, places: [], profile: async () => null,
};

describe('regional chat sampling', () => {
  it('samples three to six named points and returns valid anchors for every result', () => {
    const result = sampleRegion(chart, 'rain', [
      { name: 'North sample', lat: -33, lon: 111 },
      { name: 'Central sample', lat: -34, lon: 112 },
      { name: 'South sample', lat: -35, lon: 113 },
    ], '2026-10-08T00:00:00Z');
    expect(result).toMatchObject({ var: 'rain', count: 3 });
    expect((result.samples as Record<string, unknown>[]).map((sample) => sample.value)).toEqual([4.5, 4.5, 4.5]);
    expect((result.samples as Record<string, unknown>[]).map((sample) => [sample.name, sample.lat, sample.lon])).toEqual([
      ['North sample', -33, 111], ['Central sample', -34, 112], ['South sample', -35, 113],
    ]);
    expect(anchorsFromTools([result]).places).toEqual([
      { text: 'North sample', lat: -33, lon: 111 },
      { text: 'Central sample', lat: -34, lon: 112 },
      { text: 'South sample', lat: -35, lon: 113 },
    ]);
  });

  it('rejects an unbounded request or coordinates outside the chart coordinate bounds', async () => {
    expect(sampleRegion(chart, 'rain', [], '2026-10-08T00:00:00Z')).toEqual({ error: 'sample_region needs 3 to 6 points' });
    expect(sampleRegion(chart, 'rain', [
      { name: 'AA', lat: -33, lon: 111 }, { name: 'BB', lat: -34, lon: 112 }, { name: 'CC', lat: 91, lon: 113 },
    ], '2026-10-08T00:00:00Z')).toEqual({ error: 'each point needs a named latitude and longitude within bounds' });
    await expect(runTool('sample_region', { var: 'rain', timeUtc: '2026-10-08T00:00:00Z', points: [{ name: 'AA', lat: -33, lon: 111 }] }, chart, { archive: false, queueArchive: async () => false })).resolves.toEqual({ error: 'sample_region needs 3 to 6 points' });
  });

  it('focuses the answer on the named off-screen place and has no arbitrary fallback', () => {
    const anchors: ChatAnchors = { places: [
      { text: 'Kelowna', lat: 49.89, lon: -119.5 }, { text: 'Penticton', lat: 49.5, lon: -119.6 },
    ], times: [] };
    expect(answerFocus(anchors, 'Penticton is wetter than Kelowna.')).toEqual(anchors.places[1]);
    expect(answerFocus(anchors, 'The archive has no named station here.')).toBeNull();
  });
});
