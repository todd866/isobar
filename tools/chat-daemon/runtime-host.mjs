#!/usr/bin/env node
// Installed under the agent root, owned by the daemon account, never the agent.
import { lstat, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export function workspaceSafe(workspace, root = ROOT) {
  return typeof workspace === 'string' && path.isAbsolute(workspace)
    && path.dirname(workspace) === path.join(root, 'jobs') && /^job-[A-Za-z0-9]+$/.test(path.basename(workspace));
}
export function cleanRuntimeEnv(source = process.env, home = os.homedir()) {
  const env = { HOME: home, PATH: '/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', UV_OFFLINE: '1', UV_NO_PROGRESS: '1', DISABLE_AUTOUPDATER: '1' };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM']) if (source[key]) env[key] = source[key];
  return env;
}
export function buildRuntimeArgs(runtime, workspace, root = ROOT) {
  if (!workspaceSafe(workspace, root)) throw new Error('workspace outside agent jobs root');
  const server = 'mcp_servers.isobar-archive';
  const mcpArgs = ['run', '--directory', path.join(root, 'data/isobar-data'), 'python', '-m', 'isobar_data.archive_mcp', '--store', path.join(root, 'data/isobar')];
  if (runtime === 'codex') return { command: '/opt/homebrew/bin/codex', args: [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', workspace,
    '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', 'model_reasoning_effort="medium"',
    '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"',
    '-c', `${server}.command="/opt/homebrew/bin/uv"`, '-c', `${server}.args=${JSON.stringify(mcpArgs)}`,
    '-c', `${server}.env={UV_OFFLINE="1",UV_NO_PROGRESS="1"}`, '-c', `${server}.default_tools_approval_mode="approve"`, '-',
  ], cwd: workspace };
  if (runtime === 'cursor') return { command: path.join(os.homedir(), '.local/bin/cursor-agent'), args: [
    '-p', '--model', 'grok-4.5', '--mode', 'ask', '--approve-mcps', '--trust', '--workspace', workspace, '--output-format', 'json',
  ], cwd: workspace };
  throw new Error('unsupported runtime');
}
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export function parseRuntimeOutput(raw, runtime) {
  let text = '', complete = false, usage; const tools = new Set();
  const count = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000 ? n : undefined;
  for (const line of raw.split(/\r?\n/).filter((value) => value.trim())) {
    const event = object(JSON.parse(line));
    if (event.is_error || event.type === 'error' || event.type === 'turn.failed') throw new Error('runtime failed');
    if (event.usage) usage = { promptTokens: count(event.usage.input_tokens), completionTokens: count(event.usage.output_tokens) };
    if (runtime === 'codex') {
      const item = object(event.item);
      if (item.type && !['agent_message', 'reasoning', 'mcp_tool_call'].includes(item.type)) throw new Error('unknown tool');
      if (item.type === 'mcp_tool_call') {
        if (item.server !== 'isobar-archive' || !/^[A-Za-z0-9_]+$/.test(item.tool)) throw new Error('unknown tool');
        tools.add(`mcp__isobar-archive__${item.tool}`);
      }
      if (event.type === 'item.completed' && item.type === 'agent_message') text = item.text;
      if (event.type === 'turn.completed') complete = true;
    } else {
      // Cursor's JSON result envelope. Partial assistant/status output is not a result.
      if (event.type === 'result' && event.subtype === 'success' && typeof event.result === 'string') {
        if (complete) throw new Error('multiple results');
        text = event.result; complete = true;
      }
      for (const tool of event.toolsUsed ?? []) {
        if (typeof tool !== 'string' || !/^mcp__isobar-archive__[A-Za-z0-9_]+$/.test(tool)) throw new Error('unknown tool');
        tools.add(tool);
      }
      for (const item of object(event.message).content ?? []) {
        if (item.type === 'tool_use') {
          if (!/^mcp__isobar-archive__[A-Za-z0-9_]+$/.test(item.name)) throw new Error('unknown tool');
          tools.add(item.name);
        }
      }
    }
  }
  if (!complete || typeof text !== 'string' || !text.trim() || text.length > 20_000) throw new Error('no successful final answer');
  return { text: text.trim(), model: runtime === 'codex' ? 'codex-chatgpt' : 'grok-4.5', toolsUsed: [...tools], ...(usage ? { usage } : {}) };
}
export function chatgptAuth(auth) {
  return !!auth && !auth.OPENAI_API_KEY && (!auth.auth_mode || auth.auth_mode === 'chatgpt')
    && typeof auth.tokens?.access_token === 'string' && !!auth.tokens.access_token;
}
/** Settle only after descendants have been killed, including on cancellation. */
export function run(command, args, env, cwd, stdin, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = []; let bytes = 0, failure = null, killer;
    const kill = (signal) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
    const stop = () => { if (failure) return; failure = 'runtime stopped'; kill('SIGTERM'); killer = setTimeout(() => kill('SIGKILL'), 500); };
    const timer = setTimeout(stop, timeoutMs);
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > 4_000_000) stop(); else if (!failure) chunks.push(chunk); });
    child.stdin.on('error', stop);
    child.on('error', stop);
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(killer); process.off('SIGTERM', stop); process.off('SIGINT', stop); kill('SIGKILL');
      if (failure || code !== 0) reject(new Error('runtime failed')); else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(stdin);
  });
}
export async function runRuntime(runtime, workspace, prompt) {
  if (!workspaceSafe(workspace) || await realpath(workspace) !== workspace) throw new Error('invalid workspace');
  const info = await lstat(workspace);
  if (!info.isDirectory() || process.getuid?.() === 0 || info.uid === process.getuid?.() || (info.mode & 0o022)) throw new Error('separate agent user required');
  if (runtime === 'codex' && !chatgptAuth(JSON.parse(await readFile(path.join(os.homedir(), '.codex/auth.json'), 'utf8')))) throw new Error('ChatGPT login required');
  const manual = await readFile(path.join(workspace, 'AGENTS.md'), 'utf8');
  const spec = buildRuntimeArgs(runtime, workspace);
  const input = `${manual}\n\n${prompt}`;
  // Cursor's documented print mode takes the prompt as an argument. No credentials travel here.
  if (runtime === 'cursor') spec.args.push(input);
  return parseRuntimeOutput(await run(spec.command, spec.args, cleanRuntimeEnv(), workspace, runtime === 'codex' ? input : ''), runtime);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [runtime, workspace] = process.argv.slice(2);
    let prompt = ''; for await (const chunk of process.stdin) { prompt += chunk; if (Buffer.byteLength(prompt) > 128_000) throw new Error('prompt too large'); }
    process.stdout.write(`${JSON.stringify(await runRuntime(runtime, workspace, prompt))}\n`);
  } catch { process.stderr.write('runtime-host: unavailable\n'); process.exitCode = 1; }
}
