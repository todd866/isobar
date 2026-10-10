import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRuntimeArgs, cleanRuntimeEnv, parseRuntimeOutput, workspaceSafe, chatgptAuth, run } from '../../../tools/chat-daemon/runtime-host.mjs';
import { fallbackRunner, parseFallbackOutput, sandboxFromConfig } from '../../../tools/chat-daemon/fallback';

describe('fallback runtime confinement', () => {
  it('requires a separate non-root configured user and absolute root', () => {
    expect(sandboxFromConfig({ ISOBAR_AGENT_USER: 'isobaragent', ISOBAR_AGENT_ROOT: '/Users/Shared/isobar-agent', USER: 'owner' })).toEqual({ user: 'isobaragent', root: '/Users/Shared/isobar-agent' });
    expect(sandboxFromConfig({ ISOBAR_AGENT_USER: 'owner', ISOBAR_AGENT_ROOT: '/tmp/x', USER: 'owner' })).toBeNull();
    expect(sandboxFromConfig({ ISOBAR_AGENT_USER: 'root', ISOBAR_AGENT_ROOT: '/tmp/x', USER: 'owner' })).toBeNull();
  });
  it('builds fixed read-only Codex and pinned Cursor commands', () => {
    const codex = buildRuntimeArgs('codex', '/Users/Shared/isobar-agent/jobs/job-1', '/Users/Shared/isobar-agent');
    expect(codex.args).toEqual(expect.arrayContaining(['--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', 'model_reasoning_effort="medium"']));
    const cursor = buildRuntimeArgs('cursor', '/Users/Shared/isobar-agent/jobs/job-1', '/Users/Shared/isobar-agent');
    expect(cursor.args).toEqual(expect.arrayContaining(['--model', 'grok-4.5', '--mode', 'ask', '--approve-mcps', '--trust', '--output-format', 'json']));
    expect(() => buildRuntimeArgs('codex', '/tmp/outside', '')).toThrow();
  });
  it('cleans provider/API secrets from the helper environment', () => {
    expect(cleanRuntimeEnv({ PATH: '/bin', HOME: '/owner', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret', DATABASE_URL: 'secret' }, '/isolated')).toMatchObject({ HOME: '/isolated', UV_OFFLINE: '1' });
  });
  it('requires a structured final envelope and rejects unknown tools', () => {
    expect(parseRuntimeOutput('{"type":"result","subtype":"success","result":"answer","toolsUsed":[]}', 'cursor').text).toBe('answer');
    expect(() => parseRuntimeOutput('{"text":"answer","model":"x","toolsUsed":["shell"]}', 'codex')).toThrow();
    expect(() => parseRuntimeOutput('answer', 'codex')).toThrow();
    expect(parseFallbackOutput('{"text":"answer","model":"codex-chatgpt","toolsUsed":[]}', 'codex').model).toBe('codex-chatgpt');
    expect(() => parseFallbackOutput('{"text":"","model":"x","toolsUsed":[]}', 'codex')).toThrow();
  });
});


describe('fallback final-output contract', () => {
  it('accepts Codex completed agent messages only after turn completion and records archive MCP', () => {
    const events = [{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'isobar-archive', tool: 'sample' } }, { type: 'item.completed', item: { type: 'agent_message', text: 'The front moved.' } }, { type: 'turn.completed' }];
    const raw = events.map((x) => JSON.stringify(x)).join('\n');
    expect(parseRuntimeOutput(raw, 'codex')).toEqual({ text: 'The front moved.', model: 'codex-chatgpt', toolsUsed: ['mcp__isobar-archive__sample'] });
    expect(() => parseRuntimeOutput(JSON.stringify(events[1]), 'codex')).toThrow();
    expect(() => parseRuntimeOutput(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'No capacity' }), 'cursor')).toThrow();
  });
  it('permits a null API-key field but requires actual ChatGPT token evidence', () => {
    expect(chatgptAuth({ OPENAI_API_KEY: null, auth_mode: 'chatgpt', tokens: { access_token: 'fixture' } })).toBe(true);
    expect(chatgptAuth({ OPENAI_API_KEY: 'key', tokens: { access_token: 'fixture' } })).toBe(false);
    expect(chatgptAuth({ tokens: {} })).toBe(false);
  });
  it('rejects traversal and nested or sibling workspaces', () => {
    const root = '/Users/Shared/isobar-agent';
    expect(workspaceSafe(root + '/jobs/job-abc', root)).toBe(true);
    for (const suffix of ['/jobs/job-abc/..', '/jobs/job-abc/child', '/jobs-other/job-abc', '/../job-abc']) expect(workspaceSafe(root + suffix, root)).toBe(false);
  });
  it('executes fake binaries and rejects failures, with no runtime invocation', async () => {
    expect(await run(process.execPath, ['-e', 'process.stdout.write("ok")'], cleanRuntimeEnv(), process.cwd(), '', 1000)).toBe('ok');
    await expect(run(process.execPath, ['-e', 'process.exit(3)'], cleanRuntimeEnv(), process.cwd(), '', 1000)).rejects.toThrow();
  });
});


it('provisions only the manual and archive config for a fake isolated invocation, then cleans it', async () => {
  const parent = path.resolve(import.meta.dirname, '../../../build/slow-lane-qa');
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(path.join(parent, 'fallback-'));
  try {
    await mkdir(path.join(root, 'jobs'), { mode: 0o755 });
    await writeFile(path.join(root, 'runtime-host.mjs'), '// reviewed helper', { mode: 0o644 });
    const runner = fallbackRunner('codex', { user: 'isobaragent', root, execute: async (command, args, env, stdin, signal, cwd) => {
      expect(command).toBe('/usr/bin/sudo'); expect(args.slice(0, 4)).toEqual(['-n', '-H', '-u', 'isobaragent']);
      expect(args).toContain(path.join(root, 'runtime-host.mjs'));
      expect(await readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toContain('Isobar');
      const mcp = JSON.parse(await readFile(path.join(cwd, '.cursor/mcp.json'), 'utf8'));
      expect(mcp.mcpServers['isobar-archive'].args).toContain(path.join(root, 'data/isobar'));
      expect(stdin).toContain('untrusted'); expect(env.ISOBAR_AGENT_TOKEN).toBeUndefined();
      return JSON.stringify({ text: 'A front.', model: 'codex-chatgpt', toolsUsed: [] });
    } });
    expect((await runner({ question: 'Front?', context: {}, thread: [], user: { level: null, goal: null } }, new AbortController().signal)).text).toBe('A front.');
    expect(await readdir(path.join(root, 'jobs'))).toEqual([]);
    await chmod(path.join(root, 'runtime-host.mjs'), 0o666);
    await expect(runner({ question: 'Front?', context: {}, thread: [], user: { level: null, goal: null } }, new AbortController().signal)).rejects.toThrow('untrusted');
  } finally { await rm(root, { recursive: true, force: true }); }
});
