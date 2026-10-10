import { constants } from 'node:fs';
import { open, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { apiClient } from './api';
import { claudeRunner } from './runner';
import { readCapacity } from './capacity';
import { md3Busy } from './yield';
import { fallbackRunner, sandboxFromConfig } from './fallback';
import { subscriptionRunner } from './runtime';
import { notifyOwner } from './reports';
import { startDaemon, startReportMaintenance } from './loop';

export async function readEnvFile(file: string): Promise<Record<string, string> & { ISOBAR_AGENT_TOKEN: string; ISOBAR_URL: string }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192) throw new Error('invalid env file');
    const buffer = Buffer.alloc(8193); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 8192) throw new Error('invalid env file');
    const values: Record<string, string> = {};
    for (const line of buffer.subarray(0, length).toString('utf8').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const match = /^(ISOBAR_AGENT_TOKEN|ISOBAR_URL|ISOBAR_DAEMON_ROLE|ISOBAR_DAEMON_HOST|ISOBAR_STANDBY_MS|ISOBAR_YIELD_LOCK|ISOBAR_AGENT_USER|ISOBAR_AGENT_ROOT|ISOBAR_OWNER_NOTIFY)=(.*)$/.exec(line.trim());
      if (!match || match[1] in values) throw new Error('invalid env file');
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
    if (!/^isb_agent_[A-Za-z0-9_-]{43}$/.test(values.ISOBAR_AGENT_TOKEN ?? '') || !values.ISOBAR_URL) throw new Error('invalid env file');
    return values as { ISOBAR_AGENT_TOKEN: string; ISOBAR_URL: string };
  } finally { await handle.close(); }
}

export function daemonSettings(values: Record<string, string>, home = os.homedir()) {
  const role = values.ISOBAR_DAEMON_ROLE ?? 'primary';
  const ownerNotify=values.ISOBAR_OWNER_NOTIFY ?? 'text-ian';
  if(!['text-ian','email'].includes(ownerNotify)) throw new Error('invalid owner notifier');
  const host = values.ISOBAR_DAEMON_HOST ?? os.hostname();
  const standbyMs = Number(values.ISOBAR_STANDBY_MS ?? 90_000);
  if (!['primary', 'standby'].includes(role) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(host)
      || !Number.isSafeInteger(standbyMs) || standbyMs < 90_000 || standbyMs > 86_400_000) throw new Error('invalid daemon settings');
  const configuredLock = values.ISOBAR_YIELD_LOCK ?? path.join(home, '.local/state/md3-tutor/busy.json');
  const yieldLock = configuredLock.startsWith('~/') ? path.join(home, configuredLock.slice(2)) : configuredLock;
  if (!path.isAbsolute(yieldLock)) throw new Error('yield lock must be absolute');
  if (values.ISOBAR_AGENT_USER && !sandboxFromConfig(values)) throw new Error('invalid agent user');
  return { role: role as 'primary' | 'standby', host, standbyMs, yieldLock, ownerNotify };
}

/** Heartbeat is independent of job concurrency and never logs server payloads. */
export function startHeartbeat(api: ReturnType<typeof apiClient>, state: string, current: () => string,
  version: string, log: (event: string) => void, intervalMs = 20_000): () => Promise<void> {
  let active: Promise<void> | null = null, stopped = false;
  const tick = () => {
    if (active || stopped) return;
    active = (async () => {
      await api.heartbeat(current(), version);
      const server = await api.health();
      const at = new Date().toISOString(), temporary = path.join(state, `health-${process.pid}.tmp`);
      await writeFile(temporary, JSON.stringify({ checkedAt: at, serverAt: at, runtime: current(), server }), { mode: 0o600 });
      await rename(temporary, path.join(state, 'health.json'));
    })().catch(() => log('heartbeat:unavailable')).finally(() => { active = null; });
  };
  tick(); const timer = setInterval(tick, intervalMs);
  return async () => { stopped = true; clearInterval(timer); await active; };
}

async function main(): Promise<void> {
  process.umask(0o077);
  const state = path.join(os.homedir(), '.local/state/isobar-chat-daemon');
  const values = await readEnvFile(path.join(state, 'daemon.env'));
  const settings = daemonSettings(values), sandbox = sandboxFromConfig(values);
  const api = apiClient(values.ISOBAR_URL, values.ISOBAR_AGENT_TOKEN, fetch, 15_000, settings);
  const capacity = () => readCapacity(sandbox ? ['codex', 'cursor'] : []);
  const busy = () => md3Busy(settings.yieldLock);
  let runtime = 'idle';
  const log = (event: string) => process.stdout.write(`${new Date().toISOString()} ${event}\n`);
  const runner = subscriptionRunner({ claude: claudeRunner({ timeoutMs: 180_000 }),
    ...(sandbox ? { codex: fallbackRunner('codex', sandbox), cursor: fallbackRunner('cursor', sandbox) } : {}),
  }, capacity, busy, (value) => { runtime = value; });
  // Only an owner-scoped, current token can serve both hosts and read health.
  await api.heartbeat('idle', 'slow-lane-ha-1');
  await api.health();
  const stopHeartbeat = startHeartbeat(api, state, () => runtime, 'slow-lane-ha-1', log);
  const stop = startDaemon(api, runner, {
    capacity: async () => {
      const ready = !await busy() && (await capacity()).ok;
      runtime = ready ? 'idle' : 'waiting';
      return { ok: ready };
    }, log,
  });
  const stopMaintenance = startReportMaintenance(api, { log, notify:(task,opts)=>notifyOwner(task,{...opts,env:{ISOBAR_OWNER_NOTIFY:settings.ownerNotify}}) });
  const shutdown = () => { void Promise.all([stop(), stopMaintenance(), stopHeartbeat()]).catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { process.stderr.write('isobar-chat-daemon: startup failed\n'); process.exitCode = 1; });
}
