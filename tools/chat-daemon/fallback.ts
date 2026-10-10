import { promptFor } from './runner';
import { chmod, copyFile, lstat, realpath, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess, safeAgentEnv } from './runner';
import type { Runner, RunnerInput, RunnerResult } from './types';

export const FALLBACK_TIMEOUT_MS = 200_000;
export function sandboxFromConfig(values: NodeJS.ProcessEnv = process.env): { user: string; root: string } | null {
  const user = values.ISOBAR_AGENT_USER?.trim();
  const root = values.ISOBAR_AGENT_ROOT?.trim() || '/Users/Shared/isobar-agent';
  if (!user || !root.startsWith('/') || !/^isobar[a-z0-9_]*$/.test(user) || user === os.userInfo().username || user === 'root' || process.getuid?.() === 0) return null;
  return { user, root };
}



export function parseFallbackOutput(raw: string, runtime: 'codex' | 'cursor'): RunnerResult {
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error(`${runtime} helper returned invalid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${runtime} helper returned invalid envelope`);
  const row = value as Record<string, unknown>;
  if (row.model !== (runtime === 'codex' ? 'codex-chatgpt' : 'grok-4.5')) throw new Error('invalid runtime');
  if (typeof row.text !== 'string' || !row.text.trim() || typeof row.model !== 'string' || !Array.isArray(row.toolsUsed) || row.toolsUsed.some((tool) => typeof tool !== 'string' || !/^mcp__isobar-archive__[A-Za-z0-9_]+$/.test(tool))) throw new Error(`${runtime} helper returned incomplete envelope`);
  return { text: row.text.trim(), model: row.model, toolsUsed: row.toolsUsed, ...(row.usage && typeof row.usage === 'object' ? { usage: row.usage as RunnerResult['usage'] } : {}) };
}

export function fallbackRunner(runtime: 'codex' | 'cursor', options: { user?: string; root?: string; nodePath?: string; helperPath?: string; execute?: typeof runProcess } = {}): Runner {
  const config = sandboxFromConfig({ ...process.env, ...(options.user ? { ISOBAR_AGENT_USER: options.user } : {}), ...(options.root ? { ISOBAR_AGENT_ROOT: options.root } : {}) });
  if (!config) throw new Error('fallback requires a separate non-root ISOBAR_AGENT_USER and absolute ISOBAR_AGENT_ROOT');
  const nodePath = options.nodePath ?? '/opt/homebrew/opt/node@24/bin/node';
  const helperPath = options.helperPath ?? path.join(config.root, 'runtime-host.mjs');
  return async (input, signal) => {
    signal.throwIfAborted();
    const jobs = path.join(config.root, 'jobs');
    for (const [file, directory] of [[config.root, true], [jobs, true], [helperPath, false]] as const) {
      const info = await lstat(file);
      if (await realpath(file) !== file || info.uid !== process.getuid?.() || (info.mode & 0o022) ||
          (directory ? !info.isDirectory() : !info.isFile())) throw new Error('untrusted agent installation');
    }
    const workspace = await mkdtemp(path.join(jobs, 'job-'));
    await chmod(workspace, 0o755);
    try {
      await copyFile(path.join(import.meta.dirname, 'SLOW.md'), path.join(workspace, 'AGENTS.md'));
      await chmod(path.join(workspace, 'AGENTS.md'), 0o644);
      await mkdir(path.join(workspace, '.cursor'), { mode: 0o755 });
      await chmod(path.join(workspace, '.cursor'), 0o755);
      const mcpFile = path.join(workspace, '.cursor/mcp.json');
      await writeFile(mcpFile, JSON.stringify({ mcpServers: { 'isobar-archive': { command: '/opt/homebrew/bin/uv',
        args: ['run', '--directory', path.join(config.root, 'data/isobar-data'), 'python', '-m', 'isobar_data.archive_mcp', '--store', path.join(config.root, 'data/isobar')],
        env: { UV_OFFLINE: '1', UV_NO_PROGRESS: '1' },
      } } }), { mode: 0o644 });
      await chmod(mcpFile, 0o644);
      const raw = await (options.execute ?? runProcess)('/usr/bin/sudo', ['-n', '-H', '-u', config.user, nodePath, helperPath, runtime, workspace], safeAgentEnv({ PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: process.env.TMPDIR }), promptFor(input), signal, workspace, { timeoutMs: FALLBACK_TIMEOUT_MS, killGraceMs: 2_000, maxOutputBytes: 1_000_000 });
      return parseFallbackOutput(raw, runtime);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  };
}
