import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const health = await import('../../../tools/chat-daemon/health.mjs');
const blocks = await import('../../../tools/chat-daemon/ai-block.mjs');
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('slow lane local health', () => {
  it('uses local evidence only and does not read credential contents', async () => {
    const parent = path.resolve(import.meta.dirname, '../../../build/slow-lane-qa'); await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(path.join(parent, 'isobar-health-')); dirs.push(dir);
    const state = path.join(dir, 'state'); const archive = path.join(dir, 'archive');
    await mkdir(state); await mkdir(archive); const env = path.join(state, 'daemon.env');
    await writeFile(env, 'ISOBAR_AGENT_TOKEN=secret\nISOBAR_URL=https://example.invalid\n', { mode: 0o600 });
    const loginEvidence = vi.fn(async () => ({ present: true, providers: ['.claude'] }));
    const result = await health.collectLocalHealth({ state, archive, loginEvidence, serviceLoaded: async () => false });
    expect(result.config.owned0600).toBe(true); expect(result.archive.readable).toBe(true);
    expect(result.service.loaded).toBe(false); expect(result.logins).toEqual({ present: true, providers: ['.claude'] });
    expect(loginEvidence).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toContain('secret');
    await chmod(env, 0o644); expect((await health.collectLocalHealth({ state, archive, loginEvidence, serviceLoaded: async () => false })).config.owned0600).toBe(false);
    await chmod(env, 0o600); const link = path.join(state, 'link'); await symlink(env, link); expect(await health.isOwned0600(link)).toBe(false);
  });

  it('reports cached server fields and freshness without contacting the server', async () => {
    const result = await health.collectLocalHealth({ state: '/missing', archive: '/missing', serviceLoaded: async () => false,
      loginEvidence: async () => ({ status: 'unknown', providers: [] }), cache: { serverAt: '2026-10-09T00:00:00.000Z', checkedAt: '2026-10-09T00:00:00.000Z', backlog: 3, lastDeliveredAt: '2026-10-08T23:59:00.000Z', runtime: 'claude', heartbeats: [] } });
    expect(result.server.backlog).toBe(3); expect(result.server.lastDeliveredAt).toContain('23:59'); expect(result.server.ageMs).toBeGreaterThan(0);
    expect(result.cache.status).toBe('stale'); expect(result.logins.status).toBe('unknown');
  });
});

describe('AI access block operator CLI', () => {
  it('parses a block and validates its future expiry', () => {
    const parsed = blocks.parseArgs(['block', '--scope', 'global', '--until', '2999-01-01T00:00:00Z', '--reason', 'capacity', '--source', 'md3 watcher']);
    expect(parsed).toMatchObject({ command: 'block', scope: 'global', reason: 'capacity', source: 'md3 watcher' });
    expect(parsed.until).toBeInstanceOf(Date);
    expect(() => blocks.parseArgs(['block', '--scope', 'global', '--until', '2000-01-01T00:00:00Z', '--reason', 'x', '--source', 'y'])).toThrow();
    expect(() => blocks.parseArgs(['block', '--scope', 'global', '--until', '2999-01-01', '--reason', 'x', '--source', 'y'])).toThrow();
    expect(() => blocks.parseArgs(['block', '--scope', 'global', '--until', '2999-01-01T00:00:00Z', '--reason', 'x', '--source', 'y', '--bogus', 'z'])).toThrow();
  });
  it('requires an exact lift id and exposes the active predicate', () => {
    expect(blocks.parseArgs(['lift', '--id', 'clx123'])).toEqual({ command: 'lift', id: 'clx123' });
    expect(() => blocks.parseArgs(['lift', '--scope', 'global'])).toThrow();
    const now = new Date('2026-10-09T00:00:00Z');
    expect(blocks.activeBlock({ until: '2026-10-09T00:01:00Z', liftedAt: null }, now)).toBe(true);
    expect(blocks.activeBlock({ until: '2026-10-09T00:01:00Z', liftedAt: now }, now)).toBe(false);
    expect(blocks.activeBlock({ until: '2026-10-08T00:01:00Z', liftedAt: null }, now)).toBe(false);
  });
  it('help and parsing do not load Prisma or require DATABASE_URL', () => {
    expect(blocks.usage()).toContain('ai-block.mjs block');
    expect(() => blocks.parseArgs(['list', '--x'])).toThrow();
  });
  it('supports fake block, idempotent lift, and list operations without a database', async () => {
    const row = { id: 'b1', scope: 'global', until: new Date('2999-01-01T00:00:00Z'), reason: 'x', source: 'test', createdAt: new Date(), liftedAt: null };
    const db = { aiAccessBlock: {
      create: vi.fn(async () => row), updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ id: 'b1', liftedAt: new Date('2026-10-09T00:00:00Z') })),
      findMany: vi.fn(async () => [row]),
    }, $disconnect: vi.fn(async () => {}) };
    await blocks.main(['block', '--scope', 'global', '--until', '2999-01-01T00:00:00Z', '--reason', 'x', '--source', 'test'], { db });
    await blocks.main(['lift', '--id', 'b1'], { db }); await blocks.main(['list'], { db });
    expect(db.aiAccessBlock.create).toHaveBeenCalledOnce(); expect(db.aiAccessBlock.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'b1', liftedAt: null } })); expect(db.aiAccessBlock.findMany).toHaveBeenCalledOnce();
  });
});
