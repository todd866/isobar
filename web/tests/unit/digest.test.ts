import { describe, expect, it } from 'vitest';
import { exampleBlock } from '../../src/lib/chat/examples';
import {
  assembleDigest, digestEmail, parseCritiques, runDigest, type DigestMessage,
} from '../../src/lib/chat/digest';
import { ownerGate, secretMatch } from '../../src/lib/chat/gate';
import { parseAgentReply } from '../../src/lib/chat/agent-reply';

const NOW = new Date('2026-10-08T22:00:00Z');

function message(partial: Partial<DigestMessage> & Pick<DigestMessage, 'id' | 'role' | 'content'>): DigestMessage {
  return {
    threadId: 't1', user: 'pilot@example.com', status: 'complete', lane: 'fast', context: { lens: 'wind' },
    model: null, costUsd: null, grade: null, gradeReason: null, toolCalls: null, example: false,
    failureReason: null, createdAt: new Date(NOW.getTime() - 60 * 60_000), ...partial,
  };
}

describe('digest assembly', () => {
  const rows: DigestMessage[] = [
    message({ id: 'q', role: 'user', content: 'Why is the wind backing?', createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000) }),
    message({
      id: 'a', role: 'assistant', content: 'It is backing ahead of the low.', model: 'claude-opus-5-5', costUsd: 0.04,
      grade: 'interesting', gradeReason: 'uses the chart', toolCalls: [{ name: 'sample_field', input: {}, output: {} }],
      example: false, createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000 + 1000),
    }),
    message({
      id: 's', role: 'assistant', lane: 'slow', content: 'Yesterday ran warm.', status: 'complete', costUsd: 0,
      context: { question: 'What did yesterday get wrong?' }, createdAt: new Date(NOW.getTime() - 60 * 60_000),
    }),
    message({ id: 'old', role: 'user', content: 'too old', createdAt: new Date(NOW.getTime() - 25 * 60 * 60_000) }),
  ];

  it('lists the last day of questions, replies, grades, tools, cost and hand-offs', () => {
    const view = assembleDigest(rows, new Date(NOW.getTime() - 24 * 60 * 60_000), NOW);
    expect(view.threads).toHaveLength(1);
    const thread = view.threads[0];
    expect(thread.user).toBe('pilot@example.com');
    expect(thread.turns[0]).toMatchObject({
      question: 'Why is the wind backing?', reply: 'It is backing ahead of the low.', grade: 'interesting',
      toolCalls: ['sample_field'], example: false,
    });
    expect(thread.handoffs).toEqual([{ question: 'What did yesterday get wrong?', status: 'complete', outcome: 'Yesterday ran warm.' }]);
    expect(thread.costUsd).toBeCloseTo(0.04);
    expect(thread.missed).toBeNull();
    expect(view.threads.some((item) => item.turns.some((turn) => turn.question === 'too old'))).toBe(false);
  });

  it('asks Sonnet once, skips when that budget or the governor is closed, and emails once', async () => {
    const paragraph = 'The reply never said how far the low had moved, and a position from the chart would have made it useful.';
    let calls = 0;
    const open = await runDigest({
      now: NOW, messages: rows, modelOpen: true, digestTier: 'sonnet', alreadySent: false, send: true,
      complete: async () => { calls += 1; return { text: paragraph, costUsd: 0.01 }; },
    });
    expect(calls).toBe(1);
    expect(open.view.threads[0].missed).toBe(paragraph);
    expect(open.costUsd).toBe(0.01);
    expect(open.model).toBe('claude-sonnet-5-5');
    expect(open.email).toContain('Why is the wind backing?');
    expect(open.email).toContain(paragraph);
    expect(digestEmail(open.view)).toContain('Slow complete');

    calls = 0;
    const spent = await runDigest({
      now: NOW, messages: rows, modelOpen: false, digestTier: 'sonnet', alreadySent: false, send: true,
      complete: async () => { calls += 1; return { text: paragraph, costUsd: 0.01 }; },
    });
    expect(calls).toBe(0);
    expect(spent.view.threads[0].missed).toBeNull();
    expect(spent.email).toContain('Why is the wind backing?');

    const resting = await runDigest({
      now: NOW, messages: rows, modelOpen: true, digestTier: 'rest', alreadySent: false, send: true,
      complete: async () => { calls += 1; return { text: paragraph, costUsd: 1 }; },
    });
    expect(calls).toBe(0);
    expect(resting.model).toBeNull();

    const quiet = await runDigest({
      now: NOW, messages: [], modelOpen: true, digestTier: 'sonnet', alreadySent: false, send: true,
      complete: async () => ({ text: paragraph, costUsd: 0.01 }),
    });
    expect(quiet.email).toBeNull();

    const again = await runDigest({
      now: NOW, messages: rows, modelOpen: true, digestTier: 'haiku', alreadySent: true, send: true,
      complete: async () => ({ text: paragraph, costUsd: 0.002 }),
    });
    expect(again.model).toBe('claude-haiku-5-5');
    expect(again.email).toBeNull();
  });

  it('rejects a critique that is not one paragraph per thread', () => {
    expect(parseCritiques('Only one paragraph here for the owner.', 2)).toBeNull();
    expect(parseCritiques('Short.', 1)).toBeNull();
  });
});

describe('examples and the agent reply', () => {
  it('keeps the newest examples short', () => {
    const block = exampleBlock([
      { question: 'Why is the wind backing?', context: 'Perth Wind', reply: 'It is backing ahead of the low.' },
    ]);
    expect(block).toContain('Why is the wind backing?');
    expect(block).toContain('Perth Wind');
    expect(block.split('\n')).toHaveLength(2);
  });

  it('requires context and tool calls on a slow reply', () => {
    expect(parseAgentReply({ messageId: 'm1', content: 'Done', context: { lens: 'wind' }, toolCalls: [] })).toMatchObject({
      messageId: 'm1', context: { lens: 'wind' }, toolCalls: [],
    });
    expect(parseAgentReply({ messageId: 'm1', content: 'Done', toolCalls: [] })).toEqual({ error: 'context' });
    expect(parseAgentReply({ messageId: 'm1', content: 'Done', context: { lens: 'wind' } })).toEqual({ error: 'tools' });
    const parsed = parseAgentReply({
      messageId: 'm1', content: 'Done', context: { lens: 'wind' },
      toolCalls: [{ name: 'sample_field', input: { var: 'wind' }, output: { value: 12 } }],
    });
    expect(parsed).toMatchObject({ toolCalls: [{ name: 'sample_field', output: { value: 12 } }] });
  });

  it('admits the owner or the digest secret and nobody else', () => {
    expect(secretMatch('abc', 'abc')).toBe(true);
    expect(secretMatch('abc', 'abd')).toBe(false);
    expect(secretMatch('ab', 'abc')).toBe(false);
    expect(ownerGate({
      sessionEmail: 'pilot@example.com', ownerEmail: 'owner@isobar.test', header: null, authorization: null, secret: 's3cret',
    })).toBe(false);
    expect(ownerGate({
      sessionEmail: 'owner@isobar.test', ownerEmail: 'owner@isobar.test', header: null, authorization: null, secret: null,
    })).toBe(true);
    expect(ownerGate({
      sessionEmail: null, ownerEmail: 'owner@isobar.test', header: 's3cret', authorization: null, secret: 's3cret',
    })).toBe(true);
    expect(ownerGate({
      sessionEmail: null, ownerEmail: 'owner@isobar.test', header: null, authorization: 'Bearer s3cret', secret: 's3cret',
    })).toBe(true);
  });
});
