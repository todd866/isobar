import { describe, expect, it } from 'vitest';
import { openShift } from '../../src/lib/od/story/play';
import { casesFor, readStoryPayload } from '../../src/lib/od/story/payload';
import { previewCases } from '../../src/lib/od/story/schedule';
import type { StoryCase, StoryPayload } from '../../src/lib/od/story/types';

function payloadFor(cases: StoryCase[], seed = 4): StoryPayload {
  return { seed, shifts: { '1': cases }, strands: {} };
}

describe('story session payload', () => {
  it('preserves a valid supplied queue', () => {
    const supplied = previewCases(1, 4).map(item => ({ ...item, fact: 'Saved dossier' }));
    const payload = payloadFor(supplied);

    expect(casesFor(payload, 1)).toBe(supplied);
    expect(casesFor(payload, 1)).toEqual(supplied);
  });

  it.each([
    ['id', (item: StoryCase) => ({ ...item, id: '' })],
    ['decreeId', (item: StoryCase) => ({ ...item, decreeId: 'not-a-decree' })],
    ['strand', (item: StoryCase) => ({ ...item, strand: 'unknown' as StoryCase['strand'] })],
    ['difficulty', (item: StoryCase) => ({ ...item, difficulty: Number.NaN })],
    ['failing', (item: StoryCase) => ({ ...item, failing: 'yes' as unknown as boolean })],
    ['weatherBad', (item: StoryCase) => ({ ...item, weatherBad: true, failing: false })],
    ['route', (item: StoryCase) => ({ ...item, route: '' })],
    ['clock', (item: StoryCase) => ({ ...item, clock: 'x'.repeat(65) })],
    ['fact', (item: StoryCase) => ({ ...item, fact: 'x'.repeat(513) })],
  ])('falls back when the %s field is malformed', (_field, mutate) => {
    const valid = previewCases(1, 4);
    const malformed = valid.map((item, index) => index === 2 ? mutate(item) : item);

    expect(casesFor(payloadFor(malformed), 1)).toEqual(previewCases(1, 5));
  });

  it('rejects short and oversized queues before scoring can see them', () => {
    const valid = previewCases(1, 4);
    const short = payloadFor(valid.slice(0, -1));
    const oversized = payloadFor([...valid, ...valid]);

    const fallback = casesFor(short, 1);
    expect(fallback).toEqual(previewCases(1, 5));
    expect(casesFor(oversized, 1)).toEqual(fallback);
    expect(() => openShift({ shift: 1, cases: fallback, seed: 1 })).not.toThrow();
  });

  it('normalizes unsafe seeds and non-record storage sections', () => {
    const parsed = readStoryPayload(JSON.stringify({ seed: 1e30, shifts: [], strands: [] }));

    expect(parsed).toEqual({ seed: 1, shifts: {}, strands: {} });
    expect(casesFor(parsed, 1)).toEqual(previewCases(1, 2));
  });

  it('keeps bounded strand snapshots and drops unknown or non-finite values', () => {
    const parsed = readStoryPayload(JSON.stringify({
      strands: {
        1: {
          before: { charts: 2, physics: 'bad', unknown: 1, numbers: 1e30 },
          after: { charts: 2.5, numbers: 4 },
        },
        2: 'bad',
      },
    }));

    expect(parsed.strands).toEqual({
      '1': { before: { charts: 2 }, after: { charts: 2.5, numbers: 4 } },
    });
  });

  it('does not turn an invalid shift or seed into an exception or NaN preview', () => {
    const payload = { seed: Number.NaN, shifts: {}, strands: {} } as StoryPayload;

    expect(casesFor(payload, Number.NaN)).toEqual([]);
    expect(casesFor(payload, 1)).toEqual(previewCases(1, 2));
  });
});
