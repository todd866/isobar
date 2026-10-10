#!/usr/bin/env node
import { access, lstat, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const DEFAULT_STATE = path.join(os.homedir(), '.local/state/isobar-chat-daemon');
const DEFAULT_ENV = path.join(DEFAULT_STATE, 'daemon.env');
const DEFAULT_CACHE = path.join(DEFAULT_STATE, 'health.json');
const DEFAULT_ARCHIVE = path.join(os.homedir(), 'Data/isobar');

export async function isOwned0600(file, uid = process.getuid?.()) {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink() && (uid === undefined || info.uid === uid) && (info.mode & 0o777) === 0o600;
  } catch { return false; }
}

async function readable(file) {
  try { await access(file, constants.R_OK); return true; } catch { return false; }
}

async function serviceLoaded(label, launchctl = 'launchctl') {
  try { await exec(launchctl, ['print', `gui/${process.getuid?.() ?? 0}/${label}`], { timeout: 2500 }); return true; } catch { return false; }
}

async function loginEvidence(home = os.homedir(), agentUser) {
  // Only file metadata/access. Keychain-backed logins remain unknown, never prompted.
  const providers = {
    claude: await readable(path.join(home, '.claude/.credentials.json')) ? 'present' : 'unknown',
    codex: 'disabled', cursor: 'disabled',
  };
  if (agentUser && /^isobar[a-z0-9_]*$/.test(agentUser)) {
    providers.codex = await readable(path.join('/Users', agentUser, '.codex/auth.json')) ? 'present' : 'unknown';
    providers.cursor = 'unknown';
  }
  return { status: Object.values(providers).includes('present') ? 'present' : 'unknown', providers };
}

export async function readDaemonEnv(file = DEFAULT_ENV) {
  if (!(await isOwned0600(file))) return {};
  const text = await readFile(file, 'utf8');
  if (text.length > 8192 || text.includes('\0')) return {};
  const values = {};
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^(ISOBAR_URL|ISOBAR_AGENT_TOKEN|ISOBAR_DAEMON_ROLE|ISOBAR_DAEMON_HOST|ISOBAR_STANDBY_MS|ISOBAR_YIELD_LOCK|ISOBAR_AGENT_USER|ISOBAR_AGENT_ROOT)=(.*)$/.exec(line.trim());
    if (!match || match[2].includes('`') || match[2].includes('$(') || match[2].includes(';')) return {};
    if (match[1] in values) return {};
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

export function ageMs(value, now = Date.now()) {
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

export async function readCache(file = DEFAULT_CACHE) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

export async function collectLocalHealth(options = {}) {
  const state = options.state ?? DEFAULT_STATE;
  const envFile = options.envFile ?? path.join(state, 'daemon.env');
  const archive = options.archive ?? DEFAULT_ARCHIVE;
  const cacheFile = options.cacheFile ?? path.join(state, 'health.json');
  const cache = options.cache ?? await readCache(cacheFile);
  const envValues = options.envValues ?? await readDaemonEnv(envFile);
  const checkedAt = new Date().toISOString();
  const server = cache?.server ?? cache;
  const cacheAgeMs = ageMs(cache?.checkedAt ?? cache?.serverAt, Date.parse(checkedAt));
  const backlog = Number.isFinite(server?.backlog) ? server.backlog : (Number.isFinite(server?.pending) ? server.pending : null);
  return {
    checkedAt,
    service: { loaded: await (options.serviceLoaded ?? serviceLoaded)('md.isobar.chat-daemon') },
    config: { path: envFile, owned0600: await isOwned0600(envFile) },
    daemon: { role: envValues.ISOBAR_DAEMON_ROLE ?? cache?.role ?? null, host: envValues.ISOBAR_DAEMON_HOST ?? cache?.host ?? null },
    archive: { path: archive, readable: await (options.readable ?? readable)(archive) },
    logins: await (options.loginEvidence ?? loginEvidence)(os.homedir(), envValues.ISOBAR_AGENT_USER),
    cache: { status: !cache ? 'missing' : cacheAgeMs !== null && cacheAgeMs <= 60_000 ? 'fresh' : 'stale', ageMs: cacheAgeMs },
    server: cache ? {
      checkedAt: cache.serverAt ?? cache.checkedAt ?? null,
      backlog,
      pending: Number.isFinite(server?.pending) ? server.pending : null,
      claimed: Number.isFinite(server?.claimed) ? server.claimed : null,
      expired: Number.isFinite(server?.expired) ? server.expired : null,
      lastDeliveredAt: server?.lastDeliveredAt ?? null,
      ageMs: ageMs(server?.lastDeliveredAt),
      runtime: cache.runtime ?? null,
      hosts: server?.heartbeats ?? server?.hosts ?? [],
    } : { checkedAt: null, backlog: null, pending: null, claimed: null, expired: null, lastDeliveredAt: null, ageMs: null, runtime: null, hosts: [] },
  };
}

export async function serverHealth(url, token, fetchImpl = fetch) {
  if (!url || !token) throw new Error('ISOBAR_URL and ISOBAR_AGENT_TOKEN are required for --server');
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('ISOBAR_URL must be an HTTPS origin');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(`${origin.origin}/api/agent/health`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' }, body: '{}',
    });
    if (!response.ok) throw new Error(`health server returned ${response.status}`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('empty health response');
    const chunks = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 128_000) { await reader.cancel(); throw new Error('health response too large'); } chunks.push(part.value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timer); }
}

export async function main(argv = process.argv.slice(2)) {
  const server = argv.includes('--server');
  const json = !argv.includes('--text');
  const local = await collectLocalHealth();
  if (server) {
    const values = await readDaemonEnv();
    const remote = await serverHealth(values.ISOBAR_URL, values.ISOBAR_AGENT_TOKEN);
    const serverAt = new Date().toISOString();
    local.server = { ...local.server, ...remote, checkedAt: serverAt, ageMs: ageMs(remote.lastDeliveredAt) };
    await writeFile(DEFAULT_CACHE, `${JSON.stringify({ checkedAt: serverAt, serverAt, runtime: remote.runtime ?? null, server: remote }, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(json ? `${JSON.stringify(local)}\n` : [
    `service: ${local.service.loaded ? 'loaded' : 'not-loaded'}`,
    `login: ${Array.isArray(local.logins.providers) ? local.logins.status : Object.entries(local.logins.providers).map(([name, status]) => `${name}=${status}`).join(' ')}`,
    `archive: ${local.archive.readable ? 'readable' : 'unreadable'}`,
    `last answer age: ${local.server.ageMs === null ? 'unknown' : `${Math.round(local.server.ageMs / 1000)}s`}`,
    `backlog: ${local.server.backlog ?? 'unknown'}`,
    `cache: ${local.cache.status}${local.cache.ageMs === null ? '' : ` (${Math.round(local.cache.ageMs / 1000)}s)`}`,
  ].join('\n') + '\n');
  return local;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { process.stderr.write(`health: ${error.message}\n`); process.exitCode = 1; });
