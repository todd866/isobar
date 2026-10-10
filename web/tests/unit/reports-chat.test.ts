import { describe, expect, it, vi } from 'vitest';
import { reportToolSpec, runTool } from '../../src/lib/chat/tools';

const chart = {
  manifest: { south: -90, north: 90, west: -180, east: 180, step: 1, nx: 2, ny: 2, wrapsLongitude: false, run: '2026-10-09T00:00:00Z', forecastHours: [0], variables: {} },
  frame: () => null, points: [], aviation: null, sky: null, places: [], profile: async () => null,
} as any;

describe('chat report tool', () => {
  it('exposes only the policy schema', () => {
    expect(reportToolSpec()).toMatchObject({ name: 'manage_reports', input_schema: expect.objectContaining({ additionalProperties: false }) });
    const schema = reportToolSpec().input_schema as { properties: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty('email');
    expect(schema.properties).not.toHaveProperty('recipient');
  });

  it('passes the signed-in command and thread id through without adding identity fields', async () => {
    const command = vi.fn(async (input: unknown, threadId: string) => ({ ok: true, line: `${threadId}:${JSON.stringify(input)}` }));
    const input = { action: 'list' };
    await expect(runTool('manage_reports', input, chart, { archive: false, queueArchive: async () => false, reportCommand: command, threadId: 'thread-1' })).resolves.toEqual({ ok: true, line: 'thread-1:{"action":"list"}' });
    expect(command).toHaveBeenCalledWith(input, 'thread-1');
  });

  it('refuses report management without a signed-in command', async () => {
    await expect(runTool('manage_reports', { action: 'list' }, chart, { archive: false, queueArchive: async () => false })).resolves.toEqual({ error: 'Report management requires a signed-in account.' });
  });
});
