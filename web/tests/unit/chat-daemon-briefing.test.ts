import { describe, expect, it } from 'vitest';
import { parseClaudeOutput, promptFor } from '../../../tools/chat-daemon/runner';

const event = (result: string) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result,
});

describe('slow daemon laptop briefing', () => {
  it('extracts the concise answer and bounded evidence briefing', () => {
    const parsed = parseClaudeOutput(event(JSON.stringify({
      answer: 'Rain reaches Penticton after 18Z.',
      briefing: {
        keyNumbers: ['12 mm at Penticton, 18Z', '8 mm at Kelowna, 18Z'],
        sources: ['run 2026-10-08T00Z; station CYLW 17:00Z'],
      },
    })));
    expect(parsed).toMatchObject({
      text: 'Rain reaches Penticton after 18Z.',
      briefing: { keyNumbers: ['12 mm at Penticton, 18Z', '8 mm at Kelowna, 18Z'] },
    });
  });

  it('keeps legacy plain answers and rejects malformed briefing fields without losing text', () => {
    expect(parseClaudeOutput(event('The archive is missing that station.'))).toMatchObject({ text: 'The archive is missing that station.' });
    expect(parseClaudeOutput(event(JSON.stringify({ answer: 'Useful answer', briefing: { keyNumbers: ['one'] } })))).toMatchObject({ text: 'Useful answer' });
  });

  it('passes the original question and context to the slow prompt', () => {
    const prompt = promptFor({ question: 'Compare the Okanagan', context: { map: 'kelowna' }, thread: [], user: { level: null, goal: null } });
    expect(prompt).toContain('Compare the Okanagan');
    expect(prompt).toContain('kelowna');
  });
});

// Prompt/payload contract only: no real model invocation or claim about archive coverage.
it('requires a regional station/run inventory and passes the admitted gaps intact', async () => {
  const { readFileSync } = await import('node:fs');
  const manual = readFileSync(new URL('../../../tools/chat-daemon/SLOW.md', import.meta.url), 'utf8');
  expect(manual).toContain('9–15 representative points');
  expect(manual).toContain('station and run inventories');
  expect(manual).toContain('Read every relevant station');
  expect(manual).toContain('latest and earlier runs');
  expect(manual).toContain('no boilerplate');
  const prompt = promptFor({ question: 'Rain along the Okanagan?', context: { fastAnswer: 'Only Kelowna sampled.', gaps: ['Sample Penticton and Vernon', 'Read CYLW observations'] }, thread: [], user: { level: null, goal: null } });
  expect(prompt).toContain('Only Kelowna sampled.');
  expect(prompt).toContain('Sample Penticton and Vernon');
  expect(prompt).toContain('Read CYLW observations');
});
