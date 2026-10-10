import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { processOne as processOneReal, screenAgentReply, startDaemon as startDaemonReal } from '../../../tools/chat-daemon/loop';
import { buildClaudeArgs, claudeRunner, parseClaudeOutput, runProcess, safeAgentEnv } from '../../../tools/chat-daemon/runner';
import { apiClient } from '../../../tools/chat-daemon/api';
import { readEnvFile } from '../../../tools/chat-daemon/daemon';
import type { AgentApi, PendingMessage, Runner } from '../../../tools/chat-daemon/types';

const ready = async () => ({ ok: true });
const processOne: typeof processOneReal = (api, runner, capacity = ready, shutdown) => processOneReal(api, runner, capacity, shutdown);
const startDaemon: typeof startDaemonReal = (api, runner, options = {}) => startDaemonReal(api, runner, { capacity: ready, ...options });
const root = path.resolve(import.meta.dirname, '../../../build/slow-lane-qa');
const dirs: string[] = [];
async function scratch() { await mkdir(root, { recursive: true }); const dir = await mkdtemp(path.join(root, 'daemon-test-')); dirs.push(dir); return dir; }
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const final = (result = 'The archive shows the approaching front.', extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, ...extra });
const pending = (): PendingMessage => ({ id: 'm1', question: 'Why is the wind backing at Perth?', context: { runId: 'r1' }, thread: [], user: { level: null, goal: null }, leaseId: '12345678-1234-4123-8123-123456789012', leaseUntil: new Date(Date.now() + 900_000).toISOString() });
function fakeApi(message: PendingMessage | null = pending()) {
  return { heartbeat: vi.fn(async () => {}), health: vi.fn(async () => ({})), pending: vi.fn(async () => message), reply: vi.fn(async (_r: unknown) => {}), release: vi.fn(async (_id: string, _lease: string) => {}) } satisfies AgentApi;
}
const result = { text: 'The gradient turns the wind.', model: 'claude-opus-5-5', toolsUsed: ['mcp__isobar-archive__sample'] };

describe('slow daemon loop', () => {
  it('posts into the exact lease and keeps lease credentials out of the runner input', async () => {
    const api = fakeApi(); const runner = vi.fn<Runner>(async () => result);
    expect(await processOne(api, runner)).toBe('complete');
    expect(api.reply).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', leaseId: pending().leaseId, ...result, usage: { latencyMs: expect.any(Number) } }));
    expect(runner.mock.calls[0][0]).toEqual({ question: pending().question, context: pending().context, user: pending().user, thread: [] });
    expect(api.release).not.toHaveBeenCalled();
  });
  it('crash releases once; release failure is left to server expiry', async () => {
    const api = fakeApi(); const runner: Runner = async () => { throw new Error('private stderr'); };
    expect(await processOne(api, runner)).toBe('released');
    expect(api.release).toHaveBeenCalledExactlyOnceWith('m1', pending().leaseId);
    api.release.mockRejectedValueOnce(new Error('offline'));
    await expect(processOne(api, runner)).rejects.toThrow('offline');
    expect(api.release).toHaveBeenCalledTimes(2);
  });
  it('capacity waits before claiming, then resumes at the next poll', async () => {
    const api = fakeApi(); const runner = vi.fn<Runner>(async () => result);
    expect(await processOne(api, runner, async () => ({ ok: false }))).toBe('waiting');
    expect(api.pending).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled();
    expect(await processOne(api, runner, async () => ({ ok: true }))).toBe('complete');
  });
  it('never overlaps jobs and awaits active shutdown cleanup before releasing', async () => {
    vi.useFakeTimers(); const api = fakeApi(); let closed = false;
    const runner: Runner = (_input, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { setTimeout(() => { closed = true; reject(new Error('closed')); }, 20); });
    });
    api.release.mockImplementation(async () => { expect(closed).toBe(true); });
    const stop = startDaemon(api, runner);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.pending).toHaveBeenCalledTimes(1);
    const stopping = stop(); await vi.advanceTimersByTimeAsync(20); await stopping;
    expect(api.release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); expect(api.pending).toHaveBeenCalledTimes(1);
  });
  it('never publishes after abort or leaks; logs contain events only', async () => {
    const api = fakeApi(); const shutdown = new AbortController();
    await processOne(api, async () => { shutdown.abort(); return result; }, undefined, shutdown.signal);
    expect(api.reply).not.toHaveBeenCalled(); expect(api.release).toHaveBeenCalledTimes(1);
    expect(screenAgentReply(`isb_agent_${'a'.repeat(43)}`)).toContain('a credential');
    await processOne(api, async () => ({ ...result, text: 'Read /Users/' + 'example/test' }));
    expect(api.reply).not.toHaveBeenCalled();
  });
});

describe('restricted Claude runner, no real Claude invocation', () => {
  it('sets md3 restricted mode, one built-in and one MCP; drops all tokens and API keys', () => {
    const args = buildClaudeArgs('/tmp/job', '/tmp/mcp.json', '/tmp/SLOW.md');
    expect(args).toContain('--restricted'); expect(args).toContain('--strict-mcp-config'); expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read'); expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__isobar-archive');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(safeAgentEnv({ ISOBAR_AGENT_TOKEN: 'secret', DATABASE_URL: 'secret', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'secret', PATH: '/bin', HOME: '/test' })).toEqual({ PATH: '/bin', HOME: '/test' });
  });
  it.each([
    'plain output', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Partial reply' }] } }),
    final('Error', { is_error: true }), final('Error', { subtype: 'error_max_turns' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }) + '\n' + final(),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__isobar-archive-evil__shell' }] } }) + '\n' + final(),
  ])('rejects unsuccessful or unconfined output %s', (raw) => { expect(() => parseClaudeOutput(raw)).toThrow(); });
  it('keeps known usage and inline PNGs from archive tool results, never remote images', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLVcAAAAASUVORK5CYII=';
    const raw = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__isobar-archive__section', id: 'call' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] } },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n' + final('Section from run r1.', { usage: { input_tokens: 50, cache_read_input_tokens: 100, output_tokens: 20 } });
    expect(parseClaudeOutput(raw)).toMatchObject({ toolsUsed: ['mcp__isobar-archive__section'], usage: { promptTokens: 150, completionTokens: 20 }, images: [{ src: `data:image/png;base64,${png}`, alt: 'Archive weather chart' }] });
  });
  it('passes stdin/config/manual to a fake executable in a private workspace and cleans it', async () => {
    const dir = await scratch(); const fake = path.join(dir, 'fake-claude');
    await writeFile(fake, `#!${process.execPath}\nconst fs=require('node:fs'),assert=require('node:assert');
const a=process.argv.slice(2);assert(a.includes('--restricted'));assert.equal(a[a.indexOf('--tools')+1],'Read');
const config=JSON.parse(fs.readFileSync(a[a.indexOf('--mcp-config')+1],'utf8'));assert.deepEqual(Object.keys(config.mcpServers),['isobar-archive']);
assert(config.mcpServers['isobar-archive'].args.includes('isobar_data.archive_mcp'));assert.equal(config.mcpServers['isobar-archive'].env.UV_OFFLINE,'1');
assert(fs.readFileSync(a[a.indexOf('--append-system-prompt-file')+1],'utf8').includes('Isobar'));
assert(process.cwd().startsWith(${JSON.stringify(dir)}));assert.equal(fs.statSync(process.cwd()).mode & 511,448);
assert.equal(process.env.ISOBAR_AGENT_TOKEN,undefined);let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{assert(text.includes('Perth'));process.stdout.write(${JSON.stringify(final())});});\n`, { mode: 0o700 });
    const runner = claudeRunner({ claudePath: fake, workspaceRoot: dir });
    expect((await runner({ question: pending().question, context: {}, thread: [], user: pending().user }, new AbortController().signal)).text).toContain('front');
    expect(await readdir(dir)).toEqual(['fake-claude']);
  });
  it('handles process exit failure, overflow, timeout and pre-abort without output fallback', async () => {
    const dir = await scratch(), signal = new AbortController().signal;
    const run = (code: string, limits = {}) => runProcess(process.execPath, ['-e', code], safeAgentEnv(process.env), '', signal, dir, limits);
    await expect(run('process.exit(3)')).rejects.toThrow('failed');
    await expect(run('process.stdout.write("x".repeat(1024))', { maxOutputBytes: 32 })).rejects.toThrow('limit');
    await expect(run('process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)', { timeoutMs: 80, killGraceMs: 20 })).rejects.toThrow('timed out');
    await expect(runProcess('/does-not-exist', [], {}, '', AbortSignal.abort(), dir)).rejects.toThrow('aborted');
    await expect(runProcess('/does-not-exist', [], {}, '', signal, dir)).rejects.toThrow('start');
  });
  it('aborts a fake process group and kills its child before completion', async () => {
    const dir = await scratch(), pidFile = path.join(dir, 'child.pid'), started = path.join(dir, 'started');
    const controller = new AbortController();
    const script = `const fs=require('node:fs'),{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.on('SIGTERM',()=>process.exit(0));fs.writeFileSync(${JSON.stringify(started)},'ok');setInterval(()=>{},1000);`;
    const running = runProcess(process.execPath, ['-e', script], safeAgentEnv(process.env), '', controller.signal, dir, { killGraceMs: 30 });
    const checked = expect(running).rejects.toThrow('aborted');
    await vi.waitFor(async () => expect(await readFile(started, 'utf8')).toBe('ok'));
    const pid = Number(await readFile(pidFile, 'utf8')); controller.abort(); await checked;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1000 });
  });
});

describe('daemon transport and private configuration', () => {
  it('uses bearer POST with exact claim identity and refuses redirect-capable or insecure origins', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(pending()));
    const api = apiClient('https://isobar.test', 'secret', fetcher); await api.pending();
    expect(fetcher).toHaveBeenCalledWith('https://isobar.test/api/agent/claim', expect.objectContaining({ method: 'POST', redirect: 'error', headers: expect.objectContaining({ authorization: 'Bearer secret' }) }));
    for (const url of ['http://isobar.test', 'ftp://localhost', 'https://user:secret@isobar.test', 'https://isobar.test/path', 'https://isobar.test?key=secret']) expect(() => apiClient(url, 'secret', fetcher)).toThrow();
  });
  it('bounds body time and bytes, rejects malformed pending payloads', async () => {
    const stalled = apiClient('https://isobar.test', 'secret', async () => new Response(new ReadableStream({ start() {} })), 20);
    await expect(stalled.pending()).rejects.toThrow('timeout');
    await expect(apiClient('https://isobar.test', 'secret', async () => new Response('x'.repeat(128001))).pending()).rejects.toThrow('large');
    await expect(apiClient('https://isobar.test', 'secret', async () => Response.json({ id: 'm' })).pending()).rejects.toThrow('invalid');
  });
  it('reads only an owned 0600 regular bounded env file and refuses links', async () => {
    const dir = await scratch(), file = path.join(dir, 'daemon.env'), text = `ISOBAR_AGENT_TOKEN=isb_agent_${'a'.repeat(43)}\nISOBAR_URL=https://isobar.test\n`;
    await writeFile(file, text, { mode: 0o600 }); expect((await readEnvFile(file)).ISOBAR_URL).toBe('https://isobar.test');
    await chmod(file, 0o644); await expect(readEnvFile(file)).rejects.toThrow();
    await chmod(file, 0o600); const link = path.join(dir, 'link'); await symlink(file, link); await expect(readEnvFile(link)).rejects.toThrow();
    await writeFile(file, 'x'.repeat(8193)); await expect(readEnvFile(file)).rejects.toThrow();
  });
});
