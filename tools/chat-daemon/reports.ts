import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { screenAnswer } from '../../web/src/lib/chat/watcher';
import type { AgentApi, MaintenanceTask, PendingMessage, Runner, RunnerResult } from './types';

const execFile = promisify(nodeExecFile);

/** Execute the owner's existing sender without a shell or recipient data. */
export async function notifyOwner(task: MaintenanceTask, options: {
  env?: NodeJS.ProcessEnv;
  exec?: typeof execFile;
  log?: (event: string) => void;
} = {}): Promise<'text-ian' | 'email'> {
  const requested = options.env?.ISOBAR_OWNER_NOTIFY ?? process.env.ISOBAR_OWNER_NOTIFY;
  const channel = requested === 'email' || (requested === undefined && process.platform !== 'darwin') ? 'email' : 'text-ian';
  if (channel === 'email') return 'email';
  try {
    await (options.exec ?? execFile)(`${process.env.HOME ?? os.homedir()}/.local/bin/text-ian`, [task.message], { timeout: 30_000, windowsHide: true });
    return 'text-ian';
  } catch { options.log?.('report:owner-notify-failed'); return 'email'; }
}

export function reportInput(pending: PendingMessage) {
  if (pending.type !== 'report' || !pending.report) throw new Error('missing report job');
  const report = pending.report;
  return {
    question: 'Prepare the requested weather report.',
    context: { report: { dueAt: report.dueAt, timezone: report.timezone, places: report.places, instructions: report.instructions, kind: report.kind } },
    thread: pending.thread,
    user: pending.user,
    report,
  } as const;
}

export async function processReport(api: AgentApi, runner: Runner, pending: PendingMessage, signal: AbortSignal, started = Date.now()): Promise<void> {
  if (!api.reportReady || !api.reportRelease) throw new Error('report API unavailable');
  try {
    signal.throwIfAborted();
    const result = await runner(reportInput(pending), signal);
    signal.throwIfAborted();
    if (!result.text.trim() || result.text.length > 20_000 || result.images?.length) throw new Error('invalid report');
    if (screenAnswer(result.text).length) throw new Error('report held');
    signal.throwIfAborted();
    await api.reportReady({ id: pending.id, leaseId: pending.leaseId, ...result, usage: { ...result.usage, latencyMs: Date.now() - started } });
  } catch (error) {
    await api.reportRelease(pending.id, pending.leaseId);
    throw error;
  }
}

export async function processMaintenance(api: AgentApi, options: { notify?: typeof notifyOwner; log?: (event: string) => void } = {}): Promise<'idle' | 'notified'> {
  const task = await api.reportMaintenance?.();
  if (!task) return 'idle';
  const channel = await (options.notify ?? notifyOwner)(task, { log: options.log });
  await api.reportNotified?.(task.id, task.leaseId, channel);
  return 'notified';
}
