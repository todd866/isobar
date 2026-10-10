import { describe, expect, it, vi } from 'vitest';
import { apiClient, validPending } from '../../../tools/chat-daemon/api';
import { processMaintenance, processReport, notifyOwner, reportInput } from '../../../tools/chat-daemon/reports';
import type { AgentApi, MaintenanceTask, PendingMessage, RunnerResult } from '../../../tools/chat-daemon/types';

const pending = (extra: Partial<PendingMessage> = {}): PendingMessage => ({
  id: 'report-1', question: 'unused', context: null, thread: [], user: { level: null, goal: null },
  leaseId: '123e4567-e89b-12d3-a456-426614174000', leaseUntil: '2030-01-01T00:00:00Z',
  type: 'report', report: { dueAt: '2030-01-01T06:00:00Z', timezone: 'Australia/Sydney', places: [{ name: 'Sydney', lat: -33.86, lon: 151.2 }], instructions: 'Include rain and wind.', kind: 'recurring' }, ...extra,
});

describe('report daemon support', () => {
  it('validates a report claim and keeps the report contract', () => {
    expect(validPending(pending()).report?.timezone).toBe('Australia/Sydney');
    expect(() => validPending(pending({ report: { ...pending().report!, places: [{ name: 'bad', lat: 91, lon: 0 }] } }))).toThrow('invalid report');
  });

  it('keeps report instructions in trusted report input context', () => {
    const input = reportInput(pending());
    expect(input.question).toBe('Prepare the requested weather report.');
    expect(input.context).toMatchObject({ report: { instructions: 'Include rain and wind.' } });
  });

  it('readies a generated report and releases failed work', async () => {
    const ready = vi.fn(), release = vi.fn();
    const api = { reportReady: ready, reportRelease: release } as unknown as AgentApi;
    const result: RunnerResult = { text: 'Sydney rain: 2 mm.', model: 'claude-opus-5-5', toolsUsed: ['mcp__isobar-archive__runs'] };
    await processReport(api, async () => result, pending(), new AbortController().signal);
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ id: 'report-1', text: result.text }));
    await expect(processReport(api, async () => { throw new Error('offline'); }, pending(), new AbortController().signal)).rejects.toThrow('offline');
    expect(release).toHaveBeenCalledWith('report-1', pending().leaseId);
  });

  it('does not claim report success when the ready API is unavailable', async () => {
    const api = { reportRelease: vi.fn() } as unknown as AgentApi;
    await expect(processReport(api, async () => ({ text: 'report', model: 'm', toolsUsed: [] }), pending(), new AbortController().signal)).rejects.toThrow('report API unavailable');
    expect(api.reportRelease).not.toHaveBeenCalled();
  });

  it('runs maintenance notification and acknowledges its channel', async () => {
    const task: MaintenanceTask = { id: 'run-1', leaseId: 'lease-1', message: 'Isobar report → todd@example.com at 06:00 · preview https://isobar.md/p · hold https://isobar.md/h' };
    const notified = vi.fn();
    const api = { reportMaintenance: async () => task, reportNotified: notified } as unknown as AgentApi;
    const notify = vi.fn(async () => 'text-ian' as const);
    await expect(processMaintenance(api, { notify })).resolves.toBe('notified');
    expect(notify).toHaveBeenCalledWith(task, expect.anything());
    expect(notified).toHaveBeenCalledWith('run-1', 'lease-1', 'text-ian');
  });

  it('uses execFile arguments without a shell and falls back to email', async () => {
    const exec = vi.fn(async () => undefined);
    const task: MaintenanceTask = { id: 'run-1', leaseId: 'lease-1', message: 'preview' };
    await expect(notifyOwner(task, { env: { ISOBAR_OWNER_NOTIFY: 'text-ian' }, exec })).resolves.toBe('text-ian');
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('/.local/bin/text-ian'), ['preview'], expect.objectContaining({ timeout: 30_000 }));
    const failed = vi.fn(async () => { throw new Error('no Messages'); });
    await expect(notifyOwner(task, { env: { ISOBAR_OWNER_NOTIFY: 'text-ian' }, exec: failed })).resolves.toBe('email');
  });

  it('sends report actions through the authenticated reports endpoint', async () => {
    const calls: unknown[] = [];
    const fetcher = async (_url: string, init?: RequestInit) => { calls.push(JSON.parse(String(init?.body))); return Response.json(null); };
    const api = apiClient('https://isobar.test', 'token', fetcher);
    await api.reportClaim?.();
    expect(calls).toEqual([expect.objectContaining({ action: 'claim', host: 'isobar' })]);
  });
});
